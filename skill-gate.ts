import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { basename } from 'node:path';
import { listedSkills } from './stats.ts';

// A member's listed skills are how its role works, but the list itself only says "read a skill when
// the task matches", and members with plenty of documents to read never made that decision: an
// incense modeler ran 186 turns (2026-11-28) without opening the skill that the repository's rules
// and its brief both named. So the decision is made a step of the work: until the member has read
// one of its listed skills, or said why none fits, tools that run or change things are refused.
// It needs no setup in the repository and does not parse briefs.
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
  const reads = (path: unknown) => {
    const text = String(path ?? '');
    return listed.find(s => text.endsWith(`${basename(s.dir)}/SKILL.md`));
  };
  pi.registerTool({ name: skillSkipTool, label: 'No skill fits',
    description: 'State that none of your listed skills fits this task, with the reason, so you can start working. Use it only after checking the skill descriptions against the brief and the project rules; when a skill fits, read its SKILL.md instead.',
    parameters: Type.Object({ reason: Type.String({ minLength: 10, description: 'Why none of the listed skills applies to this task.' }) }),
    async execute(_id, p) {
      decided = true;
      return { content: [{ type: 'text' as const, text: `Noted: no listed skill applies (${p.reason}). Say so in your report.` }], details: {} };
    } });
  // A resumed member already decided in its earlier turns.
  pi.on('session_start', (_e, ctx) => {
    type Entry = { type: string; message?: { role?: string; content?: unknown } };
    decided = (ctx.sessionManager.getBranch() as Entry[]).some(e => e.type === 'message' && e.message?.role === 'assistant' && Array.isArray(e.message.content)
      && (e.message.content as { type?: string; name?: string; arguments?: ReadArgs }[]).some(c => c.type === 'toolCall'
        && (c.name === skillSkipTool || (c.name === 'read' && skillFile.test(String(c.arguments?.path ?? '')) && whole(c.arguments)))));
  });
  pi.on('before_agent_start', event => { listed = listedSkills(event.systemPrompt).skills; });
  pi.on('tool_call', e => {
    if (decided || !listed.length) return;
    if (e.toolName === 'read' && reads((e.input as ReadArgs).path) && whole(e.input as ReadArgs)) { decided = true; return; }
    if (!gatedTool(e.toolName)) return;
    const shown = listed.slice(0, 12).map(s => `- ${s.name}: ${s.dir}/SKILL.md`).join('\n');
    return { block: true, reason: `Choose your skills before the first command, edit or tool that changes anything. Read the whole SKILL.md of each listed skill that fits this task with the read tool (no offset or limit; a partial read does not count), starting with any skill the project rules or the brief name for this kind of work:\n${shown}${listed.length > 12 ? `\n(and ${listed.length - 12} more in your skill list)` : ''}\nIf none fits, call ${skillSkipTool} with the reason. Then repeat this call.` };
  });
}
