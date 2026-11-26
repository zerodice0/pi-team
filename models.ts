import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readPresets, registerModels } from './presets.ts';
import { git } from './registry.ts';

// Loaded only into members the main session delegates to (subagentOnlyExtensions). It registers the
// role virtual models so team/<preset>.<role> resolves in the child, and nothing else.
export default function models(pi: ExtensionAPI) {
  let cwd = process.cwd();
  try { cwd = git(cwd, ['rev-parse', '--show-toplevel']); } catch { /* not a git repository */ }
  registerModels(pi, readPresets(cwd), undefined, { skipOrchestrator: true });
}
