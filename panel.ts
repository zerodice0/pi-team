import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { OverlayOptions, TuiMouseEvent } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { basename, join } from 'node:path';
import { status, teamLabel } from './board.ts';
import { readJson, root, teams, writeJson, type Participant } from './registry.ts';

// A non-capturing side panel, so the user can keep typing while teams work.
// By default it sits below quota-panel.ts (top-right, about ten rows) and shares that
// panel's titanium palette and frame, so the two read as one stack. In fullscreen mode
// the title row is a drag handle; the position is remembered in teams/panel.json.
const WIDTH = 50;
// pi-tui clamps an overlay to its margins after applying offsets, so a large top margin
// would pin the panel below it. Keep the margin minimal and express the default position
// (row 11, under quota-panel.ts) as an offset that dragging can change in both directions.
const MARGIN = 1;
const DEFAULT_Y = 10;
const RIGHT = 1;
const FRAME = 4; // title, two padding rows and the bottom border
const MIN_BODY = 3;
const RESERVE = 5; // bottom rows kept clear for the widget, editor and footer
const LIVE_ROWS = 5;
const REFRESH_MS = 2000;
const positionFile = join(root, 'panel.json');
type Info = ReturnType<typeof status>;

// Text uses name/label only (both pass 4.5:1 on the panel); dim and border carry rails and rules.
const palette = {
  panel: '#151820', border: '#2a3038', title: '#d4c090', name: '#e8ecf4', label: '#9ca3b0', dim: '#6b7280',
  ok: '#00b4ff', good: '#00ff88', warn: '#ffb347', crit: '#ff4757',
} as const;
type Tone = Exclude<keyof typeof palette, 'panel'>;
type Segment = [text: string, tone?: Tone, bold?: boolean];
type Line = { left: Segment[]; right?: Segment[] };
const rgb = (hex: string) => { const n = Number.parseInt(hex.slice(1), 16); return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`; };
const fg = (tone: Tone, text: string, bold = false) => `${bold ? '\x1b[1m' : ''}\x1b[38;2;${rgb(palette[tone])}m${text}\x1b[39m${bold ? '\x1b[22m' : ''}`;
const BG = `\x1b[48;2;${rgb(palette.panel)}m`;
const BG_OFF = '\x1b[49m';

const glyph: Record<string, [string, Tone]> = {
  working: ['▶', 'ok'], waiting: ['◆', 'warn'], idle: ['○', 'label'], done: ['✓', 'good'],
  failed: ['✗', 'crit'], stopped: ['■', 'label'], stale: ['!', 'warn'], starting: ['…', 'label'],
};
export const live = new Set(['working', 'waiting', 'idle', 'starting']);
export const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
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
function wrap(text: string, width: number, lines: number) {
  const out: string[] = [];
  let rest = text;
  while (rest && out.length < lines) {
    if (visibleWidth(rest) <= width || out.length === lines - 1) { out.push(clip(rest, width)); break; }
    let cut = 0;
    let used = 0;
    let space = -1;
    const chars = [...rest];
    for (let i = 0; i < chars.length; i++) {
      used += visibleWidth(chars[i]);
      if (used > width) break;
      if (chars[i] === ' ') space = i;
      cut = i + 1;
    }
    const at = space > width / 2 ? space : cut;
    out.push(chars.slice(0, at).join('').trimEnd());
    rest = chars.slice(at).join('').trimStart();
  }
  return out;
}
const short = (address?: string) => address?.split('@')[0] ?? '?';
const modelName = (model?: string) => model?.split('/').pop()?.replace(/^claude-/, '') ?? '—';
const tools: Record<string, string> = { team_wait: 'waiting for mail', team_send: 'sending mail', team_inbox: 'reading mail', team_peers: 'checking team', subagent: 'delegating', team_report: 'reporting' };
const idleWords: Record<string, string> = { working: 'thinking', waiting: 'waiting for mail', idle: 'idle', done: 'done', failed: 'failed', stopped: 'stopped', starting: 'starting', stale: 'offline' };
export function activity(p: { tool?: string; path?: string; error?: string }, state: string) {
  if (p.tool) return tools[p.tool] ?? `${p.tool}${p.path ? ` ${basename(p.path)}` : ''}`;
  return state === 'failed' && p.error ? `failed: ${oneLine(p.error)}` : idleWords[state] ?? state;
}
export function diffShort(diff: string) {
  const plus = /(\d+) insertion/.exec(diff)?.[1];
  const minus = /(\d+) deletion/.exec(diff)?.[1];
  return plus || minus ? `+${plus ?? 0} −${minus ?? 0}` : diff === 'clean' ? 'no changes' : '';
}

const KEY = 10;
const MODEL = 11;
function memberLine(p: { key: string; model?: string; fallback?: boolean; tool?: string; path?: string; error?: string }, state: string): Line {
  const [mark, tone] = glyph[state] ?? ['?', 'label'];
  const busy = state === 'working' || state === 'waiting';
  return {
    left: [['    '], [mark, tone], [' '], [clip(p.key, KEY).padEnd(KEY), 'name'], [' '], [activity(p, state), busy ? 'name' : 'label']],
    // A fallback model is shown in amber rather than with an extra glyph.
    right: [[clip(modelName(p.model), MODEL), p.fallback ? 'warn' : 'label']],
  };
}
export function teamLines(d: Info, inner: number): Line[] {
  const rows = [...d.rows].sort((a, b) => Number(live.has(b.state)) - Number(live.has(a.state)) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const working = rows.filter(p => p.state === 'working' || p.state === 'waiting').length + d.pending.length;
  const finished = rows.filter(p => !live.has(p.state)).length;
  // The lead may sit idle while its members work; show the team as working then.
  const teamState = working && (d.state === 'idle' || d.state === 'working') ? 'working' : d.state;
  const [mark, tone] = glyph[teamState] ?? ['?', 'label'];
  const summary = d.state === 'done' ? [`done`, diffShort(d.diff)].filter(Boolean).join(' · ')
    : d.state === 'stale' ? 'lead offline'
    : d.state === 'starting' ? 'starting'
    : [working && `${working} working`, finished && `${finished} done`].filter(Boolean).join(' · ') || d.state;
  const lines: Line[] = [{
    left: [[mark, tone], [' '], [teamLabel(d.team), 'name', true], [`  ${d.team.description ? oneLine(d.team.description) : d.team.preset}`, 'label']],
    right: [[summary, d.state === 'done' ? 'good' : d.state === 'stale' ? 'warn' : 'label']],
  }];
  const goal = wrap(oneLine(d.team.goal), inner - 2, d.state === 'done' ? 1 : 2);
  lines.push(...goal.map(text => ({ left: [['  '], [text, 'name']] as Segment[] })));
  if (d.state === 'done') return lines;
  const followUp = d.sent.filter(e => e.from === 'main' && e.to === `lead@${d.team.id}`).at(-1);
  if (followUp?.body) lines.push({ left: [['  + ', 'dim'], [oneLine(followUp.body), 'label']] });
  const people: { p: Parameters<typeof memberLine>[0]; state: string }[] = [
    ...(d.lead ? [{ p: { ...d.lead, key: 'lead' }, state: d.state }] : []),
    ...rows.filter(p => live.has(p.state)).map(p => ({ p, state: p.state })),
    ...d.pending.map(p => ({ p: { key: p.role, model: p.model }, state: 'starting' })),
  ];
  const done = rows.filter(p => !live.has(p.state));
  const shown = people.slice(0, LIVE_ROWS);
  const tail: Line[] = [];
  if (people.length > shown.length) tail.push({ left: [['      '], [`+${people.length - shown.length} more live`, 'label']] });
  // With nothing live, finished members are the story; otherwise fold them into one line.
  if (done.length && people.length <= 1 && done.length <= LIVE_ROWS - shown.length) shown.push(...done.map(p => ({ p, state: p.state })));
  else if (done.length) tail.push({ left: [['    '], [glyph.done[0], 'good'], [' '], [`${done.length} finished: ${done.map(p => p.key).join(', ')}`, 'label']] });
  const members = [...shown.map(({ p, state }) => memberLine(p, state)), ...tail];
  if (members.length) lines.push(...members);
  else lines.push({ left: [['    '], ['lead has not started yet', 'label']] });
  const mail = d.sent.filter(e => e.from !== 'main').at(-1);
  if (mail) lines.push({ left: [['  ✉ ', 'dim'], [`${short(mail.from)} → ${short(mail.to)}`, 'label'], ['  '], [oneLine(mail.subject ?? mail.body ?? ''), 'label']] });
  return lines;
}

interface Position { v?: number; offsetX: number; offsetY: number }
export function teamPanel(pi: ExtensionAPI, current?: string) {
  let data: Info[] = [];
  let loadError: string | undefined;
  let handle: { setHidden(hidden: boolean): void } | undefined;
  let close: (() => void) | undefined;
  let rerender: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let visible = false;
  let drag: { x: number; y: number; ox: number; oy: number } | undefined;
  const saved = readJson<Position>(positionFile);
  // Version 1 stored offsetY relative to the old 11-row top margin.
  const savedY = saved ? saved.v === 2 ? saved.offsetY : saved.offsetY + DEFAULT_Y : DEFAULT_Y;
  const options: OverlayOptions = {
    anchor: 'top-right', width: WIDTH, margin: { top: MARGIN, right: RIGHT }, nonCapturing: true,
    offsetX: saved?.offsetX ?? 0, offsetY: savedY,
    visible: (w, h) => w >= WIDTH + 40 && h >= MARGIN + FRAME + MIN_BODY + RESERVE + 4,
  };
  const maxY = (rows: number) => Math.max(0, rows - RESERVE - FRAME - MIN_BODY - MARGIN);
  const save = () => { try { writeJson(positionFile, { v: 2, offsetX: options.offsetX ?? 0, offsetY: options.offsetY ?? DEFAULT_Y }); } catch { /* position is a convenience */ } };
  const rank = (d: Info) => d.team.id === current ? 0 : d.state === 'done' ? 2 : 1;
  // Heartbeats rewrite lead.json and members every two seconds without changing what the panel shows.
  // Ask for a frame only when the drawn content changes; pi still calls render() on every frame it draws.
  let drawnWidth = WIDTH;
  let drawn = '';
  const load = () => {
    try { data = teams().map(status).sort((a, b) => rank(a) - rank(b) || b.team.createdAt - a.team.createdAt); loadError = undefined; }
    catch (e) { loadError = String(e); }
    const next = JSON.stringify([loadError, data.map(d => teamLines(d, drawnWidth - 4))]);
    if (next !== drawn) { drawn = next; rerender?.(); }
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
        return { out, used };
      };
      const row = (line: Line, width: number) => {
        const inner = width - 4;
        const right = line.right ? paint(line.right, Math.max(0, Math.floor(inner / 2))) : { out: '', used: 0 };
        const left = paint(line.left, inner - right.used - (right.used ? 1 : 0));
        const gap = ' '.repeat(Math.max(0, inner - left.used - right.used));
        return `${BG}${fg('border', '│')} ${left.out}${gap}${right.out} ${fg('border', '│')}${BG_OFF}`;
      };
      const rule = (width: number, [l, r]: [string, string]) => `${BG}${fg('border', `${l}${'─'.repeat(Math.max(0, width - 2))}${r}`)}${BG_OFF}`;
      const blank: Line = { left: [] };
      return {
        render(width: number) {
          drawnWidth = width;
          const inner = width - 4;
          const active = data.filter(d => d.state !== 'done').length;
          const blocks: Line[][] = loadError ? [[{ left: [[oneLine(loadError), 'crit']] }]]
            : data.length ? data.map(d => teamLines(d, inner))
            : [[{ left: [['No teams running', 'name', true]] }, { left: [['/team start <preset> -- <goal>', 'label']] },
              { left: [['Drag this title to move · alt+t to hide', 'label']] }]];
          // Fit the stack between the panel's top row and the editor, keeping whole teams where possible.
          const top = MARGIN + Math.min(options.offsetY ?? DEFAULT_Y, maxY(tui.terminal.rows));
          const room = Math.max(MIN_BODY, tui.terminal.rows - top - FRAME - RESERVE);
          const body: (Line | 'rule')[] = [];
          for (const [i, block] of blocks.entries()) {
            const need = block.length + (i ? 1 : 0);
            if (body.length + need > room) {
              const left = blocks.length - i;
              // A first team taller than the room is cut rather than dropped.
              if (i === 0) body.push(...block.slice(0, room - 1));
              if (body.length < room) body.push({ left: [['  '], [i === 0 ? '… more in /team board' : `+${left} more team${left === 1 ? '' : 's'} · /team board`, 'label']] });
              break;
            }
            if (i) body.push('rule');
            body.push(...block);
          }
          const dragging = !!drag;
          const title = ` ${fg(dragging ? 'ok' : 'title', 'pi-team', true)} `;
          const note = data.length ? fg('label', ` ${[active && `${active} active`, data.length - active && `${data.length - active} done`].filter(Boolean).join(' · ')} `) : '';
          const fill = Math.max(1, width - 2 - visibleWidth(title) - visibleWidth(note) - 2);
          const lines = [
            `${BG}${fg('border', '╭─')}${title}${fg('border', '─'.repeat(fill))}${note}${fg('border', '─╮')}${BG_OFF}`,
            row(blank, width),
            // Divide teams with plain rules: ├ and ┤ fall back to other fonts in some terminals and render broken.
            ...body.map(line => line === 'rule' ? `${BG}${fg('border', '│')} ${fg('border', '─'.repeat(Math.max(0, width - 4)))} ${fg('border', '│')}${BG_OFF}` : row(line, width)),
            row(blank, width),
            rule(width, ['╰', '╯']),
          ];
          return lines;
        },
        // Fullscreen mode routes mouse input to overlays; drag the title row to move the panel.
        handleMouse(event: TuiMouseEvent) {
          if (event.type === 'press' && event.button === 'left' && event.y === 0) {
            drag = { x: event.screenX, y: event.screenY, ox: options.offsetX ?? 0, oy: options.offsetY ?? 0 };
            return { capture: true };
          }
          if (!drag) return undefined;
          if (event.type === 'drag' || event.type === 'move') {
            const cols = tui.terminal.columns;
            const baseCol = cols - RIGHT - WIDTH;
            options.offsetX = Math.min(0, Math.max(-baseCol, drag.ox + event.screenX - drag.x));
            options.offsetY = Math.min(maxY(tui.terminal.rows), Math.max(0, drag.oy + event.screenY - drag.y));
            return { handled: true, capture: true, render: true };
          }
          if (event.type === 'release' || event.type === 'click') {
            drag = undefined;
            save();
            return { handled: true, render: true };
          }
          return { handled: true, capture: true };
        },
        invalidate() {},
      };
    }, { overlay: true, overlayOptions: options, onHandle: h => { handle = h; } })
      .finally(() => { handle = undefined; close = undefined; rerender = undefined; drag = undefined; });
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
      else if (args === 'reset') { options.offsetX = 0; options.offsetY = DEFAULT_Y; save(); show(ctx); rerender?.(); }
      else if (!args) toggle(ctx);
      else throw new Error('Usage: /team panel [on|off|reset]');
    },
  };
}
