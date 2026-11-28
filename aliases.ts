import { join } from 'node:path';
import { start, type Start } from './lifecycle.ts';
import { send } from './mailbox.ts';
import { checkIcon, getLead, hostPreset, isLive, leadState, locked, namePattern, readJson, root, teams, type Team } from './registry.ts';
import type { Presets } from './presets.ts';

interface Alias { preset: string; names: string[]; description: string; base?: string; icon?: string }
interface AliasTarget extends Alias { key: string }
export interface TeamTargets {
  aliases: Map<string, AliasTarget>;
  byName: Map<string, AliasTarget>;
  presets: Set<string>;
}

function normalized(name: string) { return name.toLowerCase().replace(/\s+/gu, '').replace(/(?:팀|team)$/u, ''); }
function readAliasFile(path: string): Record<string, unknown> {
  let data: unknown;
  try { data = readJson<unknown>(path); }
  catch (e) { throw new Error(`Cannot read team aliases at ${path}: ${String(e)}`); }
  if (data === undefined) return {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Expected a team alias object at ${path}.`);
  return data as Record<string, unknown>;
}
export function readTargets(cwd: string, presets: Presets): TeamTargets {
  const config = { ...readAliasFile(join(root, 'aliases.json')), ...readAliasFile(join(cwd, '.pi', 'teams', 'aliases.json')) };
  const targets: TeamTargets = { aliases: new Map(), byName: new Map(), presets: new Set(Object.keys(presets)) };
  for (const [key, raw] of Object.entries(config)) {
    if (!namePattern.test(key)) throw new Error(`Invalid team alias key: ${key}. Use 1–32 lowercase letters, digits or hyphens.`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Team alias ${key} must be an object.`);
    const { preset, names, description, base, icon } = raw as Record<string, unknown>;
    if (typeof preset !== 'string' || !targets.presets.has(preset)) throw new Error(`Team alias ${key} refers to unknown preset: ${String(preset)}.`);
    if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || /[\x00-\x1f\x7f-\x9f]/u.test(name) || !normalized(name))) {
      throw new Error(`Team alias ${key} needs a nonempty list of names that remain nonempty after normalization.`);
    }
    if (typeof description !== 'string' || !description.trim()) throw new Error(`Team alias ${key} needs a nonempty description.`);
    if (base !== undefined && (typeof base !== 'string' || !base.trim() || /\s|\0/u.test(base))) throw new Error(`Team alias ${key} has an invalid base ref.`);
    const alias: AliasTarget = { key, preset, names, description, base, icon: icon === undefined ? undefined : checkIcon(icon, `Team alias ${key}`) };
    targets.aliases.set(key, alias);
    for (const label of [key, ...names]) {
      const name = normalized(label);
      if (!name) continue;
      const prior = targets.byName.get(name);
      if (prior && prior.key !== key) throw new Error(`Duplicate team alias name ${JSON.stringify(label)}: ${prior.key} and ${key}.`);
      targets.byName.set(name, alias);
    }
  }
  return targets;
}

export function resolveTarget(targets: TeamTargets, input: string) {
  const exact = input.trim().toLowerCase();
  const name = normalized(input);
  const alias = targets.aliases.get(exact) ?? targets.byName.get(name);
  if (alias) return { preset: alias.preset, alias };
  if (targets.presets.has(exact)) return { preset: exact };
  if (targets.presets.has(name)) return { preset: name };
  const aliases = [...targets.aliases.values()].map(a => `${a.key} (${a.names.join(', ')})`).join('; ');
  throw new Error(`Unknown team alias or preset: ${JSON.stringify(input)}. Available aliases: ${aliases || '(none)'}. Available presets: ${[...targets.presets].join(', ') || '(none)'}.`);
}

export function aliasHints(targets: TeamTargets) {
  const brief = (s: string, length: number) => s.replace(/\s+/gu, ' ').trim().slice(0, length);
  return [...targets.aliases.values()].map(a => `${a.key} (${a.names.slice(0, 4).map(n => brief(n, 40)).join(', ')}): ${brief(a.description, 70)}`).join('; ').slice(0, 700);
}

function currentTeams() {
  const current = new Map<string, Team>();
  for (const team of teams()) {
    if (!team.alias) continue;
    const prior = current.get(team.alias);
    if (!prior || team.createdAt >= prior.createdAt) current.set(team.alias, team);
  }
  return current;
}
function liveStatus(team: Team) {
  const lead = getLead(team.id);
  return isLive(lead) && leadState(lead, team.createdAt) !== 'stale' ? 'live' : 'stale';
}
export function showAliases(targets: TeamTargets) {
  const current = currentTeams();
  return [...targets.aliases.values()].map(a => {
    const team = current.get(a.key);
    return `${a.icon ? `${a.icon} ` : ''}${a.key} (${a.names.join(', ')}) → ${a.preset} | ${team ? `${team.id} (${liveStatus(team)})` : 'no current team'} | ${a.description}`;
  }).join('\n') || 'No team aliases configured.';
}

// No preset or alias: the host's default preset, the one new main sessions start in (/team main <preset> --default).
export function defaultTarget(input?: string) {
  if (input?.trim()) return input;
  const preset = hostPreset();
  if (!preset) throw new Error('No preset given and no host default. Name a preset or alias, or set the default with /team main <preset> --default.');
  return preset;
}
export function startNamed(cwd: string, targets: TeamTargets, params: Start) {
  const { preset, alias } = resolveTarget(targets, defaultTarget(params.preset));
  return start(cwd, { ...params, preset, base: params.base ?? alias?.base }, alias);
}
export function delegate(cwd: string, targets: TeamTargets, input: string, task: string, fromDirty = false, label: { title?: string; name?: string } = {}) {
  const { preset, alias } = resolveTarget(targets, input);
  if (!alias) return start(cwd, { preset, goal: task, fromDirty, title: label.title, name: label.name });
  return locked(join(root, `.alias-${alias.key}.lock`), () => {
    const team = currentTeams().get(alias.key);
    if (!team) return start(cwd, { preset, base: alias.base, goal: task, fromDirty, title: label.title }, alias);
    const [receipt] = send(undefined, { to: `lead@${team.id}`, body: task });
    if (receipt.state !== 'sent') throw new Error(`Could not send the task to team ${team.id} (${receipt.state}).`);
    const state = liveStatus(team);
    return `Task sent to existing team ${team.id} (${state}), message ${receipt.id}.${state === 'stale' ? ' The task is queued in the lead inbox; the lead must be running to receive it.' : ''}`;
  });
}
