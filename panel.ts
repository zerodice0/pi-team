import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { status, teamLabel } from './board.ts';
import { teams, type Participant } from './registry.ts';

// A non-capturing side panel, so the user can keep typing while teams work.
// It sits below quota-panel.ts (top-right, about ten rows) instead of covering it.
const WIDTH = 50;
const TOP = 11;
const MEMBERS = 6;
const REFRESH_MS = 2000;
type Info = ReturnType<typeof status>;
type Tone = 'accent' | 'text' | 'muted' | 'dim' | 'success' | 'warning' | 'error' | 'border';
type Segment = [string, Tone?];
const icons: Record<string, Segment> = {
  working: ['▶', 'accent'], waiting: ['⧗', 'warning'], idle: ['·', 'muted'], done: ['✓', 'success'],
  failed: ['✗', 'error'], stopped: ['■', 'dim'], stale: ['!', 'warning'], starting: ['…', 'muted'],
};
const live = new Set(['working', 'waiting', 'idle', 'starting']);
const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
// Truncate plain text ourselves: truncateToWidth() inserts a full reset that would drop the panel background.
function clip(text: string, width: number) {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = visibleWidth(ch);
    if (used + w > width - 1) break;
    out += ch; used += w;
  }
  return `${out}…`;
}
const fixed = (text: string, width: number) => { const t = clip(text, width); return t + ' '.repeat(Math.max(0, width - visibleWidth(t))); };
const short = (address?: string) => address?.split('@')[0] ?? '?';
const model = (p: { model?: string; fallback?: boolean }) => `${p.fallback ? '⇢' : ''}${p.model?.split('/').pop() ?? 'pending'}`;

