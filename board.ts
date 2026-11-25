import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { join } from 'node:path';
import { send, type Address } from './mailbox.ts';
import { findSummary, threads } from './lifecycle.ts';
import { activity, diffShort, edge, fg, glyph, headline, modelName, oneLine, pad, row, short, wrap, type Info, type Line, type Segment, type Tone } from './frame.ts';
import { getLead, leadState, ledger, members, readJson, teamDir, teamIcon, teams, type LedgerEntry, type Snapshot, type Team } from './registry.ts';

export const teamLabel = (t: Team) => `${teamIcon(t)} ${t.alias ? `${t.id}(${t.aliasLabel ?? t.alias})` : t.id}`;

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
const views = ['Teams', 'Team', 'Messages', 'Summary'] as const;
const home = process.env.HOME ?? '';
const tilde = (path: string) => home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const delivery: Record<LedgerEntry['event'], [string, Tone]> = {
  sent: ['queued', 'label'], delivered: ['delivered', 'good'], replied: ['replied', 'ok'], closed: ['closed', 'label'],
  undelivered: ['undelivered', 'crit'], fallback: ['fallback', 'warn'],
};
const blank: Line = { left: [] };
// Teams view: one card per team. The selected card carries the gold rail and the only bright goal,
// so the eye lands on it first; the others step back to label gray.
function card(d: Info, selected: boolean, inner: number): Line[] {
  const rail: Segment = selected ? ['▌ ', 'title'] : ['  '];
  const { mark, tone, summary, summaryTone } = headline(d);
  const t = d.team;
  const goal = wrap(oneLine(t.goal), inner - 4, 2);
  const diff = diffShort(d.diff) || (d.diff === 'not yet recorded' ? '' : oneLine(d.diff));
  return [
    { left: [rail, [mark, tone], [' '], [teamLabel(t), 'name', true], [`  ${t.description ? oneLine(t.description) : t.preset}`, 'label']], right: [[summary, summaryTone]] },
    ...goal.map(text => ({ left: [rail, ['  '], [text, selected ? 'name' : 'label']] as Segment[] })),
    { left: [rail, ['  '], [[count(d.rows.length + d.pending.length, 'member'), count(d.sent.length, 'message'), diff].filter(Boolean).join(' · '), 'label']] },
    { left: [rail, ['  '], [`${tilde(t.worktree)} · ${t.branch}`, 'label']] },
  ];
}
// Team view: a roster whose columns size to their content; "now" takes whatever width is left.
function roster(d: Info, inner: number): Line[] {
  const t = d.team;
  const mail = (key: string) => {
    const address = `${key}@${t.id}`;
    return `${d.events.filter(e => e.event === 'sent' && e.from === address).length}/${d.events.filter(e => e.event === 'delivered' && e.to === address).length}`;
  };
  type Row = { role: string; key: string; model: string; fallback?: boolean; state: string; now: string; mail: string; tokens: string };
  const people: Row[] = [
    ...(d.lead ? [{ role: 'lead', key: 'lead', model: modelName(d.lead.model), fallback: d.lead.fallback, state: d.state, now: activity(d.lead, d.state), mail: mail('lead'), tokens: d.lead.tokens.toLocaleString('en-US') }] : []),
    ...d.rows.map(p => ({ role: p.role, key: p.key, model: modelName(p.model), fallback: p.fallback, state: p.state, now: activity(p, p.state), mail: mail(p.key), tokens: p.tokens.toLocaleString('en-US') })),
    ...d.pending.map(p => ({ role: p.role, key: p.key, model: modelName(p.model), state: 'starting', now: 'starting', mail: '0/0', tokens: (p.tokens?.total ?? 0).toLocaleString('en-US') })),
  ];
  // "Now" repeats the state word when a member is not in a tool; show a dash instead.
  for (const r of people) if (r.now === r.state || (r.state === 'idle' && r.now === 'idle')) r.now = '—';
  const widest = (pick: (r: Row) => string, head: string, cap: number) => Math.min(cap, Math.max(head.length, ...people.map(r => visibleWidth(pick(r)))));
  // Members are named after their role unless a role runs twice; drop the column when it adds nothing.
  const keyed = people.some(r => r.key !== r.role);
  const w = { role: widest(r => r.role, 'ROLE', 18), key: keyed ? widest(r => r.key, 'MEMBER', 16) : 0, model: widest(r => r.model, 'MODEL', 22), state: 10, mail: widest(r => r.mail, 'MAIL', 7), tokens: widest(r => r.tokens, 'TOKENS', 9) };
  const fixed = 2 + w.role + (keyed ? w.key + 2 : 0) + w.state + w.model + w.mail + w.tokens + 10;
  // Size "now" to its content so the table stays one compact block on wide terminals.
  const now = Math.max(8, Math.min(inner - fixed, Math.max(24, widest(r => r.now, 'NOW', 60))));
  const cell = (text: string, width: number, tone: Tone, bold = false): Segment[] => width ? [[pad(text, width), tone, bold], ['  ']] : [];
  const lines: Line[] = [{ left: [['  '], ...cell('ROLE', w.role, 'dim'), ...cell('MEMBER', w.key, 'dim'), ...cell('STATE', w.state, 'dim'), ...cell('NOW', now, 'dim'), ...cell('MODEL', w.model, 'dim'), ...cell('MAIL', w.mail, 'dim'), ['TOKENS'.padStart(w.tokens), 'dim']] }];
  for (const r of people) {
    const [mark, tone] = glyph[r.state] ?? ['?', 'label'];
    const busy = r.state === 'working' || r.state === 'waiting';
    lines.push({ left: [['  '], ...cell(r.role, w.role, 'name', true), ...cell(r.key, w.key, 'label'), [mark, tone], [` ${pad(r.state, w.state - 2)}`, tone], ['  '],
      ...cell(r.now, now, busy ? 'name' : 'label'), ...cell(r.model, w.model, r.fallback ? 'warn' : 'label'), ...cell(r.mail, w.mail, 'label'), [r.tokens.padStart(w.tokens), 'label']] });
  }
  if (!d.lead) lines.splice(1, 0, { left: [['  '], ['The lead has not registered yet.', 'label']] });
  const recent = d.sent.slice(-5);
  if (recent.length) {
    lines.push(blank, { left: [['  '], ['RECENT MESSAGES', 'dim']] });
    for (const e of recent) lines.push({ left: [['  '], [`${short(e.from)} → ${short(e.to)}`, 'name'], ['  '], [oneLine(e.subject ?? e.body ?? ''), 'label']], right: [[clock(e.at), 'label']] });
  }
  return lines;
}
// Messages view: each thread opens with its first message; replies sit indented beneath it.
function messages(d: Info, inner: number): Line[] {
  const lines: Line[] = [];
  for (const group of threads(d.events)) {
    if (lines.length) lines.push(blank);
    for (const [i, { message: e, state }] of group.entries()) {
      const indent = i ? '      ' : '  ';
      const [word, tone] = delivery[state] ?? [state, 'label'];
      lines.push({ left: [[indent], [`${short(e.from)} → ${short(e.to)}`, 'name', true], ...(e.subject ? [['  '], [oneLine(e.subject), 'name']] as Segment[] : [])], right: [[word, tone], [`  ${clock(e.at)}`, 'label']] });
      for (const text of wrap(oneLine(e.body ?? ''), inner - indent.length - 2, 3)) lines.push({ left: [[`${indent}  `], [text, 'label']] });
    }
  }
  return lines.length ? lines : [{ left: [['  '], ['No messages yet.', 'label']] }];
}
// Summary view: the lead's report, wrapped; markdown headings keep their weight.
function summary(d: Info, inner: number): Line[] {
  const text = findSummary(d.team.id);
  if (!text) return [{ left: [['  '], ['No summary yet. The lead writes one with team_report.', 'label']] }];
  return text.replace(/\r/g, '').split('\n').flatMap(raw => {
    const line = raw.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/\t/g, '  ');
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) return [{ left: [['  '], [heading[1], 'title', true]] }];
    if (!line.trim()) return [blank];
    const indent = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?/.exec(line)?.[0].length ?? 0;
    return wrap(line.trimEnd(), inner - 2 - indent).map((part, i) => ({ left: [['  '], [i ? `${' '.repeat(indent)}${part}` : part, 'name']] as Segment[] }));
  });
}
export async function board(ctx: ExtensionContext, initial?: string, sender?: Address) {
  if (!ctx.hasUI) throw new Error('The team board requires interactive Pi.');
  let data = teams().map(status);
  let selected = Math.max(0, data.findIndex(d => d.team.id === initial));
  let view = initial && data.some(d => d.team.id === initial) ? 1 : 0;
  let offset = 0;
  let room = 10;
  let timer: NodeJS.Timeout | undefined;
  let refreshError: string | undefined;
  const chosen = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
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
        const inner = width - 4;
        const d = data[selected];
        // A fixed height keeps the frame still while switching views and teams.
        const height = Math.max(12, Math.min(tui.terminal.rows - 2, 40));
        const header: Line[] = d && view ? (() => {
          const { mark, tone, summary: state, summaryTone } = headline(d);
          return [{ left: [[mark, tone], [' '], [teamLabel(d.team), 'name', true], [`  ${d.team.description ? oneLine(d.team.description) : d.team.preset}`, 'label']], right: [[state, summaryTone]] },
            ...(view === 1 ? wrap(oneLine(d.team.goal), inner - 2, 2).map(text => ({ left: [['  '], [text, 'label']] as Segment[] })) : []), blank];
        })() : [];
        room = Math.max(3, height - 4 - header.length - (refreshError ? 1 : 0));
        let body: Line[];
        let begin = 0;
        if (!d) body = [{ left: [['  '], ['No teams yet', 'name', true]] }, { left: [['  '], ['/team start <preset or alias> -- <goal>', 'label']] }];
        else if (view === 0) {
          const cards = data.map((t, i) => card(t, i === selected, inner));
          body = cards.flatMap((c, i) => i ? [blank, ...c] : c);
          // Keep the whole selected card in view.
          const top = cards.slice(0, selected).reduce((n, c) => n + c.length + 1, 0);
          const bottom = top + cards[selected].length;
          begin = Math.max(0, Math.min(top, Math.max(bottom - room, Math.min(offset, top))));
          offset = begin;
        } else {
          body = view === 1 ? roster(d, inner) : view === 2 ? messages(d, inner) : summary(d, inner);
          offset = Math.max(0, Math.min(offset, body.length - room));
          begin = offset;
        }
        const shown = body.slice(begin, begin + room);
        const filler = Array.from({ length: room - shown.length }, () => blank);
        const tabs = views.map((v, i) => i === view ? fg('title', v, true) : fg('label', v)).join(fg('dim', ' · '));
        const scroll = body.length > room ? fg('label', ` ${begin + 1}–${Math.min(body.length, begin + room)} of ${body.length} `) : '';
        const key = (k: string, what: string) => `${fg('name', k)} ${fg('label', what)}`;
        const keys = ` ${[view === 0 ? key('↑↓', 'select') : key('↑↓', 'scroll'), view === 0 ? key('enter', 'open') : key('←→', 'team'), key('tab', 'view'), key('s', 'send'), key('esc', 'close')].join(fg('dim', '  '))} `;
        return [
          edge(width, ['╭', '╮'], ` ${fg('title', 'pi-team board', true)} `, ` ${tabs} `),
          row(blank, width),
          ...[...header, ...shown, ...filler].map(line => row(line, width, 0.4)),
          ...(refreshError ? [row({ left: [[oneLine(refreshError), 'crit']] }, width)] : []),
          row(blank, width),
          edge(width, ['╰', '╯'], keys, scroll),
        ];
      },
      handleInput(key: string) {
        if (matchesKey(key, 'escape')) { done(undefined); return; }
        if (key === 's' && data[selected]) { done(data[selected].team.id); return; }
        const move = (to: number) => { selected = Math.max(0, Math.min(data.length - 1, to)); offset = 0; };
        if (matchesKey(key, 'tab')) { view = (view + 1) % views.length; offset = 0; }
        else if (matchesKey(key, 'shift+tab')) { view = (view + views.length - 1) % views.length; offset = 0; }
        else if (matchesKey(key, 'enter') && view === 0 && data.length) { view = 1; offset = 0; }
        else if (matchesKey(key, 'left') && view) move(selected - 1);
        else if (matchesKey(key, 'right') && view) move(selected + 1);
        else if (matchesKey(key, 'up')) { if (view === 0) selected = Math.max(0, selected - 1); else offset = Math.max(0, offset - 1); }
        else if (matchesKey(key, 'down')) { if (view === 0) selected = Math.max(0, Math.min(data.length - 1, selected + 1)); else offset++; }
        else if (matchesKey(key, 'pageUp')) offset = Math.max(0, offset - room);
        else if (matchesKey(key, 'pageDown')) offset += room;
        tui.requestRender();
      },
      invalidate() {},
    };
  }, { overlay: true, overlayOptions: { width: '94%', minWidth: 60, anchor: 'center' } }).finally(() => clearInterval(timer));
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
      return `${teamLabel(t)} ${d.state === 'done' ? `✓ done (${d.diff})` : `${d.state === 'stale' ? '!' : '▶'} ${finished}/${d.rows.length} ✉${d.sent.length}`}`;
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
