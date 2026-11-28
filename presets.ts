import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blenderTools, toolName } from './blender-mcp/extension.ts';
import { reaTools } from './rea-mcp/extension.ts';
import { ambientScope, effectiveModels, readOverrides } from './overrides.ts';
import { coreSkills, roleSkillsDir, type RepoSkills } from './skills.ts';
import { gatedTool, skillSkipTool } from './skill-gate.ts';
import { exists, locked, log, mkdir, namePattern, names, readJson, readText, remove, root, teamDir, writeAtomic, writeJson } from './registry.ts';

// core: skills put into the member's prompt whole (how the role works at all); skills: listed, read when they fit.
export interface Role { models: string[]; description?: string; skills?: string[]; core?: string[]; mcp?: string[]; tools?: string[]; extensions?: string[]; readOnly?: boolean; max?: number; prompt?: string }
// MCP servers a role can ask for by name. Each one is an extension that only that role's members load,
// so the main session and the lead never start it; the extension registers the server's tools.
const mcpServers: Record<string, { extension: string; tools: string[]; prompt: string }> = {
  blender: {
    extension: join(dirname(fileURLToPath(import.meta.url)), 'blender-mcp', 'extension.ts'),
    tools: blenderTools.map(toolName),
    prompt: 'You have your own headless Blender (mcp-for-blender), started on your first Blender call: run bpy code with mcp__blender__execute_blender_code, inspect with mcp__blender__get_scene_info and look at the result with mcp__blender__look. Save .blend files, renders and exports inside the team worktree; the scene is lost when you finish.',
  },
  rea: {
    extension: join(dirname(fileURLToPath(import.meta.url)), 'rea-mcp', 'extension.ts'),
    tools: reaTools,
    prompt: `REA reverse-engineering tools are reached through rea_tools (search by words), rea_tool_schema (exact input schema) and rea_call (run one tool). REA starts on the first of these calls and stops after ${Number(process.env.PI_TEAM_REA_IDLE_MINUTES ?? 10)} idle minutes, which closes open targets. Native decompilation uses Ghidra, whose first analysis of a target can take minutes. Keep evidence and reports inside the team worktree.`,
  },
};
export type Presets = Record<string, Record<string, Role>>;
const here = dirname(fileURLToPath(import.meta.url));
const defaultsPath = join(here, 'presets.default.json');
export const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const candidatePattern = /^([\w.-]+)\/([\w./-]+):((?:off|minimal|low|medium|high|xhigh|max))$/;
function candidate(s: string) {
  const match = candidatePattern.exec(s);
  if (!match || match[1] === 'team') throw new Error(`Invalid physical model candidate: ${s}`);
  return { provider: match[1], id: match[2], level: match[3] as ThinkingLevel, key: `${match[1]}/${match[2]}` };
}
function validate(value: Presets | undefined, relativeTo: string): Presets {
  if (!value) return {};
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Presets must be a JSON object.');
  const result: Presets = {};
  for (const [preset, roles] of Object.entries(value)) {
    if (!namePattern.test(preset) || !roles?.orchestrator || Object.getPrototypeOf(roles) !== Object.prototype) throw new Error(`Invalid preset: ${preset}`);
    const clean: Record<string, Role> = {};
    for (const [role, details] of Object.entries(roles)) {
      if (!namePattern.test(role) || !Array.isArray(details?.models) || !details.models.length || details.models.some(m => typeof m !== 'string' || !candidate(m)) ||
          (details.max !== undefined && (!Number.isSafeInteger(details.max) || details.max < 1)) ||
          (details.readOnly !== undefined && typeof details.readOnly !== 'boolean') ||
          (details.prompt !== undefined && typeof details.prompt !== 'string') ||
          (details.description !== undefined && (typeof details.description !== 'string' || !details.description.trim() || /[\r\n]/.test(details.description))) ||
          (details.skills !== undefined && (!Array.isArray(details.skills) || details.skills.some(s => typeof s !== 'string' || !/^[\w:.-]+$/.test(s)))) ||
          (details.core !== undefined && (!Array.isArray(details.core) || details.core.some(s => typeof s !== 'string' || !/^[\w:.-]+$/.test(s)))) ||
          (details.mcp !== undefined && (!Array.isArray(details.mcp) || details.mcp.some(s => typeof s !== 'string' || !Object.hasOwn(mcpServers, s)))) ||
          (details.tools !== undefined && (!Array.isArray(details.tools) || details.tools.some(t => typeof t !== 'string' || !/^[\w:.-]+$/.test(t)))) ||
          (details.extensions !== undefined && (!Array.isArray(details.extensions) || details.extensions.some(p => typeof p !== 'string' || !p || /[\r\n,]/.test(p))))) {
        throw new Error(`Invalid role: ${preset}.${role}`);
      }
      clean[role] = { ...details, extensions: details.extensions?.map(p => isAbsolute(p) ? p : resolve(relativeTo, p)) };
    }
    result[preset] = clean;
  }
  return result;
}
// Preset files come in layers: the defaults shipped with pi-team, then ~/.pi/agent/teams/presets.json,
// then <repo>/.pi/teams/presets.json. A version 2 layer merges into the layers below it:
//   models  - aliases for physical models, e.g. "opus": "anthropic/claude-opus-5-5" (change one line per release)
//   presets - { extends, abstract, description, slots, roles }; slots map a slot name to candidates such as
//             "opus:high", and a role's models may name a slot as "@lead". A role set to null is removed.
// A file without "version" is the older flat form; each preset in it replaces the one of that name.
type RawRole = Omit<Role, 'models'> & { models?: string | string[] };
interface PresetDef { extends?: string; abstract?: boolean; description?: string; slots?: Record<string, string[]>; roles?: Record<string, RawRole | null>; replace?: boolean }
interface Layer { models: Record<string, string>; presets: Record<string, PresetDef> }
export interface Catalog { presets: Presets; descriptions: Record<string, string>; problems: Record<string, string>; models: Record<string, string> }
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const aliasPattern = /^[a-z][\w.-]*$/;
const physicalPattern = /^[\w.-]+\/[\w./-]+$/;
function readLayer(path: string, relativeTo: string): Layer {
  const data = readJson<unknown>(path);
  if (data === undefined) return { models: {}, presets: {} };
  if (!plain(data)) throw new Error(`Presets must be a JSON object: ${path}`);
  const fixPaths = (role: RawRole) => role.extensions && Array.isArray(role.extensions)
    ? { ...role, extensions: role.extensions.map(p => typeof p === 'string' && p && !isAbsolute(p) ? resolve(relativeTo, p) : p) } : role;
  if (data.version === undefined) {
    const presets: Record<string, PresetDef> = {};
    for (const [name, roles] of Object.entries(data)) {
      presets[name] = { replace: true, roles: plain(roles) ? Object.fromEntries(Object.entries(roles).map(([r, v]) => [r, plain(v) ? fixPaths(v as RawRole) : v as null])) : roles as never };
    }
    return { models: {}, presets };
  }
  if (data.version !== 2) throw new Error(`Unsupported presets version in ${path}: ${String(data.version)}`);
  const models = data.models ?? {};
  if (!plain(models) || Object.entries(models).some(([k, v]) => !aliasPattern.test(k) || typeof v !== 'string' || !physicalPattern.test(v))) {
    throw new Error(`Invalid models in ${path}: map an alias such as "opus" to "provider/model-id".`);
  }
  const presets = data.presets ?? {};
  if (!plain(presets)) throw new Error(`Invalid presets in ${path}.`);
  const result: Record<string, PresetDef> = {};
  for (const [name, def] of Object.entries(presets)) {
    if (!plain(def)) { result[name] = { replace: true, roles: 'invalid' as never }; continue; }
    const roles = plain(def.roles) ? Object.fromEntries(Object.entries(def.roles).map(([r, v]) => [r, plain(v) ? fixPaths(v as RawRole) : v as null])) : def.roles;
    result[name] = { ...def, roles } as PresetDef;
  }
  return { models: models as Record<string, string>, presets: result };
}
function merge(layers: Layer[]) {
  const models: Record<string, string> = {};
  const presets: Record<string, PresetDef> = {};
  for (const layer of layers) {
    Object.assign(models, layer.models);
    for (const [name, def] of Object.entries(layer.presets)) {
      const prior = presets[name];
      if (!prior || def.replace) { presets[name] = def; continue; }
      const roles: Record<string, RawRole | null> = { ...prior.roles };
      for (const [role, value] of Object.entries(def.roles ?? {})) roles[role] = value && roles[role] ? { ...roles[role], ...value } : value;
      presets[name] = { ...prior, ...def, slots: { ...prior.slots, ...def.slots }, roles };
    }
  }
  return { models, presets };
}
function resolvePreset(name: string, defs: Record<string, PresetDef>, models: Record<string, string>): Record<string, Role> {
  const chain: PresetDef[] = [];
  for (let at: string | undefined = name; at !== undefined;) {
    const def: PresetDef | undefined = defs[at];
    if (!def) throw new Error(`extends unknown preset ${at}`);
    if (chain.includes(def)) throw new Error(`extends loop at ${at}`);
    if ((def.roles !== undefined && !plain(def.roles)) || (def.slots !== undefined && !plain(def.slots)) ||
        (def.extends !== undefined && typeof def.extends !== 'string')) throw new Error(`malformed preset ${at}`);
    chain.unshift(def);
    at = def.replace ? undefined : def.extends;
  }
  const slots: Record<string, string[]> = {};
  const roles: Record<string, RawRole | null> = {};
  for (const def of chain) {
    Object.assign(slots, def.slots);
    for (const [role, value] of Object.entries(def.roles ?? {})) roles[role] = value && roles[role] ? { ...roles[role], ...value } : value;
  }
  const physical = (c: string) => {
    if (typeof c !== 'string') throw new Error(`model candidates must be strings`);
    const m = /^([^/:]+):([a-z]+)$/.exec(c);
    if (!m || c.includes('/')) return c;
    if (!Object.hasOwn(models, m[1])) throw new Error(`unknown model alias ${m[1]} in ${c}`);
    return `${models[m[1]]}:${m[2]}`;
  };
  const result: Record<string, Role> = {};
  for (const [role, raw] of Object.entries(roles)) {
    if (raw === null) continue;
    if (!plain(raw)) throw new Error(`role ${role} must be an object or null`);
    const list = raw.models === undefined ? [] : Array.isArray(raw.models) ? raw.models : [raw.models];
    const expanded = list.flatMap(entry => {
      if (typeof entry !== 'string' || !entry.startsWith('@')) return [physical(entry)];
      const slot = slots[entry.slice(1)];
      if (!Array.isArray(slot) || !slot.length) throw new Error(`role ${role} uses slot ${entry}, which this preset does not define`);
      return slot.map(physical);
    });
    result[role] = { ...raw, models: [...new Set(expanded)] };
  }
  return result;
}
export function presetCatalog(cwd: string): Catalog {
  const { models, presets: defs } = merge([readLayer(defaultsPath, here), readLayer(join(root, 'presets.json'), root), readLayer(join(cwd, '.pi', 'teams', 'presets.json'), cwd)]);
  const catalog: Catalog = { presets: {}, descriptions: {}, problems: {}, models };
  // One broken preset must not take the others down: teams started from them keep working.
  for (const [name, def] of Object.entries(defs)) {
    if (def.abstract) continue;
    try {
      Object.assign(catalog.presets, validate({ [name]: resolvePreset(name, defs, models) }, root));
      if (typeof def.description === 'string') catalog.descriptions[name] = def.description;
    } catch (e) { catalog.problems[name] = e instanceof Error ? e.message : String(e); }
  }
  return catalog;
}
export function readPresets(cwd: string, team?: string): Presets {
  if (team) {
    const captured = readJson<Presets>(join(teamDir(team), 'preset.json'));
    if (captured) return validate(captured, cwd);
  }
  return presetCatalog(cwd).presets;
}
export function unknownPreset(cwd: string, preset: string) {
  const problem = presetCatalog(cwd).problems[preset];
  return new Error(problem ? `Preset ${preset} is invalid: ${problem}` : `Unknown preset: ${preset}`);
}
export const imageEntry = join(root, 'vendor', 'node_modules', 'pi-codex-image-gen', 'index.ts');
export const imageDisabled = () => readJson<{ reason: string; at: number }>(join(root, 'image-disabled.json'))?.reason
  ?? (exists(imageEntry) ? undefined : 'Private pi-codex-image-gen@0.3.2 is not installed.');
