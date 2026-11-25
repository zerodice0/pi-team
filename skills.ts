import { getAgentDir, loadSkills, type Skill } from '@earendil-works/pi-coding-agent';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { exists } from './registry.ts';

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
  const skillPaths = [join(homedir(), '.agents', 'skills'), join(cwd, '.agents', 'skills'),
    ...packageDirs(join(agentDir, 'npm', 'node_modules')).map(dir => join(dir, 'skills'))].filter(exists);
  return loadSkills({ cwd, agentDir, skillPaths, includeDefaults: true }).skills;
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
