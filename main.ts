import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { authGaps, candidates, imageDisabled, mainAgentName, recordCooldown, roleAgent, unknownPreset, type Presets } from './presets.ts';
import { readJson, remove, root, writeJson } from './registry.ts';
import { readOverrides, routeTable, scopePath } from './overrides.ts';
import type { RouteTarget } from './routing.ts';
import { routingGuide } from './lifecycle.ts';
import { repoSkills } from './skills.ts';

// Main mode: the main session runs on a preset's orchestrator as a fixed physical model (so the
// thinking level, cache warming and cache stay as usual) and can delegate to that preset's roles
// as pi-team.<role> agents, which route through team/<preset>.<role> in the child.
interface Registration { dispose(): void }
const entryType = 'pi-team-main';
const defaultPath = join(root, 'main.json');
const overflow = /context(?:[ _-]window| length)|too long|maximum context|prompt is too long/i;
// pi-subagents' toolActivation "auto" shows only its subagents_enable loader, whose description
// says not to delegate unless the user asks. Turning main mode on is that request, so main mode
// keeps subagent (and the tools pi-subagents declares with it) active.
const delegationTools = ['subagent', 'subagent_supervisor', 'bg_wait'];

// Sessions that never left main mode leave their override files behind; drop ones idle for two weeks.
function pruneOverrides() {
  const dir = join(root, 'main-overrides');
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (Date.now() - statSync(path).mtimeMs > 14 * 86_400_000) rmSync(path, { force: true });
    }
  } catch { /* nothing to prune */ }
}
export function mainMode(pi: ExtensionAPI, load: () => Presets, cwd: string) {
  let preset: string | undefined;
  let roles: string[] = [];
  // Children inherit this, so their routers read this session's overrides (/team effort, /team model).
  let key = '';
  const active = new Map<string, Registration>();
  const asked = new Set<number>();
  const unregister = () => { for (const r of active.values()) r.dispose(); active.clear(); roles = []; };
  const register = (presets: Presets, name: string) => {
    unregister();
    const repo = repoSkills(cwd);
    try {
      for (const [role, item] of Object.entries(presets[name])) {
        if (role === 'orchestrator' || (role === 'image' && imageDisabled())) continue;
        const request: { version: 1; name: string; definition: object; result?: { ok: true; registration: Registration } | { ok: false; error: Error } } = {
          version: 1, name: mainAgentName(role), definition: roleAgent(name, role, item, 'main', repo),
        };
        pi.events.emit('pi-subagents:runtime-agent-register:v1', request);
        if (!request.result) throw new Error('pi-team main mode requires the pi-subagents 0.90 runtime agent API.');
        if (!request.result.ok) throw request.result.error;
        active.set(role, request.result.registration);
        roles.push(role);
      }
    } catch (e) { unregister(); throw e; }
  };
  const presetOf = (name: string) => {
    const presets = load();
    if (!presets[name]) throw unknownPreset(cwd, name);
    return presets;
  };
  async function use(name: string, ctx: ExtensionContext) {
    const presets = presetOf(name);
    const ready = candidates(presets[name].orchestrator.models, ctx.modelRegistry);
    const now = Date.now();
    const pick = ready.find(c => c.until <= now) ?? ready[0];
    if (!pick) throw new Error(`No signed-in orchestrator candidate in ${name}: ${presets[name].orchestrator.models.join(', ')}.`);
    if (!await pi.setModel(pick.model)) throw new Error(`Cannot switch to ${pick.key}: no credentials.`);
    pi.setThinkingLevel(pick.level);
    register(presets, name);
    preset = name;
    pi.appendEntry(entryType, { preset: name });
    const gaps = authGaps(presets[name], ctx.modelRegistry);
    return [`Main mode ${name}: ${pick.key}:${pick.level}${pick.index ? ' (first choice unavailable)' : ''}. Delegate with pi-team.<role>.`,
      ...(gaps.length ? [`Not on their first choice here: ${gaps.join(', ')}.`] : []), table(presets, ctx)].join('\n');
  }
  // Where each role routes now; the orchestrator line shows the main model itself.
  function table(presets: Presets, ctx: ExtensionContext) {
    if (!preset || !presets[preset]) return '';
    return routeTable(presets[preset], ctx.modelRegistry, readOverrides({ main: key }),
      { role: 'orchestrator', model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, level: pi.getThinkingLevel() });
  }
  function off() {
    unregister();
    try { remove(scopePath({ main: key })); } catch { /* nothing to drop */ }
    if (preset) pi.appendEntry(entryType, { preset: null });
    preset = undefined;
  }
  // Offer the next orchestrator candidate after the main model's request finally failed.
  async function offerFallback(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    type Reply = { role: string; stopReason?: string; errorMessage?: string; provider?: string; model?: string; timestamp?: number };
    let last: Reply | undefined;
    for (let i = branch.length - 1; i >= 0 && !last; i--) {
      const entry = branch[i] as { type: string; message?: Reply };
      if (entry.type === 'message' && entry.message?.role === 'assistant') last = entry.message;
    }
    if (!last || last.stopReason !== 'error' || !preset || last.timestamp === undefined || asked.has(last.timestamp)) return;
    asked.add(last.timestamp);
    const failed = `${last.provider}/${last.model}`;
    const error = last.errorMessage ?? '';
    const cooled = recordCooldown(failed, error);
    if (!cooled && overflow.test(error)) return; // another model would not help
    const presets = load();
    if (!presets[preset]) return;
    const now = Date.now();
    const next = candidates(presets[preset].orchestrator.models, ctx.modelRegistry).filter(c => c.key !== failed)
      .sort((a, b) => Number(a.until > now) - Number(b.until > now) || a.index - b.index)[0];
    if (!next) {
      ctx.ui.notify(`pi-team: main model ${failed} failed${cooled ? ` (${cooled.reason})` : ''}; ${preset} has no other signed-in orchestrator candidate.`, 'warning');
      return;
    }
    const yes = `Switch to ${next.key}:${next.level}`;
    const choice = await ctx.ui.select(
      `Main model ${failed} failed${cooled ? ` (${cooled.reason})` : ''}: ${error.slice(0, 160)}\nSwitching loses the prompt cache: the next request sends the whole conversation again at full input price.`,
      [yes, `Stay on ${failed}`]);
    if (choice !== yes) return;
    if (!await pi.setModel(next.model)) { ctx.ui.notify(`pi-team: cannot switch to ${next.key}.`, 'error'); return; }
    pi.setThinkingLevel(next.level);
    ctx.ui.notify(`pi-team: main model is now ${next.key}:${next.level}. Send your message again, or "continue".`, 'info');
  }
  // Team member agents need their team's child extension and worktree; from here they only fail.
  const teamOnly = (agent: string, presets: Presets) => Object.entries(presets).some(([p, rs]) => Object.keys(rs).some(r => agent === `pi-team.${p}-${r}`));

  pi.on('session_start', async (event, ctx) => {
    key = ctx.sessionManager.getSessionId();
    process.env.PI_TEAM_MAIN_KEY = key;
    pruneOverrides();
    let saved: string | null | undefined;
    for (const entry of ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: { preset?: string | null } }[]) {
      if (entry.type === 'custom' && entry.customType === entryType) saved = entry.data?.preset ?? null;
    }
    const notify = (message: string, kind: 'info' | 'warning') => { if (ctx.hasUI) ctx.ui.notify(message, kind); else process.stderr.write(`${message}\n`); };
    try {
      if (saved) { register(presetOf(saved), saved); preset = saved; return; } // the session restores its own model
      if (saved === null || (event.reason !== 'startup' && event.reason !== 'new')) return;
      const host = readJson<{ preset?: string }>(defaultPath)?.preset;
      if (!host || process.argv.some(a => a === '--model' || a.startsWith('--model='))) return;
      notify(await use(host, ctx), 'info');
    } catch (e) { notify(`pi-team main mode: ${e instanceof Error ? e.message : String(e)}`, 'warning'); }
  });
  pi.on('session_shutdown', unregister);
  pi.on('agent_settled', (_event, ctx) => {
    if (preset && ctx.hasUI) void offerFallback(ctx).catch(e => ctx.ui.notify(`pi-team: ${String(e)}`, 'warning'));
  });
  pi.on('before_agent_start', event => {
    if (!preset || !roles.length) return;
    const registered = new Set(pi.getAllTools().map(t => t.name));
    const missing = delegationTools.filter(t => registered.has(t) && !pi.getActiveTools().includes(t));
    if (missing.length) {
      pi.setActiveTools([...pi.getActiveTools(), ...missing]);
      const selected = event.systemPromptOptions.selectedTools;
      if (selected) for (const t of missing) if (!selected.includes(t)) selected.push(t);
    }
    const presets = load();
    event.systemPromptOptions.sections['pi-team-main'] = [
      `pi-team main mode (${preset}): you work with the user directly and lead these agents through the subagent tool; each runs that role's preset model. The user turned this mode on, which authorizes delegating to them without asking each time:`,
      ...roles.map(r => `- ${mainAgentName(r)}${presets[preset!]?.[r]?.description ? `: ${presets[preset!][r].description}` : ''}`),
      [
        'Balance doing and delegating:',
        '- Do it yourself when it is quick: answering from what you already know, reading one or two known files, a small edit, a single command.',
        '- Delegate when work spans several steps or files: investigation across code, docs or logs; implementation with builds and tests; review of changes; browser or image checks. Run independent pieces in parallel, and keep your own context for talking with the user.',
        '- When the goal is unclear, ask the user before delegating.',
      ].join('\n'),
      routingGuide(presets, preset, 'pi-team.'),
      'Do not pass model. Give each member a complete brief (goal, background, scope it may change, done-when checks, what to report); it cannot see this conversation.',
    ].filter(Boolean).join('\n\n');
  });
  pi.on('tool_call', event => {
    if (event.toolName !== 'subagent') return;
    const input = event.input as { agent?: unknown; tasks?: { agent?: unknown }[] };
    const agents = [input.agent, ...(Array.isArray(input.tasks) ? input.tasks.map(t => t?.agent) : [])].filter((a): a is string => typeof a === 'string');
    const presets = load();
    const bad = agents.find(a => teamOnly(a, presets));
    if (bad) return { block: true, reason: `${bad} runs only inside a pi-team team. ${preset ? `Use ${roles.map(mainAgentName).join(', ')} here.` : 'Run /team main <preset> to delegate from the main session, or start a team.'}` };
  });

  return {
    preset: () => preset,
    target(cwd: string): RouteTarget | undefined {
      if (!preset) return undefined;
      const presets = load();
      return { scope: { main: key }, roles: presets[preset], cwd, label: `main mode ${preset}`, self: 'main' };
    },
    current(ctx: ExtensionContext) { return { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, level: pi.getThinkingLevel() }; },
    async command(args: string, ctx: ExtensionContext) {
      const words = args.split(/\s+/).filter(Boolean);
      const asDefault = words.includes('--default');
      const [name] = words.filter(w => w !== '--default');
      if (!name) {
        const host = readJson<{ preset?: string }>(defaultPath)?.preset;
        return [`Main mode: ${preset ?? 'off'}. Host default: ${host ?? 'none'}.`, ...(preset ? [table(load(), ctx)] : []),
          'Usage: /team main <preset> [--default] | off [--default]; adjust with /team effort and /team model'].join('\n');
      }
      if (name === 'off') {
        off();
        if (asDefault) remove(defaultPath);
        return `Main mode off; the model stays as it is.${asDefault ? ' Host default cleared.' : ''}`;
      }
      const result = await use(name, ctx);
      if (asDefault) writeJson(defaultPath, { preset: name });
      return `${result}${asDefault ? `\nNew sessions on this host start in ${name} unless --model is given.` : ''}`;
    },
  };
}
