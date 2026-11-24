import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { status, teamLabel } from './board.ts';
import { teams, type Participant } from './registry.ts';

// A non-capturing side panel, so the user can keep typing while teams work.
// It sits below quota-panel.ts (top-right, about ten rows) instead of covering it,
// and shares that panel's titanium palette and frame so the two read as one stack.
const WIDTH = 50;
const TOP = 11;
const MEMBERS = 6;
const REFRESH_MS = 2000;
type Info = ReturnType<typeof status>;
const palette = {
  panel: '#151820', border: '#2a3038', title: '#d4c090', name: '#e8ecf4', label: '#9ca3b0', dim: '#6b7280',
  ok: '#00b4ff', good: '#00ff88', warn: '#ffb347', crit: '#ff4757',
} as const;
type Tone = Exclude<keyof typeof palette, 'panel'>;
type Segment = [string, Tone?, boolean?];
const rgb = (hex: string) => { const n = Number.parseInt(hex.slice(1), 16); return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`; };
const fg = (tone: Tone, text: string, bold = false) => `${bold ? '\x1b[1m' : ''}\x1b[38;2;${rgb(palette[tone])}m${text}\x1b[39m${bold ? '\x1b[22m' : ''}`;
const BG = `\x1b[48;2;${rgb(palette.panel)}m`;
const BG_OFF = '\x1b[49m';
const icons: Record<string, Segment> = {
  working: ['▶', 'ok'], waiting: ['⧗', 'warn'], idle: ['·', 'dim'], done: ['✓', 'good'],
  failed: ['✗', 'crit'], stopped: ['■', 'dim'], stale: ['!', 'warn'], starting: ['…', 'label'],
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
  const [icon, tone] = icons[state] ?? ['?', 'dim'];
  return [['  '], [icon, tone], [' '], [fixed(p.key, 11), 'name'], [' '], [fixed(model(p), 16), 'label'], [' '],
    [p.tool ? `${p.tool}${p.path ? ` ${p.path}` : ''}` : state, 'dim']];
}
export function teamLines(d: Info): Segment[][] {
  const [icon, tone] = icons[d.state] ?? ['?', 'dim'];
  const lines: Segment[][] = [[[icon, tone], [' '], [teamLabel(d.team), 'name', true], [` ${d.team.preset} · ${d.state} · ✉${d.sent.length}`, 'label']]];
  lines.push([['  goal ', 'label'], [oneLine(d.team.goal), 'name']]);
  const delegated = d.sent.filter(e => e.from === 'main' && e.to === `lead@${d.team.id}`).at(-1);
  if (delegated?.body) lines.push([['  main ', 'label'], [oneLine(delegated.body), 'name']]);
  const rows = [...d.rows].sort((a, b) => Number(live.has(b.state)) - Number(live.has(a.state)) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  if (d.state === 'done') {
    lines.push([['  '], [`${rows.length} member${rows.length === 1 ? '' : 's'} · ${d.diff}`, 'dim']]);
    return lines;
  }
  const members = [
    ...(d.lead ? [memberLine(d.lead, d.state)] : [[['  '], ['… lead not registered yet', 'dim']] as Segment[]]),
    ...rows.map(p => memberLine(p, p.state)),
    ...d.pending.map(p => memberLine({ key: p.role, model: p.model }, 'starting')),
  ];
  if (members.length > MEMBERS) {
    const hidden = members.length - (MEMBERS - 1);
    lines.push(...members.slice(0, MEMBERS - 1), [['  '], [`… +${hidden} more (/team board)`, 'dim']]);
  } else lines.push(...members);
  const last = d.sent.filter(e => e.from !== 'main').at(-1);
  if (last) lines.push([['  ✉ ', 'dim'], [`${short(last.from)}→${short(last.to)}: ${oneLine(last.subject ?? last.body ?? '')}`, 'dim']]);
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
    else void ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      rerender = () => tui.requestRender();
      close = () => done();
      const paint = (segments: Segment[], width: number) => {
        let used = 0;
        let out = '';
        for (const [text, tone, bold] of segments) {
          const part = clip(text, width - used);
          if (!part) break;
          used += visibleWidth(part);
          out += tone ? fg(tone, part, bold) : part;
          if (part !== text) break;
        }
        return out + ' '.repeat(Math.max(0, width - used));
      };
      const row = (segments: Segment[], width: number) => `${BG}${fg('border', '│')} ${paint(segments, width - 4)} ${fg('border', '│')}${BG_OFF}`;
      return {
        render(width: number) {
          const body: Segment[][] = loadError ? [[[oneLine(loadError), 'crit']]]
            : data.length ? data.flatMap((d, i) => [...(i ? [[] as Segment[]] : []), ...teamLines(d)])
            : [[['No teams. /team start <preset> -- <goal>', 'dim']]];
          const room = Math.max(3, tui.terminal.rows - TOP - 10);
          const shown = body.length > room ? [...body.slice(0, room - 1), [['… more in /team board', 'dim']] as Segment[]] : body;
          const title = ` ${fg('title', 'pi-team', true)} `;
          const note = fg('dim', ` ${data.length} team${data.length === 1 ? '' : 's'} · alt+t `);
          const fill = Math.max(1, width - 2 - visibleWidth(title) - visibleWidth(note) - 2);
          return [
            `${BG}${fg('border', '╭─')}${title}${fg('border', '─'.repeat(fill))}${note}${fg('border', '─╮')}${BG_OFF}`,
            row([], width),
            ...shown.map(segments => row(segments, width)),
            row([], width),
            `${BG}${fg('border', `╰${'─'.repeat(Math.max(0, width - 2))}╯`)}${BG_OFF}`,
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
  // ctrl+shift+t needs a terminal that reports modified keys; alt+t works everywhere.
  for (const key of ['ctrl+shift+t', 'alt+t'] as const) {
    pi.registerShortcut(key, { description: 'Toggle the pi-team side panel', handler: async ctx => { if (ctx.hasUI) toggle(ctx); } });
  }
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
