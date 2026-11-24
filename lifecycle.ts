import { realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, basename, isAbsolute, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateAgents, readPresets } from './presets.ts';
import { appendLedger, diffStat, exec, exists, getLead, getTeam, git, isLive, ledger, locked, log, members, mkdir, readText, root, teamDir, writeAtomic, writeJson, type Team, type LedgerEntry } from './registry.ts';

export interface Start { preset: string; name?: string; base?: string; fromDirty?: boolean; goal: string }
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
export function start(cwd: string, p: Start, alias?: { key: string; names: string[] }) {
  if (!p.goal.trim() || p.goal.includes('\0')) throw new Error('A goal is required.');
  const repo = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  const presets = readPresets(repo);
  if (!Object.hasOwn(presets, p.preset)) throw new Error(`Unknown preset: ${p.preset}`);
  const base = p.base ?? 'HEAD';
  const baseCommit = git(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  const symbolic = git(repo, ['rev-parse', '--symbolic-full-name', '--end-of-options', base]).split('\n').find(x => x.startsWith('refs/heads/') || x.startsWith('refs/remotes/'));
  if (!p.fromDirty && git(repo, ['status', '--porcelain'])) throw new Error('Working tree is dirty. Ask the user to confirm before retrying with fromDirty: true (CLI: --from-dirty); the team starts from the committed base only.');
  // Allocate and reserve the ID together so concurrent starts cannot pick the same name.
  const archive = join(root, 'archive');
  const id = locked(join(root, '.teams.lock'), () => {
    let name = p.name ?? alias?.key ?? `${p.preset.slice(0, 23)}-${randomBytes(4).toString('hex')}`;
    const reserved = (candidate: string) => candidate === 'archive' || candidate === 'vendor';
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
      alias: alias?.key, aliasLabel: alias?.names[0] };
    mkdir(dirname(worktree));
    if (process.env.HERDR_PANE_ID) {
      const response = herdr<HerdrCreated>(repo, 'worktree', 'create', '--cwd', repo, '--branch', branch, '--base', baseCommit, '--path', worktree, '--label', `pi-team ${id}`, '--no-focus');
      team.worktree = response.worktree.path; team.workspace = response.workspace.workspace_id; team.pane = response.root_pane.pane_id;
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
      `Delegate with the subagent tool only to pi-team.${p.preset}-<role> agents. Never pass model, cwd, worktree, an external runner, or a script workflow. Use async children when members must exchange mail.`,
      'If a member fails with a recorded fallback and sideEffects=false, run that role again so routing skips the cooled model. If sideEffects=true, do not rerun it; report the failure and side effects to the user.',
      'Use team_peers to inspect members and team_send to collaborate. Use team_report to finalize the team summary. Do not merge or remove the worktree without the user.',
      captured[p.preset].orchestrator.prompt ?? '',
    ].join('\n\n'));
    writeJson(join(dir, 'team.json'), team);
    const extra = captured[p.preset].orchestrator.extensions?.flatMap(path => ['--extension', path]) ?? [];
    const command = ['env', `PI_TEAM_ID=${id}`, 'PI_TEAM_ROLE=lead', 'pi', '--model', `team/${p.preset}.orchestrator`, '--append-system-prompt', promptPath, ...extra, '--', p.goal].map(quote).join(' ');
    // Herdr passes pane run's command tail as shell text, not as an argv array.
    if (team.pane) exec('herdr', ['pane', 'run', team.pane, command], repo);
    return team.pane ? `Started ${id}: ${team.worktree} (${team.branch}), workspace ${team.workspace}, pane ${team.pane}.`
      : `Created ${id}: ${team.worktree} (${team.branch}). Launch the lead:\ncd ${quote(team.worktree)} && ${command}`;
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
    if (merged) {
      // Use Git's own ancestry guard as well; keeping a branch is preferable to forcing deletion.
      try { git(team.repo, ['branch', '-d', team.branch]); }
      catch (e) { return `Closed ${id}; archive: ${archive}. Branch kept: ${String(e)}`; }
    }
    return `Closed ${id}; archive: ${archive}.${merged ? '' : ` Unmerged branch retained: ${team.branch}.`}`;
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
  const { target, goal } = splitGoal(args, 'Usage: /team start <preset or alias> [--name N] [--base REF] [--from-dirty] -- <goal>');
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
    else throw new Error(`Invalid start option: ${flag}`);
  }
  return result;
}