const mailTools = ['team_peers', 'team_send', 'team_inbox', 'team_wait'];
const managed = '<!-- Generated by pi-team -->';
export const childEntry = fileURLToPath(new URL('./child.ts', import.meta.url));
// Registers the role virtual models in members the main session delegates to; foreground
// children never load the parent's extensions, so without it team/<preset>.<role> is unknown there.
export const modelsEntry = fileURLToPath(new URL('./models.ts', import.meta.url));
export const mainAgentName = (role: string) => `pi-team.${role}`;
// What a member carries, in three layers with different delivery:
//  - project rules: the repository's AGENTS.md and the user's global one, always and whole, through
//    pi-subagents' context inheritance. A custom agent starts without them by default, which left
//    members changing a project's code without any of its rules.
//  - role knowledge: core skills in the prompt from the first turn; listed skills chosen before the
//    first command or edit (skill-gate.ts).
//  - the task: the brief.
export function roleAgent(preset: string, role: string, item: Role, mode: 'team' | 'main' = 'team', repo?: RepoSkills) {
  const main = mode === 'main';
  const core = coreSkills(item.core ?? [], repo?.root);
  const inlined = new Set(core.found.map(s => s.name));
  const skills = [...new Set([...(item.skills ?? []), ...core.missing, ...(repo?.names ?? [])])].filter(name => !inlined.has(name));
  const defaults = role === 'image' ? ['read', 'codex_generate_image'] : item.readOnly ? ['read', 'grep', 'find', 'ls'] : ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
  const excludeTools = item.readOnly ? ['write', 'edit'] : [];
  const mcp = item.mcp ?? [];
  const base = [...new Set([...(item.tools ?? defaults), ...(main ? [] : mailTools), ...mcp.flatMap(name => mcpServers[name].tools),
    ...(role === 'vision' ? ['read'] : []), ...(role === 'image' ? ['codex_generate_image'] : [])])]
    .filter(tool => !excludeTools.includes(tool));
  // Roles that only read and search are never held back by the skill choice, so they do not need its tool.
  const tools = base.some(gatedTool) ? [...base, skillSkipTool] : base;
  const gated = tools.includes(skillSkipTool);
  const subagentOnlyExtensions = [...new Set([...(main ? [modelsEntry] : []), ...(item.extensions ?? []), ...mcp.map(name => mcpServers[name].extension), ...(role === 'image' ? [imageEntry] : [])])];
  const lead = main ? 'the main session' : 'the lead';
  const systemPrompt = [
    main
      ? `You are the ${role} member the main session delegated to. Work in the current repository within the scope the brief gives, and give a concise final result.`
      : `You are the ${role} member. Stay inside the team worktree; use team_peers, team_send, team_inbox and team_wait to coordinate. Give the lead a concise final result.`,
    `Your prompt carries this project's instructions (AGENTS.md files) and the user's global rules. They bind your work as they bind ${lead}: where they and a skill disagree, they win, and a skill the repository ships wins over a general one. You are a member, so you cannot ask the user or delegate: when a rule calls for the user's approval, a question to the user or another agent, do not do that part; ${main ? 'say so in your report' : 'ask the lead with team_send or say so in your report'}. Rules about coordinating panes, sending mail or reporting to the user are ${lead}'s to follow, not yours.`,
    ...core.found.map(s => `Core skill ${s.name}: this is how you work in this role, so follow it. Its files are in ${s.dir}; resolve its relative paths there.\n\n${s.body}`),
    gated && skills.length ? `Your listed skills are how this role works, not optional reading. Before your first command, edit or other tool that changes anything, check them against the brief and the project rules and read the whole SKILL.md of each one that fits with the read tool (no offset or limit), starting with any skill the project rules or the brief name for this kind of work; if none fits, call ${skillSkipTool} with the reason. Other tools are refused until then.` : '',
    gated && (skills.length || core.found.length) ? 'A skill you follow sets the method; the brief\'s time box sets how much you do. When time is short, cut the scope of the work and report what is left; do not skip the steps or the documents the skill requires, and do not read them in part. A SKILL.md often sends you to documents in its own folder (references/…) for part of the work: read the ones it names for your task whole before that step. After your context is compacted the skill text is gone from it, so you will be asked to read again what your current step needs.' : '',
    main
      ? 'Follow the brief\'s Limits: append to the notes file after each step and stop to report before the time box ends, even if unfinished. If the brief leaves a choice open, take the safer option and state it.'
      : 'Follow the brief\'s Limits: append to the notes file after each step and stop to report before the time box ends, even if unfinished. If the brief leaves a choice open, take the safer option and state it; ask the lead with team_send only when a wrong guess would waste the work.',
    `End with a short report under these headings: Result; Checks (run, with outcome, and not run); Open issues; Changed files (or none); Artifacts (paths). Never report an unrun check as passed.${gated && (skills.length || core.found.length) ? ' Under Checks, name the skills you followed, or say that none applied, and name any part of a skill, or a document it points to, that you read only in part or skipped, with the reason.' : ''}`,
    'Keep your context small; it is re-read on every turn. Read large files with line ranges or rg instead of printing whole files, except a skill you follow: read its SKILL.md whole, since the later sections carry the procedure and the documents to read next. Do not reread a file or image you already have unless it changed. When you are resumed for a follow-up, build on what you already read.',
    role === 'vision' ? 'Use `read` on the supplied image path and describe the actual visual content.' : '',
    role === 'image' ? 'Use codex_generate_image with save="custom", saveDir="artifacts", outputFormat="png". Report the saved PNG path or the exact tool error; do not substitute another image generator.' : '',
    ...mcp.map(name => mcpServers[name].prompt.replaceAll('team worktree', main ? 'repository' : 'team worktree')),
    item.prompt?.trim().replaceAll('team worktree', main ? 'repository' : 'team worktree'),
    repo?.names.length ? `The repository ships its own skills (${repo.names.join(', ')}). When a task matches one, read it before starting; where it and a general skill both fit, follow the repository's.` : '',
  ].filter(Boolean).join('\n\n');
  const description = `pi-team ${preset} ${role} member${item.description ? `: ${item.description.trim()}` : ''}`;
  // Repository folders first, so a project skill wins over pi-team's role skill of the same name.
  const skillPath = [...(repo?.dirs ?? []), ...(exists(roleSkillsDir) ? [roleSkillsDir] : [])];
  return { description, model: `team/${preset}.${role}`, tools, excludeTools, skills, ...(skillPath.length ? { skillPath } : {}), extensions: [], subagentOnlyExtensions, systemPrompt,
    inheritProjectContext: true, inheritGlobalContext: true };
}
export function generateAgents(presets: Presets, target = join(getAgentDir(), 'agents', 'pi-team')) {
  mkdir(target);
  for (const [preset, roles] of Object.entries(presets)) {
    const dir = join(target, preset);
    const live = new Set<string>();
    for (const [role, item] of Object.entries(roles)) {
      if (role === 'orchestrator' || (role === 'image' && imageDisabled())) continue;
      const def = roleAgent(preset, role, item);
      const body = ['---', 'package: pi-team', `name: ${preset}-${role}`, `description: ${def.description}`, `model: ${def.model}`,
        `tools: ${def.tools.join(', ')}`, ...(def.excludeTools.length ? [`excludeTools: ${def.excludeTools.join(', ')}`] : []),
        ...(def.skills.length ? [`skills: ${def.skills.join(', ')}`] : []), ...(def.skillPath ? [`skillPath: ${def.skillPath.join(', ')}`] : []),
        'inheritProjectContext: true', 'inheritGlobalContext: true', 'extensions: []',
        ...(def.subagentOnlyExtensions.length ? [`subagentOnlyExtensions: ${def.subagentOnlyExtensions.map(s => JSON.stringify(s)).join(', ')}`] : []),
        '---', '', managed, '', def.systemPrompt, ''].join('\n');
      live.add(`${role}.md`);
      const path = join(dir, `${role}.md`);
      const old = readText(path);
      if (old !== body && (old === undefined || old.includes(managed))) writeAtomic(path, body);
    }
    for (const file of names(dir)) if (!live.has(file) && file.endsWith('.md') && readText(join(dir, file))?.includes(managed)) remove(join(dir, file));
  }
}

