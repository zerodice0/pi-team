import { visibleWidth } from '@earendil-works/pi-tui';
import { basename } from 'node:path';
import type { status } from './board.ts';
import { ago, offlineFor, STALE_MS } from './disk.ts';

// Shared drawing for the side panel and the board: one titanium surface, a quiet border, gold for
// the product's name and the current choice, and color only where a state means something.
// Text uses name/label only (both pass 4.5:1 on the panel); dim and border carry rails and rules.
export const palette = {
  panel: '#151820', border: '#2a3038', title: '#d4c090', name: '#e8ecf4', label: '#9ca3b0', dim: '#6b7280',
  ok: '#00b4ff', good: '#00ff88', warn: '#ffb347', crit: '#ff4757',
} as const;
export type Tone = Exclude<keyof typeof palette, 'panel'>;
export type Segment = [text: string, tone?: Tone, bold?: boolean];
export type Line = { left: Segment[]; right?: Segment[] };
export type Info = ReturnType<typeof status>;
const rgb = (hex: string) => { const n = Number.parseInt(hex.slice(1), 16); return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`; };
export const fg = (tone: Tone, text: string, bold = false) => `${bold ? '\x1b[1m' : ''}\x1b[38;2;${rgb(palette[tone])}m${text}\x1b[39m${bold ? '\x1b[22m' : ''}`;
export const BG = `\x1b[48;2;${rgb(palette.panel)}m`;
export const BG_OFF = '\x1b[49m';

export const glyph: Record<string, [string, Tone]> = {
  working: ['▶', 'ok'], waiting: ['◆', 'warn'], idle: ['○', 'label'], done: ['✓', 'good'],
  failed: ['✗', 'crit'], stopped: ['■', 'label'], stale: ['!', 'warn'], starting: ['…', 'label'],
};
export const live = new Set(['working', 'waiting', 'idle', 'starting']);
// What is working spins, as in pi-subagents' async widget: a braille frame that advances once a
// second. `seed` offsets rows so they do not turn in lockstep. The board keeps the static ▶.
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPIN_MS = 1000;
export const spin = (seed: number, now = Date.now()) => SPIN[(Math.floor(now / SPIN_MS) + seed) % SPIN.length];
export const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
// Truncate plain text ourselves: truncateToWidth() inserts a full reset that would drop the panel background.
export function clip(text: string, width: number) {
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
export function wrap(text: string, width: number, lines = Infinity) {
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
    const at = space > width / 2 ? space : Math.max(1, cut);
    out.push(chars.slice(0, at).join('').trimEnd());
    rest = chars.slice(at).join('').trimStart();
  }
  return out;
}
export const pad = (text: string, width: number) => { const c = clip(text, width); return c + ' '.repeat(Math.max(0, width - visibleWidth(c))); };

export const short = (address?: string) => address?.split('@')[0] ?? '?';
export const modelName = (model?: string, level?: string) => `${model?.split('/').pop()?.replace(/^claude-/, '') ?? '—'}${model && level ? `·${level}` : ''}`;
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
// One reading of a team's state for every surface: the lead may sit idle while its members work.
export function headline(d: Info) {
  const working = d.rows.filter(p => p.state === 'working' || p.state === 'waiting').length + d.pending.length;
  const finished = d.rows.filter(p => !live.has(p.state)).length;
  const state = working && (d.state === 'idle' || d.state === 'working') ? 'working' : d.state;
  const [mark, tone] = glyph[state] ?? ['?', 'label'];
  const summary = d.state === 'done' ? ['done', diffShort(d.diff)].filter(Boolean).join(' · ')
    : d.state === 'stale' || (d.state === 'stopped' && !working) ? `lead offline ${ago(offlineFor(d.team, d.lead) ?? 0)}`
    : d.state === 'starting' ? 'starting'
    : [working && `${working} working`, finished && `${finished} done`].filter(Boolean).join(' · ') || d.state;
  // A lead gone for a day is how teams end up forgotten with gigabytes of builds: make it stand out.
  const away = d.state === 'stale' || d.state === 'stopped' ? offlineFor(d.team, d.lead) ?? 0 : 0;
  const summaryTone: Tone = d.state === 'done' ? 'good' : away >= STALE_MS ? 'crit' : d.state === 'stale' ? 'warn' : 'label';
  return { state, mark, tone, summary, summaryTone, working, finished };
}

// Paint segments into at most `width` columns; returns the text and the columns it used.
export function paint(segments: Segment[], width: number) {
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
}
// A framed row: │ left … right │ on the panel surface, one space of padding inside each border.
export function row(line: Line, width: number, rightShare = 0.5) {
  const inner = width - 4;
  const right = line.right ? paint(line.right, Math.max(0, Math.floor(inner * rightShare))) : { out: '', used: 0 };
  const left = paint(line.left, inner - right.used - (right.used ? 1 : 0));
  const gap = ' '.repeat(Math.max(0, inner - left.used - right.used));
  return `${BG}${fg('border', '│')} ${left.out}${gap}${right.out} ${fg('border', '│')}${BG_OFF}`;
}
// Divide blocks with plain rules: ├ and ┤ fall back to other fonts in some terminals and render broken.
export const divider = (width: number) => `${BG}${fg('border', '│')} ${fg('border', '─'.repeat(Math.max(0, width - 4)))} ${fg('border', '│')}${BG_OFF}`;
// A top or bottom border with painted labels set into it: ╭─ left ───── right ─╮
export function edge(width: number, [l, r]: [string, string], left: string, right = '', tone: Tone = 'border') {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  const fill = Math.max(1, width - 4 - lw - rw);
  return `${BG}${fg(tone, `${l}─`)}${left}${fg(tone, '─'.repeat(fill))}${right}${fg(tone, `─${r}`)}${BG_OFF}`;
}
