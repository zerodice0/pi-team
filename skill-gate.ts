import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { basename } from 'node:path';
import { listedSkills, skillDocs } from './stats.ts';

// A member's listed skills are how its role works, but the list itself only says "read a skill when
// the task matches", and members with plenty of documents to read never made that decision: an
// incense modeler ran 186 turns (2026-11-28) without opening the skill that the repository's rules
// and its brief both named. So the decision is made a step of the work: until the member has read
// one of its listed skills, or said why none fits, tools that run or change things are refused.
// It needs no setup in the repository and does not parse briefs.
//
// Reading once is not enough on a long run. Compaction replaces the skill's text with a summary that
// keeps its name, and members went on without it: one worked 437 of its 477 turns after its first
// compaction and never read a skill a second time. So the choice holds only while a read is still in
// the context; after a compaction that dropped it, the member reads again what its current step needs.
//
// A SKILL.md often sends the member to documents in its own folder (references/…). One member read
// seven skills and only counted the lines of their documents. A whole read of a skill therefore ends
// with the list of that folder's documents.
export const skillSkipTool = 'skill_skip';
// Reading, searching and talking stay open: the member must be able to read the skill and its brief.
const open = new Set(['read', 'grep', 'find', 'ls', skillSkipTool, 'team_peers', 'team_send', 'team_inbox', 'team_wait', 'contact_supervisor', 'intercom']);
export const gatedTool = (tool: string) => !open.has(tool);
const skillFile = /(?:^|\/)SKILL\.md$/;
// Only a read of the whole file counts. A member told to keep its context small read the first 80
// lines of an 18k-character skill and passed, missing the procedure and the documents it points to.
type ReadArgs = { path?: unknown; offset?: unknown; limit?: unknown };
const whole = (a: ReadArgs | undefined) => (a?.limit === undefined || a.limit === null) && (a?.offset === undefined || a.offset === null || Number(a.offset) <= 1);

export function skillGate(pi: ExtensionAPI) {
  let listed: { name: string; dir: string }[] = [];
  let decided = false;
  // True while the choice was lost to a compaction, for the message the member gets.
  let compacted = false;
  const reads = (path: unknown) => {
    const text = String(path ?? '');
    return listed.find(s => text.endsWith(`${basename(s.dir)}/SKILL.md`));
  };
  pi.registerTool({ name: skillSkipTool, label: 'No skill fits',
    description: 'State that none of your listed skills fits this task, with the reason, so you can start working. Use it only after checking the skill descriptions against the brief and the project rules; when a skill fits, read its SKILL.md instead.',
    parameters: Type.Object({ reason: Type.String({ minLength: 10, description: 'Why none of the listed skills applies to this task.' }) }),
    async execute(_id, p) {
      decided = true;
      compacted = false;
      return { content: [{ type: 'text' as const, text: `Noted: no listed skill applies (${p.reason}). Say so in your report.` }], details: {} };
    } });
  // The choice is read from what is still in the context: entries from the last compaction's first
  // kept entry on. That covers a resumed member (it decided in earlier turns) and a compacted one.
  type Entry = { type: string; id?: string; firstKeptEntryId?: string; message?: { role?: string; content?: unknown } };
  let compactions = 0;
  const inContext = (entries: Entry[]) => {
    let from = 0;
    let count = 0;
    entries.forEach((e, i) => {
      if (e.type !== 'compaction') return;
      count++;
      const kept = entries.findIndex(k => k.id === e.firstKeptEntryId);
      from = kept >= 0 ? kept : i;
    });
    const chosen = entries.slice(from).some(e => e.type === 'message' && e.message?.role === 'assistant' && Array.isArray(e.message.content)
      && (e.message.content as { type?: string; name?: string; arguments?: ReadArgs }[]).some(c => c.type === 'toolCall'
        && (c.name === skillSkipTool || (c.name === 'read' && skillFile.test(String(c.arguments?.path ?? '')) && whole(c.arguments)))));
    return { chosen, count };
  };
  pi.on('session_start', (_e, ctx) => {
    const now = inContext(ctx.sessionManager.getBranch() as Entry[]);
    decided = now.chosen;
    compactions = now.count;
    compacted = now.count > 0 && !now.chosen;
  });
  // pi-team compacts members at turn ends and pi compacts by itself; either way the entry is in the
  // branch by the next turn.
  pi.on('turn_start', (_e, ctx) => {
    const now = inContext(ctx.sessionManager.getBranch() as Entry[]);
    if (now.count === compactions) return;
    compactions = now.count;
    if (decided && !now.chosen) { decided = false; compacted = true; }
  });
  pi.on('before_agent_start', event => { listed = listedSkills(event.systemPrompt).skills; });
  // A skill read whole ends with the documents its folder holds, at the moment the member decides
  // what to read next.
  pi.on('tool_result', e => {
    if (e.toolName !== 'read' || e.isError || !whole(e.input as ReadArgs)) return;
    const skill = reads((e.input as ReadArgs).path);
    if (!skill) return;
    const docs = skillDocs(skill.dir);
    if (!docs.length) return;
    const shown = docs.slice(0, 24).map(d => `- ${skill.dir}/${d}`).join('\n');
    return { content: [...e.content, { type: 'text' as const, text: `\n[pi-team] ${skill.name} has ${docs.length} more document${docs.length > 1 ? 's' : ''} in its folder:\n${shown}${docs.length > 24 ? `\n(and ${docs.length - 24} more)` : ''}\nWhen SKILL.md sends you to one of them for this task, read it whole before that step. In your report, name any it required that you did not read.` }] };
  });
  pi.on('tool_call', e => {
    if (decided || !listed.length) return;
    if (e.toolName === 'read' && reads((e.input as ReadArgs).path) && whole(e.input as ReadArgs)) { decided = true; compacted = false; return; }
    if (!gatedTool(e.toolName)) return;
    const shown = listed.slice(0, 12).map(s => `- ${s.name}: ${s.dir}/SKILL.md`).join('\n');
    if (compacted) return { block: true, reason: `Your context was compacted, and the text of the skills you read is no longer in it; the summary keeps only their names. Before you go on, read again the whole SKILL.md (read tool, no offset or limit) of each skill the step you are on now needs, and the documents of it that step uses:\n${shown}${listed.length > 12 ? `\n(and ${listed.length - 12} more in your skill list)` : ''}\nIf no skill applies to what is left, call ${skillSkipTool} with the reason. Then repeat this call.` };
    return { block: true, reason: `Choose your skills before the first command, edit or tool that changes anything. Read the whole SKILL.md of each listed skill that fits this task with the read tool (no offset or limit; a partial read does not count), starting with any skill the project rules or the brief name for this kind of work:\n${shown}${listed.length > 12 ? `\n(and ${listed.length - 12} more in your skill list)` : ''}\nIf none fits, call ${skillSkipTool} with the reason. Then repeat this call.` };
  });
}
