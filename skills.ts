import { getAgentDir, loadSkills, type Skill } from '@earendil-works/pi-coding-agent';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists } from './registry.ts';

// Skills pi-team ships for its roles (role-skills/<name>/SKILL.md). Members find them through the
// role agent's skillPath, which pi-subagents keeps private to the child, so they never enter the main
// session's or a lead's skill list: the main session delegates to the role instead of reading them.
// The folder is not named skills/ so pi never takes it for a package skill folder.
export const roleSkillsDir = fileURLToPath(new URL('./role-skills', import.meta.url));
// loadSkills() alone reads only <agentDir>/skills and <cwd>/.pi/skills; pi's package manager also adds
// ~/.agents/skills, .agents/skills in the working tree, and the skills of installed packages (pi-subagents).
export function skillCatalog(cwd: string): Skill[] {
  const agentDir = getAgentDir();
  const packageDirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .flatMap(d => d.name.startsWith('@') ? packageDirs(join(dir, d.name)) : [join(dir, d.name)]);
    } catch { return []; }
  };
  // Repository folders first: on a name clash the first skill loaded wins, and the project's should.
  // pi-team's role skills are listed too, so team_skills can give one to a member of another role.
  const skillPaths = [join(cwd, '.omp', 'skills'), join(cwd, '.agents', 'skills'), join(homedir(), '.agents', 'skills'), roleSkillsDir,
    ...packageDirs(join(agentDir, 'npm', 'node_modules')).map(dir => join(dir, 'skills'))].filter(exists);
  return loadSkills({ cwd, agentDir, skillPaths, includeDefaults: true }).skills;
}
// Skills a repository ships for its own work. pi loads .pi/skills and .agents/skills, but a member
// lists only its role's named skills, and .omp/skills (omp's folder, which many repositories keep)
// pi never loads. Every member gets these, found through skillPath so a project skill wins over a
// general skill of the same name.
const repoSkillFolders = ['.omp/skills', '.pi/skills', '.agents/skills'];
export interface RepoSkills { names: string[]; dirs: string[] }
export function repoSkills(root: string): RepoSkills {
  const dirs = repoSkillFolders.map(folder => join(root, folder)).filter(exists);
  if (!dirs.length) return { names: [], dirs };
  try {
    const skills = loadSkills({ cwd: root, agentDir: getAgentDir(), skillPaths: dirs, includeDefaults: false }).skills
      .filter(s => !s.disableModelInvocation && dirs.some(dir => inside(dir, s.filePath)));
    return { names: [...new Set(skills.map(s => s.name))], dirs };
  } catch { return { names: [], dirs }; }
}
export const skillSize = (skill: Skill) => { try { return statSync(skill.filePath).size; } catch { return 0; } };
export const inside = (root: string, path: string) => { const rel = relative(root, path); return !!rel && !isAbsolute(rel) && !rel.startsWith('..'); };

// The lead coordinates; it does not need the whole skill catalogue in every request (79 skills were
// about 45k characters of system prompt on each turn). Give it these skills, or the orchestrator's
// own `skills` list, plus any skills the repository itself ships. `skills: ["*"]` keeps them all.
export const leadSkills = ['fluent-korean', 'herdr-agent-messenger', 'pi-subagents'];
export function leadSkillArgs(wanted: string[] | undefined, worktree: string) {
  const names = wanted ?? leadSkills;
  if (names.includes('*')) return [];
  const chosen = skillCatalog(worktree).filter(s => names.includes(s.name) || inside(worktree, s.filePath));
  return ['--no-skills', ...[...new Set(chosen.map(s => dirname(s.filePath)))].flatMap(dir => ['--skill', dir])];
}
