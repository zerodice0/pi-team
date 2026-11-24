import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { join } from 'node:path';
import { send, type Address } from './mailbox.ts';
import { findSummary, threads } from './lifecycle.ts';
import { getLead, leadState, ledger, members, readJson, teamDir, teams, type LedgerEntry, type Participant, type Snapshot, type Team } from './registry.ts';

export function status(t: Team) {
  const lead = getLead(t.id);
  const snapshot = readJson<Snapshot>(join(teamDir(t.id), 'members.json'));
  const direct = members(t.id);
  const merged = new Map(snapshot?.members.map(m => [m.key, m]) ?? []);
  for (const m of direct) if (m.at >= (merged.get(m.key)?.at ?? 0)) merged.set(m.key, m);
  const rows = [...merged.values()];
  const events = ledger(t.id);
  const sent = events.filter(e => e.event === 'sent');
  const prefix = `pi-team.${t.preset}-`;
  const pending = [];
  const matched = new Set<string>();
  for (const entry of snapshot?.fleet ?? []) {
    if (!entry.agent.startsWith(prefix) || Date.now() - snapshot!.at >= 10_000) continue;
    const role = entry.agent.slice(prefix.length).replace(`.team-${t.id}`, '');
    const registered = rows.filter(m => m.role === role && !matched.has(m.key))
      .sort((a, b) => Math.abs((a.startedAt ?? 0) - (entry.startedAt ?? 0)) - Math.abs((b.startedAt ?? 0) - (entry.startedAt ?? 0)))[0];
    if (registered && Math.abs((registered.startedAt ?? 0) - (entry.startedAt ?? 0)) <= 30_000) matched.add(registered.key);
    else pending.push({ role, ...entry });
  }
  return { team: t, state: leadState(lead, t.createdAt), lead, rows, events, sent, diff: lead?.diff ?? 'not yet recorded', pending };
}
function rowText(p: Participant, events: LedgerEntry[], team: string, state: string = p.state) {
  const key = `${p.key}@${team}`;
  const s = events.filter(e => e.event === 'sent' && e.from === key).length;
  const r = events.filter(e => e.event === 'delivered' && e.to === key).length;
  return `${p.role} | ${p.key} | ${p.fallback ? '⇢ ' : ''}${p.model ?? 'pending'} | ${state} | ${p.tool ?? '—'}${p.path ? ` ${p.path}` : ''} | S${s}/R${r} | ${p.tokens} tokens`;
}
const views = ['Teams', 'Team', 'Messages', 'Summary'] as const;
function clean(s: string) { return s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
export async function board(ctx: ExtensionContext, initial?: string, sender?: Address) {
  if (!ctx.hasUI) throw new Error('The team board requires interactive Pi.');
  let data = teams().map(status);
  let selected = Math.max(0, data.findIndex(d => d.team.id === initial));
  let view = initial && data.some(d => d.team.id === initial) ? 1 : 0;
  let offset = 0;
  let timer: NodeJS.Timeout | undefined;
  let refreshError: string | undefined;
  const chosen = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    timer = setInterval(() => {
      try {
        const id = data[selected]?.team.id;
        data = teams().map(status);
        const index = data.findIndex(d => d.team.id === id);
        selected = index >= 0 ? index : Math.max(0, Math.min(selected, data.length - 1));
        refreshError = undefined;
      } catch (e) { refreshError = String(e); }
      tui.requestRender();
    }, 1800).unref();
    return {
      render(width: number) {
        const d = data[selected];
        const max = Math.max(1, Math.min(20, tui.terminal.rows - 8));
        let lines: string[];
        if (!d) lines = ['No teams. Use /team start to create one.'];
        else if (view === 0) lines = data.flatMap(({ team: t, state, rows, sent, diff }, i) => [
          `${selected === i ? '▶' : ' '} ${t.id} | ${t.preset} | ${state} | ${rows.length} members | ${sent.length} messages | ${diff}`,
          `  Repo ${t.repo} · ${t.workspace ?? 'external'}`,
          `  Worktree ${t.worktree} · ${t.branch}`]);
        else if (view === 1) lines = [
          `${d.team.id} · ${d.team.worktree} · ${d.state}`,
          'Role | member key | actual model | state | current tool/path | sent/received | tokens',
          ...(d.lead ? [rowText(d.lead, d.events, d.team.id, d.state)] : ['Lead has not registered.']),
          ...d.rows.map(p => rowText(p, d.events, d.team.id)),
          ...d.pending.map(p => `${p.role} | ${p.key} | ${p.model ?? 'pending'} | starting | — | S0/R0 | ${p.tokens?.total ?? 0} tokens`),
          '', 'Recent messages (max 5)',
          ...d.sent.slice(-5).map(e => `${e.from} → ${e.to}: ${e.subject ?? e.body}`)];
        else if (view === 2) lines = threads(d.events).flatMap(group => group.map(({ message: e, state }, i) => `${i ? '  ↳' : '•'} ${e.from} → ${e.to} [${state}] ${e.subject ? `${e.subject}: ` : ''}${e.body}`));
        else lines = (findSummary(d.team.id) ?? 'No summary yet.').split('\n');
        if (!lines.length) lines = ['No messages.'];
        const begin = Math.min(view === 0 ? Math.max(0, (selected - Math.max(1, Math.floor(max / 3)) + 1) * 3) : offset, Math.max(0, lines.length - max));
        const title = `pi-team board · ${views.map((v, i) => i === view ? `[${v}]` : v).join('  ')}`;
        const pad = (s: string) => truncateToWidth(s, width, '', true);
        return [pad(theme.fg('accent', title)), ...lines.slice(begin, begin + max).map(s => pad(clean(s))),
          ...(refreshError ? [pad(theme.fg('warning', clean(refreshError)))] : []), pad(theme.fg('muted', '↑↓ Move · Enter Open · Tab View · s Send · Esc Close'))];
      },
      handleInput(key: string) {
        if (matchesKey(key, 'escape')) { done(undefined); return; }
        if (key === 's' && data[selected]) { done(data[selected].team.id); return; }
        if (matchesKey(key, 'tab')) { view = (view + 1) % views.length; offset = 0; }
        if (matchesKey(key, 'enter') && view === 0 && data.length) { view = 1; offset = 0; }
        if (matchesKey(key, 'up')) { if (view === 0) selected = Math.max(0, selected - 1); else offset = Math.max(0, offset - 1); }
        if (matchesKey(key, 'down')) { if (view === 0) selected = Math.max(0, Math.min(data.length - 1, selected + 1)); else offset++; }
        tui.requestRender();
      },
      invalidate() {},
    };
  }, { overlay: true, overlayOptions: { width: '94%', anchor: 'center' } }).finally(() => clearInterval(timer));
  if (chosen) {
    const to = sender && sender.key !== 'lead' && sender.team === chosen ? 'lead' : `lead@${chosen}`;
    const body = await ctx.ui.editor(`Message to ${to}`);
    if (body?.trim()) send(sender, { to, body });
  }
}
export function widget(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  let before = '';
  const refresh = () => {
    if (!ctx?.hasUI) return;
    const active = teams();
    const next = active.map(t => {
      const d = status(t);
      const finished = d.rows.filter(p => ['done', 'failed', 'stopped'].includes(p.state)).length;
      return `${t.id} ${d.state === 'done' ? `✓ done (${d.diff})` : `${d.state === 'stale' ? '!' : '▶'} ${finished}/${d.rows.length} ✉${d.sent.length}`}`;
    }).join(' · ');
    if (next !== before) ctx.ui.setWidget('pi-team', next ? [`teams: ${next}`] : undefined);
    before = next;
    if (active.length && !timer) timer = setInterval(safeRefresh, 2000).unref();
    if (!active.length && timer) { clearInterval(timer); timer = undefined; }
  };
  const safeRefresh = () => { try { refresh(); } catch (e) { ctx?.ui.notify(String(e), 'warning'); } };
  pi.on('session_start', (_e, c) => { ctx = c; safeRefresh(); });
  pi.on('agent_settled', safeRefresh);
  pi.on('session_shutdown', () => { if (timer) clearInterval(timer); timer = undefined; ctx = undefined; before = ''; });
  return safeRefresh;
}