function memberLine(p: Pick<Participant, 'key' | 'model' | 'fallback' | 'tool' | 'path'>, state: string): Segment[] {
  const [icon, tone] = icons[state] ?? ['?', 'muted'];
  return [['  '], [icon, tone], [' '], [fixed(p.key, 11), 'text'], [' '], [fixed(model(p), 16), 'muted'], [' '],
    [p.tool ? `${p.tool}${p.path ? ` ${p.path}` : ''}` : state, 'dim']];
}
export function teamLines(d: Info): Segment[][] {
  const [icon, tone] = icons[d.state] ?? ['?', 'muted'];
  const lines: Segment[][] = [[[icon, tone], [' '], [teamLabel(d.team), 'accent'], [` ${d.team.preset} · ${d.state} · ✉${d.sent.length}`, 'muted']]];
  lines.push([['  goal ', 'dim'], [oneLine(d.team.goal), 'text']]);
  const delegated = d.sent.filter(e => e.from === 'main' && e.to === `lead@${d.team.id}`).at(-1);
  if (delegated?.body) lines.push([['  main ', 'dim'], [oneLine(delegated.body), 'text']]);
  const rows = [...d.rows].sort((a, b) => Number(live.has(b.state)) - Number(live.has(a.state)) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  if (d.state === 'done') {
    lines.push([['  ', 'dim'], [`${rows.length} member${rows.length === 1 ? '' : 's'} · ${d.diff}`, 'muted']]);
    return lines;
  }
  const members = [
    ...(d.lead ? [memberLine(d.lead, d.state)] : [[['  '], ['… lead not registered yet', 'muted']] as Segment[]]),
    ...rows.map(p => memberLine(p, p.state)),
    ...d.pending.map(p => memberLine({ key: p.role, model: p.model }, 'starting')),
  ];
  if (members.length > MEMBERS) {
    const hidden = members.length - (MEMBERS - 1);
    lines.push(...members.slice(0, MEMBERS - 1), [['  ', 'dim'], [`… +${hidden} more (/team board)`, 'muted']]);
  } else lines.push(...members);
  const last = d.sent.filter(e => e.from !== 'main').at(-1);
  if (last) lines.push([['  ✉ ', 'dim'], [`${short(last.from)}→${short(last.to)}: ${oneLine(last.subject ?? last.body ?? '')}`, 'muted']]);
  return lines;
}

export function teamPanel(pi: ExtensionAPI, current?: string) {
  let data: Info[] = [];
  let loadError: string | undefined;
  let handle: { setHidden(hidden: boolean): void } | undefined;
  let close: (() => void) | undefined;
  let rerender: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let visible = false;
  const rank = (d: Info) => d.team.id === current ? 0 : d.state === 'done' ? 2 : 1;
  const load = () => {
    try { data = teams().map(status).sort((a, b) => rank(a) - rank(b) || b.team.createdAt - a.team.createdAt); loadError = undefined; }
    catch (e) { loadError = String(e); }
    rerender?.();
  };
  const show = (ctx: ExtensionContext) => {
    visible = true;
    load();
    if (handle) handle.setHidden(false);
    else void ctx.ui.custom<void>((tui, theme, _keys, done) => {
      rerender = () => tui.requestRender();
      close = () => done();
      const paint = (segments: Segment[], width: number) => {
        let used = 0;
        let out = '';
        for (const [text, tone] of segments) {
          const part = clip(text, width - used);
          if (!part) break;
          used += visibleWidth(part);
          out += tone ? theme.fg(tone, part) : part;
          if (part !== text) break;
        }
        return out + ' '.repeat(Math.max(0, width - used));
      };
      const frame = (s: string) => theme.bg('customMessageBg', s);
      return {
        render(width: number) {
          const inner = Math.max(10, width - 4);
          const body: Segment[][] = loadError ? [[[oneLine(loadError), 'error']]]
            : data.length ? data.flatMap((d, i) => [...(i ? [[] as Segment[]] : []), ...teamLines(d)])
            : [[['No teams. /team start <preset> -- <goal>', 'muted']]];
          const room = Math.max(3, tui.terminal.rows - TOP - 8);
          const shown = body.length > room ? [...body.slice(0, room - 1), [['… more in /team board', 'muted']] as Segment[]] : body;
          const title = ' pi-team ';
          const note = ` ${data.length} team${data.length === 1 ? '' : 's'} · alt+t `;
          const fill = Math.max(1, width - 3 - visibleWidth(title) - visibleWidth(note) - 1);
          return [
            frame(`${theme.fg('border', '╭─')}${theme.fg('accent', title)}${theme.fg('border', '─'.repeat(fill))}${theme.fg('dim', note)}${theme.fg('border', '╮')}`),
            ...shown.map(segments => frame(`${theme.fg('border', '│')} ${paint(segments, inner)} ${theme.fg('border', '│')}`)),
            frame(theme.fg('border', `╰${'─'.repeat(Math.max(0, width - 2))}╯`)),
          ];
        },
        invalidate() {},
      };
    }, {
      overlay: true,
      overlayOptions: { anchor: 'top-right', width: WIDTH, margin: { top: TOP, right: 1 }, nonCapturing: true, visible: (w, h) => w >= WIDTH + 40 && h >= TOP + 12 },
      onHandle: h => { handle = h; },
    }).finally(() => { handle = undefined; close = undefined; rerender = undefined; });
    clearInterval(timer);
    timer = setInterval(load, REFRESH_MS).unref();
  };
  const hide = () => { visible = false; clearInterval(timer); timer = undefined; handle?.setHidden(true); };
  const toggle = (ctx: ExtensionContext) => visible ? hide() : show(ctx);
  pi.registerShortcut('alt+t', { description: 'Toggle the pi-team side panel', handler: async ctx => { if (ctx.hasUI) toggle(ctx); } });
  pi.on('session_shutdown', () => { clearInterval(timer); timer = undefined; visible = false; close?.(); });
  return {
    command(args: string, ctx: ExtensionContext) {
      if (!ctx.hasUI) throw new Error('The team panel requires interactive Pi.');
      if (args === 'on') show(ctx);
      else if (args === 'off') hide();
      else if (!args) toggle(ctx);
      else throw new Error('Usage: /team panel [on|off]');
    },
  };
}
