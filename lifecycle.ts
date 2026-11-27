import { cpSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cachedUsage, size } from './disk.ts';
import { dirname, basename, isAbsolute, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateAgents, imageDisabled, readPresets, unknownPreset, type Presets } from './presets.ts';
import { leadSkillArgs } from './skills.ts';
import { retroReport, writeRetro } from './stats.ts';
import { appendLedger, checkIcon, cleanTitle, clipText, defaultIcon, diffStat, exec, exists, getLead, getTeam, git, isLive, ledger, locked, log, members, mkdir, readText, root, teamDir, teamName, teams, teamTitle, writeAtomic, writeJson, type Team, type LedgerEntry } from './registry.ts';

export interface Start { preset: string; name?: string; title?: string; base?: string; fromDirty?: boolean; goal: string; icon?: string }
interface HerdrCreated { workspace: { workspace_id: string }; root_pane: { pane_id: string }; worktree: { path: string } }
const herdrLabel = (team: Team) => `${team.icon} ${clipText(teamTitle(team), 40)}`;
// The terminal title follows the Herdr workspace label. A lead brings it in line with the team's
// title when it starts, so teams made before titles existed, or renamed meanwhile, catch up.
export function syncHerdrLabel(team: Team) {
  if (!team.workspace || process.env.HERDR_ENV !== '1') return;
  const label = herdrLabel(team);
  const current = herdr<{ workspace?: { label?: string } }>(team.repo, 'workspace', 'get', team.workspace).workspace?.label;
  if (current !== label) herdr(team.repo, 'workspace', 'rename', team.workspace, label);
}
function herdr<T>(cwd: string, ...args: string[]): T {
  const output = exec('herdr', args, cwd);
  const start = output.indexOf('{');
  if (start < 0) throw new Error(`Unexpected Herdr output: ${output}`);
  const data = JSON.parse(output.slice(start));
  if (!data.result) throw new Error(data.error?.message ?? `Unexpected Herdr response: ${output}`);
  return data.result;
}
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
// Spell out the member agents: without the list, leads guess names such as pi-team.<preset>-member.
export function roleList(presets: Presets, preset: string) {
  return Object.entries(presets[preset]).filter(([role]) => role !== 'orchestrator' && !(role === 'image' && imageDisabled()))
    .map(([role, item]) => `pi-team.${preset}-${role}${[item.readOnly && 'read-only', item.max && `up to ${item.max} at once`].filter(Boolean).map(s => ` (${s})`).join('')}${item.description ? `: ${item.description}` : ''}`);
}

