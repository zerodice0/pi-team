import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { join, resolve } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { registerMailbox } from './mailbox.ts';
import { participant } from './participant.ts';
import { imageDisabled, readPresets, registerModels } from './presets.ts';
import { getTeam, root, writeJson } from './registry.ts';
import { board, widget } from './board.ts';
import { trackRun } from './stats.ts';

export default function child(pi: ExtensionAPI) {
  const id = process.env.PI_TEAM_ID;
  const team = id && getTeam(id);
  if (!team) throw new Error('The required pi-team child extension has no registered team.');
  const presets = readPresets(team.worktree, team.id);
  let role: string | undefined;
  pi.on('session_start', (_e, ctx) => {
    const prefix = `${team.preset}.`;
    const model = ctx.model;
    if (model?.provider === 'team' && model.id.startsWith(prefix)) role = model.id.slice(prefix.length);
    if (!role || role === 'orchestrator' || !Object.hasOwn(presets[team.preset], role)) throw new Error(`Child must run a role virtual model (got ${model?.provider}/${model?.id}).`);
    if (realpathSync(ctx.cwd) !== realpathSync(team.worktree)) throw new Error('A team member must run from its team worktree.');
    if (role === 'image' && imageDisabled()) throw new Error(`Image role disabled: ${imageDisabled()}`);
  });
  const state = participant(pi, team, () => role, false, key => presets[team.preset][key].max);
  trackRun(pi, team, state.row);
  registerModels(pi, presets, state.routed);
  registerMailbox(pi, state.owner, state.update);
  widget(pi);
  pi.registerCommand('team', { description: 'Open the team board', async handler(args, ctx) {
    if (args.trim() === 'board') await board(ctx, team.id, state.owner());
    else ctx.ui.notify('Usage: /team board', 'info');
  } });
  pi.on('tool_call', e => {
    if (role !== 'image' || e.toolName !== 'codex_generate_image') return;
    if (imageDisabled()) return { block: true, reason: `Image role disabled: ${imageDisabled()}` };
    const args = e.input as Record<string, unknown>;
    const artifacts = join(team.worktree, 'artifacts');
    if (args.save !== 'custom' || typeof args.saveDir !== 'string' || resolve(team.worktree, args.saveDir) !== artifacts || args.outputFormat !== 'png') {
      return { block: true, reason: 'Use save="custom", saveDir="artifacts", outputFormat="png".' };
    }
    if (lstatSync(artifacts, { throwIfNoEntry: false })?.isSymbolicLink()) return { block: true, reason: 'The artifacts directory must not be a symbolic link.' };
  });
  pi.on('tool_result', e => {
    if (role !== 'image' || e.toolName !== 'codex_generate_image' || !e.isError) return;
    const reason = e.content.flatMap(c => c.type === 'text' ? [c.text] : []).join('\n');
    if (/oauth|unauthoriz|forbidden|HTTP\s*(?:4\d\d|5\d\d)|image generation is unavailable/i.test(reason)) {
      writeJson(join(root, 'image-disabled.json'), { reason: reason.slice(0, 4096), at: Date.now() });
    }
  });
}
