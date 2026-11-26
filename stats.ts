import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { mkdir, readJson, root, writeJson, type Participant, type Snapshot, type Team } from './registry.ts';

// One record per participant session: which skills it was offered, which it actually read, and what
// the run cost. Records outlive their teams (teams are archived), so role and skill choices can be
// judged on what happened rather than guessed again for every team.
export const statsDir = join(root, 'stats');
export interface SkillRead { name: string; turn: number; chars: number }
export interface RunStat {
  v: 1; team: string; preset: string; repo: string; role: string; key: string; sessionId: string;
  task?: string; startedAt: number; endedAt: number; state: string; resumed: boolean; models: string[];
  turns: number; tokens: { input: number; cacheRead: number; cacheWrite: number; output: number }; cost: number; maxContext: number;
  skills: { listed: string[]; listedChars: number; extra?: string[]; read: SkillRead[] };
  // Members only: headings the lead's brief left out, and headings missing from the member's final report.
  brief?: { chars: number; missing: string[] };
  report?: { chars: number; missing: string[] };
}
export const briefHeadings = ['Goal', 'Background', 'Read first', 'Do', 'Do not', 'Done when', 'Limits', 'Report'];
export const reportHeadings = ['Result', 'Checks', 'Open issues', 'Changed files', 'Artifacts'];
// A heading counts as markdown (#, ##, ...) or a bold label at the start of a line.
const missingHeadings = (text: string, names: string[]) => names.filter(name => {
  const n = name.replace(/ /g, '\\s+');
  // pi-subagents prefixes the task with "Task: ", which puts the first heading mid-line.
  return !new RegExp(`^\\s*(?:Task:\\s*)?(?:#{1,6}\\s*|\\*\\*)${n}\\s*(?:\\*\\*|:|-|—|–|\\(|$)`, 'im').test(text);
});
export const briefCheck = (task: string) => ({ chars: task.length, missing: missingHeadings(task, briefHeadings) });
export const reportCheck = (result: string | undefined) => ({ chars: result?.length ?? 0, missing: missingHeadings(result ?? '', reportHeadings) });
const ended = (state: string) => state === 'done' || state === 'failed' || state === 'stopped';
// Briefs written before the standard form use other headings; judge missing headings only on briefs
// that follow the form at all. A report is silent when the member left almost no final text.
const inForm = (b?: { missing: string[] }) => !!b && b.missing.length < briefHeadings.length;
const silentReport = (r?: { chars: number }) => !!r && r.chars < 80;
const formalReport = (r?: { chars: number; missing: string[] }) => !!r && !silentReport(r) && r.missing.length === 0;
// pi-subagents and pi both list skills as <skill><name/><description/><location/></skill>.
export function listedSkills(prompt: string) {
  const block = /<available_skills>[\s\S]*?<\/available_skills>/.exec(prompt)?.[0] ?? '';
  const entries = [...block.matchAll(/<skill>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<location>([^<]+)<\/location>[\s\S]*?<\/skill>/g)];
  return { chars: block.length, skills: entries.map(m => ({ name: m[1].trim(), dir: dirname(m[2].trim()) })) };
}
const skillPath = /([^\s"'`]*\/skills\/([^/\s"'`]+)\/SKILL\.md)/;
const textOf = (result: unknown) => {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  return Array.isArray(content) ? content.reduce((n, c) => n + (c.type === 'text' ? c.text?.length ?? 0 : 0), 0) : 0;
};

export function trackRun(pi: ExtensionAPI, team: Team, row: () => Participant | undefined) {
  let stat: RunStat | undefined;
  let listed: { name: string; dir: string }[] = [];
  const pending = new Map<string, { name: string; turn: number }>();
  const file = () => stat && join(statsDir, `${stat.team}-${stat.key}-${stat.sessionId.slice(0, 13)}.json`);
  const save = () => {
    const p = row();
    if (!stat || !p) return;
    stat.key = p.key; stat.state = p.state; stat.endedAt = Date.now();
    if (stat.role !== 'orchestrator' && ended(p.state)) stat.report = reportCheck(p.error ? undefined : p.result);
    try { mkdir(statsDir); writeJson(file()!, stat); } catch { /* statistics never block the team */ }
  };
  pi.on('session_start', (_e, ctx) => {
    const p = row();
    if (!p) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const blank: RunStat = { v: 1, team: team.id, preset: team.preset, repo: basename(team.repo), role: p.role, key: p.key, sessionId,
      startedAt: Date.now(), endedAt: Date.now(), state: p.state, resumed: false, models: [], turns: 0,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0, maxContext: 0, skills: { listed: [], listedChars: 0, read: [] } };
    stat = blank;
    // A resumed member reopens its session: keep counting on the same record.
    const previous = readJson<RunStat>(file()!);
    stat = previous ? { ...previous, resumed: true } : blank;
  });
  pi.on('before_agent_start', event => {
    if (!stat) return;
    const found = listedSkills(event.systemPrompt);
    listed = found.skills;
    stat.skills.listed = [...new Set([...stat.skills.listed, ...listed.map(s => s.name)])];
    stat.skills.listedChars = Math.max(stat.skills.listedChars, found.chars);
    if (!stat.task && event.messageType === 'user') {
      stat.task = event.prompt.replace(/\s+/g, ' ').trim().slice(0, 240);
      if (stat.role !== 'orchestrator') stat.brief = briefCheck(event.prompt);
    }
  });
  pi.on('turn_end', event => {
    if (!stat || event.message.role !== 'assistant') return;
    const m = event.message as AssistantMessage;
    const u = m.usage;
    if (!u) return;
    stat.turns++;
    stat.tokens.input += u.input ?? 0; stat.tokens.cacheRead += u.cacheRead ?? 0;
    stat.tokens.cacheWrite += u.cacheWrite ?? 0; stat.tokens.output += u.output ?? 0;
    stat.cost += u.cost?.total ?? 0;
    stat.maxContext = Math.max(stat.maxContext, (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
    if (m.provider !== 'team' && !stat.models.includes(`${m.provider}/${m.model}`)) stat.models.push(`${m.provider}/${m.model}`);
  });
  pi.on('tool_execution_start', e => {
    if (!stat || (e.toolName !== 'read' && e.toolName !== 'bash')) return;
    const text = e.toolName === 'read' ? String(e.args?.path ?? '') : String(e.args?.command ?? '');
    const byDir = listed.find(s => text.includes(`${s.dir}/SKILL.md`));
    const name = byDir?.name ?? skillPath.exec(text)?.[2];
    if (name) pending.set(e.toolCallId, { name, turn: stat.turns + 1 });
  });
  pi.on('tool_execution_end', e => {
    const read = pending.get(e.toolCallId);
    pending.delete(e.toolCallId);
    if (!stat || !read || e.isError) return;
    stat.skills.read.push({ ...read, chars: textOf(e.result) });
    if (!stat.skills.listed.includes(read.name)) stat.skills.extra = [...new Set([...(stat.skills.extra ?? []), read.name])];
  });
  pi.on('agent_settled', save);
  pi.on('session_shutdown', save);
}

export function loadStats() {
  let files: string[] = [];
  try { files = readdirSync(statsDir).filter(f => f.endsWith('.json')); } catch { return []; }
  return files.flatMap(f => { try { const s = readJson<RunStat>(join(statsDir, f)); return s?.v === 1 ? [s] : []; } catch { return []; } });
}
export interface SkillUse { name: string; listed: number; read: number; readChars: number; unlisted: number }
export function roleSkills(stats: RunStat[], role: string) {
  const runs = stats.filter(s => s.role === role);
  const uses = new Map<string, SkillUse>();
  const use = (name: string) => uses.get(name) ?? uses.set(name, { name, listed: 0, read: 0, readChars: 0, unlisted: 0 }).get(name)!;
  for (const r of runs) {
    for (const name of r.skills.listed) use(name).listed++;
    const readNames = new Set(r.skills.read.map(x => x.name));
    for (const name of readNames) {
      const u = use(name);
      u.read++;
      u.readChars += r.skills.read.filter(x => x.name === name).reduce((n, x) => n + x.chars, 0);
      if (!r.skills.listed.includes(name)) u.unlisted++;
    }
  }
  return { runs, uses: [...uses.values()] };
}
const MIN_RUNS = 5;
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const k = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
// Candidate → Adopted → Retire, judged by use: a skill listed in many runs and never read is only
// prompt weight; a skill members look up without having it listed belongs on the role.
export function statsReport(stats: RunStat[], only?: string) {
  const roles = [...new Set(stats.map(s => s.role))].filter(r => !only || r === only).sort();
  if (!roles.length) return only ? `No recorded runs for role ${only}.` : 'No recorded runs yet. Runs are recorded from now on.';
  const lines: string[] = [`pi-team run statistics: ${stats.length} runs in ${new Set(stats.map(s => s.team)).size} teams (judgements need ${MIN_RUNS}+ runs)`];
  for (const role of roles) {
    const { runs, uses } = roleSkills(stats, role);
    const states = runs.reduce<Record<string, number>>((m, r) => (m[r.state] = (m[r.state] ?? 0) + 1, m), {});
    lines.push('', `${role}: ${runs.length} runs (${Object.entries(states).map(([s, n]) => `${n} ${s}`).join(', ')}) · avg ${Math.round(avg(runs.map(r => r.turns)))} turns · max context ${k(avg(runs.map(r => r.maxContext)))} · cache read ${k(avg(runs.map(r => r.tokens.cacheRead)))} · $${avg(runs.map(r => r.cost)).toFixed(2)}/run · skill list ${k(avg(runs.map(r => r.skills.listedChars)))} chars`);
    const listed = uses.filter(u => u.listed).sort((a, b) => b.read / b.listed - a.read / a.listed || a.name.localeCompare(b.name));
    const read = listed.filter(u => u.read);
    const unread = listed.filter(u => !u.read).map(u => u.name);
    if (read.length) lines.push(`  read (runs read/listed): ${read.map(u => `${u.name} ${u.read}/${u.listed}`).join(', ')}`);
    if (unread.length) lines.push(`  never read: ${unread.length} of ${listed.length} listed skills (${unread.slice(0, 6).join(', ')}${unread.length > 6 ? ', …' : ''})`);
    const retire = listed.filter(u => u.listed >= MIN_RUNS && u.read === 0).map(u => u.name);
    const adopted = listed.filter(u => u.listed >= MIN_RUNS && u.read / u.listed >= 0.5).map(u => u.name);
    const assign = uses.filter(u => u.unlisted > 0).map(u => `${u.name} (${u.unlisted} runs, ${k(u.readChars / Math.max(1, u.read))} chars)`);
    const briefed = runs.filter(r => r.brief);
    const formed = briefed.filter(r => inForm(r.brief));
    const gaps = formed.flatMap(r => r.brief!.missing).reduce<Record<string, number>>((m, h) => (m[h] = (m[h] ?? 0) + 1, m), {});
    if (briefed.length) lines.push(`  briefs in the standard form: ${formed.length}/${briefed.length}${Object.keys(gaps).length ? `; missing ${Object.entries(gaps).map(([h, n]) => `${h} ${n}/${formed.length}`).join(', ')}` : ''}`);
    const finished = runs.filter(r => r.report);
    const silent = finished.filter(r => silentReport(r.report));
    if (finished.length) lines.push(`  reports in the standard form: ${finished.filter(r => formalReport(r.report)).length}/${finished.length}${silent.length ? `; ended without a report: ${silent.map(r => `${r.team}/${r.key} ${r.state}`).join(', ')}` : ''}`);
    if (adopted.length) lines.push(`  adopted (read in half or more): ${adopted.join(', ')}`);
    if (retire.length) lines.push(`  retire candidates (listed ${MIN_RUNS}+ runs, never read): ${retire.length > 12 ? `${retire.slice(0, 12).join(', ')}, … (${retire.length})` : retire.join(', ')}`);
    if (assign.length) lines.push(`  assign candidates (read without being listed): ${assign.join(', ')}`);
  }
  return lines.join('\n');
}

// Rebuild records from the session files of current and archived teams, for runs that finished
// before pi-team recorded them itself. Existing records are left alone.
function fromSession(team: Team, p: Participant): RunStat | undefined {
  if (!p.sessionFile || !existsSync(p.sessionFile)) return;
  const stat: RunStat = { v: 1, team: team.id, preset: team.preset, repo: basename(team.repo), role: p.role, key: p.key, sessionId: p.sessionId,
    startedAt: p.startedAt ?? p.at, endedAt: p.at, state: p.state, resumed: false, models: [], turns: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0, maxContext: 0, skills: { listed: [], listedChars: 0, read: [] } };
  let listed: { name: string; dir: string }[] = [];
  const calls = new Map<string, { name: string; turn: number }>();
  for (const line of readFileSync(p.sessionFile, 'utf8').split('\n')) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'message') continue;
    const m = e.message;
    if (m.role === 'system') {
      const prompt = typeof m.content === 'string' && m.content ? m.content : Object.values(m.sections ?? {}).join('\n');
      const found = listedSkills(prompt);
      listed = found.skills;
      stat.skills.listed = [...new Set([...stat.skills.listed, ...listed.map(s => s.name)])];
      stat.skills.listedChars = Math.max(stat.skills.listedChars, found.chars);
    } else if (m.role === 'user' && !stat.task) {
      const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? '').join(' ');
      stat.task = text.replace(/\s+/g, ' ').trim().slice(0, 240);
      if (p.role !== 'orchestrator') stat.brief = briefCheck(text);
    } else if (m.role === 'assistant' && m.usage) {
      const u = m.usage;
      stat.turns++;
      stat.tokens.input += u.input ?? 0; stat.tokens.cacheRead += u.cacheRead ?? 0; stat.tokens.cacheWrite += u.cacheWrite ?? 0; stat.tokens.output += u.output ?? 0;
      stat.cost += u.cost?.total ?? 0;
      stat.maxContext = Math.max(stat.maxContext, (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
      const model = `${m.provider}/${m.model}`;
      if (m.provider !== 'team' && !stat.models.includes(model)) stat.models.push(model);
      for (const c of m.content ?? []) {
        if (c.type !== 'toolCall' || (c.name !== 'read' && c.name !== 'bash')) continue;
        const text = c.name === 'read' ? String(c.arguments?.path ?? '') : String(c.arguments?.command ?? '');
        const name = listed.find(s => text.includes(`${s.dir}/SKILL.md`))?.name ?? skillPath.exec(text)?.[2];
        if (name) calls.set(c.id, { name, turn: stat.turns });
      }
    } else if (m.role === 'toolResult' && calls.has(m.toolCallId) && !m.isError) {
      const read = calls.get(m.toolCallId)!;
      stat.skills.read.push({ ...read, chars: (m.content ?? []).reduce((n: number, c: any) => n + (c.text?.length ?? 0), 0) });
      if (!stat.skills.listed.includes(read.name)) stat.skills.extra = [...new Set([...(stat.skills.extra ?? []), read.name])];
    }
  }
  if (p.role !== 'orchestrator' && ended(p.state)) stat.report = reportCheck(p.error ? undefined : p.result);
  return stat.turns ? stat : undefined;
}
export function backfillStats(dry = false) {
  const out: string[] = [];
  const dirs = [...readdirSync(root).map(n => join(root, n)), ...(existsSync(join(root, 'archive')) ? readdirSync(join(root, 'archive')).map(n => join(root, 'archive', n)) : [])]
    .filter(d => existsSync(join(d, 'team.json')));
  let written = 0;
  let kept = 0;
  for (const dir of dirs) {
    const team = readJson<Team>(join(dir, 'team.json'))!;
    const people = new Map<string, Participant>();
    const lead = readJson<Participant>(join(dir, 'lead.json'));
    if (lead) people.set('lead', lead);
    for (const m of readJson<Snapshot>(join(dir, 'members.json'))?.members ?? []) people.set(m.key, m);
    if (existsSync(join(dir, 'members'))) for (const f of readdirSync(join(dir, 'members'))) {
      const m = readJson<Participant>(join(dir, 'members', f));
      if (m && (!people.get(m.key) || m.at >= people.get(m.key)!.at)) people.set(m.key, m);
    }
    for (const p of people.values()) {
      const file = join(statsDir, `${team.id}-${p.key}-${p.sessionId.slice(0, 13)}.json`);
      if (existsSync(file)) { kept++; continue; }
      const stat = fromSession(team, p);
      if (!stat) continue;
      out.push(`${team.id} ${p.key}: ${stat.turns} turns, listed ${stat.skills.listed.length}, read ${[...new Set(stat.skills.read.map(r => r.name))].join(', ') || 'none'}`);
      if (!dry) { mkdir(statsDir); writeJson(file, stat); }
      written++;
    }
  }
  out.push(`${dry ? 'would write' : 'wrote'} ${written} records, kept ${kept} existing, from ${dirs.length} team directories`);
  return out.join('\n');
}

// A retrospective draft for one team, computed from its run records and compared with the same
// roles in other teams. It costs no model tokens; the lead decides what, if anything, becomes a lesson.
export function retroReport(teamId: string, all = loadStats()) {
  const runs = all.filter(s => s.team === teamId);
  if (!runs.length) return `No run records for team ${teamId}.`;
  const others = all.filter(s => s.team !== teamId);
  const total = runs.reduce((n, r) => n + r.cost, 0);
  const lines = [`# Retrospective draft: ${teamId}`, '',
    `${runs.length} runs · $${total.toFixed(2)} · ${runs.reduce((n, r) => n + r.turns, 0)} turns · cache read ${k(runs.reduce((n, r) => n + r.tokens.cacheRead, 0))}`, '', '## Runs'];
  for (const r of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    const read = [...new Set(r.skills.read.map(x => x.name))];
    const unread = r.skills.listed.filter(n => !read.includes(n)).length;
    const flags = [
      r.brief ? !inForm(r.brief) ? 'brief not in the standard form' : r.brief.missing.length ? `brief missing ${r.brief.missing.join(', ')}` : '' : '',
      r.report ? silentReport(r.report) ? 'no report' : !formalReport(r.report) ? 'report not in the standard form' : '' : '',
      r.skills.extra?.length ? `looked up unlisted ${r.skills.extra.join(', ')}` : '',
    ].filter(Boolean);
    lines.push(`- ${r.key} (${r.role}, ${r.state}${r.resumed ? ', resumed' : ''}): ${r.turns} turns, max context ${k(r.maxContext)}, $${r.cost.toFixed(2)}; skills read ${read.join(', ') || 'none'}${unread ? `, ${unread} listed never read` : ''}${flags.length ? `; ${flags.join('; ')}` : ''}`);
  }
  const notes: string[] = [];
  const roles = [...new Set(runs.map(r => r.role))];
  for (const role of roles) {
    const mine = runs.filter(r => r.role === role);
    const past = others.filter(r => r.role === role);
    if (mine.length > 1) notes.push(`${role} ran ${mine.length} times in this team: check whether resuming one member would have avoided rereading (${mine.map(r => k(r.maxContext)).join(', ')} max context).`);
    if (past.length >= 3) {
      const ratio = avg(mine.map(r => r.cost)) / Math.max(1e-9, avg(past.map(r => r.cost)));
      if (ratio >= 2 || ratio <= 0.5) notes.push(`${role} cost ${ratio.toFixed(1)}x its average over ${past.length} runs in other teams.`);
    }
    const listed = [...new Set(mine.flatMap(r => r.skills.listed))];
    const never = listed.filter(n => !mine.some(r => r.skills.read.some(x => x.name === n)));
    if (never.length >= 5) notes.push(`${role} carried ${never.length} skills it never read (${never.slice(0, 5).join(', ')}, …): see /team stats ${role} before trimming the role.`);
  }
  const silent = runs.filter(r => silentReport(r.report));
  if (silent.length) notes.push(`Ended without a report: ${silent.map(r => `${r.key} (${r.state}${inForm(r.brief) && r.brief!.missing.includes('Limits') ? ', brief had no Limits' : ''})`).join(', ')}.`);
  const briefed = runs.filter(r => r.brief);
  const outside = briefed.filter(r => !inForm(r.brief));
  if (outside.length) notes.push(`${outside.length} of ${briefed.length} briefs were not in the standard form.`);
  const gaps = [...new Set(briefed.filter(r => inForm(r.brief)).flatMap(r => r.brief!.missing))];
  if (gaps.length) notes.push(`Standard-form briefs left out: ${gaps.join(', ')}.`);
  const reported = runs.filter(r => r.report && !silentReport(r.report));
  const loose = reported.filter(r => !formalReport(r.report));
  if (loose.length) notes.push(`${loose.length} of ${reported.length} reports were not in the standard form.`);
  const extra = runs.flatMap(r => (r.skills.extra ?? []).map(n => `${n} (${r.role})`));
  if (extra.length) notes.push(`Members looked up skills their role does not list: ${[...new Set(extra)].join(', ')}.`);
  lines.push('', '## Signals', ...(notes.length ? notes.map(n => `- ${n}`) : ['- Nothing stands out.']));
  return lines.join('\n');
}
export const retroAsk = [
  'Review this retrospective draft before you finish:',
  '- Record a lesson with lesson_record only for a pattern that should change how future teams are set up or briefed (topic team-roles for any repository, or the repository\'s proj- topic). One-off events are not lessons. If lesson_record is unavailable, list the lesson candidates in your reply instead.',
  '- If members lacked knowledge that no installed skill covers, run `npx skills find <keywords>` and add the best candidates (name, installs, link) to the team summary as candidates for the user. Do not install anything.',
  '- Tell the user in two or three lines what the draft shows.',
].join('\n');
// Saved beside summary.md so it is archived with the team; stats records stay in teams/stats.
export function writeRetro(teamId: string, retro: string, dir = join(root, teamId)) {
  try { writeFileSync(join(dir, 'retro.md'), `${retro}\n`); } catch { /* the draft is a convenience */ }
}
