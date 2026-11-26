import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { aliasHints, delegate, readTargets, resolveTarget, showAliases, startNamed, type TeamTargets } from './aliases.ts';
import { board, status, widget } from './board.ts';
import { closeTeam, findSummary, parseStart, report, retitle, roleList, splitGoal } from './lifecycle.ts';
import { registerMailbox, send, sendParams } from './mailbox.ts';
import { teamPanel } from './panel.ts';
import { herdrStatus } from './herdr-status.ts';
import { participant, type ParticipantRuntime } from './participant.ts';
import { authGaps, childEntry, generateAgents, imageDisabled, presetCatalog, presetView, readPresets, registerModels, roleAgent, type Presets } from './presets.ts';
import { mainMode } from './main.ts';
import { skillCatalog, skillSize } from './skills.ts';
import { backfillStats, loadStats, retroAsk, retroReport, roleSkills, statsReport, trackRun, writeRetro } from './stats.ts';
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
// Warn when a preset would not run on its first choices here, e.g. mix on a Claude-only host.
function gapNote(ctx: ExtensionContext, targets: TeamTargets, cwd: string, input: string) {
  try {
    const { preset } = resolveTarget(targets, input);
    const gaps = authGaps(readPresets(cwd)[preset] ?? {}, ctx.modelRegistry);
    return gaps.length ? `\nNote: on this host ${preset} is not on its first choice for ${gaps.join(', ')}. A preset for the signed-in accounts (for example claude or codex) avoids that.` : '';
  } catch { return ''; }
}
function registerMainLoader(pi: ExtensionAPI, refresh: () => void, targets: TeamTargets, cwd: string) {
  const hints = aliasHints(targets);
  const activation = hints
    ? `Only call when the user expressly asks you to create or manage a Pi team or to delegate work to a named team. Configured team aliases: ${hints}. Use team_delegate for named-team delegation even if the team already exists.`
    : 'Only call when the user expressly asks you to create or manage a Pi team.';
  const toolNames = ['team_start', 'team_status', 'team_send', 'team_delegate'];
  // People tell teams apart by title; the name only becomes the branch and address.
  const title = Type.Optional(Type.String({ description: 'Short title of the work for the panel, board and Herdr, in the user\'s language, about 15-40 characters, e.g. "폴더블 시뮬레이터 동작 검증". Always give one for a new team.' }));
  const name = Type.Optional(Type.String({ description: 'Team ID for the branch and addresses: 2-4 English words, e.g. foldable-sim-check (lowercased and hyphenated, at most 32 characters). Always give one for a new team unless you name an alias.' }));
  let installed = false;
  pi.on('session_shutdown', () => { installed = false; });
  pi.registerTool({ name: 'team_enable', label: 'Enable team tools',
    description: `${activation} Enables ${toolNames.join(', ')} without changing model or subagent tools.`, parameters: Type.Object({}),
    async execute() {
      if (!installed) {
        pi.registerTool({ name: 'team_start', label: 'Start team', description: 'Create a new Pi team from a preset or alias and give the user its interactive lead. Only when explicitly requested.',
          parameters: Type.Object({ preset: Type.String(), title, name, base: Type.Optional(Type.String()), fromDirty: Type.Optional(Type.Boolean()), goal: Type.String(), icon: Type.Optional(Type.String({ description: 'One emoji that identifies the team, if the user asked for one.' })) }),
          async execute(_id, p, _signal, _update, ctx) { const result = startNamed(ctx.cwd, targets, p); refresh(); return text(result + gapNote(ctx, targets, cwd, p.preset)); } });
        pi.registerTool({ name: 'team_status', label: 'Team status', description: 'Read active team registry or the selected team summary.', parameters: Type.Object({ team: Type.Optional(Type.String()) }),
          async execute(_id, p) { return text(JSON.stringify(teamStatus(p.team))); } });
        pi.registerTool({ name: 'team_send', label: 'Send to team lead', description: 'Send a direct message to an exact lead@<team> address. For assigning work to a named team, use team_delegate instead, even if you know its address.', parameters: sendParams,
          async execute(_id, p) { return text(JSON.stringify(send(undefined, p))); } });
        pi.registerTool({ name: 'team_delegate', label: 'Delegate to a team', description: 'Use this for every request to assign work to a named team, including follow-up assignments. Pass the alias key or natural-language name even if you know an existing team ID. This tool selects the current team or starts one. A bare preset starts a new team. Ask the user before using fromDirty. Relay any lead launch command to the user.',
          parameters: Type.Object({ team: Type.String(), task: Type.String(), title, name, fromDirty: Type.Optional(Type.Boolean({ default: false })) }),
          async execute(_id, p, _signal, _update, ctx) {
            const result = delegate(ctx.cwd, targets, p.team, p.task, p.fromDirty, { title: p.title, name: p.name });
            refresh();
            return text(result + gapNote(ctx, targets, cwd, p.team));
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
    if (typeof input.action === 'string' && input.agent === undefined && ['guide', 'status', 'children.list', 'steer', 'interrupt', 'stop'].includes(input.action)) return;
    // A resumed child keeps its team agent, model, tools and worktree; the member extension checks them again.
    if (input.action === 'resume' && input.agent === undefined) {
      if (['agent', 'model', 'cwd', 'worktree', 'runner', 'profile', 'machine', 'tasks', 'chain', 'script', 'extensions', 'subagentOnlyExtensions'].some(k => Object.hasOwn(input, k) || Object.hasOwn(options, k))) return block('Resume a team member with only its run id and a message.');
      return;
    }
    const prefix = `pi-team.${team.preset}-`;
    const agent = input.agent;
    let role = typeof agent === 'string' && agent.startsWith(prefix) ? agent.slice(prefix.length) : '';
    const suffix = `.team-${team.id}`;
    if (role.endsWith(suffix)) role = role.slice(0, -suffix.length);
    if (!role || role === 'orchestrator' || !Object.hasOwn(presets[team.preset], role)) return block(`Unknown team agent ${String(agent)}. Use one of: ${roleList(presets, team.preset).join(', ')}.`);
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
  const main = targets ? mainMode(pi, () => readPresets(configCwd), configCwd) : undefined;
  if (targets) {
    registerModels(pi, presets, undefined, { skipOrchestrator: true });
    registerMainLoader(pi, refresh, targets, configCwd);
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
    trackRun(pi, team, lead.row);
    registerModels(pi, presets, lead.routed);
    registerMailbox(pi, lead.owner, lead.update);
    snapshots(pi, team);
    herdrStatus(pi, team);
    guardDelegation(pi, team, presets, registerRoleAgents(pi, team, presets));
    if (orchestrator.tools || orchestrator.readOnly) pi.on('session_start', () => {
      const allowed = orchestrator.tools && new Set([...orchestrator.tools, 'subagents_enable', 'subagent', 'team_peers', 'team_send', 'team_inbox', 'team_wait', 'team_report', 'team_skills']);
      const available = allowed ? pi.getAllTools().map(t => t.name).filter(t => allowed.has(t)) : pi.getActiveTools();
      pi.setActiveTools(available.filter(t => !orchestrator.readOnly || (t !== 'write' && t !== 'edit')));
    });
    if (orchestrator.readOnly) pi.on('tool_call', e => {
      if (e.toolName === 'write' || e.toolName === 'edit') return { block: true, reason: 'This orchestrator role is read-only.' };
    });
    // Compact the lead while it waits rather than re-reading a huge context on every later turn.
    // Context usage keeps the last response's size until a new response arrives, so judge again only
    // after a turn has finished since the previous compaction.
    const compactAt = Number(process.env.PI_TEAM_LEAD_COMPACT_TOKENS ?? 200_000);
    let compacting = false;
    let fresh = true;
    if (compactAt > 0) {
      pi.on('turn_end', () => { fresh = true; });
      pi.on('agent_settled', (_e, ctx) => {
        const tokens = ctx.getContextUsage()?.tokens;
        if (compacting || !fresh || tokens == null || tokens < compactAt) return;
        compacting = true;
        fresh = false;
        ctx.compact({
          customInstructions: 'Keep the team goal and user instructions verbatim, every decision and user answer, each member key with its role, latest run id, state and latest result, open questions, commits, and file paths. Drop file contents, command output and image details already summarized.',
          onComplete: () => { compacting = false; },
          onError: e => { compacting = false; if (ctx.hasUI && !/nothing to compact/i.test(e.message)) ctx.ui.notify(`pi-team: lead compaction failed: ${e.message}`, 'warning'); },
        });
      });
    }
    // Installed skills only: no network and no installs while a team runs.
    pi.registerTool({ name: 'team_skills', label: 'Team skills',
      description: 'Search installed skills to give a member extra ones. Shows each match with its size and how often members of a role read it. Pass role to see that role\'s default skills.',
      parameters: Type.Object({ query: Type.Optional(Type.String()), role: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })) }),
      async execute(_id, p) {
        const roles = presets[team.preset];
        if (p.role && (!Object.hasOwn(roles, p.role) || p.role === 'orchestrator')) throw new Error(`Unknown role ${p.role}. Use one of: ${Object.keys(roles).filter(r => r !== 'orchestrator').join(', ')}.`);
        const stats = loadStats();
        const usage = p.role ? new Map(roleSkills(stats, p.role).uses.map(u => [u.name, u])) : undefined;
        const words = (p.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const matches = skillCatalog(team.worktree).filter(s => words.every(w => `${s.name} ${s.description}`.toLowerCase().includes(w)));
        const lines = matches.slice(0, p.limit ?? 15).map(s => {
          const u = usage?.get(s.name);
          return `- ${s.name} (${Math.round(skillSize(s) / 1000)}k chars${u ? `; ${p.role} read it in ${u.read} of ${Math.max(u.listed, u.read)} runs` : ''}): ${s.description.replace(/\s+/g, ' ').slice(0, 220)}`;
        });
        const defaults = p.role ? roles[p.role].skills ?? [] : undefined;
        return text([
          ...(defaults ? [`${p.role} default skills: ${defaults.length ? defaults.join(', ') : 'none'}`] : []),
          `${matches.length} installed skills match${matches.length > lines.length ? ` (showing ${lines.length})` : ''}.`, ...lines,
          'To add skills for one member, pass subagent skill: [default skills..., extra skills...]; the list replaces the role defaults. Every listed skill costs its description on each turn and its body once read, so add only what this task needs.',
        ].join('\n'));
      } });
    pi.registerTool({ name: 'team_report', label: 'Team report', description: 'Save the team summary and gathered outcomes to summary.md. Use status done on completion.',
      parameters: Type.Object({ summary: Type.String(), status: Type.String() }),
      async execute(_id, p) {
        const path = report(team, p.summary, p.status);
        if (p.status !== 'done') return text(path);
        lead.update('done');
        // A retrospective draft from the run records; the lead turns only lasting patterns into lessons.
        const retro = retroReport(team.id);
        writeRetro(team.id, retro);
        return text([path, '', retro, '', retroAsk].join('\n'));
      } });
  }
  const show = (ctx: ExtensionContext, output: string) => { if (ctx.hasUI) ctx.ui.notify(output, 'info'); else process.stdout.write(`${output}\n`); };
  pi.registerCommand('team', { description: 'Start, inspect, message or close a Pi team', async handler(input, ctx) {
    try {
      const [, verb = '', args = ''] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim()) ?? [];
      if (verb === 'board') { try { await board(ctx, team?.id, state?.owner()); } finally { refresh(); } return; }
      if (verb === 'panel') return panel.command(args.trim(), ctx);
      if (verb === 'stats' && /^import(\s+--dry-run)?$/.test(args.trim())) return show(ctx, backfillStats(args.includes('--dry-run')));
      if (verb === 'stats' && /^retro\s+\S+$/.test(args.trim())) return show(ctx, retroReport(args.trim().split(/\s+/)[1]));
      if (verb === 'stats') return show(ctx, statsReport(loadStats(), args.trim() || undefined));
      if (verb === 'preset' && /^show(?:\s+\S+)?$/.test(args)) {
        const catalog = team ? { presets, descriptions: {}, problems: {} } : presetCatalog(configCwd);
        return show(ctx, presetView(catalog.presets, ctx, args.split(/\s+/)[1], catalog));
      }
      if (main && verb === 'main') return show(ctx, await main.command(args, ctx));
      if (verb === 'title') {
        // A lead retitles its own team; the main session names the team first.
        const m = team ? /^([\s\S]+)$/.exec(args.trim()) : /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
        if (!m) throw new Error(team ? 'Usage: /team title <title>' : 'Usage: /team title <team> <title>');
        const output = team ? retitle(team.id, m[1]) : retitle(m[1], m[2]);
        refresh(); return show(ctx, output);
      }
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
        const parsed = parseStart(args);
        const output = startNamed(ctx.cwd, targets, parsed); refresh(); return show(ctx, output + gapNote(ctx, targets, configCwd, parsed.preset));
      }
      if (targets && verb === 'delegate') {
        const { target, goal } = splitGoal(args, 'Usage: /team delegate <alias or preset> -- <task>');
        const output = delegate(ctx.cwd, targets, target, goal); refresh(); return show(ctx, output + gapNote(ctx, targets, configCwd, target));
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
      show(ctx, `Usage: /team board | panel [on|off|reset] | stats [role|import|retro <team>] | preset show [preset] | send <address> <body>${team ? ' | title <title> | done [summary]' : ' | title <team> <title> | main [preset|off] [--default] | start <preset or alias> [options] -- <goal> | delegate <alias or preset> -- <task> | alias show | collect <team> | close <team>'}`);
    } catch (e) { if (ctx.hasUI) ctx.ui.notify(e instanceof Error ? e.message : String(e), 'error'); else throw e; }
  } });
}
