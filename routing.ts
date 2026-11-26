import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { effectiveModels, isLevel, parseModel, readOverrides, routeTable, setOverride, type RoleOverride, type Scope } from './overrides.ts';
import { candidates, readPresets, type Role } from './presets.ts';
import { getLead, getTeam, isLive, members, teamTitle } from './registry.ts';

// Where /team effort, /team model and /team routes act:
//  - lead: its own team; the orchestrator's effort is pi's own thinking level (shift+tab works too)
//  - main session with --team <id>: that team, through its overrides file
//  - main session in main mode: the main preset; the orchestrator is the main model itself
export interface RouteTarget {
  scope: Scope; roles: Record<string, Role>; cwd: string; label: string;
  self?: 'lead' | 'main';
  current?: { model?: string; level?: string };
}
export function teamTarget(id: string, self = false): RouteTarget {
  const team = getTeam(id);
  if (!team) throw new Error(`Unknown team: ${id}`);
  const lead = getLead(id);
  return { scope: { team: id }, roles: readPresets(team.worktree, id)[team.preset], cwd: team.worktree, label: `${teamTitle(team)} (${id}, ${team.preset})`,
    self: self ? 'lead' : undefined, current: lead ? { model: lead.model, level: lead.level } : undefined };
}
export const cacheNote = 'Applies from the next request; a changed effort or model can rebuild part of the prompt cache once.';
const firstLevel = (item: Role) => (item.models[0]?.split(':').pop() ?? 'medium') as ThinkingLevel;

// Change one role's effort (null resets it). The orchestrator of this very session is pi's own thinking level.
export function applyEffort(pi: ExtensionAPI, t: RouteTarget, role: string, level: ThinkingLevel | null, leadLevel?: () => ThinkingLevel | undefined) {
  const item = t.roles[role];
  if (role === 'orchestrator' && t.self) {
    const next = level ?? (t.self === 'lead' ? leadLevel?.() : undefined) ?? firstLevel(item);
    pi.setThinkingLevel(next);
    return `orchestrator: thinking ${next} for this session`;
  }
  setOverride(t.scope, role, { level: level ?? undefined });
  return `${role}: effort ${level ?? 'reset to the preset'}`;
}
// Put one model in front of a role's candidates (null resets). In main mode the orchestrator is the main model.
export async function applyModel(pi: ExtensionAPI, ctx: ExtensionContext, t: RouteTarget, role: string, candidate: string | null) {
  const item = t.roles[role];
  if (role === 'orchestrator' && t.self === 'main') {
    const pick = candidates([candidate ?? item.models[0]], ctx.modelRegistry)[0];
    if (!pick) throw new Error(`${candidate ?? item.models[0]} is not available or not signed in here.`);
    if (!await pi.setModel(pick.model)) throw new Error(`Cannot switch to ${pick.key}.`);
    pi.setThinkingLevel(pick.level);
    return `orchestrator: main model ${pick.key}:${pick.level}`;
  }
  setOverride(t.scope, role, { model: candidate ?? undefined });
  const warn = candidate && !candidates([candidate], ctx.modelRegistry).length ? ` (warning: ${candidate} is not signed in here; the router will skip it)` : '';
  return `${role}: model ${candidate ?? 'reset to the preset'}${warn}`;
}
export const levelOf = (candidate: string) => candidate.split(':').pop() as ThinkingLevel;

// One row per role for the routes view: the chain the router would walk, what is live now.
export interface RouteRow {
  role: string; override?: RoleOverride; level: ThinkingLevel;
  steps: { key: string; level: string; usable: boolean; cooling: boolean; chosen: boolean }[];
  running: string[];
}
export function routeRows(t: RouteTarget, registry: ExtensionContext['modelRegistry'], thinking?: ThinkingLevel): RouteRow[] {
  const overrides = readOverrides(t.scope);
  const now = Date.now();
  const team = 'team' in t.scope ? t.scope.team : undefined;
  const live = team ? members(team).filter(m => isLive(m)) : [];
  return Object.entries(t.roles).map(([role, item]) => {
    const o = overrides[role];
    const chain = effectiveModels(item, o);
    const ready = candidates(chain, registry);
    const pick = ready.find(c => c.until <= now) ?? ready[0];
    const steps = chain.map((c, i) => {
      const state = ready.find(r => r.index === i);
      return { key: c.replace(/:[a-z]+$/, ''), level: o?.level ?? levelOf(c), usable: !!state, cooling: !!state && state.until > now, chosen: !!state && state === pick };
    });
    const selfLevel = role === 'orchestrator' && t.self ? thinking : undefined;
    const level = (selfLevel ?? o?.level ?? (pick ? levelOf(chain[pick.index]) : levelOf(chain[0]))) as ThinkingLevel;
    const running = role === 'orchestrator' ? (t.current?.model ? [`${t.current.model}${t.current.level ? `:${t.current.level}` : ''}`] : [])
      : live.filter(m => m.role === role).map(m => `${m.model ?? '?'}${m.level ? `:${m.level}` : ''}`);
    return { role, override: o, level, steps, running };
  });
}

export async function routeCommand(pi: ExtensionAPI, ctx: ExtensionContext, verb: 'effort' | 'model' | 'routes', args: string, target: (team?: string) => RouteTarget, leadLevel?: () => ThinkingLevel | undefined) {
  const words = args.split(/\s+/).filter(Boolean);
  const at = words.indexOf('--team');
  const teamArg = at >= 0 ? words[at + 1] : undefined;
  if (at >= 0) { if (!teamArg) throw new Error('--team needs a team ID.'); words.splice(at, 2); }
  const t = target(teamArg);
  const table = () => [`Routes for ${t.label}:`, routeTable(t.roles, ctx.modelRegistry, readOverrides(t.scope),
    t.current ? { role: 'orchestrator', ...t.current } : undefined)].join('\n');
  if (verb === 'routes') return table();
  const [role, value] = words;
  const usage = `Usage: /team ${verb} <role|all> <${verb === 'effort' ? 'level' : 'provider/model[:level] or alias[:level]'}|reset> [--team <id>]`;
  if (!role || !value || words.length > 2) throw new Error(usage);
  const roles = role === 'all' ? Object.keys(t.roles) : [role];
  for (const r of roles) if (!Object.hasOwn(t.roles, r)) throw new Error(`Unknown role ${r}. Roles: ${Object.keys(t.roles).join(', ')}.`);
  const reset = value === 'reset';
  if (verb === 'effort' && !reset && !isLevel(value)) throw new Error(`Unknown level ${value}. Use off, minimal, low, medium, high, xhigh or max.`);
  const notes: string[] = [];
  for (const r of roles) {
    if (verb === 'effort') notes.push(applyEffort(pi, t, r, reset ? null : value as ThinkingLevel, leadLevel));
    else notes.push(await applyModel(pi, ctx, t, r, reset ? null : parseModel(value, t.cwd, firstLevel(t.roles[r]))));
  }
  return [...notes, cacheNote, '', table()].join('\n');
}
