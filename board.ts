import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Editor, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { join } from 'node:path';
import { send, type Address } from './mailbox.ts';
import { findSummary, threads } from './lifecycle.ts';
import { activity, BG, BG_OFF, diffShort, edge, fg, glyph, headline, modelName, oneLine, pad, row, short, wrap, type Info, type Line, type Segment, type Tone } from './frame.ts';
import { clipText, getLead, goalDetail, leadState, ledger, members, readJson, scopedTeams, teamDir, teamIcon, teams, teamTitle, type LedgerEntry, type Participant, type Snapshot, type Team } from './registry.ts';
import { ago, diskUsage, offlineFor, STALE_MS, usageLine } from './disk.ts';

// Surfaces show the title; the ID, preset and alias appear only where an address is needed (board).
export const teamLabel = (t: Team) => `${teamIcon(t)} ${teamTitle(t)}`;
export const teamIds = (t: Team) => [t.id, t.preset, t.alias && (t.aliasLabel ?? t.alias), t.description && oneLine(t.description)].filter(Boolean).join(' · ');

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
  undelivered: ['undelivered', 'crit'], fallback: ['fallback', 'warn'], route: ['route', 'ok'],
};
const blank: Line = { left: [] };
// Teams view: one card per team. The selected card carries the gold rail and the only bright goal,
// so the eye lands on it first; the others step back to label gray.
function card(d: Info, selected: boolean, inner: number): Line[] {
  const rail: Segment = selected ? ['▌ ', 'title'] : ['  '];
  const { mark, tone, summary, summaryTone } = headline(d);
  const t = d.team;
  const goal = wrap(goalDetail(t), inner - 4, 2);
  const diff = diffShort(d.diff) || (d.diff === 'not yet recorded' ? '' : oneLine(d.diff));
  return [
    { left: [rail, [mark, tone], [' '], [teamLabel(t), 'name', true]], right: [[summary, summaryTone]] },
    ...goal.map(text => ({ left: [rail, ['  '], [text, selected ? 'name' : 'label']] as Segment[] })),
    { left: [rail, ['  '], [teamIds(t), 'label']] },
    { left: [rail, ['  '], [[count(d.rows.length + d.pending.length, 'member'), count(d.sent.length, 'message'), diff].filter(Boolean).join(' · '), 'label']] },
    { left: [rail, ['  '], [`${tilde(t.worktree)} · ${t.branch}`, 'label']] },
    ...disk(d, rail),
  ];
}
// Worktree size from a cache refreshed in the background (du is too slow for a redraw), with a hint
// when rebuildable outputs are large or the lead has been gone for a day.
function disk(d: Info, rail: Segment): Line[] {
  if (d.state === 'done') return [];
  const u = diskUsage(d.team);
  if (!u) return [{ left: [rail, ['  '], ['measuring disk use…', 'dim']] }];
  const away = offlineFor(d.team, d.lead);
  const heavy = u.rebuildableKb >= 1024 * 1024;
  const hint = away !== undefined && away >= STALE_MS ? `lead offline ${ago(away)}: /team resume or /team close ${d.team.id}` : heavy ? `/team clean ${d.team.id}` : '';
  return [{ left: [rail, ['  '], [usageLine(u), heavy ? 'warn' : 'label'], ...(hint ? [[' · ', 'dim'], [hint, 'label']] as Segment[] : [])] }];
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
    ...(d.lead ? [{ role: 'lead', key: 'lead', model: modelName(d.lead.model, d.lead.level), fallback: d.lead.fallback, state: d.state, now: activity(d.lead, d.state), mail: mail('lead'), tokens: d.lead.tokens.toLocaleString('en-US') }] : []),
    ...d.rows.map(p => ({ role: p.role, key: p.key, model: modelName(p.model, p.level), fallback: p.fallback, state: p.state, now: activity(p, p.state), mail: mail(p.key), tokens: p.tokens.toLocaleString('en-US') })),
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
// Replies are written inside the board so the decisions it shows stay in view while the user answers.
// Where the reply goes depends on the session: a lead's own team gets it as the user's own message
// (`own`); any other team's lead gets it through the mailbox.
export async function board(ctx: ExtensionContext, initial?: string, sender?: Address, own?: (body: string) => void) {
  if (!ctx.hasUI) throw new Error('The team board requires interactive Pi.');
  // Teams of this session's repository (its main checkout or any of its worktrees); a toggles all.
  let all = false;
  let hidden = 0;
  const load = () => {
    const scope = scopedTeams(ctx.cwd);
    hidden = scope.elsewhere.length;
    return (all ? [...scope.here, ...scope.elsewhere] : scope.here).map(status);
  };
  let data = load();
  if (initial && !data.some(d => d.team.id === initial) && hidden) { all = true; data = load(); }
  let selected = Math.max(0, data.findIndex(d => d.team.id === initial));
  let view = initial && data.some(d => d.team.id === initial) ? 1 : 0;
  let offset = 0;
  let room = 10;
  let timer: NodeJS.Timeout | undefined;
  let refreshError: string | undefined;
  // The team a reply is being written to, and the outcome of the last one.
  let composing: string | undefined;
  let note: [string, Tone] | undefined;
  const target = (id: string) => own && sender?.key === 'lead' && sender.team === id ? 'you' : sender && sender.key !== 'lead' && sender.team === id ? 'lead' : `lead@${id}`;
  await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
    const editor = new Editor(tui, {
      borderColor: text => fg('title', text),
      selectList: { selectedPrefix: t => fg('title', t), selectedText: t => fg('title', t), description: t => fg('label', t), scrollInfo: t => fg('label', t), noMatch: t => fg('warn', t) },
    }, { paddingX: 1 });
    let focused = false;
    const focus = () => { editor.focused = focused && !!composing; };
    editor.onSubmit = text => {
      const body = text.trim();
      const id = composing;
      if (!body || !id) return;
      const to = target(id);
      try {
        if (to === 'you') own!(body); else send(sender, { to, body });
        note = [`Sent to ${to === 'you' ? 'the lead (as your message)' : to}.`, 'good'];
        editor.addToHistory(body);
        editor.setText('');
        composing = undefined;
        focus();
      } catch (e) { note = [oneLine(e instanceof Error ? e.message : String(e)), 'crit']; }
      tui.requestRender();
    };
    timer = setInterval(() => {
      try {
        const id = data[selected]?.team.id;
        data = load();
        const index = data.findIndex(d => d.team.id === id);
        selected = index >= 0 ? index : Math.max(0, Math.min(selected, data.length - 1));
        refreshError = undefined;
      } catch (e) { refreshError = String(e); }
      tui.requestRender();
    }, 1800).unref();
    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; focus(); },
      render(width: number) {
        const inner = width - 4;
        const d = data[selected];
        // A fixed height keeps the frame still while switching views and teams.
        const height = Math.max(12, Math.min(tui.terminal.rows - 2, 40));
        const header: Line[] = d && view ? (() => {
          const { mark, tone, summary: state, summaryTone } = headline(d);
          return [{ left: [[mark, tone], [' '], [teamLabel(d.team), 'name', true], [`  ${teamIds(d.team)}`, 'label']], right: [[state, summaryTone]] },
            ...(view === 1 ? wrap(goalDetail(d.team), inner - 2, 2).map(text => ({ left: [['  '], [text, 'label']] as Segment[] })) : []), blank];
        })() : [];
        // The reply box takes the bottom of the frame; the view above keeps scrolling.
        const box = composing ? editor.render(inner).slice(-Math.max(3, Math.floor(height / 3))) : [];
        const compose = composing ? [
          row(blank, width),
          row({ left: [['Reply to ', 'label'], [target(composing) === 'you' ? 'the lead' : target(composing), 'title', true]], right: [[target(composing) === 'you' ? 'sent as your message' : 'sent through the mailbox', 'label']] }, width),
          ...box.map(line => `${BG}${fg('border', '│')} ${line}${' '.repeat(Math.max(0, inner - visibleWidth(line)))} ${fg('border', '│')}${BG_OFF}`),
        ] : note ? [row({ left: [note] }, width)] : [];
        room = Math.max(3, height - 4 - header.length - (refreshError ? 1 : 0) - compose.length);
        let body: Line[];
        let begin = 0;
        if (!d) body = [{ left: [['  '], [hidden && !all ? 'No teams in this repository' : 'No teams yet', 'name', true]] },
          { left: [['  '], [hidden && !all ? `a shows ${count(hidden, 'team')} in other repositories` : '/team start <preset or alias> -- <goal>', 'label']] }];
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
        const keys = composing
          ? ` ${[key('enter', 'send'), key('shift+enter', 'new line'), key('pgup/pgdn', 'scroll'), key('esc', 'cancel')].join(fg('dim', '  '))} `
          : ` ${[view === 0 ? key('↑↓', 'select') : key('↑↓', 'scroll'), view === 0 ? key('enter', 'open') : key('←→', 'team'), key('tab', 'view'), key('s', 'reply'), ...(hidden ? [key('a', all ? 'this repo' : `all +${hidden}`)] : []), key('esc', 'close')].join(fg('dim', '  '))} `;
        return [
          edge(width, ['╭', '╮'], ` ${fg('title', 'pi-team board', true)}${hidden ? fg('label', all ? ' · all repositories' : ' · this repository') : ''} `, ` ${tabs} `),
          row(blank, width),
          ...[...header, ...shown, ...filler].map(line => row(line, width, 0.4)),
          ...(refreshError ? [row({ left: [[oneLine(refreshError), 'crit']] }, width)] : []),
          ...compose,
          row(blank, width),
          edge(width, ['╰', '╯'], keys, scroll),
        ];
      },
      handleInput(key: string) {
        if (composing) {
          if (matchesKey(key, 'escape')) { composing = undefined; editor.setText(''); focus(); }
          else if (matchesKey(key, 'pageUp')) offset = Math.max(0, offset - room);
          else if (matchesKey(key, 'pageDown')) offset += room;
          else editor.handleInput(key);
          tui.requestRender();
          return;
        }
        if (matchesKey(key, 'escape')) { done(undefined); return; }
        if (key === 's' && data[selected]) { composing = data[selected].team.id; note = undefined; focus(); tui.requestRender(); return; }
        const move = (to: number) => { selected = Math.max(0, Math.min(data.length - 1, to)); offset = 0; };
        if (key === 'a' && hidden) {
          const id = data[selected]?.team.id;
          all = !all; data = load();
          selected = Math.max(0, data.findIndex(x => x.team.id === id)); offset = 0;
          tui.requestRender(); return;
        }
        if (matchesKey(key, 'tab')) { view = (view + 1) % views.length; offset = 0; }
        else if (matchesKey(key, 'shift+tab')) { view = (view + views.length - 1) % views.length; offset = 0; }
        else if (matchesKey(key, 'enter') && view === 0 && data.length) { view = 1; offset = 0; }
        else if (matchesKey(key, 'left') && view) move(selected - 1);
        else if (matchesKey(key, 'right') && view) move(selected + 1);
        else if (matchesKey(key, 'up')) { if (view === 0) selected = Math.max(0, selected - 1); else offset = Math.max(0, offset - 1); }
        else if (matchesKey(key, 'down')) { if (view === 0) selected = Math.max(0, Math.min(data.length - 1, selected + 1)); else offset++; }
        else if (matchesKey(key, 'pageUp')) offset = Math.max(0, offset - room);
        else if (matchesKey(key, 'pageDown')) offset += room;
        note = undefined;
        tui.requestRender();
      },
      invalidate() { editor.invalidate(); },
    };
  }, { overlay: true, overlayOptions: { width: '94%', minWidth: 60, anchor: 'center' } }).finally(() => clearInterval(timer));
}
// The line above the editor: main mode's preset and the repository's teams. Clicking it (pi-tui passes
// mouse events only in fullscreen mode) runs onClick, which toggles the team panel.
export function widget(pi: ExtensionAPI, options: { mainPreset?: () => string | undefined; onClick?: (ctx: ExtensionContext) => void } = {}) {
  let ctx: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  let before = '';
  let rerender: (() => void) | undefined;
  const refresh = () => {
    if (!ctx?.hasUI) return;
    const active = scopedTeams(ctx.cwd).here;
    const teamText = active.map(t => {
      const d = status(t);
      const finished = d.rows.filter(p => ['done', 'failed', 'stopped'].includes(p.state)).length;
      return `${teamIcon(t)} ${clipText(teamTitle(t), 24)} ${d.state === 'done' ? `✓ done (${d.diff})` : `${d.state === 'stale' ? '!' : '▶'} ${finished}/${d.rows.length} ✉${d.sent.length}`}`;
    }).join(' · ');
    const preset = options.mainPreset?.();
    const next = [preset && `team main: ${preset}`, teamText && `teams: ${teamText}`].filter(Boolean).join(' · ');
    if (next !== before) {
      if (!next) { ctx.ui.setWidget('pi-team', undefined); rerender = undefined; }
      else if (!before || !rerender) ctx.ui.setWidget('pi-team', tui => {
        rerender = () => tui.requestRender();
        return {
          render: (width: number) => before ? [truncateToWidth(before, Math.max(0, width - 1))] : [],
          invalidate() {},
          handleMouse(event: TuiMouseEvent) {
            if (event.type !== 'press' || event.button !== 'left' || !ctx || !options.onClick) return undefined;
            options.onClick(ctx);
            return { handled: true, render: true };
          },
        };
      });
      else rerender();
    }
    before = next;
    if (active.length && !timer) timer = setInterval(safeRefresh, 2000).unref();
    if (!active.length && timer) { clearInterval(timer); timer = undefined; }
  };
  const safeRefresh = () => { try { refresh(); } catch (e) { ctx?.ui.notify(String(e), 'warning'); } };
  pi.on('session_start', (_e, c) => { ctx = c; safeRefresh(); });
  pi.on('agent_settled', safeRefresh);
  pi.on('session_shutdown', () => { if (timer) clearInterval(timer); timer = undefined; ctx = undefined; before = ''; rerender = undefined; });
  return safeRefresh;
}
