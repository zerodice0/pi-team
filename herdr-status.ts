import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createConnection } from 'node:net';
import { status } from './board.ts';
import { activity, diffShort, live, oneLine } from './panel.ts';
import { getTeam, teamIcon, type Team } from './registry.ts';

// The lead publishes who the team is and what it is doing as Herdr metadata tokens, so the
// agents and spaces sidebars can show `$team` and `$team_now` rows. Tokens are a flat map per
// pane, so pi-team uses its own names and never touches HAM's display_agent, label or tokens.
const SOURCE = 'pi-team';
const REFRESH_MS = 2000;
const clip = (s: string, n: number) => [...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s;

export function teamToken(team: Team) {
  const label = team.aliasLabel ? ` ${team.aliasLabel}` : '';
  return clip(`${teamIcon(team)} ${team.id}${label}${team.description ? ` · ${oneLine(team.description)}` : ''}`, 80);
}
export function nowToken(d: ReturnType<typeof status>) {
  if (d.state === 'done') return ['✓ done', diffShort(d.diff)].filter(Boolean).join(' · ');
  const parts: string[] = [];
  if (d.lead?.tool) parts.push(`lead ${activity(d.lead, d.state)}`);
  for (const p of d.rows.filter(p => live.has(p.state))) parts.push(`${p.key} ${activity(p, p.state)}`);
  for (const p of d.pending) parts.push(`${p.role} starting`);
  if (!parts.length) parts.push(`lead ${activity({}, d.state)}`);
  const finished = d.rows.filter(p => !live.has(p.state)).length;
  if (finished) parts.push(`${finished} done`);
  return clip(parts.join(' · '), 120);
}

function request(socketPath: string, method: string, params: object) {
  return new Promise<void>(resolve => {
    const socket = createConnection(socketPath);
    const finish = () => { clearTimeout(timer); socket.destroy(); resolve(); };
    const timer = setTimeout(finish, 1000);
    timer.unref();
    socket.on('error', finish);
    socket.on('data', finish);
    socket.on('end', finish);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`, method, params })}\n`));
  });
}

export function herdrStatus(pi: ExtensionAPI, team: Team) {
  const pane = process.env.HERDR_PANE_ID;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_ENV !== '1' || !pane || !socketPath || process.platform === 'win32') return;
  let timer: NodeJS.Timeout | undefined;
  let last = '';
  let busy = false;
  const publish = async (tokens: Record<string, string | null>) => {
    await request(socketPath, 'pane.report_metadata', { pane_id: pane, source: SOURCE, tokens });
    if (team.workspace) await request(socketPath, 'workspace.report_metadata', { workspace_id: team.workspace, source: SOURCE, tokens });
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const current = getTeam(team.id);
      if (!current) return;
      const tokens = { team: teamToken(current), team_now: nowToken(status(current)) };
      const next = JSON.stringify(tokens);
      if (next === last) return;
      last = next;
      await publish(tokens);
    } catch { /* display only */ } finally { busy = false; }
  };
  pi.on('session_start', () => { timer = setInterval(() => void tick(), REFRESH_MS); timer.unref(); void tick(); });
  pi.on('session_shutdown', async () => {
    clearInterval(timer);
    last = '';
    await publish({ team: null, team_now: null }).catch(() => undefined);
  });
}
