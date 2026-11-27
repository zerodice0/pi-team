import { execFile, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getLead, isLive, readJson, teamDir, teams, writeJson, type Participant, type Team } from './registry.ts';

// A team worktree lives for days, and builds pile up in it: one Flutter team held 14 GB of build,
// ios/DerivedData and .dart_tool. These helpers measure that, list the folders build tools recreate,
// and remove only those, so a team can stay open without filling the disk.

// Folder names build tools recreate. A folder counts only when Git ignores it and tracks nothing in
// it, so a committed dist/ is never touched. Never git clean -X: ignored files also hold copied
// configuration (config/app.env) and evidence that cannot be rebuilt.
const REBUILDABLE = new Set(['build', '.build', '.dart_tool', 'DerivedData', 'Pods', 'node_modules', '.gradle', '.cxx', 'target', 'dist', '.next', '.turbo', '.expo', '.svelte-kit']);
const SKIP = new Set(['.git', 'artifacts']);
const DEPTH = 4;
const FRESH_MS = 10 * 60_000;

export interface DiskUsage { at: number; totalKb: number; rebuildableKb: number; dirs: { path: string; kb: number }[] }

function candidates(worktree: string) {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP.has(e.name)) continue;
      const path = join(dir, e.name);
      if (REBUILDABLE.has(e.name)) found.push(path);
      else if (depth < DEPTH) walk(path, depth + 1);
    }
  };
  walk(worktree, 1);
  if (!found.length) return [];
  const rel = found.map(p => relative(worktree, p));
  const ignored = new Set(spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: worktree, input: rel.join('\0'), encoding: 'utf8' }).stdout.split('\0').filter(Boolean));
  const tracked = spawnSync('git', ['ls-files', '-z', '--', ...rel.filter(p => ignored.has(p))], { cwd: worktree, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout.split('\0').filter(Boolean);
  return rel.filter(p => ignored.has(p) && !tracked.some(t => t === p || t.startsWith(`${p}/`) || t.startsWith(`${p}${sep}`)));
}
// du -sk prints "<kb>\t<path>" per argument. Folders are disjoint, so one call is enough.
const parseDu = (out: string) => new Map(out.split('\n').filter(Boolean).map(line => {
  const [kb, ...path] = line.split('\t');
  return [path.join('\t'), Number(kb) || 0] as const;
}));
function usage(worktree: string, rel: string[], total: string, dirs: string): DiskUsage {
  const sizes = parseDu(dirs);
  const list = rel.map(path => ({ path, kb: sizes.get(join(worktree, path)) ?? 0 })).filter(d => d.kb > 0).sort((a, b) => b.kb - a.kb);
  return { at: Date.now(), totalKb: parseDu(total).get(worktree) ?? 0, rebuildableKb: list.reduce((n, d) => n + d.kb, 0), dirs: list };
}
const cachePath = (id: string) => join(teamDir(id), 'disk.json');
export const cachedUsage = (id: string) => readJson<DiskUsage>(cachePath(id));

// For surfaces that redraw often: return what is cached and refresh it in the background when it
// is older than ten minutes. du over a 20 GB tree takes seconds, so it never runs in the draw path.
const running = new Set<string>();
export function diskUsage(team: Team, onUpdate?: () => void): DiskUsage | undefined {
  const cached = cachedUsage(team.id);
  if ((!cached || Date.now() - cached.at > FRESH_MS) && !running.has(team.id) && exists(team.worktree)) {
    running.add(team.id);
    let rel: string[];
    try { rel = candidates(team.worktree); } catch { running.delete(team.id); return cached; }
    const du = (args: string[]) => new Promise<string>(resolve => execFile('du', ['-sk', ...args], { maxBuffer: 16 << 20 }, (_e, out) => resolve(out ?? '')));
    void Promise.all([du([team.worktree]), rel.length ? du(rel.map(p => join(team.worktree, p))) : Promise.resolve('')])
      .then(([total, dirs]) => { try { writeJson(cachePath(team.id), usage(team.worktree, rel, total, dirs)); onUpdate?.(); } catch { /* team closed meanwhile */ } })
      .finally(() => running.delete(team.id));
  }
  return cached;
}
const exists = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };
// Measure now, for an explicit command.
export function measure(team: Team): DiskUsage {
  const rel = candidates(team.worktree);
  const du = (args: string[]) => spawnSync('du', ['-sk', ...args], { encoding: 'utf8', maxBuffer: 16 << 20 }).stdout ?? '';
  const result = usage(team.worktree, rel, du([team.worktree]), rel.length ? du(rel.map(p => join(team.worktree, p))) : '');
  try { writeJson(cachePath(team.id), result); } catch { /* display cache only */ }
  return result;
}
export function removeRebuildable(team: Team, dirs: { path: string }[]) {
  for (const d of dirs) {
    const full = join(team.worktree, d.path);
    // The list came from this worktree; refuse anything that would leave it.
    if (relative(team.worktree, full).startsWith('..') || !d.path || d.path.includes('\0')) throw new Error(`Refusing to remove ${d.path}`);
    rmSync(full, { recursive: true, force: true });
  }
  return measure(team);
}

export function size(kb: number) {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`;
  return `${kb}K`;
}
export const usageLine = (u?: DiskUsage) => u ? `${size(u.totalKb)} on disk${u.rebuildableKb ? `, ${size(u.rebuildableKb)} rebuildable` : ''}` : '';

// How long a team has had no live lead, or undefined while one runs.
export function offlineFor(team: Team, lead: Participant | undefined = getLead(team.id)) {
  if (isLive(lead) && lead!.state !== 'stopped') return undefined;
  if (lead?.state === 'done') return undefined;
  return Date.now() - (lead?.at ?? team.createdAt);
}
export function ago(ms: number) {
  const h = ms / 3_600_000;
  return h >= 48 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${Math.floor(h)}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
}
// Open teams whose lead has been gone longer than a day: the ones that fill disks unnoticed.
export const STALE_MS = Number(process.env.PI_TEAM_STALE_HOURS ?? 24) * 3_600_000;
export function staleTeams() {
  return teams().map(team => ({ team, offline: offlineFor(team) })).filter((t): t is { team: Team; offline: number } => t.offline !== undefined && t.offline >= STALE_MS);
}
