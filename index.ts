import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { aliasHints, delegate, readTargets, resolveTarget, showAliases, startNamed, type TeamTargets } from './aliases.ts';
import { board, status, widget } from './board.ts';
import { cacheRetention, closeGuide, closePlan, closeTeam, findSummary, memberCacheRetention, parseStart, refreshLeadPrompt, relaunchAsLead, report, resumeLead, retitle, roleList, splitGoal, syncHerdrLabel } from './lifecycle.ts';
import { applyMainCache, cacheNotice, cacheReport, shellCache } from './cache.ts';
import { ago, cachedUsage, diskUsage, measure, removeRebuildable, size, staleTeams, usageLine } from './disk.ts';
import { registerMailbox, send, sendParams } from './mailbox.ts';
import { teamPanel } from './panel.ts';
import { herdrStatus } from './herdr-status.ts';
import { participant, type ParticipantRuntime } from './participant.ts';
import { authGaps, candidates, childEntry, generateAgents, imageDisabled, presetCatalog, presetView, readPresets, registerModels, roleAgent, type Presets } from './presets.ts';
import { mainMode } from './main.ts';
import { registerLeadRoute } from './lead-route.ts';
import { leadCompaction } from './compact.ts';
import { routeCommand, teamTarget, type RouteTarget } from './routing.ts';
import { routesView } from './routes-view.ts';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { repoSkills, skillCatalog, skillSize } from './skills.ts';
import { backfillStats, directWork, loadStats, retroAsk, retroReport, roleSkills, statsReport, trackRun, writeRetro } from './stats.ts';
import { errorCode, getLead, getTeam, git, isLive, members, scopedTeams, teamDir, teams, teamTitle, text, writeJson, type FleetEntry, type Team } from './registry.ts';

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
    // Read at each start, so skills the repository adds while the team runs reach members after /reload.
    const repo = repoSkills(team.worktree);
    try {
      for (const [role, item] of Object.entries(presets[team.preset])) {
        if (role === 'orchestrator' || (role === 'image' && imageDisabled())) continue;
        const request: { version: 1; name: string; definition: object; result?: { ok: true; registration: Registration } | { ok: false; error: Error } } = {
          version: 1, name: scopedAgent(team, role), definition: roleAgent(team.preset, role, item, 'team', repo),
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
// A lead that reads, builds or checks by itself pays for its whole context on every call: on
// 2026-11-26 a lead with a 250k context ran bash 247 times, 78% of its cost. Steer it back to
// delegating when it does that several times in a short while. The message is shown to the user too.
function watchDirectWork(pi: ExtensionAPI) {
  const limit = Number(process.env.PI_TEAM_LEAD_DIRECT_WARN ?? 6);
  if (!(limit > 0)) return;
  const window = 10 * 60_000;
  const quiet = 30 * 60_000;
  let calls: { at: number; tool: string }[] = [];
  let warnedAt = 0;
  pi.on('tool_execution_start', (e, ctx) => {
    if (!directWork(e.toolName, e.args)) return;
    const now = Date.now();
    calls = [...calls.filter(c => now - c.at < window), { at: now, tool: e.toolName }];
    if (calls.length < limit || now - warnedAt < quiet) return;
    warnedAt = now;
    const counts = calls.reduce<Record<string, number>>((m, c) => (m[c.tool] = (m[c.tool] ?? 0) + 1, m), {});
    const tokens = ctx.getContextUsage()?.tokens;
    pi.sendMessage({ customType: 'pi-team-lean', display: true, details: { counts },
      content: `pi-team: you ran ${calls.length} tool calls yourself in the last 10 minutes (${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')})${tokens ? ` with a ${Math.round(tokens / 1000)}k-token context that every call re-reads` : ''}. Hand reading, searching, builds, tests and checks to a member (scout, reviewer, qa-tester) or resume the member that did the last round, and work from its summary.` },
    { deliverAs: 'steer' });
    calls = [];
  });
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
  const toolNames = ['team_start', 'team_status', 'team_send', 'team_delegate', 'team_close'];
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
        // Closing removes a worktree and maybe a branch, so the user confirms every call in a dialog.
        pi.registerTool({ name: 'team_close', label: 'Close team',
          description: 'Close a team the user asked you to close: archive its record and artifacts/, remove its worktree and delete its branch if merged. The user confirms in a dialog. confirmLead closes while the lead still runs, confirmUnmerged removes the worktree of an unmerged branch (the branch stays), keepWorktree archives the team but keeps the worktree and branch for the repository\'s own cleanup. Only when the user expressly asks; never to tidy up on your own.',
          parameters: Type.Object({ team: Type.String(), confirmLead: Type.Optional(Type.Boolean()), confirmUnmerged: Type.Optional(Type.Boolean()), keepWorktree: Type.Optional(Type.Boolean()) }),
          async execute(_id, p, _signal, _update, ctx) {
            if (!ctx.hasUI) throw new Error(`Closing needs the user's confirmation in interactive pi. Ask the user to run /team close ${p.team}.`);
            const flags = [p.confirmLead && '--confirm-lead', p.confirmUnmerged && '--confirm-unmerged', p.keepWorktree && '--keep-worktree'].filter(Boolean).join(' ');
            const ok = await ctx.ui.confirm(`Close team ${p.team}${flags ? ` (${flags})` : ''}?`, closePlan(p.team, !!p.keepWorktree));
            if (!ok) return text(`The user declined; team ${p.team} is still open.`);
            const result = closeTeam(p.team, !!p.confirmLead, !!p.confirmUnmerged, !!p.keepWorktree);
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
// Notes for a session that is not a lead.
// - A plain `pi` in a team's worktree, or one that resumed the lead's session file, looks like the
//   lead but runs as a main session: no lead.json, mail, lead prompt or team stats, and its
//   pi-team.<role> agents are not team members. That is how a restarted lead went unnoticed.
// - On startup, open teams whose lead has been gone for a day, the ones that fill disks unnoticed.
// The team whose lead session file this is, when that lead is not running.
export function leadSessionOf(file?: string) {
  if (!file) return undefined;
  return teams().find(t => { const lead = getLead(t.id); return lead?.sessionFile === file && !(isLive(lead) && lead.state !== 'stopped'); });
}
export function startNotes(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>, reason: string): [string, 'warning' | 'info'][] {
  const notes: [string, 'warning' | 'info'][] = [];
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const cwd = real(ctx.cwd);
  const file = ctx.sessionManager.getSessionFile();
  const all = teams();
  const own = all.find(t => real(t.worktree) === cwd || (file && getLead(t.id)?.sessionFile === file));
  if (own) notes.push([`pi-team: this session is in team ${own.id}'s ${real(own.worktree) === cwd ? 'worktree' : 'lead session'} but is not running as its lead, so team mail, the lead prompt and team records are off, and pi-team.<role> agents here are not team members. Exit, then run /team resume ${own.id} from the main session.`, 'warning']);
  if (reason !== 'startup' || own) return notes;
  const stale = staleTeams();
  for (const { team } of stale) diskUsage(team); // refresh sizes in the background for the board
  if (stale.length) notes.push([`pi-team: ${stale.length} open team${stale.length === 1 ? ' has' : 's have'} had no lead for over a day:\n${stale.map(({ team, offline }) => {
    const u = cachedUsage(team.id);
    return `- ${team.id} (offline ${ago(offline)}${u ? `, ${usageLine(u)}` : ''})`;
  }).join('\n')}\nResume with /team resume <team>, free builds with /team clean <team>, or finish with /team close <team>.`, 'warning']);
  return notes;
}
const closeFlags = ['--confirm-lead', '--confirm-unmerged', '--keep-worktree'];
// Completions for /team: the subcommand, then team IDs, presets or fixed words where an argument takes one.
const leadVerbs = ['board', 'panel', 'routes', 'effort', 'model', 'preset', 'stats', 'send', 'title', 'done', 'clean', 'cache', 'close'];
const mainVerbs = ['board', 'panel', 'routes', 'effort', 'model', 'preset', 'stats', 'send', 'title', 'clean', 'cache', 'main', 'start', 'delegate', 'alias', 'collect', 'resume', 'close'];
export function teamCompletions(prefix: string, lead: boolean, cwd: string): AutocompleteItem[] | null {
  const words = prefix.split(/\s+/);
  const last = words.pop() ?? '';
  const done = words.join(' ');
  const pick = (values: string[]) => {
    const items = [...new Set(values)].filter(v => v.startsWith(last)).map(v => ({ value: done ? `${done} ${v}` : v, label: v }));
    return items.length ? items : null;
  };
  try {
    if (!words.length) return pick(lead ? leadVerbs : mainVerbs);
    const [verb] = words;
    const ids = () => teams().map(t => t.id);
    const presetNames = () => Object.keys(presetCatalog(cwd).presets);
    if (words.length === 1) {
      if (['close', 'resume', 'collect', 'clean', 'title'].includes(verb) && !(lead && verb !== 'clean')) return pick(ids());
      if (verb === 'panel') return pick(['on', 'off', 'reset']);
      if (verb === 'preset') return pick(['show', 'use', 'reset']);
      if (verb === 'main') return pick([...presetNames(), 'off']);
      if (verb === 'start' || verb === 'delegate') return pick(presetNames());
      if (verb === 'stats') return pick(['import', 'retro']);
      if (verb === 'alias') return pick(['show']);
    }
    if (verb === 'close' && words.length >= 2) return pick(closeFlags.filter(f => !words.includes(f)));
    if (verb === 'preset' && words.length === 2 && ['show', 'use'].includes(words[1])) return pick(presetNames());
    if (verb === 'stats' && words.length === 2 && words[1] === 'retro') return pick(ids());
  } catch { /* completions are a convenience */ }
  return null;
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
  const refresh = widget(pi, { mainPreset: () => main?.preset(), onClick: ctx => panel.toggle(ctx) });
  const panel = teamPanel(pi, team?.id);
  const main = targets ? mainMode(pi, () => readPresets(configCwd), configCwd) : undefined;
  // Main mode restores its preset in its own session_start, which runs before this one.
  if (main) pi.on('session_start', () => refresh());
  if (targets) {
    registerModels(pi, presets, undefined, { skipOrchestrator: true });
    registerMainLoader(pi, refresh, targets, configCwd);
    generateAgents(presets);
  }
  if (!team) applyMainCache();
  if (!team) pi.on('session_start', async (event, ctx) => {
    const restored = leadSessionOf(ctx.sessionManager.getSessionFile());
    if (restored) {
      // pi-ai reads PI_CACHE_RETENTION on every request, so this keeps the lead's large context on the
      // 1-hour cache even if the user stays in this session.
      // The shell's values win; main.json's (main sessions only) must not apply to a lead's conversation.
      if (!shellCache.lead) process.env.PI_CACHE_RETENTION = cacheRetention();
      if (!shellCache.member) process.env.PI_SUBAGENT_CACHE_RETENTION = memberCacheRetention();
      const pane = process.env.HERDR_PANE_ID;
      if (ctx.hasUI && pane && process.env.HERDR_ENV === '1') {
        const ok = await ctx.ui.confirm(`Restart as the lead of ${restored.id}?`,
          `This is the lead session of team ${restored.id} ("${teamTitle(restored)}"), opened without the team settings, as Herdr does when it restores panes. It runs as a plain session: no team mail or lead prompt, no lead compaction, and members do not belong to the team.\nYes: pi exits and the lead starts again on this session in this pane with the team settings.`);
        if (ok) {
          try { relaunchAsLead(restored.id, pane); ctx.ui.notify(`pi-team: restarting as the lead of ${restored.id}...`, 'info'); ctx.shutdown(); return; }
          catch (e) { ctx.ui.notify(`pi-team: could not restart as the lead: ${e instanceof Error ? e.message : String(e)}`, 'error'); }
        }
      }
    }
    if (ctx.hasUI) for (const [text, level] of startNotes(ctx, event.reason)) ctx.ui.notify(text, level);
    if (ctx.hasUI && !restored && event.reason === 'startup') { const note = cacheNotice(); if (note) ctx.ui.notify(note, 'info'); }
  });
  let state: ParticipantRuntime | undefined;
  let leadLevelRef: (() => ThinkingLevel | undefined) | undefined;
  if (team) {
    if (realpathSync(process.cwd()) !== realpathSync(team.worktree)) throw new Error(`Launch the lead from its worktree: ${team.worktree}`);
    // pi reads the --append-system-prompt file after extensions load, so a team made by older code
    // gets the current lead guidance on this very launch.
    let promptNote = '';
    try { if (refreshLeadPrompt(team, presets)) promptNote = 'pi-team: updated this team\'s lead prompt to the current guidance.'; }
    catch (e) { promptNote = `pi-team: could not update the lead prompt: ${e instanceof Error ? e.message : String(e)}`; }
    if (promptNote) pi.on('session_start', (_e, ctx) => { if (ctx.hasUI) ctx.ui.notify(promptNote, promptNote.includes('could not') ? 'warning' : 'info'); });
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
    // The lead starts at its first candidate's effort; if the user then picks another thinking level,
    // the router follows it (see registerModels), so the orchestrator's effort can change for a while.
    let leadLevel: ThinkingLevel | undefined;
    // A resumed session also starts with reason "startup", so the first pick is kept as a session entry
    // and the user's later choice is not overwritten.
    pi.on('session_start', (_event, ctx) => {
      const saved = (ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: { level?: ThinkingLevel } }[])
        .findLast(e => e.type === 'custom' && e.customType === 'pi-team-lead-level')?.data?.level;
      if (saved) { leadLevel = saved; return; }
      const ready = candidates(orchestrator.models, ctx.modelRegistry);
      leadLevel = (ready.find(c => c.until <= Date.now()) ?? ready[0])?.level;
      if (!leadLevel) return;
      pi.setThinkingLevel(leadLevel);
      pi.appendEntry('pi-team-lead-level', { level: leadLevel });
    });
    leadLevelRef = () => leadLevel;
    registerLeadRoute(pi, team, () => leadLevel);
    registerModels(pi, presets, lead.routed, { leadLevel: () => leadLevel });
    leadCompaction(pi, Number(process.env.PI_TEAM_LEAD_COMPACT_TOKENS ?? 200_000));
    watchDirectWork(pi);
    registerMailbox(pi, lead.owner, lead.update);
    snapshots(pi, team);
    herdrStatus(pi, team);
    pi.on('session_start', () => { try { syncHerdrLabel(getTeam(team.id) ?? team); } catch { /* display only */ } });
    guardDelegation(pi, team, presets, registerRoleAgents(pi, team, presets));
    if (orchestrator.tools || orchestrator.readOnly) pi.on('session_start', () => {
      const allowed = orchestrator.tools && new Set([...orchestrator.tools, 'subagents_enable', 'subagent', 'team_peers', 'team_send', 'team_inbox', 'team_wait', 'team_report', 'team_skills', 'team_route']);
      const available = allowed ? pi.getAllTools().map(t => t.name).filter(t => allowed.has(t)) : pi.getActiveTools();
      pi.setActiveTools(available.filter(t => !orchestrator.readOnly || (t !== 'write' && t !== 'edit')));
    });
    if (orchestrator.readOnly) pi.on('tool_call', e => {
      if (e.toolName === 'write' || e.toolName === 'edit') return { block: true, reason: 'This orchestrator role is read-only.' };
    });
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
        const defaults = p.role ? [...new Set([...(roles[p.role].skills ?? []), ...repoSkills(team.worktree).names])] : undefined;
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
        return text([path, '', retro, '', retroAsk, `- ${closeGuide(team.id)}`].join('\n'));
      } });
  }
  const show = (ctx: ExtensionContext, output: string) => { if (ctx.hasUI) ctx.ui.notify(output, 'info'); else process.stdout.write(`${output}\n`); };
  pi.registerCommand('team', { description: 'Start, inspect, message or close a Pi team',
    getArgumentCompletions: prefix => teamCompletions(prefix, !!team, configCwd),
    async handler(input, ctx) {
    try {
      const [, verb = '', args = ''] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim()) ?? [];
      if (verb === 'board') {
        // In a lead, a reply to its own team is the user's next message to it: steer a running turn.
        const own = team ? (body: string) => { if (ctx.isIdle()) pi.sendUserMessage(body); else pi.sendUserMessage(body, { deliverAs: 'steer' }); } : undefined;
        try { await board(ctx, team?.id, state?.owner(), own); } finally { refresh(); }
        return;
      }
      if (verb === 'panel') return panel.command(args.trim(), ctx);
      if (verb === 'stats' && /^import(\s+--dry-run)?$/.test(args.trim())) return show(ctx, backfillStats(args.includes('--dry-run')));
      if (verb === 'stats' && /^retro\s+\S+$/.test(args.trim())) return show(ctx, retroReport(args.trim().split(/\s+/)[1]));
      if (verb === 'stats') return show(ctx, statsReport(loadStats(), args.trim() || undefined));
      if (verb === 'preset' && /^show(?:\s+\S+)?$/.test(args)) {
        const catalog = team ? { presets, descriptions: {}, problems: {} } : presetCatalog(configCwd);
        return show(ctx, presetView(catalog.presets, ctx, args.split(/\s+/)[1], catalog));
      }
      if (main && verb === 'main') { const output = await main.command(args, ctx); refresh(); return show(ctx, output); }
      if (verb === 'effort' || verb === 'model' || verb === 'routes' || (verb === 'preset' && /^(?:use|reset)\b/.test(args))) {
        const target = (id?: string) => {
          if (team && (!id || id === team.id)) return teamTarget(team.id, true);
          if (id) return teamTarget(id);
          const t = main?.target(configCwd);
          if (!t) throw new Error('Name a team with --team <id>, or turn on main mode with /team main <preset>.');
          return { ...t, current: main!.current(ctx) };
        };
        // Interactive /team routes opens the overlay; --text (or print mode) prints the table.
        if (verb === 'routes' && ctx.hasUI && !/(?:^|\s)--text(?:\s|$)/.test(args)) {
          const want = /--team\s+(\S+)/.exec(args)?.[1];
          const list = (): RouteTarget[] => {
            if (team) return [teamTarget(team.id, true)];
            const own = main?.target(configCwd);
            const ids = teams().map(t => t.id).sort((a, b) => Number(b === want) - Number(a === want));
            return [...(own && !want ? [{ ...own, current: main!.current(ctx) }] : []), ...ids.map(id => teamTarget(id)), ...(own && want ? [{ ...own, current: main!.current(ctx) }] : [])];
          };
          await routesView(pi, ctx, list, leadLevelRef);
          return;
        }
        return show(ctx, await routeCommand(pi, ctx, verb, args.replace(/(?:^|\s)--text(?=\s|$)/, ' '), target, leadLevelRef));
      }
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
      if (team && verb === 'close') {
        return show(ctx, `This is the lead pane of ${team.id}; a team is closed from the main session (a pi in the repository without this team): /team close ${team.id} [--confirm-lead] [--confirm-unmerged] [--keep-worktree]. Use --confirm-lead while this lead still runs.`);
      }
      if (!team && verb === 'close') {
        const [name, ...flags] = args.split(/\s+/).filter(Boolean);
        if (!name || flags.some(f => !closeFlags.includes(f))) throw new Error('Usage: /team close <team> [--confirm-lead] [--confirm-unmerged] [--keep-worktree]');
        const output = closeTeam(name, flags.includes('--confirm-lead'), flags.includes('--confirm-unmerged'), flags.includes('--keep-worktree'));
        refresh(); return show(ctx, output);
      }
      if (!team && verb === 'resume') {
        const id = args.trim();
        if (!id || /\s/.test(id)) throw new Error('Usage: /team resume <team>');
        const output = resumeLead(id); refresh(); return show(ctx, output);
      }
      if (verb === 'cache' && !args.trim()) return show(ctx, cacheReport(ctx.sessionManager.getSessionFile(), team ? [team] : scopedTeams(ctx.cwd).here));
      if (verb === 'clean') {
        const words = args.split(/\s+/).filter(Boolean);
        const yes = words.includes('--yes');
        const id = words.find(w => w !== '--yes') ?? team?.id;
        if (!id || words.filter(w => w !== '--yes').length > 1) throw new Error('Usage: /team clean <team> [--yes]');
        const target = getTeam(id);
        if (!target) throw new Error(`Unknown team: ${id}`);
        // A running member may be in the middle of a build that writes to these folders.
        const busy = members(id).filter(m => isLive(m) && m.state === 'working');
        if (busy.length) throw new Error(`Members are working (${busy.map(m => m.key).join(', ')}); clean after they finish.`);
        const before = measure(target);
        if (!before.dirs.length) return show(ctx, `${id}: ${usageLine(before)}; no rebuildable folders to remove.`);
        const list = before.dirs.map(d => `- ${d.path}  ${size(d.kb)}`).join('\n');
        const lead = getLead(id);
        const warn = isLive(lead) && lead!.state === 'working' ? '\nThe lead is working; a build it started may fail.' : '';
        const ok = yes || (ctx.hasUI && await ctx.ui.confirm(`Remove ${size(before.rebuildableKb)} of rebuildable folders from ${id}?`, `${list}${warn}\nThey are recreated by the next build. Source, config and artifacts/ stay.`));
        if (!ok) return show(ctx, `${id}: ${usageLine(before)}. Rebuildable folders:\n${list}\nNothing removed${ctx.hasUI ? '' : '; add --yes to remove them'}.`);
        const after = removeRebuildable(target, before.dirs);
        return show(ctx, `${id}: removed ${before.dirs.length} folder${before.dirs.length === 1 ? '' : 's'}, freed ${size(Math.max(0, before.totalKb - after.totalKb))}; ${usageLine(after)}.`);
      }
      if (!team && verb === 'collect') {
        const summary = findSummary(args);
        if (!summary) throw new Error(`No report for ${args}.`);
        pi.sendMessage({ customType: 'pi-team-summary', content: summary, display: true, details: { team: args } }, { deliverAs: 'nextTurn' });
        return show(ctx, `Queued ${args} summary for the next user turn (no model request).`);
      }
      show(ctx, `Usage: /team board | panel [on|off|reset] | stats [role|import|retro <team>] | preset show [preset] | preset use <preset>|reset [--team <id>] | send <address> <body> | routes | effort <role|all> <level|reset> | model <role|all> <model|reset> [--team <id>] | clean [team] [--yes] | cache${team ? ' | title <title> | done [summary]' : ' | title <team> <title> | main [preset|off] [--default] | start <preset or alias> [options] -- <goal> | delegate <alias or preset> -- <task> | alias show | collect <team> | resume <team> | close <team> [--confirm-lead] [--confirm-unmerged] [--keep-worktree]'}`);
    } catch (e) { if (ctx.hasUI) ctx.ui.notify(e instanceof Error ? e.message : String(e), 'error'); else throw e; }
  } });
}