type Kind = 'quota' | 'rate_limit' | 'overloaded' | 'auth';
const duration: Record<Kind, number> = { quota: 3_600_000, rate_limit: 60_000, overloaded: 120_000, auth: 900_000 };
interface Cooldown { reason: Kind; until: number }
const cooldowns = () => readJson<Record<string, Cooldown>>(join(root, 'cooldown.json')) ?? {};
export function classify(message: string): Kind | undefined {
  if (/insufficient_quota|usage[ _-]limit|billing|quota/i.test(message)) return 'quota';
  if (/\b429\b|rate[ _-]limit/i.test(message)) return 'rate_limit';
  if (/\b(?:529|503)\b|overload/i.test(message)) return 'overloaded';
  if (/\b(?:401|403)\b/.test(message)) return 'auth';
}
export function recordCooldown(model: string, error: string) {
  const reason = classify(error);
  if (!reason) return;
  const at = Date.now();
  const until = at + duration[reason];
  locked(join(root, '.cooldown.lock'), () => {
    const current = cooldowns();
    current[model] = { until: Math.max(current[model]?.until ?? 0, until), reason };
    writeJson(join(root, 'cooldown.json'), current);
  });
  return { reason, at, until };
}
export function recordFailure(team: string, from: string, model: string, error: string, sideEffects: boolean) {
  const cooled = recordCooldown(model, error);
  if (cooled) log(team, { event: 'fallback', at: cooled.at, from, model, reason: cooled.reason, sideEffects, until: cooled.until });
}
export interface Choice { key: string; level: ThinkingLevel; index: number; model: NonNullable<ReturnType<ExtensionContext['modelRegistry']['find']>>; until: number }
// Authenticated candidates of a chain in order, with their cooldown end (0 when ready).
export function candidates(models: string[], registry: ExtensionContext["modelRegistry"]): Choice[] {
  const cd = cooldowns();
  return models.map(candidate).flatMap((c, index) => {
    const model = registry.find(c.provider, c.id);
    return model && registry.hasConfiguredAuth(model) ? [{ key: c.key, level: c.level, index, model, until: cd[c.key]?.until ?? 0 }] : [];
  });
}
interface RouteState { override?: string }
const overrideKey = (o?: { model?: string; level?: string; models?: string[] }) => o?.model || o?.level || o?.models?.length ? `${o.model ?? ''}|${o.level ?? ''}|${o.models?.join(',') ?? ''}` : '';
export function registerModels(pi: ExtensionAPI, presets: Presets, onRoute?: (model: string, fallback: boolean, level: ThinkingLevel) => void, options: { skipOrchestrator?: boolean } = {}) {
  for (const [preset, roles] of Object.entries(presets)) for (const [role, item] of Object.entries(roles)) {
    if (role === 'image' && imageDisabled()) continue;
    // Main sessions and leads run on physical models; listing team/<preset>.orchestrator there only
    // invites picking it as the session model, which ignores the thinking level and loses cache warming.
    if (options.skipOrchestrator && role === 'orchestrator') continue;
    const id = `${preset}.${role}`;
    pi.registerVirtualModel<RouteState>({ provider: 'team', id, name: `Team ${id}`, thinkingLevels: [...levels], route(request, ctx) {
      const disabled = role === 'image' && imageDisabled();
      if (disabled) throw new Error(`Image role disabled: ${disabled}`);
      const now = Date.now();
      const failed = request.reason === 'retry' && request.failed?.model;
      // Temporary overrides (/team effort, /team model) apply from the next request.
      const override = readOverrides(ambientScope())[role];
      const available = candidates(effectiveModels(item, override), ctx.modelRegistry).filter(c => !(failed && failed.id === c.model.id && failed.provider === c.model.provider));
      // Within a turn (tool follow-ups, compaction) stay on the model that answered last: switching
      // there drops the prompt cache. A new user turn or a retry chooses again, and so does the first
      // request after the role's override changed. A lead runs on mail and subagent notices, which
      // are continuations, so without that it could keep the old model until the user writes.
      // The router state remembers which override the session last routed with.
      const routed = overrideKey(override);
      const changed = request.reason !== 'direct' && (request.state?.override ?? '') !== routed;
      const previous = !changed && (request.reason === 'continuation' || request.reason === 'direct') ? request.previous?.model : undefined;
      let choice = (previous && available.find(c => c.model.id === previous.id && c.model.provider === previous.provider)) || available.find(c => c.until <= now);
      if (!choice) {
        choice = available.reduce<(typeof available)[number] | undefined>((best, c) => !best || c.until < best.until ? c : best, undefined);
        if (!choice) throw new Error(`No authenticated candidate available for team/${id}${failed ? ' after retry' : ''}.`);
        const warning = `team/${id}: all authenticated candidates are cooling down; trying ${choice.key}.`;
        if (ctx.hasUI) ctx.ui.notify(warning, 'warning'); else process.stderr.write(`${warning}\n`);
      }
      const level = override?.level ?? choice.level;
      if (request.reason !== 'direct') onRoute?.(choice.key, choice.index !== 0, level);
      return { model: choice.model, thinkingLevel: level, ...(changed ? { state: { override: routed } } : {}) };
    } });
  }
}
export function presetView(presets: Presets, ctx: ExtensionContext, select?: string, info: Partial<Pick<Catalog, 'descriptions' | 'problems'>> = {}) {
  if (select && !presets[select]) throw new Error(info.problems?.[select] ? `Preset ${select} is invalid: ${info.problems[select]}` : `Unknown preset: ${select}`);
  const cd = cooldowns();
  const problems = Object.entries(info.problems ?? {}).filter(([p]) => !select || select === p).map(([p, why]) => `${p}: INVALID - ${why}`);
  return [...problems, ...Object.entries(presets).filter(([p]) => !select || select === p).flatMap(([p, roles]) => [`${p}${info.descriptions?.[p] ? ` - ${info.descriptions[p]}` : ''}`,
    ...Object.entries(roles).map(([role, item]) => `  ${role}: ${item.models.map(s => {
      const c = candidate(s);
      const model = ctx.modelRegistry.find(c.provider, c.id);
      const cooldown = cd[c.key];
      return `${s} [${!model ? 'unavailable' : ctx.modelRegistry.hasConfiguredAuth(model) ? 'auth' : 'no auth'}; ${cooldown && cooldown.until > Date.now() ? `cooldown ${cooldown.reason} until ${new Date(cooldown.until).toISOString()}` : 'ready'}]`;
    }).join(' → ')}${role === 'image' && imageDisabled() ? ` (disabled: ${imageDisabled()})` : ''}`)])].join('\n');
}
// Roles whose first choice cannot run on this host, e.g. Codex candidates where only Claude is signed in.
export function authGaps(roles: Record<string, Role>, registry: ExtensionContext['modelRegistry']) {
  return Object.entries(roles).flatMap(([role, item]) => {
    if (role === 'image' && imageDisabled()) return [];
    const ready = candidates(item.models, registry);
    return ready[0]?.index === 0 ? [] : [`${role} (${ready.length ? `falls back to ${ready[0].key}` : 'no signed-in candidate'})`];
  });
}
