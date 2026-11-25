import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blenderTools, toolName } from './blender-mcp/extension.ts';
import { exists, locked, log, mkdir, namePattern, names, readJson, readText, remove, root, teamDir, writeAtomic, writeJson } from './registry.ts';

interface Role { models: string[]; description?: string; skills?: string[]; mcp?: string[]; tools?: string[]; extensions?: string[]; readOnly?: boolean; max?: number; prompt?: string }
// MCP servers a role can ask for by name. Each one is an extension that only that role's members load,
// so the main session and the lead never start it; the extension registers the server's tools.
const mcpServers: Record<string, { extension: string; tools: string[]; prompt: string }> = {
  blender: {
    extension: join(dirname(fileURLToPath(import.meta.url)), 'blender-mcp', 'extension.ts'),
    tools: blenderTools.map(toolName),
    prompt: 'You have your own headless Blender (mcp-for-blender): run bpy code with mcp__blender__execute_blender_code, inspect with mcp__blender__get_scene_info and look at the result with mcp__blender__look. Save .blend files, renders and exports inside the team worktree; the scene is lost when you finish.',
  },
};
export type Presets = Record<string, Record<string, Role>>;
const sol = 'openai-codex/gpt-6.2-sol';
const opus = 'anthropic/claude-opus-5-5:high';
const defaultPresets: Presets = { mix: {
  orchestrator: { models: [opus, `${sol}:xhigh`] },
  task: { models: [`${sol}:medium`, opus], max: 3 },
  scout: { models: ['openai-codex/gpt-6-luna:high', `${sol}:medium`], readOnly: true },
  reviewer: { models: [`${sol}:high`, opus], readOnly: true },
  vision: { models: [`${sol}:high`, opus], readOnly: true },
  image: { models: [`${sol}:medium`] },
} };
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
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
export function readPresets(cwd: string, team?: string): Presets {
  const path = join(root, 'presets.json');
  if (!exists(path)) locked(join(root, '.presets.lock'), () => { if (!exists(path)) writeJson(path, defaultPresets); });
  if (team) {
    const captured = readJson<Presets>(join(teamDir(team), 'preset.json'));
    if (captured) return validate(captured, cwd);
  }
  return { ...validate(readJson<Presets>(path), root), ...validate(readJson<Presets>(join(cwd, '.pi', 'teams', 'presets.json')), cwd) };
}
export const imageEntry = join(root, 'vendor', 'node_modules', 'pi-codex-image-gen', 'index.ts');
export const imageDisabled = () => readJson<{ reason: string; at: number }>(join(root, 'image-disabled.json'))?.reason
  ?? (exists(imageEntry) ? undefined : 'Private pi-codex-image-gen@0.3.2 is not installed.');
