import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { aliasHints, delegate, readTargets, showAliases, startNamed, type TeamTargets } from './aliases.ts';
import { board, status, widget } from './board.ts';
import { closeTeam, findSummary, parseStart, report, splitGoal } from './lifecycle.ts';
import { registerMailbox, send, sendParams } from './mailbox.ts';
import { teamPanel } from './panel.ts';
import { participant, type ParticipantRuntime } from './participant.ts';
import { childEntry, generateAgents, imageDisabled, presetView, readPresets, registerModels, roleAgent, type Presets } from './presets.ts';
import { errorCode, getTeam, git, isLive, members, teamDir, teams, text, writeJson, type FleetEntry, type Team } from './registry.ts';

interface Registration { dispose(): void }
interface RequiredExtensionAPI {
  registerRequiredChildExtensions(input: { sessionId: string; extensions: { id: string; path: string }[]; requireForAllRunners: boolean }): Registration;
}
async function requiredExtensions(): Promise<RequiredExtensionAPI> {
  const resolver = createRequire(join(getAgentDir(), 'npm', 'package.json'));
  const entry = resolver.resolve('pi-subagents/required-child-extensions');
  return import(pathToFileURL(entry).href);
}
// Keep canonical generated files discoverable while pinning live launches to the
// team's captured definition, even if another checkout regenerates that preset.
const scopedAgent = (team: Team, role: string) => `pi-team.${team.preset}-${role}.team-${team.id}`;
function registerRoleAgents(pi: ExtensionAPI, team: Team, presets: Presets) {
  const active = new Map<string, Registration>();
  const dispose = () => { for (const registration of active.values()) registration.dispose(); active.clear(); };
  pi.on('session_start', () => {
    try {
      for (const [role, item] of Object.entries(presets[team.preset])) {
        if (role === 'orchestrator' || (role === 'image' && imageDisabled())) continue;
        const request: { version: 1; name: string; definition: object; result?: { ok: true; registration: Registration } | { ok: false; error: Error } } = {
          version: 1, name: scopedAgent(team, role), definition: roleAgent(team.preset, role, item),
        };
        pi.events.emit('pi-subagents:runtime-agent-register:v1', request);
        if (!request.result) throw new Error('pi-team requires the pi-subagents 0.90 runtime agent API.');
        if (!request.result.ok) throw request.result.error;
        active.set(role, request.result.registration);
      }
    } catch (e) { dispose(); throw e; }
  });
  pi.on('session_shutdown', dispose);
  return active;
}
function teamStatus(select?: string) {
  if (!select) return teams().map(t => {
    const info = status(t);
    return { id: t.id, preset: t.preset, state: info.state, worktree: t.worktree, branch: t.branch, workspace: t.workspace, diff: info.diff,
      members: info.rows.length, messages: info.sent.length };
  });
  const team = getTeam(select);
  const summary = findSummary(select);
  if (!team && !summary) throw new Error(`No team or summary found for ${select}.`);
  if (!team) return { summary };
  const info = status(team);
  return { team, state: info.state, lead: info.lead, members: info.rows, diff: info.diff, messages: info.sent.length, summary };
}
function registerMainLoader(pi: ExtensionAPI, refresh: () => void, targets: TeamTargets) {
  const hints = aliasHints(targets);
  const activation = hints
    ? `Only call when the user expressly asks you to create or manage a Pi team or to delegate work to a named team. Configured team aliases: ${hints}. Use team_delegate for named-team delegation even if the team already exists.`
    : 'Only call when the user expressly asks you to create or manage a Pi team.';
  const toolNames = ['team_start', 'team_status', 'team_send', 'team_delegate'];
  let installed = false;
  pi.on('session_shutdown', () => { installed = false; });
  pi.registerTool({ name: 'team_enable', label: 'Enable team tools',
    description: `${activation} Enables ${toolNames.join(', ')} without changing model or subagent tools.`, parameters: Type.Object({}),
    async execute() {
      if (!installed) {
        pi.registerTool({ name: 'team_start', label: 'Start team', description: 'Create a new Pi team from a preset or alias and give the user its interactive lead. Only when explicitly requested.',
          parameters: Type.Object({ preset: Type.String(), name: Type.Optional(Type.String()), base: Type.Optional(Type.String()), fromDirty: Type.Optional(Type.Boolean()), goal: Type.String() }),
          async execute(_id, p, _signal, _update, ctx) { const result = startNamed(ctx.cwd, targets, p); refresh(); return text(result); } });
        pi.registerTool({ name: 'team_status', label: 'Team status', description: 'Read active team registry or the selected team summary.', parameters: Type.Object({ team: Type.Optional(Type.String()) }),
          async execute(_id, p) { return text(JSON.stringify(teamStatus(p.team))); } });
        pi.registerTool({ name: 'team_send', label: 'Send to team lead', description: 'Send a direct message to an exact lead@<team> address. For assigning work to a named team, use team_delegate instead, even if you know its address.', parameters: sendParams,
          async execute(_id, p) { return text(JSON.stringify(send(undefined, p))); } });
        pi.registerTool({ name: 'team_delegate', label: 'Delegate to a team', description: 'Use this for every request to assign work to a named team, including follow-up assignments. Pass the alias key or natural-language name even if you know an existing team ID. This tool selects the current team or starts one. A bare preset starts a new team. Ask the user before using fromDirty. Relay any lead launch command to the user.',
          parameters: Type.Object({ team: Type.String(), task: Type.String(), fromDirty: Type.Optional(Type.Boolean({ default: false })) }),
          async execute(_id, p, _signal, _update, ctx) {
            const result = delegate(ctx.cwd, targets, p.team, p.task, p.fromDirty);
            refresh();
            return text(result);
          } });
        installed = true;
      }
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...toolNames])]);
      return text(`Enabled ${toolNames.join(', ')}.`);
    } });
}
function snapshots(pi: ExtensionAPI, team: Team) {
  let timer: NodeJS.Timeout | undefined;
  let cancelReply: (() => void) | undefined;
  let fleet: FleetEntry[] = [];
  let lastTick = 0;
  const publish = () => {
    if (!getTeam(team.id)) return;
    try { writeJson(join(teamDir(team.id), 'members.json'), { at: Date.now(), members: members(team.id), fleet }, false); }
    catch (e) { if (errorCode(e) !== 'ENOENT' || getTeam(team.id)) throw e; }
  };
  const tick = () => {
    const seq = ++lastTick;
    cancelReply?.();
    const requestId = randomUUID();
    cancelReply = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, value => {
      if (seq !== lastTick) return;
      const r = value as { success?: boolean; data?: { fleet?: { entries?: FleetEntry[] } } };
      if (r.success && Array.isArray(r.data?.fleet?.entries)) { fleet = r.data.fleet.entries; publish(); }
      cancelReply?.(); cancelReply = undefined;
    });
    pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'status', params: {} });
    publish();
  };
  pi.on('session_start', (_e, ctx) => {
    const safe = () => { try { tick(); } catch (e) { if (ctx.hasUI) ctx.ui.notify(String(e), 'warning'); else console.error(e); } };
    timer = setInterval(safe, 2000).unref();
    safe();
  });
  pi.on('session_shutdown', () => { clearInterval(timer); cancelReply?.(); });
}
function guardDelegation(pi: ExtensionAPI, team: Team, presets: Presets, active: Map<string, Registration>) {
  const pending = new Map<string, string>();
  pi.on('tool_call', e => {
    if (e.toolName !== 'subagent') return;
    const input = e.input as Record<string, unknown>;
    const block = (reason: string) => ({ block: true, reason });
    const options = input.options && typeof input.options === 'object' ? input.options : {};
    if (Object.hasOwn(input, 'model') || Object.hasOwn(options, 'model')) return block('Let the team role virtual model choose the physical model; do not pass model.');
    if (typeof input.action === 'string' && input.agent === undefined && ['guide', 'status', 'steer', 'interrupt', 'stop'].includes(input.action)) return;
    const prefix = `pi-team.${team.preset}-`;
    const agent = input.agent;
    let role = typeof agent === 'string' && agent.startsWith(prefix) ? agent.slice(prefix.length) : '';
    const suffix = `.team-${team.id}`;
    if (role.endsWith(suffix)) role = role.slice(0, -suffix.length);
    if (!role || role === 'orchestrator' || !Object.hasOwn(presets[team.preset], role)) return block(`Only ${prefix}<role> agents are permitted.`);
    if (role === 'image' && imageDisabled()) return block(`Image role disabled: ${imageDisabled()}`);
    if (input.action || ['workflow', 'args', 'cwd', 'worktree', 'runner', 'profile', 'machine', 'gate', 'tasks', 'chain', 'script', 'isolation', 'agentScope', 'extensions', 'subagentOnlyExtensions'].some(k => Object.hasOwn(input, k) || Object.hasOwn(options, k))) {
      return block('Run a direct team role in this worktree without alternate launch options.');
    }
    if (!active.has(role)) return block(`Team role ${role} is not registered in this session.`);
    const max = presets[team.preset][role].max;
    if (max && members(team.id).filter(m => m.role === role && isLive(m)).length + [...pending.values()].filter(r => r === role).length >= max) return block(`${role}: maximum ${max} concurrent members.`);
    pending.set(e.toolCallId, role);
    input.agent = scopedAgent(team, role);
  });
  pi.on('tool_result', e => { if (e.toolName === 'subagent') pending.delete(e.toolCallId); });
  pi.on('agent_settled', () => pending.clear());
}
export default async function piTeam(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === '1') return; // The required child extension owns member mode.
  const mode = process.env.PI_TEAM_ROLE;
  if (mode && mode !== 'lead') throw new Error(`Unsupported PI_TEAM_ROLE: ${mode}`);
  const id = mode ? process.env.PI_TEAM_ID : undefined;
  const team = id ? getTeam(id) : undefined;
  if (mode && !team) throw new Error(`No registered team for PI_TEAM_ID=${id ?? ''}.`);
  const cwd = team?.worktree ?? process.cwd();
  const configCwd = team ? cwd : (() => { try { return git(cwd, ['rev-parse', '--show-toplevel']); } catch { return cwd; } })();
  const presets = readPresets(configCwd, team?.id);
  const targets = team ? undefined : readTargets(configCwd, presets);
  const refresh = widget(pi);
  const panel = teamPanel(pi, team?.id);
  if (targets) {
    registerModels(pi, presets);
    registerMainLoader(pi, refresh, targets);
    generateAgents(presets);
  }
  let state: ParticipantRuntime | undefined;
  if (team) {
    if (realpathSync(process.cwd()) !== realpathSync(team.worktree)) throw new Error(`Launch the lead from its worktree: ${team.worktree}`);
    const required = await requiredExtensions();
    let registration: Registration | undefined;
    const orchestrator = presets[team.preset].orchestrator;
    pi.on('session_start', (_e, ctx) => {
      registration = required.registerRequiredChildExtensions({ sessionId: ctx.sessionManager.getSessionId(), extensions: [{ id: 'pi-team-member', path: childEntry }], requireForAllRunners: true });
    });
    pi.on('session_shutdown', () => { registration?.dispose(); registration = undefined; });
    state = participant(pi, team, () => 'orchestrator', true);
    const lead = state;
    registerModels(pi, presets, lead.routed);
    registerMailbox(pi, lead.owner, lead.update);
    snapshots(pi, team);
    guardDelegation(pi, team, presets, registerRoleAgents(pi, team, presets));
    if (orchestrator.tools || orchestrator.readOnly) pi.on('session_start', () => {
      const allowed = orchestrator.tools && new Set([...orchestrator.tools, 'subagents_enable', 'subagent', 'team_peers', 'team_send', 'team_inbox', 'team_wait', 'team_report']);
      const available = allowed ? pi.getAllTools().map(t => t.name).filter(t => allowed.has(t)) : pi.getActiveTools();
      pi.setActiveTools(available.filter(t => !orchestrator.readOnly || (t !== 'write' && t !== 'edit')));
    });
    if (orchestrator.readOnly) pi.on('tool_call', e => {
      if (e.toolName === 'write' || e.toolName === 'edit') return { block: true, reason: 'This orchestrator role is read-only.' };
    });
    pi.registerTool({ name: 'team_report', label: 'Team report', description: 'Save the team summary and gathered outcomes to summary.md. Use status done on completion.',
      parameters: Type.Object({ summary: Type.String(), status: Type.String() }),
      async execute(_id, p) { const path = report(team, p.summary, p.status); if (p.status === 'done') lead.update('done'); return text(path); } });
  }
  const show = (ctx: ExtensionContext, output: string) => { if (ctx.hasUI) ctx.ui.notify(output, 'info'); else process.stdout.write(`${output}\n`); };
  pi.registerCommand('team', { description: 'Start, inspect, message or close a Pi team', async handler(input, ctx) {
    try {
      const [, verb = '', args = ''] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim()) ?? [];
      if (verb === 'board') { try { await board(ctx, team?.id, state?.owner()); } finally { refresh(); } return; }
      if (verb === 'panel') return panel.command(args.trim(), ctx);
      if (verb === 'preset' && /^show(?:\s+\S+)?$/.test(args)) return show(ctx, presetView(team ? presets : readPresets(configCwd), ctx, args.split(/\s+/)[1]));
      if (verb === 'send') {
        const m = /^(\S+)\s+(?:--\s+)?([\s\S]+)$/.exec(args);
        if (!m) throw new Error('Usage: /team send <address> [--] <message>');
        if (team && !state?.owner()) throw new Error('Team lead is not registered.');
        return show(ctx, JSON.stringify(send(state?.owner(), { to: m[1], body: m[2] })));
      }
      if (verb === 'done' && team && state) {
        const summary = args || state.row()?.result || 'The lead marked this team done.';
        const path = report(team, summary, 'done'); state.update('done'); return show(ctx, path);
      }
      if (targets && verb === 'start') {
        const output = startNamed(ctx.cwd, targets, parseStart(args)); refresh(); return show(ctx, output);
      }
      if (targets && verb === 'delegate') {
        const { target, goal } = splitGoal(args, 'Usage: /team delegate <alias or preset> -- <task>');
        const output = delegate(ctx.cwd, targets, target, goal); refresh(); return show(ctx, output);
      }
      if (targets && verb === 'alias' && args === 'show') return show(ctx, showAliases(targets));
      if (!team && verb === 'close') {
        const [name, ...flags] = args.split(/\s+/);
        if (!name || flags.some(f => !['--confirm-lead', '--confirm-unmerged'].includes(f))) throw new Error('Usage: /team close <team> [--confirm-lead] [--confirm-unmerged]');
        const output = closeTeam(name, flags.includes('--confirm-lead'), flags.includes('--confirm-unmerged'));
        refresh(); return show(ctx, output);
      }
      if (!team && verb === 'collect') {
        const summary = findSummary(args);
        if (!summary) throw new Error(`No report for ${args}.`);
        pi.sendMessage({ customType: 'pi-team-summary', content: summary, display: true, details: { team: args } }, { deliverAs: 'nextTurn' });
        return show(ctx, `Queued ${args} summary for the next user turn (no model request).`);
      }
      show(ctx, `Usage: /team board | panel [on|off|reset] | preset show [preset] | send <address> <body>${team ? ' | done [summary]' : ' | start <preset or alias> [options] -- <goal> | delegate <alias or preset> -- <task> | alias show | collect <team> | close <team>'}`);
    } catch (e) { if (ctx.hasUI) ctx.ui.notify(e instanceof Error ? e.message : String(e), 'error'); else throw e; }
  } });
}
