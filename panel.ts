import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { OverlayOptions, TuiMouseEvent } from '@earendil-works/pi-tui';
import { join } from 'node:path';
import { status, teamLabel } from './board.ts';
import { activity, clip, divider, edge, fg, glyph, headline, live, modelName, oneLine, row, short, wrap, type Info, type Line, type Segment } from './frame.ts';

export { activity, diffShort, live, oneLine } from './frame.ts';
import { goalDetail, readJson, root, teams, writeJson, type Participant } from './registry.ts';

// A non-capturing side panel, so the user can keep typing while teams work.
// By default it sits below quota-panel.ts (top-right, about ten rows) and shares that
// panel's titanium palette and frame, so the two read as one stack. In fullscreen mode
// the title row is a drag handle; the position is remembered in teams/panel.json.
const WIDTH = 60;
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
  const { mark, tone, summary, summaryTone } = headline(d);
  const lines: Line[] = [{
    left: [[mark, tone], [' '], [teamLabel(d.team), 'name', true]],
    right: [[summary, summaryTone]],
  }];
  const goal = wrap(goalDetail(d.team), inner - 2, d.state === 'done' ? 1 : 2);
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
    // Saved values may come from v1, which allowed offsets that pi-tui then clamped away.
    offsetX: Math.min(0, saved?.offsetX ?? 0), offsetY: Math.max(0, savedY),
    visible: (w, h) => w >= WIDTH + 40 && h >= MARGIN + FRAME + MIN_BODY + RESERVE + 4,
  };
  const maxY = (rows: number) => Math.max(0, rows - RESERVE - FRAME - MIN_BODY - MARGIN);
  // Offsets pi-tui can draw: column 0 through the right margin, row 0 through maxY.
  const clampX = (x: number, cols: number) => Math.min(0, Math.max(-Math.max(0, cols - RIGHT - WIDTH), x));
  const clampY = (y: number, rows: number) => Math.min(maxY(rows), Math.max(0, y));
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
          const lines = [
            edge(width, ['╭', '╮'], title, note),
            row(blank, width),
            ...body.map(line => line === 'rule' ? divider(width) : row(line, width)),
            row(blank, width),
            edge(width, ['╰', '╯'], ''),
          ];
          return lines;
        },
        // Fullscreen mode routes mouse input to overlays; drag the title row to move the panel.
        handleMouse(event: TuiMouseEvent) {
          if (event.type === 'press' && event.button === 'left' && event.y === 0) {
            // Start from where pi-tui actually drew the panel. A position saved in a larger terminal,
            // or kept across a resize, lies outside the current range and would leave a dead zone.
            drag = { x: event.screenX, y: event.screenY, ox: clampX(options.offsetX ?? 0, tui.terminal.columns), oy: clampY(options.offsetY ?? DEFAULT_Y, tui.terminal.rows) };
            return { capture: true };
          }
          if (!drag) return undefined;
          if (event.type === 'drag' || event.type === 'move') {
            options.offsetX = clampX(drag.ox + event.screenX - drag.x, tui.terminal.columns);
            options.offsetY = clampY(drag.oy + event.screenY - drag.y, tui.terminal.rows);
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
