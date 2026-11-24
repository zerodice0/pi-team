import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { join, relative, resolve } from 'node:path';
import { diffStat, errorCode, getLead, getTeam, isLive, locked, members, mkdir, root, teamDir, writeJson, type Participant, type Team } from './registry.ts';
import { recordFailure } from './presets.ts';

export interface ParticipantRuntime {
  row(): Participant | undefined;
  owner(): { team: string; key: string } | undefined;
  update(state: Participant['state']): void;
  routed(model: string, didFallback: boolean): void;
}

export function participant(pi: ExtensionAPI, team: Team, role: () => string | undefined, lead = false, maxForRole?: (role: string) => number | undefined): ParticipantRuntime {
  let row: Participant | undefined;
  let path: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let terminal: AssistantMessage | undefined;
  let failure: AssistantMessage | undefined;
  let lastModel: string | undefined;
  let fallback: boolean | undefined;
  let stopped = false;
  let finished = false;
  const activeTools = new Map<string, { tool: string; path?: string }>();
  const persist = () => {
    if (!row || !path) return;
    row.at = Date.now();
    try { writeJson(path, row, false); } catch (e) { if (errorCode(e) !== 'ENOENT' || getTeam(team.id)) throw e; }
  };
  const update = (state: Participant['state']) => {
    if (!row || stopped) return;
    if (state === 'done' && lead) finished = true;
    if (state === 'waiting') row.waitSince ??= Date.now(); else row.waitSince = undefined;
    row.state = state;
    persist();
  };
  const routed = (model: string, didFallback: boolean) => {
    lastModel = model; fallback = didFallback;
    if (row) { row.model = model; row.fallback = didFallback; persist(); }
  };
  const diff = () => {
    if (!row || !lead) return;
    try { row.diff = diffStat(team.worktree, team.baseCommit); }
    catch (e) { row.diff = `unavailable: ${String(e)}`; }
  };
  pi.on('session_start', (_event, ctx) => {
    const partRole = role();
    if (!partRole) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    stopped = false;
    locked(join(root, `.participants-${team.id}.lock`), () => {
      if (!getTeam(team.id)) throw new Error(`Team ${team.id} is closed.`);
      let key = 'lead';
      let previous: Participant | undefined;
      if (lead) {
        const existing = getLead(team.id);
        if (isLive(existing)) throw new Error(`Team ${team.id} already has a live lead (PID ${existing!.pid}).`);
        path = join(teamDir(team.id), 'lead.json');
      } else {
        const rows = members(team.id);
        previous = rows.find(m => m.sessionId === sessionId);
        if (isLive(previous)) throw new Error(`This member session is already running: ${previous!.key}`);
        const max = maxForRole?.(partRole);
        if (max && rows.filter(m => m.role === partRole && isLive(m)).length >= max) throw new Error(`${partRole}: maximum ${max} concurrent members.`);
        if (previous) key = previous.key;
        else {
          const n = rows.filter(m => m.role === partRole).reduce((max, m) => Math.max(max, Number(m.key.slice(partRole.length + 1))), 0);
          key = `${partRole}-${n + 1}`;
        }
        mkdir(join(teamDir(team.id), 'members'));
        path = join(teamDir(team.id), 'members', `${key}.json`);
      }
      const now = Date.now();
      finished = false;
      row = { key, role: partRole, sessionId, sessionFile, pid: process.pid, at: now, startedAt: now, state: 'idle', tokens: previous?.tokens ?? 0,
        model: lastModel, fallback, sideEffects: previous?.sideEffects ?? false, changedPaths: previous?.changedPaths };
      diff(); persist();
    });
    if (lead) timer = setInterval(() => { diff(); persist(); }, 2_000).unref();
  });
  pi.on('agent_start', () => { terminal = undefined; update('working'); });
  pi.on('turn_end', event => {
    if (!row || event.message.role !== 'assistant') return;
    const m = event.message as AssistantMessage;
    terminal = m;
    row.tokens += m.usage?.totalTokens ?? 0;
    row.model = m.provider !== 'team' ? `${m.provider}/${m.model}` : lastModel;
    persist();
  });
  pi.on('tool_execution_start', e => {
    if (!row) return;
    const target = e.args?.path ?? e.args?.filePath ?? e.args?.saveDir;
    row.tool = e.toolName;
    row.path = typeof target === 'string' ? target.slice(0, 240) : undefined;
    activeTools.set(e.toolCallId, { tool: e.toolName, path: row.path });
    if (['write', 'edit', 'bash'].includes(e.toolName)) row.sideEffects = true;
    if ((e.toolName === 'write' || e.toolName === 'edit') && typeof target === 'string') {
      const file = relative(team.worktree, resolve(team.worktree, target)) || '.';
      const files = row.changedPaths ??= [];
      if (!files.includes(file)) files.push(file);
    }
    persist();
  });
  pi.on('tool_execution_end', e => {
    activeTools.delete(e.toolCallId);
    if (row) {
      const active = [...activeTools.values()].at(-1);
      row.tool = active?.tool; row.path = active?.path; persist();
    }
  });
  pi.on('agent_end', e => {
    if (!row) return;
    for (let i = e.messages.length - 1; i >= 0; i--) {
      if (e.messages[i].role === 'assistant') { terminal = e.messages[i] as AssistantMessage; break; }
    }
  });
  pi.on('agent_settled', e => {
    if (!row) return;
    if (e.aborted) { update(lead ? 'idle' : 'stopped'); return; }
    if (terminal?.stopReason === 'error') {
      row.error = terminal.errorMessage ?? 'Provider request failed.';
      if (!lead && row.model && terminal !== failure) {
        recordFailure(team.id, row.key, row.model, row.error, row.sideEffects);
        failure = terminal;
      }
      update(lead ? 'idle' : 'failed');
    } else {
      row.error = undefined;
      if (terminal) row.result = terminal.content.flatMap(c => c.type === 'text' ? [c.text] : []).join('\n').slice(0, 16_384);
      diff(); update(lead ? finished ? 'done' : 'idle' : 'done');
    }
  });
  pi.on('session_shutdown', () => {
    clearInterval(timer);
    if (!row) return;
    if (row.state === 'done' || row.state === 'failed') { row.pid = 0; persist(); }
    else update('stopped');
    stopped = true;
    activeTools.clear();
  });
  return { row: () => row, owner: () => row ? { team: team.id, key: row.key } : undefined, update, routed };
}
