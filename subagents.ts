import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { ago } from './disk.ts';
import { clip, glyph, modelName, oneLine, type Line } from './frame.ts';

// This session's background subagents for the side panel, read through pi-subagents' in-process RPC
// (docs/extension-api.md, "Refresh a host view without polling"): one `status` read when the panel
// opens, then one more after any change event, coalesced. Nothing is read while the panel is hidden.
interface Activity { currentTool?: string; currentToolStartedAt?: number; turnCount?: number }
interface SnapshotNode {
  kind: string; label: string; state: string; agent?: string; model?: string; thinking?: string;
  startedAt?: number; endedAt?: number; activity?: Activity; children?: SnapshotNode[];
}
interface StatusData { fleet?: { entries?: { tokens?: { total?: number } }[] }; asyncSnapshot?: { runs?: SnapshotNode[] } }
export interface SubRow {
  agent: string; label: string; state: 'running' | 'queued' | 'done' | 'failed' | 'stopped';
  tool?: string; toolSince?: number; turns?: number; model?: string; level?: string; startedAt?: number;
}
export interface SubData { rows: SubRow[]; tokens: number }

const REQUEST = 'subagents:rpc:v1:request';
const REPLY = 'subagents:rpc:v1:reply:';
const CHANGES = ['subagents:rpc:v1:ready', 'subagent:jobs-changed', 'subagent:async-started', 'subagent:child-status', 'subagent:async-complete', 'subagent:process-terminal'];
const COALESCE_MS = 250;
const TIMEOUT_MS = 5000;

const stateOf = (s: string): SubRow['state'] =>
  s === 'running' ? 'running' : s === 'queued' ? 'queued' : s === 'complete' ? 'done' : s === 'paused' || s === 'stopped' ? 'stopped' : 'failed';
// One row per child: a single or parallel run lists its steps; a workflow is one row of its own.
export function rowsOf(runs: SnapshotNode[], skip: (agent: string) => boolean): SubRow[] {
  const rows: SubRow[] = [];
  for (const run of runs) {
    const steps = run.kind !== 'workflow' ? (run.children ?? []).filter(c => c.kind === 'step') : [];
    for (const n of steps.length ? steps : [run]) {
      const agent = n.agent ?? n.label;
      if (skip(agent)) continue;
      const a = n.activity ?? run.activity;
      rows.push({
        agent, label: n.label, state: stateOf(n.state), tool: a?.currentTool, toolSince: a?.currentToolStartedAt, turns: a?.turnCount,
        model: n.model, level: n.thinking, startedAt: n.startedAt ?? run.startedAt,
      });
    }
  }
  return rows;
}

export function subagentFeed(pi: ExtensionAPI, skip: (agent: string) => boolean, changed: () => void) {
  let data: SubData = { rows: [], tokens: 0 };
  let active = false;
  let reading = false;
  let again = false;
  let timer: NodeJS.Timeout | undefined;
  const read = () => {
    if (!active) return;
    if (reading) { again = true; return; }
    reading = true;
    const requestId = randomUUID();
    let off = () => {};
    const done = () => {
      off(); clearTimeout(limit); reading = false;
      if (again) { again = false; schedule(); }
    };
    // Without pi-subagents nobody answers; the panel then simply has no subagents to show.
    const limit = setTimeout(done, TIMEOUT_MS);
    limit.unref?.();
    off = pi.events.on(`${REPLY}${requestId}`, raw => {
      const reply = raw as { success?: boolean; data?: StatusData };
      if (reply.success && reply.data) {
        data = {
          rows: rowsOf(reply.data.asyncSnapshot?.runs ?? [], skip),
          tokens: (reply.data.fleet?.entries ?? []).reduce((sum, e) => sum + (e.tokens?.total ?? 0), 0),
        };
        changed();
      }
      done();
    });
    pi.events.emit(REQUEST, { version: 1, requestId, method: 'status', params: {} });
  };
  const schedule = () => {
    if (!active || timer) return;
    timer = setTimeout(() => { timer = undefined; read(); }, COALESCE_MS);
    timer.unref?.();
  };
  for (const name of CHANGES) pi.events.on(name, schedule);
  return {
    data: () => data,
    start() { active = true; read(); },
    stop() { active = false; clearTimeout(timer); timer = undefined; },
  };
}

