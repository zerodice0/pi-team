import { join } from 'node:path';
import { getLead, mainConfigPath, members, readJson, readText, root, writeJson, type Team } from './registry.ts';
import { cacheRetention, memberCacheRetention } from './lifecycle.ts';

// Prompt-cache retention is an environment setting only (pi has no settings key). Leads and members
// get theirs from pi-team; a main session and a session Herdr restores take the shell's. This module
// reports what applies and what recent turns actually wrote, and lets main.json stand in for the shell.

// What the shell gave this process, before pi-team fills anything in.
export const shellCache = { lead: process.env.PI_CACHE_RETENTION, member: process.env.PI_SUBAGENT_CACHE_RETENTION };
const mainPath = mainConfigPath;
interface MainCache { cacheRetention?: string; subagentCacheRetention?: string }
const valid = (v: unknown): v is string => v === 'long' || v === 'short' || v === 'none';
// main.json fills what the shell left empty, for main sessions: shell env > main.json > unset (pi's 5 minutes).
// With cacheRetention set there, children of the main session default to short, as team members do.
export function applyMainCache() {
  const conf = readJson<MainCache>(mainPath) ?? {};
  const applied: string[] = [];
  if (!process.env.PI_CACHE_RETENTION && valid(conf.cacheRetention)) { process.env.PI_CACHE_RETENTION = conf.cacheRetention; applied.push('PI_CACHE_RETENTION'); }
  const member = valid(conf.subagentCacheRetention) ? conf.subagentCacheRetention : valid(conf.cacheRetention) ? 'short' : undefined;
  if (!process.env.PI_SUBAGENT_CACHE_RETENTION && member) { process.env.PI_SUBAGENT_CACHE_RETENTION = member; applied.push('PI_SUBAGENT_CACHE_RETENTION'); }
  return applied;
}

// Once per host, when the shell sets neither value: say what pi-team does and how to change the rest.
const noticesPath = join(root, 'notices.json');
export function cacheNotice() {
  if (shellCache.lead && shellCache.member) return undefined;
  const seen = readJson<Record<string, number>>(noticesPath) ?? {};
  if (seen.cacheRetention) return undefined;
  try { writeJson(noticesPath, { ...seen, cacheRetention: Date.now() }); } catch { return undefined; }
  const conf = readJson<MainCache>(mainPath) ?? {};
  const main = process.env.PI_CACHE_RETENTION ? `${process.env.PI_CACHE_RETENTION}${shellCache.lead ? '' : ' (from main.json)'}` : 'unset, so 5 minutes';
  return [
    `pi-team: team leads run with the 1-hour prompt cache (PI_CACHE_RETENTION=long) and members with 5 minutes (PI_SUBAGENT_CACHE_RETENTION=short).`,
    `This main session and sessions Herdr restores take the shell's value instead: ${main}.`,
    'If you often pause for more than five minutes, set it in the shell (fish: set -Ux PI_CACHE_RETENTION long; bash/zsh: export PI_CACHE_RETENTION=long)'
      + `${valid(conf.cacheRetention) ? '' : ', or add "cacheRetention": "long" to ~/.pi/agent/teams/main.json'}. Members can be set apart with PI_SUBAGENT_CACHE_RETENTION.`,
    '/team cache shows the settings and what recent turns wrote. This note is shown once per host.',
  ].join('\n');
}

// Cache writes of a session's last assistant turns: Anthropic usage records the 1-hour part as cacheWrite1h.
// This is the reliable check; on macOS `ps eww` does not show another process's environment.
interface Writes { turns: number; hour: number; total: number; hourTokens: number }
export function sessionWrites(file: string | undefined, last = 20): Writes | undefined {
  const text = file && readText(file);
  if (!text) return undefined;
  const turns: { w: number; h: number }[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"cacheWrite"')) continue;
    try {
      const entry = JSON.parse(line);
      const u = entry?.message?.role === 'assistant' ? entry.message.usage : undefined;
      if (u?.cacheWrite > 0) turns.push({ w: u.cacheWrite, h: u.cacheWrite1h ?? 0 });
    } catch { /* partial line */ }
  }
  const recent = turns.slice(-last);
  if (!recent.length) return { turns: 0, hour: 0, total: 0, hourTokens: 0 };
  return { turns: recent.length, hour: recent.filter(t => t.h > 0).length, total: recent.reduce((n, t) => n + t.w, 0), hourTokens: recent.reduce((n, t) => n + t.h, 0) };
}
const k = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`;
const describe = (w?: Writes) => !w ? 'no session file' : !w.turns ? 'no cache writes yet'
  : `${w.hour === w.turns ? '1 hour' : w.hour ? 'mixed' : '5 minutes'}: ${w.hour}/${w.turns} recent writes used 1h (${k(w.hourTokens)} of ${k(w.total)} tokens)`;

export function cacheReport(sessionFile: string | undefined, scope: Team[]) {
  const conf = readJson<MainCache>(mainPath) ?? {};
  const src = (now: string | undefined, shell: string | undefined) => now ? `${now} (${shell ? 'shell' : 'main.json or pi-team'})` : 'unset (5 minutes)';
  const lines = [
    'Prompt cache retention',
    `  this session:            PI_CACHE_RETENTION=${src(process.env.PI_CACHE_RETENTION, shellCache.lead)}`,
    `  its subagents:           PI_SUBAGENT_CACHE_RETENTION=${src(process.env.PI_SUBAGENT_CACHE_RETENTION, shellCache.member)}`,
    `  main.json:               cacheRetention=${conf.cacheRetention ?? 'not set'}, subagentCacheRetention=${conf.subagentCacheRetention ?? 'not set'}`,
    `  leads started now:       ${cacheRetention()}, their members ${memberCacheRetention()}`,
    'Observed (last 20 turns that wrote to the cache)',
    `  this session:            ${describe(sessionWrites(sessionFile))}`,
  ];
  for (const team of scope) {
    lines.push(`  ${team.id} lead:`.padEnd(27) + describe(sessionWrites(getLead(team.id)?.sessionFile)));
    const recent = members(team.id).filter(m => m.sessionFile).sort((a, b) => b.at - a.at).slice(0, 3);
    for (const m of recent) lines.push(`    ${m.key}:`.padEnd(27) + describe(sessionWrites(m.sessionFile)));
  }
  lines.push('Precedence: shell env, then ~/.pi/agent/teams/main.json (main sessions), then pi-team defaults (leads long, members short).');
  return lines.join('\n');
}
