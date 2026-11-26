import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { isLevel, parseModel, readOverrides, routeTable, setOverride, type Scope } from './overrides.ts';
import { candidates, readPresets, type Role } from './presets.ts';
import { getLead, getTeam } from './registry.ts';

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
  return { scope: { team: id }, roles: readPresets(team.worktree, id)[team.preset], cwd: team.worktree, label: `team ${id} (${team.preset})`,
    self: self ? 'lead' : undefined, current: lead ? { model: lead.model, level: lead.level } : undefined };
}
const cacheNote = 'Applies from the next request; a changed effort or model can rebuild part of the prompt cache once.';
const firstLevel = (item: Role) => (item.models[0]?.split(':').pop() ?? 'medium') as ThinkingLevel;

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
    const item = t.roles[r];
    // The orchestrator of this very session is pi's own model and thinking level.
    if (r === 'orchestrator' && t.self) {
      if (verb === 'effort') {
        const level = reset ? (t.self === 'lead' ? leadLevel?.() : undefined) ?? firstLevel(item) : value as ThinkingLevel;
        pi.setThinkingLevel(level);
        notes.push(`orchestrator: thinking ${level} for this session`);
        continue;
      }
      if (t.self === 'main') {
        const candidate = reset ? item.models[0] : parseModel(value, t.cwd, firstLevel(item));
        const pick = candidates([candidate], ctx.modelRegistry)[0];
        if (!pick) throw new Error(`${candidate} is not available or not signed in here.`);
        if (!await pi.setModel(pick.model)) throw new Error(`Cannot switch to ${pick.key}.`);
        pi.setThinkingLevel(pick.level);
        notes.push(`orchestrator: main model ${pick.key}:${pick.level}`);
        continue;
      }
    }
    if (verb === 'effort') setOverride(t.scope, r, { level: reset ? undefined : value as ThinkingLevel });
    else {
      const candidate = reset ? undefined : parseModel(value, t.cwd, firstLevel(item));
      if (candidate && !candidates([candidate], ctx.modelRegistry).length) notes.push(`warning: ${candidate} is not available or not signed in on this host; the router will skip it`);
      setOverride(t.scope, r, { model: candidate });
    }
    notes.push(`${r}: ${verb} ${reset ? 'reset to the preset' : value}`);
  }
  return [...notes, cacheNote, '', table()].join('\n');
}