const short = (agent: string) => agent.replace(/^pi-team\./, '');
const tokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
const NAME = 10;
const since = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : ago(ms);
const STATS = 22;
function doing(r: SubRow, now: number) {
  if (r.state === 'queued') return 'queued';
  if (!r.tool) return 'thinking';
  const secs = r.toolSince ? Math.floor((now - r.toolSince) / 1000) : 0;
  return secs >= 5 ? `${r.tool} ${since(secs * 1000)}` : r.tool;
}
// Two lines per live child (what it is doing and its model; its label, turns and age), then the
// finished ones folded into a line per outcome. Empty when nothing ran.
export function subagentLines(d: SubData, inner: number, now = Date.now()): Line[] {
  if (!d.rows.length) return [];
  const live = d.rows.filter(r => r.state === 'running' || r.state === 'queued');
  const running = live.filter(r => r.state === 'running').length;
  const lines: Line[] = [{
    left: [['⋮', running ? 'ok' : 'label'], [' '], ['subagents', 'name', true]],
    right: [[[running && `${running} running`, live.length - running && `${live.length - running} queued`, d.tokens && `${tokens(d.tokens)} tok`].filter(Boolean).join(' · '), 'label']],
  }];
  for (const r of live) {
    const [mark, tone] = r.state === 'running' ? glyph.working : glyph.starting;
    lines.push({
      left: [['    '], [mark, tone], [' '], [clip(short(r.agent), NAME).padEnd(NAME), 'name'], [' '], [doing(r, now), 'name']],
      right: [[modelName(r.model, r.level), 'label']],
    });
    const stats = [r.turns != null && `${r.turns} turns`, r.startedAt && since(now - r.startedAt)].filter(Boolean).join(' · ');
    const label = r.label !== r.agent ? oneLine(r.label) : '';
    if (label || stats) lines.push({ left: [['      '], [clip(label, inner - 6 - STATS - 1), 'label']], right: [[stats, 'label']] });
  }
  for (const [state, title] of [['done', 'finished'], ['failed', 'failed'], ['stopped', 'stopped']] as const) {
    const ended = d.rows.filter(r => r.state === state);
    if (!ended.length) continue;
    const [mark, tone] = glyph[state];
    lines.push({ left: [['    '], [mark, tone], [' '], [`${ended.length} ${title}: ${ended.map(r => r.label !== r.agent ? oneLine(r.label) : short(r.agent)).join(', ')}`, 'label']] });
  }
  return lines;
}

// pi-subagents' under-editor async widget repeats what the panel shows, so it gives way while the
// panel is on screen. pi-subagents reads its `asyncWidget` setting once and has no runtime switch,
// and pi has no API to hide another extension's widget, so this wraps the session's shared
// ctx.ui.setWidget: the widget pi-subagents mounts under its key renders no lines while `hidden()`
// holds and is otherwise untouched (its updates, mouse folding and dispose still reach it). If a
// later pi-subagents renames the key, nothing is wrapped and the widget simply stays.
const ASYNC_WIDGET = 'subagent-async';
const HOOK = Symbol.for('pi-team.async-widget');
type Ui = ExtensionContext['ui'] & { [HOOK]?: true };
type Hidden = () => boolean;
const shared = globalThis as { [HOOK]?: { hidden: Hidden; mounted: number } };
// Pass a context from an event handler: its ui is the object every extension's ctx.ui returns. A
// shortcut's or command's context can carry another copy, and wrapping that one would miss
// pi-subagents' calls.
export function quietAsyncWidget(ctx: ExtensionContext, hidden: Hidden) {
  // A reloaded pi-team replaces the predicate; the wrapper reads whichever is current.
  const state = shared[HOOK] ??= { hidden, mounted: 0 };
  state.hidden = hidden;
  const ui = ctx.ui as Ui;
  if (!ui[HOOK]) {
    const original = ui.setWidget.bind(ui) as (key: string, content: unknown, options?: unknown) => void;
    ui[HOOK] = true;
    (ui as { setWidget: unknown }).setWidget = (key: string, content: unknown, options?: unknown) => {
      if (key !== ASYNC_WIDGET || typeof content !== 'function') return original(key, content, options);
      return original(key, (tui: { requestRender(): void }, theme: unknown) => {
        const inner = (content as (tui: unknown, theme: unknown) => { render(width: number): string[]; dispose?(): void })(tui, theme);
        state.mounted++;
        return new Proxy(inner, {
          get(target, prop) {
            if (prop === 'render') return (width: number) => state.hidden() ? [] : target.render(width);
            if (prop === 'dispose') return () => { state.mounted--; target.dispose?.(); };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }, options);
    };
  }
  // A widget mounted before the wrapper existed cannot be hidden; drop it so pi-subagents mounts it
  // again through the wrapper on its next update (it remounts whenever its mounted widget is gone).
  if (!state.mounted) ui.setWidget(ASYNC_WIDGET, undefined);
}
