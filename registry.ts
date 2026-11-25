import { appendFileSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export const root = join(getAgentDir(), 'teams');
export const namePattern = /^[a-z0-9-]{1,32}$/;
export const addressPattern = /^[a-z0-9-]{1,32}-[1-9][0-9]*$/;
export function teamDir(team: string) {
  if (!namePattern.test(team)) throw new Error(`Invalid team name: ${team}`);
  return join(root, team);
}
export interface Team {
  id: string; preset: string; repo: string; worktree: string; branch: string; base: string; baseCommit: string;
  baseBranch?: string; goal: string; createdAt: number; workspace?: string; pane?: string;
  /** Primary Herdr workspace that `herdr worktree create` opened for this repository on pi-team's behalf. */
  hostWorkspace?: string;
  alias?: string; aliasLabel?: string;
}
export interface Participant {
  key: string; role: string; pid: number; sessionId: string; sessionFile?: string; at: number;
  startedAt?: number; waitSince?: number;
  state: 'idle' | 'working' | 'waiting' | 'done' | 'failed' | 'stopped';
  model?: string; fallback?: boolean; tool?: string; path?: string; tokens: number; sideEffects: boolean;
  result?: string; error?: string; diff?: string; changedPaths?: string[];
}
export interface FleetEntry { key: string; agent: string; model?: string; startedAt?: number; tokens?: { total?: number } }
export interface Snapshot { at: number; members: Participant[]; fleet: FleetEntry[] }
export interface LedgerEntry {
  event: 'sent' | 'delivered' | 'replied' | 'closed' | 'undelivered' | 'fallback';
  at: number; id?: string; from?: string; to?: string; replyTo?: string; subject?: string; body?: string;
  model?: string; reason?: string; sideEffects?: boolean; until?: number;
}
export function mkdir(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); }
export function errorCode(e: unknown) { return (e as NodeJS.ErrnoException)?.code; }
export function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (e) { if (errorCode(e) !== 'ENOENT') throw e; }
}
export function readText(path: string) {
  try { return readFileSync(path, 'utf8'); }
  catch (e) { if (errorCode(e) !== 'ENOENT') throw e; }
}
export function names(path: string) {
  try { return readdirSync(path); }
  catch (e) { if (errorCode(e) === 'ENOENT') return []; throw e; }
}
export function exists(path: string) {
  try { lstatSync(path); return true; }
  catch (e) { if (errorCode(e) === 'ENOENT') return false; throw e; }
}
export function writeAtomic(path: string, value: string, createParent = true) {
  if (createParent) mkdir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { writeFileSync(tmp, value, { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
  finally { remove(tmp); }
}
export function remove(path: string) {
  try { unlinkSync(path); } catch (e) { if (errorCode(e) !== 'ENOENT') throw e; }
}
export function writeJson(path: string, value: unknown, createParent = true) { writeAtomic(path, JSON.stringify(value) + '\n', createParent); }
export function pidLive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { if (errorCode(e) === 'ESRCH') return false; throw e; }
}
const lockDelay = new Int32Array(new SharedArrayBuffer(4));
// Synchronous, short critical sections only. The owner is written before publishing the lock.
export function locked<T>(path: string, fn: () => T): T {
  mkdir(dirname(path));
  const owner = `${path}.${process.pid}.${randomBytes(6).toString('hex')}`;
  writeFileSync(owner, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { linkSync(owner, path); break; }
      catch (e) {
        if (errorCode(e) !== 'EEXIST') throw e;
        if (attempt === 50) {
          const pid = Number(readText(path));
          const remedy = pid && !pidLive(pid) ? ' The owner is gone; remove this stale lock after checking that no related Pi session is active.' : '';
          throw new Error(`Registry lock busy: ${path}.${remedy}`);
        }
        Atomics.wait(lockDelay, 0, 0, 10);
      }
    }
    try { return fn(); } finally { remove(path); }
  } finally { remove(owner); }
}
export const getTeam = (team: string) => readJson<Team>(join(teamDir(team), 'team.json'));
export function teams() {
  return names(root).filter(n => namePattern.test(n) && n !== 'archive' && n !== 'vendor' && exists(join(root, n, 'team.json')))
    .map(n => getTeam(n)).filter((t): t is Team => !!t);
}
export const getLead = (team: string) => readJson<Participant>(join(teamDir(team), 'lead.json'));
export function members(team: string) {
  const dir = join(teamDir(team), 'members');
  return names(dir).filter(n => n.endsWith('.json')).map(n => readJson<Participant>(join(dir, n))).filter((m): m is Participant => !!m);
}
export function isLive(p?: Participant) {
  return !!p && p.state !== 'stopped' && (p.key === 'lead' || (p.state !== 'done' && p.state !== 'failed')) && pidLive(p.pid);
}
export function leadState(p?: Participant, createdAt = 0) {
  if (!p) return Date.now() - createdAt >= 10_000 ? 'stale' : 'starting';
  if (p.state !== 'stopped' && !(p.state === 'done' && !p.pid) && Date.now() - p.at >= 10_000) return 'stale';
  return p.state;
}
export function ledger(team: string) {
  const source = readText(join(teamDir(team), 'ledger.jsonl'));
  if (!source) return [];
  const lines = source.split('\n');
  lines.pop(); // Ignore an in-progress append until its terminating newline exists.
  return lines.map(line => JSON.parse(line) as LedgerEntry);
}
export function appendLedger(dir: string, entries: LedgerEntry[]) {
  if (entries.length) appendFileSync(join(dir, 'ledger.jsonl'), entries.map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
}
export function log(team: string, ...entries: LedgerEntry[]) {
  appendLedger(teamDir(team), entries);
}
export function diffStat(worktree: string, baseCommit: string) {
  const tracked = git(worktree, ['diff', '--shortstat', baseCommit]);
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).length;
  return [tracked, untracked ? `${untracked} untracked` : ''].filter(Boolean).join('; ') || 'clean';
}
export function exec(file: string, args: string[], cwd: string) {
  try { return execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) {
    const { stderr, stdout, message } = e as Error & { stderr?: string; stdout?: string };
    throw new Error(stderr?.trim() || stdout?.trim() || message);
  }
}
export const git = (cwd: string, args: string[]) => exec('git', args, cwd);
export interface ToolReply { content: { type: 'text'; text: string }[]; details: Record<string, never> }
export const text = (value: string): ToolReply => ({ content: [{ type: 'text', text: value }], details: {} });
