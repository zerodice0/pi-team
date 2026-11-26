import { realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, basename, isAbsolute, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateAgents, imageDisabled, readPresets, type Presets } from './presets.ts';
import { leadSkillArgs } from './skills.ts';
import { appendLedger, checkIcon, defaultIcon, diffStat, exec, exists, getLead, getTeam, git, isLive, ledger, locked, log, members, mkdir, readText, root, teamDir, teams, writeAtomic, writeJson, type Team, type LedgerEntry } from './registry.ts';

export interface Start { preset: string; name?: string; base?: string; fromDirty?: boolean; goal: string; icon?: string }
interface HerdrCreated { workspace: { workspace_id: string }; root_pane: { pane_id: string }; worktree: { path: string } }
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
export const cacheRetention = () => process.env.PI_CACHE_RETENTION || 'long';
const leanLead = [
  'Keep your own context small; it is re-read on every turn. Members do the reading, building and checking:',
  '- Do not read source files, logs or long documents to review or verify work, and do not run builds, tests or captures yourself. Ask a member (scout, reviewer, qa-tester, vision) and work from its summary.',
  '- Look at an image yourself only when you must judge it for the user, and not the same image twice.',
  '- For a follow-up on the same files, resume the member that did the previous round instead of starting a fresh one that has to reread everything: find its exact run id with subagent action "status" or "children.list" (a "Mission" id is not a run id), then call action "resume" with that id and a message. Start a fresh member only for a different role, when resume is rejected, or when the previous one has a very large context.',
  '- Call team_peers only when you need addresses or states.',
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
  '## Limits - a time box (default 30 minutes), a notes file to append after each step, and when to stop and report. Keep notes, captures and other artifacts under artifacts/ in the team worktree (never /tmp) unless the user named another place.',
  '## Report - what to return: the result, checks run and checks not run, open issues, changed files, artifact paths.',
  'Add what the role needs: questions and evidence as path:line for investigation; findings P0-P2 with proof and a verdict for review; output paths for artifacts and captures.',
].join('\n');

