import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { edge, fg, pad, row, type Line, type Segment, type Tone } from './frame.ts';
import { levels, presetCatalog } from './presets.ts';
import { setOverride } from './overrides.ts';
import { applyEffort, applyModel, cacheNote, levelOf, routeRows, type RouteRow, type RouteTarget } from './routing.ts';

// The routes overlay: one row per role with where its next request goes, its fallbacks and
// what runs now. ←→ steps the effort, m picks a model, r/R reset; changes save at once and
// apply from each member's next request. Tab switches between main mode and the live teams.
const short = (key: string) => key.split('/').pop()!.replace(/^claude-/, '');
const blank: Line = { left: [] };
type Exit = { pick: { role: string; target: number; selected: number } } | undefined;

export async function routesView(pi: ExtensionAPI, ctx: ExtensionContext, targets: () => RouteTarget[], leadLevel?: () => ThinkingLevel | undefined) {
  if (!ctx.hasUI) throw new Error('The routes view needs interactive Pi; use /team routes --text.');
  let ti = 0;
  let selected = 0;
  let note = '';
  let noteTone: Tone = 'label';
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const exit = await ctx.ui.custom<Exit>((tui, _theme, _keys, done) => {
      timer = setInterval(() => tui.requestRender(), 2000).unref();
      let list = targets();
      let rows: RouteRow[] = [];
      let offset = 0;
      const target = () => list[Math.min(ti, list.length - 1)];
      const refresh = () => {
        list = targets();
        if (!list.length) return;
        rows = routeRows(target(), ctx.modelRegistry, pi.getThinkingLevel(), leadLevel);
        selected = Math.max(0, Math.min(selected, rows.length - 1));
      };
      const say = (text: string, tone: Tone = 'label') => { note = text; noteTone = tone; };
      const act = (fn: () => string) => { try { say(`${fn()}. ${cacheNote}`, 'warn'); } catch (e) { say(e instanceof Error ? e.message : String(e), 'crit'); } refresh(); };
      return {
        render(width: number) {
          refresh();
          const inner = width - 4;
          const height = Math.max(12, Math.min(tui.terminal.rows - 2, 44));
          const t = list.length ? target() : undefined;
          const tabs = list.map((x, i) => i === Math.min(ti, list.length - 1) ? fg('title', x.label, true) : fg('label', x.label)).join(fg('dim', ' · '));
          const body: Line[] = [];
          if (!t) body.push({ left: [['  '], ['Nothing to route: turn on /team main <preset> or start a team.', 'label']] });
          else {
            const wRole = Math.max(4, ...rows.map(r => r.role.length));
            const nowText = (r: RouteRow) => { const s = r.steps.find(x => x.chosen); return s ? `${short(s.key)}·${r.level}` : 'no signed-in model'; };
            const wNow = Math.min(26, Math.max(3, ...rows.map(r => visibleWidth(nowText(r)))));
            const runText = (r: RouteRow) => r.running.length ? r.running.map(m => `${short(m.replace(/:[a-z]+$/, ''))}·${levelOf(m)}`).join(', ') : '';
            const wRun = Math.min(28, Math.max(7, ...rows.map(r => visibleWidth(runText(r)))));
            const wBack = Math.max(8, inner - 2 - wRole - wNow - wRun - 8);
            body.push({ left: [['  '], [pad('ROLE', wRole), 'dim'], ['  '], [pad('NEXT', wNow), 'dim'], ['  '], [pad('FALLBACK', wBack), 'dim'], ['  '], ['RUNNING', 'dim']] });
            const room = Math.max(3, height - 8);
            offset = Math.max(0, Math.min(offset, selected, rows.length - room));
            if (selected >= offset + room) offset = selected - room + 1;
            for (const [i, r] of rows.slice(offset, offset + room).entries()) {
              const at = offset + i;
              const chosen = r.steps.find(s => s.chosen);
              const changed = !!(r.override?.level || r.override?.model);
              const nowTone: Tone = !chosen ? 'crit' : changed ? 'warn' : 'name';
              const back = r.steps.filter(s => !s.chosen).map(s => `${short(s.key)}·${s.level}${!s.usable ? ' (no auth)' : s.cooling ? ' (cooling)' : ''}`).join(' → ') || '—';
              const rail: Segment = at === selected ? ['▌ ', 'title'] : ['  '];
              body.push({ left: [rail, [pad(r.role, wRole), at === selected ? 'name' : 'label', at === selected], ['  '], [pad(nowText(r), wNow), nowTone], ['  '],
                [pad(back, wBack), 'label'], ['  '], [runText(r) || '—', r.running.length ? 'ok' : 'dim']] });
            }
            if (rows.length > room) body.push({ left: [['  '], [`${offset + 1}–${Math.min(rows.length, offset + room)} of ${rows.length} roles`, 'dim']] });
          }
          const keys = (k: string, what: string) => `${fg('name', k)} ${fg('label', what)}`;
          const footer = ` ${[keys('↑↓', 'role'), keys('←→', 'effort'), keys('m', 'model'), keys('r', 'reset'), keys('R', 'reset all'), keys('tab', 'scope'), keys('esc', 'close')].join(fg('dim', '  '))} `;
          const lines = [
            edge(width, ['╭', '╮'], ` ${fg('title', 'pi-team routes', true)} `, list.length > 1 ? ` ${tabs} ` : t ? ` ${fg('label', t.label)} ` : ''),
            row(blank, width),
            ...body.map(l => row(l, width, 0.3)),
            ...Array.from({ length: Math.max(0, height - 4 - body.length - 2) }, () => row(blank, width)),
            row(note ? { left: [['  '], [note, noteTone]] } : blank, width, 0),
            row(blank, width),
            edge(width, ['╰', '╯'], footer),
          ];
          return lines;
        },
        handleInput(key: string) {
          if (matchesKey(key, 'escape')) { done(undefined); return; }
          if (!list.length) return;
          const t = target();
          const r = rows[selected];
          if (matchesKey(key, 'up')) selected = Math.max(0, selected - 1);
          else if (matchesKey(key, 'down')) selected = Math.min(rows.length - 1, selected + 1);
          else if (matchesKey(key, 'tab')) { ti = (Math.min(ti, list.length - 1) + 1) % list.length; selected = 0; offset = 0; say(''); }
          else if (r && (matchesKey(key, 'left') || matchesKey(key, 'right'))) {
            const i = levels.indexOf(r.level as (typeof levels)[number]);
            const next = levels[Math.max(0, Math.min(levels.length - 1, i + (matchesKey(key, 'right') ? 1 : -1)))];
            if (next !== r.level) act(() => applyEffort(pi, t, r.role, next, leadLevel));
          }
          else if (r && key === 'm') { done({ pick: { role: r.role, target: ti, selected } }); return; }
          else if (r && key === 'r') act(() => { applyEffort(pi, t, r.role, null, leadLevel); return r.role === 'orchestrator' && t.self === 'main' ? `${r.role}: effort reset (use m to change the main model)` : (setOverride(t.scope, r.role, null), `${r.role}: reset to the preset`); });
          else if (key === 'R') act(() => { for (const x of rows) { if (x.role === 'orchestrator' && t.self) applyEffort(pi, t, x.role, null, leadLevel); if (x.role !== 'orchestrator' || t.self !== 'main') setOverride(t.scope, x.role, null); } return 'all roles reset to the preset'; });
          tui.requestRender();
        },
        invalidate() {},
      };
    }, { overlay: true, overlayOptions: { width: '92%', minWidth: 72, anchor: 'center' } }).finally(() => clearInterval(timer));
    if (!exit) return;
    // Model picking leaves the overlay for pi's selector, then comes back to the same row.
    const t = targets()[exit.pick.target];
    if (!t) return;
    const role = exit.pick.role;
    const level = routeRows(t, ctx.modelRegistry, pi.getThinkingLevel(), leadLevel).find(r => r.role === role)?.level ?? 'medium';
    const aliases = Object.entries(presetCatalog(t.cwd).models);
    const options = [...new Set([...t.roles[role].models.map(c => c.replace(/:[a-z]+$/, '')), ...aliases.map(([, id]) => id)])]
      .filter(id => { const [p, ...rest] = id.split('/'); const m = ctx.modelRegistry.find(p, rest.join('/')); return m && ctx.modelRegistry.hasConfiguredAuth(m); });
    const labels = options.map(id => `${aliases.find(([, v]) => v === id)?.[0] ?? short(id)}  ${id}:${level}`);
    const reset = 'Reset to the preset';
    const choice = await ctx.ui.select(`First model for ${role} (${t.label})`, [...labels, reset]);
    ti = exit.pick.target; selected = exit.pick.selected;
    if (choice) {
      try {
        const candidate = choice === reset ? null : `${options[labels.indexOf(choice)]}:${level}`;
        note = `${await applyModel(pi, ctx, t, role, candidate)}. ${cacheNote}`; noteTone = 'warn';
      } catch (e) { note = e instanceof Error ? e.message : String(e); noteTone = 'crit'; }
    }
  }
}