const mailTools = ['team_peers', 'team_send', 'team_inbox', 'team_wait'];
const managed = '<!-- Generated by pi-team -->';
export const childEntry = fileURLToPath(new URL('./child.ts', import.meta.url));
export function roleAgent(preset: string, role: string, item: Role) {
  const defaults = role === 'image' ? ['read', 'codex_generate_image'] : item.readOnly ? ['read', 'grep', 'find', 'ls'] : ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
  const excludeTools = item.readOnly ? ['write', 'edit'] : [];
  const mcp = item.mcp ?? [];
  const tools = [...new Set([...(item.tools ?? defaults), ...mailTools, ...mcp.flatMap(name => mcpServers[name].tools),
    ...(role === 'vision' ? ['read'] : []), ...(role === 'image' ? ['codex_generate_image'] : [])])]
    .filter(tool => !excludeTools.includes(tool));
  const subagentOnlyExtensions = [...new Set([...(item.extensions ?? []), ...mcp.map(name => mcpServers[name].extension), ...(role === 'image' ? [imageEntry] : [])])];
  const systemPrompt = [
    `You are the ${role} member. Stay inside the team worktree; use team_peers, team_send, team_inbox and team_wait to coordinate. Give the lead a concise final result.`,
    role === 'vision' ? 'Use `read` on the supplied image path and describe the actual visual content.' : '',
    role === 'image' ? 'Use codex_generate_image with save="custom", saveDir="artifacts", outputFormat="png". Report the saved PNG path or the exact tool error; do not substitute another image generator.' : '',
    ...mcp.map(name => mcpServers[name].prompt),
    item.prompt?.trim(),
  ].filter(Boolean).join('\n\n');
  const description = `pi-team ${preset} ${role} member${item.description ? `: ${item.description.trim()}` : ''}`;
  return { description, model: `team/${preset}.${role}`, tools, excludeTools, skills: item.skills ?? [], extensions: [], subagentOnlyExtensions, systemPrompt };
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
        ...(def.skills.length ? [`skills: ${def.skills.join(', ')}`] : []), 'extensions: []',
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
export function recordFailure(team: string, from: string, model: string, error: string, sideEffects: boolean) {
  const reason = classify(error);
  if (!reason) return;
  const at = Date.now();
  const until = at + duration[reason];
  locked(join(root, '.cooldown.lock'), () => {
    const current = cooldowns();
    current[model] = { until: Math.max(current[model]?.until ?? 0, until), reason };
    writeJson(join(root, 'cooldown.json'), current);
  });
  log(team, { event: 'fallback', at, from, model, reason, sideEffects, until });
}
export function registerModels(pi: ExtensionAPI, presets: Presets, onRoute?: (model: string, fallback: boolean) => void) {
  for (const [preset, roles] of Object.entries(presets)) for (const [role, item] of Object.entries(roles)) {
    if (role === 'image' && imageDisabled()) continue;
    const id = `${preset}.${role}`;
    const chain = item.models.map(candidate);
    pi.registerVirtualModel({ provider: 'team', id, name: `Team ${id}`, thinkingLevels: [...levels], route(request, ctx) {
      const disabled = role === 'image' && imageDisabled();
      if (disabled) throw new Error(`Image role disabled: ${disabled}`);
      const cd = cooldowns();
      const now = Date.now();
      const failed = request.reason === 'retry' && request.failed?.model;
      const available = chain.flatMap((c, index) => {
        const model = ctx.modelRegistry.find(c.provider, c.id);
        return model && ctx.modelRegistry.hasConfiguredAuth(model) && !(failed && failed.id === c.id && failed.provider === c.provider)
          ? [{ ...c, index, model, until: cd[c.key]?.until ?? 0 }] : [];
      });
      let choice = available.find(c => c.until <= now);
      if (!choice) {
        choice = available.reduce<(typeof available)[number] | undefined>((best, c) => !best || c.until < best.until ? c : best, undefined);
        if (!choice) throw new Error(`No authenticated candidate available for team/${id}${failed ? ' after retry' : ''}.`);
        const warning = `team/${id}: all authenticated candidates are cooling down; trying ${choice.key}.`;
        if (ctx.hasUI) ctx.ui.notify(warning, 'warning'); else process.stderr.write(`${warning}\n`);
      }
      if (request.reason !== 'direct') onRoute?.(choice.key, choice.index !== 0);
      return { model: choice.model, thinkingLevel: choice.level };
    } });
  }
}
export function presetView(presets: Presets, ctx: ExtensionContext, select?: string) {
  if (select && !presets[select]) throw new Error(`Unknown preset: ${select}`);
  const cd = cooldowns();
  return Object.entries(presets).filter(([p]) => !select || select === p).flatMap(([p, roles]) => [p,
    ...Object.entries(roles).map(([role, item]) => `  ${role}: ${item.models.map(s => {
      const c = candidate(s);
      const model = ctx.modelRegistry.find(c.provider, c.id);
      const cooldown = cd[c.key];
      return `${s} [${!model ? 'unavailable' : ctx.modelRegistry.hasConfiguredAuth(model) ? 'auth' : 'no auth'}; ${cooldown && cooldown.until > Date.now() ? `cooldown ${cooldown.reason} until ${new Date(cooldown.until).toISOString()}` : 'ready'}]`;
    }).join(' → ')}${role === 'image' && imageDisabled() ? ` (disabled: ${imageDisabled()})` : ''}`)]).join('\n');
}