export function start(cwd: string, p: Start, alias?: { key: string; names: string[]; description?: string; icon?: string }) {
  if (!p.goal.trim() || p.goal.includes('\0')) throw new Error('A goal is required.');
  if (p.icon !== undefined) checkIcon(p.icon, 'Team start');
  const repo = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  const presets = readPresets(repo);
  if (!Object.hasOwn(presets, p.preset)) throw new Error(`Unknown preset: ${p.preset}`);
  const base = p.base ?? 'HEAD';
  const baseCommit = git(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  const symbolic = git(repo, ['rev-parse', '--symbolic-full-name', '--end-of-options', base]).split('\n').find(x => x.startsWith('refs/heads/') || x.startsWith('refs/remotes/'));
  const { porcelain: dirty, skipped } = p.fromDirty ? { porcelain: '', skipped: 0 } : dirtyState(repo);
  if (dirty) throw new Error(`Working tree is dirty. Ask the user to confirm before retrying with fromDirty: true (CLI: --from-dirty); the team starts from the committed base only. Untracked files that tools generate can be listed in .pi/teams/start-ignore (gitignore syntax).\n${dirtyList(dirty)}`);
  const skipNote = skipped ? ` Skipped ${skipped} untracked path${skipped === 1 ? '' : 's'} matched by start-ignore.` : '';
  // Allocate and reserve the ID together so concurrent starts cannot pick the same name.
  const archive = join(root, 'archive');
  const id = locked(join(root, '.teams.lock'), () => {
    let name = p.name ?? alias?.key ?? `${p.preset.slice(0, 23)}-${randomBytes(4).toString('hex')}`;
    const reserved = (candidate: string) => candidate === 'archive' || candidate === 'vendor' || candidate === 'stats';
    if (p.name === undefined && alias) {
      const prefix = 'refs/heads/pi-team/';
      const branches = new Set(git(repo, ['for-each-ref', '--format=%(refname)', prefix]).split('\n')
        .filter(ref => ref.startsWith(prefix)).map(ref => ref.slice(prefix.length)));
      for (let n = 2; reserved(name) || exists(teamDir(name)) || exists(join(archive, name)) || branches.has(name); n++) {
        const suffix = `-${n}`;
        name = `${alias.key.slice(0, 32 - suffix.length)}${suffix}`;
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
      alias: alias?.key, aliasLabel: alias?.names[0], icon: p.icon ?? alias?.icon ?? defaultIcon(id), description: alias?.description };
    mkdir(dirname(worktree));
    if (process.env.HERDR_PANE_ID) {
      const key = repoKey(repo);
      const primaries = () => repoWorkspaces(repo, key).filter(w => !w.worktree?.is_linked_worktree).map(w => w.workspace_id);
      const before = new Set(primaries());
      const response = herdr<HerdrCreated>(repo, 'worktree', 'create', '--cwd', repo, '--branch', branch, '--base', baseCommit, '--path', worktree, '--label', `${team.icon} pi-team ${id}`, '--no-focus');
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
    const promptPath = join(dir, 'lead-prompt.md');
    writeAtomic(promptPath, [
      `You lead pi-team ${id} in ${team.worktree}. Talk directly to the user.`,
      `Delegate with the subagent tool only to these member agents, using the exact names. Pick the member whose description fits the work:\n${roleList(captured, p.preset).map(r => `- ${r}`).join('\n')}\nNever pass model, cwd, worktree, an external runner, or a script workflow. Use async children when members must exchange mail.`,
      'If a member fails with a recorded fallback and sideEffects=false, run that role again so routing skips the cooled model. If sideEffects=true, do not rerun it; report the failure and side effects to the user.',
      'Use team_peers to inspect members and team_send to collaborate. Use team_report to finalize the team summary. Do not merge or remove the worktree without the user.',
      intake,
      briefForm,
      leanLead,
      captured[p.preset].orchestrator.prompt ?? '',
    ].join('\n\n'));
    writeJson(join(dir, 'team.json'), team);
    const extra = captured[p.preset].orchestrator.extensions?.flatMap(path => ['--extension', path]) ?? [];
    const skillArgs = leadSkillArgs(captured[p.preset].orchestrator.skills, team.worktree);
    const command = ['env', `PI_TEAM_ID=${id}`, 'PI_TEAM_ROLE=lead', `PI_CACHE_RETENTION=${cacheRetention()}`, 'pi', '--model', `team/${p.preset}.orchestrator`, '--append-system-prompt', promptPath, ...skillArgs, ...extra, '--', p.goal].map(quote).join(' ');
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
    if (git(team.worktree, ['status', '--porcelain'])) throw new Error('Worktree is dirty. Commit or remove the changes before closing.');
    const dir = teamDir(id);
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
    if (merged) {
      // Use Git's own ancestry guard as well; keeping a branch is preferable to forcing deletion.
      try { git(team.repo, ['branch', '-d', team.branch]); }
      catch (e) { return `Closed ${id}; archive: ${archive}. Branch kept: ${String(e)}${host}`; }
    }
    return `Closed ${id}; archive: ${archive}.${merged ? '' : ` Unmerged branch retained: ${team.branch}.`}${host}`;
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
  const lines = [`# ${team.id}`, `Status: ${status}`, '', summary, '', '## Role results',
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
  const { target, goal } = splitGoal(args, 'Usage: /team start <preset or alias> [--name N] [--base REF] [--icon EMOJI] [--from-dirty] -- <goal>');
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
    else if ((flag === '--name' || flag === '--base') && tokens[i + 1] && !tokens[i + 1].startsWith('--')) result[flag === '--name' ? 'name' : 'base'] = tokens[++i];
    else if (flag === '--icon' && tokens[i + 1] && !tokens[i + 1].startsWith('--')) result.icon = checkIcon(tokens[++i], 'Team start');
    else throw new Error(`Invalid start option: ${flag}`);
  }
  return result;
}