// `herdr worktree create` opens a primary workspace for the repository when none exists.
// Record it as pi-team's so close can remove it once no team or worktree needs it.
interface HerdrWorkspace { workspace_id: string; pane_count: number; tab_count: number; worktree?: { repo_key: string; is_linked_worktree: boolean } }
const repoKey = (repo: string) => realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
function repoWorkspaces(repo: string, key: string) {
  const { workspaces } = herdr<{ workspaces: HerdrWorkspace[] }>(repo, 'workspace', 'list');
  return workspaces.filter(w => {
    if (!w.worktree) return false;
    try { return realpathSync(w.worktree.repo_key) === key; } catch { return false; }
  });
}
function closeHostWorkspace(team: Team) {
  const id = team.hostWorkspace;
  if (!id || teams().some(t => t.hostWorkspace === id)) return '';
  const group = repoWorkspaces(team.repo, repoKey(team.repo));
  const host = group.find(w => w.workspace_id === id);
  if (!host) return '';
  const keep = (why: string) => ` Kept Herdr workspace ${id} (${why}).`;
  if (group.some(w => w.worktree?.is_linked_worktree)) return keep('other worktrees are open');
  if (host.tab_count !== 1 || host.pane_count !== 1) return keep('it has more tabs or panes');
  const { panes } = herdr<{ panes: { pane_id: string }[] }>(team.repo, 'pane', 'list', '--workspace', id);
  const { process_info: info } = herdr<{ process_info: { shell_pid?: number; foreground_process_group_id?: number } }>(team.repo, 'pane', 'process-info', '--pane', panes[0].pane_id);
  if (!info.shell_pid || info.foreground_process_group_id !== info.shell_pid) return keep('its shell is running a command');
  herdr(team.repo, 'workspace', 'close', id);
  return ` Closed Herdr workspace ${id}.`;
}
// Names what blocked the start so the user can commit it or exclude it in git instead of guessing.
export function dirtyList(porcelain: string, limit = 10) {
  const lines = porcelain.split('\n').filter(Boolean);
  const more = lines.length > limit ? [`... and ${lines.length - limit} more`] : [];
  return ['Uncommitted or untracked paths:', ...lines.slice(0, limit).map(line => `  ${line.trim()}`), ...more].join('\n');
}
// Untracked files that tools create (.gradle/, IDE settings) should not block a start, but new
// source files must: the team starts from the committed base and would silently miss them.
// start-ignore files use gitignore syntax and only ever excuse untracked paths.
export const startIgnoreFiles = (repo: string) => [join(root, 'start-ignore'), join(repo, '.pi', 'teams', 'start-ignore')].filter(exists);
export function dirtyState(repo: string) {
  const tracked = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  const untracked = (extra: string[]) => git(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--directory', '--no-empty-directory', ...extra]).split('\0').filter(Boolean);
  const all = untracked([]);
  const files = startIgnoreFiles(repo);
  // The repository's own start-ignore never blocks a start, even before it is committed.
  const left = files.length && all.length ? untracked([...files.map(f => `--exclude-from=${f}`), '--exclude=/.pi/teams/start-ignore']) : all;
  // --directory lists a directory as a whole while any untracked file inside it is not excluded,
  // so an entry of the full list counts as skipped only when nothing at, above or below it is left.
  const skipped = all.filter(path => !left.some(l => l.startsWith(path) || path.startsWith(l))).length;
  return { porcelain: [tracked, ...left.map(path => `?? ${path}`)].filter(Boolean).join('\n'), skipped };
}
// Anthropic keeps a prompt cache for five minutes by default. A lead that waits longer for its members
// rewrites its whole context on every wake, and pi's idle cache warming does not run for the team's
// virtual models, so ask for the one-hour cache unless the user chose a retention already.
// Read once at load, from the shell: main.json's cacheRetention (applied later, for the main session
// itself) must not leak into the leads and members that session starts.
const shellLead = process.env.PI_CACHE_RETENTION;
const shellMember = process.env.PI_SUBAGENT_CACHE_RETENTION;
export const cacheRetention = () => shellLead || 'long';
// Members get the 5-minute cache unless the user set PI_SUBAGENT_CACHE_RETENTION. On macbook's 105
// member sessions (11-27) the 1-hour premium (about 5.2M input-token equivalents) cost more than the
// rewrites it saved (about 2.2M): members rarely pause past five minutes. Teams whose members wait
// long (device runs, long builds) can set long.
export const memberCacheRetention = () => shellMember || 'short';
const leanLead = [
  'Keep your own context small; it is re-read on every turn. Members do the reading, building and checking:',
  '- Do not read source files, logs or long documents to review or verify work, and do not run builds, tests or captures yourself. Ask a member (scout, reviewer, qa-tester, vision) and work from its summary.',
  '- Look at an image yourself only when you must judge it for the user, and not the same image twice.',
  '- For a follow-up on the same files, resume the member that did the previous round instead of starting a fresh one that has to reread everything: find its exact run id with subagent action "status" or "children.list" (a "Mission" id is not a run id), then call action "resume" with that id and a message. Start a fresh member only for a different role, when resume is rejected, or when the previous one has a very large context.',
  '- Call team_peers only when you need addresses or states.',
  '- When you finish with team_report status done, you get a retrospective draft built from the run records; follow its instructions briefly.',
  '- When a task needs knowledge a role does not carry, search installed skills with team_skills and give that one member the extra skills through the subagent skill option. New skills are not installed during a team run; mention the gap in your report instead.',
].join('\n');

// Members start fresh and cannot ask the user; what the lead leaves out of a brief, they guess.
// craft-light showed both sides: well-structured briefs worked, and a brief without a time box or
// report form ended in a member that timed out silently.
export const intake = [
  'Before the first delegation, check the goal:',
  '- Write a short working brief for yourself: outcome, in scope and out of scope, done criteria, constraints, unknowns. Skip this when the goal already states them.',
  '- Split the unknowns. If an answer would change what gets built or risks rework, ask the user before delegating: at most 3 questions, each with lettered options and your recommended default. Otherwise assume the default, state the assumption to the user, and proceed.',
  '- When facts in the repository would settle a question, have a scout find them instead of asking the user or reading files yourself.',
].join('\n');
export const briefForm = [
  'Every member task uses these headings, in this order, kept short and concrete:',
  '## Goal - one sentence.',
  '## Background - why, plus the user\'s words quoted verbatim when they matter; a fresh member cannot see this conversation.',
  '## Read first - exact paths, earlier notes and reports to continue from.',
  '## Do - numbered, highest priority first.',
  '## Do not - write scope (which files or folders it may change), files to leave alone, invariants. Read-only roles: say so.',
  '## Done when - acceptance criteria and how to check them (commands, captures, numbers).',
  '## Limits - a time box (default 30 minutes), a notes file to append after each step, and when to stop and report. Keep notes, captures, evidence and other artifacts under artifacts/ in the team worktree; never in /tmp, the main checkout or another shared folder, which can be cleaned while the team runs. If the user or a document names another place, keep the originals under artifacts/ and copy them there when done.',
  '## Report - what to return: the result, checks run and checks not run, open issues, changed files, artifact paths.',
  'Add what the role needs: questions and evidence as path:line for investigation; findings P0-P2 with proof and a verdict for review; output paths for artifacts and captures.',
].join('\n');

// The lead prompt is built from the current code's guidance, not frozen at team creation: a lead
// writes it again on every start (see index.ts), so restarting an older team picks up new guidance.
// When to reach for the common roles, for the ones this preset has. Descriptions say what a role
// is; this says when the lead should use it, which the 11-26 preset rework had dropped.
const routes: [role: string, line: string][] = [
  ['scout', 'scout: first, whenever facts in the code, docs or logs decide a question (where something is defined or called, what a config does, which files a change touches). Ask a concrete question and work from its path:line findings instead of reading files yourself. It cannot run commands, so builds, tests and git history go to task or qa-tester.'],
  ['task', 'task: implementation, debugging and fixes, unless a specialist role\'s description fits the work better.'],
  ['reviewer', 'reviewer: after a member changes code and before you report it to the user as done. Give it the goal, the done criteria and the changed files.'],
  ['qa-tester', 'qa-tester: to run and check a web UI in a browser.'],
  ['vision', 'vision: to read screenshots and design images; do not open the same images yourself.'],
];
export function routingGuide(presets: Presets, preset: string) {
  const roles = presets[preset] ?? {};
  const lines = routes.filter(([role]) => Object.hasOwn(roles, role)).map(([, line]) => `- pi-team.${preset}-${line}`);
  return lines.length ? `When to use the common roles:\n${lines.join('\n')}` : '';
}
export function leadPrompt(team: Team, presets: Presets) {
  return [
    `You lead pi-team ${team.id} ("${teamTitle(team)}") in ${team.worktree}. Talk directly to the user. If the work changes course, the user can retitle the team with /team title.`,
    `Delegate with the subagent tool only to these member agents, using the exact names. Pick the member whose description fits the work:\n${roleList(presets, team.preset).map(r => `- ${r}`).join('\n')}\nNever pass model, cwd, worktree, an external runner, or a script workflow. Use async children when members must exchange mail.`,
    routingGuide(presets, team.preset),
    'If a member fails with a recorded fallback and sideEffects=false, run that role again so routing skips the cooled model. If sideEffects=true, do not rerun it; report the failure and side effects to the user.',
    'Use team_peers to inspect members and team_send to collaborate. Use team_report to finalize the team summary. Do not merge or remove the worktree without the user.',
    'Team artifacts (notes, captures, evidence, reports) live under artifacts/ in this worktree, even when a handoff document names a folder in the main checkout: copy them there at the end and keep the originals. /team close moves artifacts/ into the team archive. Rebuildable outputs (build, .dart_tool, DerivedData, node_modules) can be removed with /team clean while the team stays open.',
    intake,
    briefForm,
    leanLead,
    presets[team.preset]?.orchestrator?.prompt ?? '',
  ].join('\n\n');
}
export const leadPromptPath = (id: string) => join(teamDir(id), 'lead-prompt.md');
// Returns true when the file changed. pi reads --append-system-prompt files after loading
// extensions, so a rewrite from the lead's extension factory applies to that same launch.
export function refreshLeadPrompt(team: Team, presets: Presets) {
  const path = leadPromptPath(team.id);
  const next = leadPrompt(team, presets);
  if (readText(path) === next) return false;
  writeAtomic(path, next);
  return true;
}

// The one way to run a lead: team env, the orchestrator model, the lead prompt, role skills and extensions.
// Without PI_TEAM_ROLE=lead and PI_TEAM_ID, pi-team starts as an ordinary main session.
function leadCommand(team: Team, presets: Presets, tail: string[]) {
  const orchestrator = presets[team.preset].orchestrator;
  const extra = orchestrator.extensions?.flatMap(path => ['--extension', path]) ?? [];
  const skillArgs = leadSkillArgs(orchestrator.skills, team.worktree);
  return ['env', `PI_TEAM_ID=${team.id}`, 'PI_TEAM_ROLE=lead', `PI_CACHE_RETENTION=${cacheRetention()}`, `PI_SUBAGENT_CACHE_RETENTION=${memberCacheRetention()}`, 'pi', '--model', `team/${team.preset}.orchestrator`,
    '--append-system-prompt', leadPromptPath(team.id), ...skillArgs, ...extra, ...tail].map(quote).join(' ');
}
// rename within a disk, copy and remove across disks (worktrees and ~/.pi can sit on different volumes).
function moveTree(from: string, to: string) {
  try { renameSync(from, to); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}
const shells = new Set(['fish', 'bash', 'zsh', 'sh', 'dash', 'ksh', 'tcsh', 'nu', '-fish', '-bash', '-zsh', '-sh']);
// Bring back a lead whose process ended (sleep, crash, closed pane) on its own session, so it keeps
// its conversation. In its Herdr pane when that pane sits at a shell prompt; otherwise print the command.
// The shell command that brings the lead back on its last session (or the worktree's latest one).
export function resumeCommand(id: string, ignorePid?: number) {
  const team = getTeam(id);
  if (!team) throw new Error(`Unknown team: ${id}`);
  const lead = getLead(id);
  if (isLive(lead) && lead!.state !== 'stopped' && lead!.pid !== ignorePid) throw new Error(`The lead of ${id} is already running (PID ${lead!.pid}).`);
  if (!exists(team.worktree)) throw new Error(`The worktree of ${id} is gone: ${team.worktree}`);
  const presets = readPresets(team.worktree, id);
  if (!presets[team.preset]) throw unknownPreset(team.worktree, team.preset);
  refreshLeadPrompt(team, presets);
  const session = lead?.sessionFile && exists(lead.sessionFile) ? ['--session', lead.sessionFile] : ['--continue'];
  return { team, session, command: `cd ${quote(team.worktree)} && ${leadCommand(team, presets, session)}` };
}
// Herdr restores a pane after a reboot or a server restart with a bare `pi --session <file>`: no team
// env, no lead prompt, no 1-hour cache. On 11-27 such a restored lead rewrote 250-364k tokens after
// every pause over five minutes. From inside that session: wait for this pi to exit, then run the lead
// command in the same pane, which is back at its shell prompt by then.
export function relaunchAsLead(id: string, pane: string) {
  const { command } = resumeCommand(id, process.pid);
  const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; sleep 0.7; herdr pane run "$2" "$3"';
  spawn('sh', ['-c', script, 'pi-team-relaunch', String(process.pid), pane, command], { detached: true, stdio: 'ignore' }).unref();
  return command;
}
export function resumeLead(id: string) {
  const { team, session, command } = resumeCommand(id);
  let blocked = '';
  if (team.pane) {
    try {
      // Linux reports argv; macOS reports argv0, and node programs such as pi show up as name "node".
      type Proc = { name?: string; argv?: string[]; argv0?: string };
      const info = JSON.parse(exec('herdr', ['pane', 'process-info', '--pane', team.pane], team.repo)) as { result?: { process_info?: { foreground_processes?: Proc[] } } };
      const fg = info.result?.process_info?.foreground_processes ?? [];
      const program = (p: Proc) => (p.argv0 ?? p.argv?.[0] ?? p.name ?? '').split('/').pop()!;
      const busy = fg.filter(p => !shells.has(program(p)) && !shells.has(p.name ?? ''));
      if (!busy.length) {
        exec('herdr', ['pane', 'run', team.pane, command], team.repo);
        return `Resuming the lead of ${id} in pane ${team.pane}${session[0] === '--session' ? ' on its last session' : ''}.`;
      }
      blocked = ` Pane ${team.pane} is running ${busy.map(p => p.argv?.join(' ') || program(p)).join(', ')}; exit it first, then run:`;
    } catch { blocked = ` Pane ${team.pane} is not available; run this in a terminal:`; }
  }
  return `${blocked ? blocked.trim() : `Run this in a terminal to resume the lead of ${id}:`}\n${command}`;
}

export function start(cwd: string, p: Start, alias?: { key: string; names: string[]; description?: string; icon?: string }) {
  if (!p.goal.trim() || p.goal.includes('\0')) throw new Error('A goal is required.');
  if (p.icon !== undefined) checkIcon(p.icon, 'Team start');
  const title = cleanTitle(p.title);
  const requested = p.name === undefined ? undefined : teamName(p.name);
  if (p.name !== undefined && !requested) throw new Error(`Invalid team name: ${p.name}. Use English words; they become lowercase-hyphenated.`);
  const repo = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  const presets = readPresets(repo);
  if (!Object.hasOwn(presets, p.preset)) throw unknownPreset(repo, p.preset);
  const base = p.base ?? 'HEAD';
  const baseCommit = git(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  const symbolic = git(repo, ['rev-parse', '--symbolic-full-name', '--end-of-options', base]).split('\n').find(x => x.startsWith('refs/heads/') || x.startsWith('refs/remotes/'));
  const { porcelain: dirty, skipped } = p.fromDirty ? { porcelain: '', skipped: 0 } : dirtyState(repo);
  if (dirty) throw new Error(`Working tree is dirty. Ask the user to confirm before retrying with fromDirty: true (CLI: --from-dirty); the team starts from the committed base only. Untracked files that tools generate can be listed in .pi/teams/start-ignore (gitignore syntax).\n${dirtyList(dirty)}`);
  const skipNote = skipped ? ` Skipped ${skipped} untracked path${skipped === 1 ? '' : 's'} matched by start-ignore.` : '';
  // Allocate and reserve the ID together so concurrent starts cannot pick the same name.
  const archive = join(root, 'archive');
  const id = locked(join(root, '.teams.lock'), () => {
    const chosen = requested ?? alias?.key;
    let name = chosen ?? `${p.preset.slice(0, 23)}-${randomBytes(4).toString('hex')}`;
    const reserved = (candidate: string) => candidate === 'archive' || candidate === 'vendor' || candidate === 'stats';
    // A chosen name that is taken gets -2, -3, ...; a random one is unique already.
    if (chosen) {
      const prefix = 'refs/heads/pi-team/';
      const branches = new Set(git(repo, ['for-each-ref', '--format=%(refname)', prefix]).split('\n')
        .filter(ref => ref.startsWith(prefix)).map(ref => ref.slice(prefix.length)));
      for (let n = 2; reserved(name) || exists(teamDir(name)) || exists(join(archive, name)) || branches.has(name); n++) {
        const suffix = `-${n}`;
        name = `${chosen.slice(0, 32 - suffix.length).replace(/-+$/, '')}${suffix}`;
      }
    }
    const dir = teamDir(name);
    if (reserved(name)) throw new Error(`Reserved team name: ${name}`);
    if (exists(dir) || exists(join(archive, name))) throw new Error(`Team already exists: ${name}`);
    mkdir(dir);
    return name;
  });
  const dir = teamDir(id);
  const branch = `pi-team/${id}`;
  const captured = presets;
  let made = false;
  let team: Team | undefined;
  try {
    const worktree = join(dirname(repo), 'worktrees', basename(repo), `team-${id}`);
    team = { id, preset: p.preset, repo, worktree, branch, base, baseCommit, baseBranch: symbolic, goal: p.goal, createdAt: Date.now(),
      alias: alias?.key, aliasLabel: alias?.names[0], icon: p.icon ?? alias?.icon ?? defaultIcon(id), description: alias?.description, title };
    mkdir(dirname(worktree));
    if (process.env.HERDR_PANE_ID) {
      const key = repoKey(repo);
      const primaries = () => repoWorkspaces(repo, key).filter(w => !w.worktree?.is_linked_worktree).map(w => w.workspace_id);
      const before = new Set(primaries());
      const response = herdr<HerdrCreated>(repo, 'worktree', 'create', '--cwd', repo, '--branch', branch, '--base', baseCommit, '--path', worktree, '--label', herdrLabel(team), '--no-focus');
      team.worktree = response.worktree.path; team.workspace = response.workspace.workspace_id; team.pane = response.root_pane.pane_id;
      try {
        const after = primaries();
        team.hostWorkspace = after.find(w => !before.has(w)) ?? teams().find(t => t.hostWorkspace && after.includes(t.hostWorkspace))?.hostWorkspace;
      } catch { /* cleanup bookkeeping only */ }
    } else {
      git(repo, ['worktree', 'add', '-b', branch, worktree, baseCommit]);
    }
    made = true;
    generateAgents(captured);
    const workerRoot = team.worktree;
    for (const role of Object.values(captured[p.preset])) {
      if (!role.extensions) continue;
      role.extensions = role.extensions.map(path => {
        const rel = relative(repo, path);
        return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) ? join(workerRoot, rel) : path;
      });
    }
    writeJson(join(dir, 'preset.json'), captured);
    writeAtomic(join(dir, 'ledger.jsonl'), '');
    mkdir(join(dir, 'inbox', 'lead'));
    mkdir(join(dir, 'members'));
    const promptPath = leadPromptPath(id);
    writeAtomic(promptPath, leadPrompt(team, captured));
    writeJson(join(dir, 'team.json'), team);
    const command = leadCommand(team, captured, ['--', p.goal]);
    // Herdr passes pane run's command tail as shell text, not as an argv array.
    if (team.pane) exec('herdr', ['pane', 'run', team.pane, command], repo);
    return team.pane ? `Started ${id}: ${team.worktree} (${team.branch}), workspace ${team.workspace}, pane ${team.pane}.${skipNote}`
      : `Created ${id}: ${team.worktree} (${team.branch}).${skipNote} Launch the lead:\ncd ${quote(team.worktree)} && ${command}`;
  } catch (e) {
    if (!made) rmSync(dir, { recursive: true });
    else if (!getTeam(id) && team) writeJson(join(dir, 'team.json'), team);
    throw e;
  }
}
// Retitle a team. The ID, branch, worktree and addresses stay; panels, board and Herdr follow the title.
export function retitle(id: string, title: string) {
  const clean = cleanTitle(title);
  if (!clean) throw new Error('Usage: /team title <team> <title>');
  const team = locked(join(root, `.participants-${id}.lock`), () => {
    const current = getTeam(id);
    if (!current) throw new Error(`Unknown team: ${id}`);
    const next = { ...current, title: clean };
    writeJson(join(teamDir(id), 'team.json'), next);
    return next;
  });
  let note = '';
  if (team.workspace) {
    try { herdr(team.repo, 'workspace', 'rename', team.workspace, herdrLabel(team)); }
    catch (e) { note = ` (Herdr workspace label unchanged: ${e instanceof Error ? e.message : String(e)})`; }
  }
  return `Team ${id} is now titled "${clean}".${note}`;
}
export function closeTeam(id: string, confirmLead: boolean, confirmUnmerged: boolean) {
  teamDir(id);
  return locked(join(root, `.participants-${id}.lock`), () => {
    const team = getTeam(id);
    if (!team) throw new Error(`Unknown team: ${id}`);
    const lead = getLead(id);
    if ((isLive(lead) || (!lead && team.workspace && Date.now() - team.createdAt < 10_000)) && !confirmLead) throw new Error('The lead is still live or starting. Exit it first, or explicitly confirm with --confirm-lead.');
    if (members(id).some(isLive)) throw new Error('Team members are still live.');
    const base = team.baseBranch ?? team.baseCommit;
    const merged = git(team.repo, ['rev-list', '--count', `${base}..refs/heads/${team.branch}`]) === '0';
    if (!merged && !confirmUnmerged) throw new Error('Branch is not merged into its base. Use --confirm-unmerged to retain the branch and remove only the worktree.');
    // artifacts/ (notes, captures, evidence) is not part of the work to merge: it moves into the team
    // folder and so into the archive, instead of blocking the close or vanishing with the worktree.
    const keep = join(team.worktree, 'artifacts');
    const keepArtifacts = exists(keep) && !git(team.worktree, ['ls-files', '--', 'artifacts']);
    const dirty = git(team.worktree, ['status', '--porcelain', '--untracked-files=normal']).split('\n').filter(l => l && !(keepArtifacts && /^\?\? artifacts\/?$/.test(l)));
    if (dirty.length) throw new Error(`Worktree is dirty. Commit or remove the changes before closing (artifacts/ is kept in the archive):\n${dirty.slice(0, 20).join('\n')}`);
    const dir = teamDir(id);
    if (keepArtifacts) moveTree(keep, join(dir, exists(join(dir, 'artifacts')) ? `artifacts-${Date.now()}` : 'artifacts'));
    const freed = cachedUsage(id);
    // Keep a retrospective draft with the archive, refreshed with the final run records.
    writeRetro(id, retroReport(id), dir);
    const archive = join(root, 'archive', id);
    const mailLock = join(root, '.mail.lock');
    const pending = locked(mailLock, () => {
      if (exists(archive)) throw new Error(`Archive already exists: ${id}`);
      const state = new Map<string, LedgerEntry>();
      for (const event of ledger(id)) if (event.id) state.set(event.id, event);
      const undelivered = [...state.values()].filter(e => e.event === 'sent' && e.to?.endsWith(`@${id}`));
      mkdir(dirname(archive));
      renameSync(dir, archive);
      return undelivered;
    });
    try {
      if (team.workspace) {
        try { herdr(team.repo, 'worktree', 'remove', '--workspace', team.workspace); }
        catch (e) {
          if (!String(e).includes('"code":"workspace_not_found"')) throw e;
          // A user can close the workspace before removing the checkout.
          git(team.repo, ['worktree', 'remove', team.worktree]);
        }
      } else git(team.repo, ['worktree', 'remove', team.worktree]);
    } catch (e) { locked(mailLock, () => renameSync(archive, dir)); throw e; }
    if (pending.length) locked(mailLock, () => {
      const terminal = pending.map(({ body, ...e }): LedgerEntry => ({ ...e, event: 'undelivered', at: Date.now(), reason: 'Team closed before delivery.' }));
      appendLedger(archive, terminal);
      for (const e of terminal) {
        const source = e.from?.split('@')[1];
        if (source && source !== id && getTeam(source)) log(source, e);
      }
    });
    let host = '';
    if (team.workspace) {
      try { host = closeHostWorkspace(team); }
      catch (e) { host = ` Could not check Herdr workspace ${team.hostWorkspace}: ${String(e)}`; }
    }
    const notes = [keepArtifacts && ` Artifacts kept in ${join(archive, 'artifacts')}.`, freed && ` Freed about ${size(freed.totalKb)}.`].filter(Boolean).join('');
    if (merged) {
      // Use Git's own ancestry guard as well; keeping a branch is preferable to forcing deletion.
      try { git(team.repo, ['branch', '-d', team.branch]); }
      catch (e) { return `Closed ${id}; archive: ${archive}. Branch kept: ${String(e)}${notes}${host}`; }
    }
    return `Closed ${id}; archive: ${archive}.${merged ? '' : ` Unmerged branch retained: ${team.branch}.`}${notes}${host}`;
  });
}
export function findSummary(id: string) {
  teamDir(id); // Validate before accepting an archive path.
  return readText(join(teamDir(id), 'summary.md')) ?? readText(join(root, 'archive', id, 'summary.md'));
}
export function threads(events: LedgerEntry[]) {
  const sent = new Map<string, LedgerEntry>();
  const state = new Map<string, LedgerEntry>();
  for (const e of events) if (e.id) { if (e.event === 'sent') sent.set(e.id, e); state.set(e.id, e); }
  const groups = new Map<string, { message: LedgerEntry; state: LedgerEntry['event'] }[]>();
  for (const [id, message] of sent) {
    let parent = id;
    for (let i = 0; i < 5; i++) {
      const next = sent.get(parent)?.replyTo;
      if (!next || !sent.has(next)) break;
      parent = next;
    }
    const group = groups.get(parent) ?? [];
    group.push({ message, state: state.get(id)!.event });
    groups.set(parent, group);
  }
  return [...groups.values()];
}
export function report(team: Team, summary: string, status: string) {
  const events = ledger(team.id);
  const participants = members(team.id);
  const grouped = threads(events);
  const paths = new Map<string, Set<string>>();
  for (const p of participants) for (const path of p.changedPaths ?? []) {
    const owners = paths.get(path) ?? new Set<string>();
    owners.add(p.key); paths.set(path, owners);
  }
  const conflicts = [...paths].filter(([, owners]) => owners.size > 1).map(([path, owners]) => `- ${path}: ${[...owners].join(', ')}`);
  const lead = getLead(team.id);
  const lines = [`# ${teamTitle(team)} (${team.id})`, `Status: ${status}`, '', summary, '', '## Role results',
    ...(lead ? [`- lead (${lead.model ?? 'unknown'}): ${summary}`] : []),
    ...participants.map(p => `- ${p.key} (${p.model ?? 'unknown'}${p.fallback ? ', fallback' : ''}, ${p.state}): ${p.error ?? p.result ?? 'No final result.'}`),
    '', '## Message threads', ...(grouped.length ? grouped.map(group => {
      const first = group[0].message;
      return `- ${first.subject ?? first.id}: ${group.map(({message, state}) => `${message.from} → ${message.to} (${state}): ${message.body}`).join(' / ')}${group.length === 1 && group[0].state !== 'closed' ? ' [no reply]' : ''}`;
    }) : ['- None.']), '', `## Diff stat\n${diffStat(team.worktree, team.baseCommit)}`, '', '## Fallback and cooldown',
    ...events.filter(e => e.event === 'fallback').map(e => `- ${e.from}: ${e.model} ${e.reason}, expires ${new Date(e.until!).toISOString()}, sideEffects=${e.sideEffects}`),
    '', '## Conflict candidates', ...(conflicts.length ? conflicts : ['- No overlapping recorded file edits. Bash side effects require manual review.']), ''];
  const path = join(teamDir(team.id), 'summary.md');
  writeAtomic(path, lines.join('\n'));
  return path;
}
export function splitGoal(args: string, usage: string) {
  const marker = /(?:^|\s)--(?:\s|$)/u.exec(args);
  const target = marker && args.slice(0, marker.index).trim();
  const goal = marker && args.slice(marker.index + marker[0].length).trim();
  if (!target || !goal) throw new Error(usage);
  return { target, goal };
}
export function parseStart(args: string): Start {
  const { target, goal } = splitGoal(args, 'Usage: /team start <preset or alias> [--title TEXT] [--name N] [--base REF] [--icon EMOJI] [--from-dirty] -- <goal>');
  const firstFlag = /(?:^|\s)--\S/u.exec(target);
  const preset = firstFlag ? target.slice(0, firstFlag.index).trim() : target;
  if (!preset) throw new Error('A preset or alias is required.');
  const tokens = firstFlag ? target.slice(firstFlag.index).trim().split(/\s+/u) : [];
  const result: Start = { preset, goal };
  const seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i];
    if (seen.has(flag)) throw new Error(`Repeated start option: ${flag}`);
    seen.add(flag);
    if (flag === '--from-dirty') result.fromDirty = true;
    else if (flag === '--title') {
      // The title runs to the next option, so it can hold spaces without quotes.
      const words: string[] = [];
      while (tokens[i + 1] && !tokens[i + 1].startsWith('--')) words.push(tokens[++i]);
      if (!words.length) throw new Error('--title needs text.');
      result.title = words.join(' ');
    }
    else if ((flag === '--name' || flag === '--base') && tokens[i + 1] && !tokens[i + 1].startsWith('--')) result[flag === '--name' ? 'name' : 'base'] = tokens[++i];
    else if (flag === '--icon' && tokens[i + 1] && !tokens[i + 1].startsWith('--')) result.icon = checkIcon(tokens[++i], 'Team start');
    else throw new Error(`Invalid start option: ${flag}`);
  }
  return result;
}
