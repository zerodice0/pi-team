import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { join } from 'node:path';
import { candidates, levels, presetCatalog, type Role } from './presets.ts';
import { locked, mkdir, readJson, root, teamDir, writeJson } from './registry.ts';

// Temporary routing changes on top of a preset: a role's effort, or a model tried before its
// candidates. They live beside the team (or the main-mode session) and never touch presets.json,
// so closing the team or leaving main mode drops them. Routers read them on every request.
export interface RoleOverride { level?: ThinkingLevel; model?: string }
export type Overrides = Record<string, RoleOverride>;
export type Scope = { team: string } | { main: string };
export const scopePath = (s: Scope) => 'team' in s ? join(teamDir(s.team), 'overrides.json') : join(root, 'main-overrides', `${s.main.replace(/[^\w.-]/g, '_')}.json`);
// The router's own scope: a team process (lead or member) or a child delegated in main mode.
export function ambientScope(): Scope | undefined {
  if (process.env.PI_TEAM_ID) return { team: process.env.PI_TEAM_ID };
  if (process.env.PI_TEAM_MAIN_KEY) return { main: process.env.PI_TEAM_MAIN_KEY };
}
export function readOverrides(scope?: Scope): Overrides {
  if (!scope) return {};
  try { return readJson<Overrides>(scopePath(scope)) ?? {}; } catch { return {}; }
}
export function setOverride(scope: Scope, role: string, patch: RoleOverride | null) {
  const path = scopePath(scope);
  mkdir(join(path, '..'));
  return locked(`${path}.lock`, () => {
    const all = readOverrides(scope);
    const next = patch ? { ...all[role], ...patch } : undefined;
    for (const k of ['level', 'model'] as const) if (next && next[k] === undefined) delete next[k];
    if (next && Object.keys(next).length) all[role] = next; else delete all[role];
    writeJson(path, all);
    return all;
  });
}
export const isLevel = (s: string): s is ThinkingLevel => (levels as readonly string[]).includes(s);
// Accept provider/id[:level] or a model alias from the presets (opus, sol, ...), with an optional level.
export function parseModel(input: string, cwd: string, fallbackLevel: ThinkingLevel) {
  const m = /^([^:]+)(?::([a-z]+))?$/.exec(input.trim());
  if (!m || (m[2] && !isLevel(m[2]))) throw new Error(`Invalid model ${input}: use provider/model[:level] or an alias such as opus:high.`);
  const id = m[1].includes('/') ? m[1] : presetCatalog(cwd).models[m[1]];
  if (!id) throw new Error(`Unknown model alias ${m[1]}. Use provider/model or one of: ${Object.keys(presetCatalog(cwd).models).join(', ')}.`);
  return `${id}:${m[2] ?? fallbackLevel}`;
}
// The candidate chain a role actually routes through: an override model first, then the preset's.
export function effectiveModels(item: Role, override?: RoleOverride) {
  if (!override?.model) return item.models;
  const key = (c: string) => c.replace(/:[a-z]+$/, '');
  return [override.model, ...item.models.filter(c => key(c) !== key(override.model!))];
}
const short = (key: string) => key.split('/').pop()!.replace(/^claude-/, '');
// One line per role: where a request would go now, then the fallbacks; override marks and unusable candidates.
export function routeTable(roles: Record<string, Role>, registry: ExtensionContext['modelRegistry'], overrides: Overrides, current?: { role: string; model?: string; level?: string }) {
  const now = Date.now();
  const width = Math.max(...Object.keys(roles).map(r => r.length));
  return Object.entries(roles).map(([role, item]) => {
    const o = overrides[role];
    const chain = effectiveModels(item, o);
    const ready = candidates(chain, registry);
    const pick = ready.find(c => c.until <= now) ?? ready[0];
    const steps = chain.map((c, i) => {
      const [key, lvl] = [c.replace(/:[a-z]+$/, ''), c.split(':').pop()!];
      const state = ready.find(r => r.index === i);
      const level = o?.level ?? lvl;
      const mark = !state ? ' (no auth)' : state.until > now ? ' (cooling)' : '';
      return `${state && state === pick ? '▸' : ''}${short(key)}·${level}${mark}`;
    });
    const live = current?.role === role && current.model ? `  now ${short(current.model)}·${current.level ?? '?'}` : '';
    const tags = [o?.model && 'model override', o?.level && 'effort override'].filter(Boolean).join(', ');
    return `${role.padEnd(width)}  ${steps.join(' → ')}${tags ? `  [${tags}]` : ''}${live}`;
  }).join('\n');
}
