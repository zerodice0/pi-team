import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { effectiveModels, isLevel, parseModel, readOverrides, routeTable } from './overrides.ts';
import { levels } from './presets.ts';
import type { Team } from './registry.ts';
import { applyEffort, applyModel, applyPreset, cacheNote, routeRows, teamTarget, type RouteActor } from './routing.ts';

// The lead's side of /team routes: it shows where each role's requests go and changes a role's model
// or effort, or routes the team through another preset's models. A change the user asked for needs
// their words quoted in approval; those words must appear in a user message of this session or in
// mail from the main session. On its own judgement the lead may only lower a role's effort or move a
// model that is already in the role's candidate chain to the front, at no higher effort.

const rank = (level: string) => (levels as readonly string[]).indexOf(level);
const key = (candidate: string) => candidate.replace(/:[a-z]+$/, '');
const squash = (s: string) => s.toLowerCase().replace(/[\s"'`「」『』“”‘’.,!?。]+/g, '');
type Content = string | { type: string; text?: string }[] | undefined;
const textOf = (content: Content) => typeof content === 'string' ? content : (content ?? []).map(c => c.type === 'text' ? c.text ?? '' : '').join('\n');

// What the user said to this lead: its user messages and the main session's mail.
function userWords(ctx: ExtensionContext) {
  const entries = ctx.sessionManager.getBranch() as { type: string; customType?: string; content?: Content; details?: { from?: string; body?: string }; message?: { role?: string; content?: Content } }[];
  return entries.flatMap(e => {
    if (e.type === 'message' && e.message?.role === 'user') return [textOf(e.message.content)];
    if (e.type === 'custom_message' && e.customType === 'pi-team-mail' && e.details?.from === 'main') return [e.details.body ?? textOf(e.content)];
    return [];
  });
}
export function approvedBy(ctx: ExtensionContext, approval: string) {
  const quote = squash(approval);
  if (quote.length < 4) return false;
  return userWords(ctx).some(text => squash(text).includes(quote));
}

export function registerLeadRoute(pi: ExtensionAPI, team: Team, leadLevel: () => ThinkingLevel | undefined) {
  pi.registerTool({
    name: 'team_route', label: 'Team routes',
    description: 'Show or change which model and effort each role of this team runs on (the lead\'s /team routes). action "show" lists every role\'s next model, fallbacks and running members. '
      + '"model" puts a model first for a role (value: alias[:level] such as opus:high, or provider/model[:level], or reset). "effort" sets a role\'s thinking level (value: low, medium, high, xhigh or reset). '
      + '"preset" routes every role through another preset\'s models (value: a preset name, or reset); the team keeps its member names, tools and skills. role may be "all" for model and effort; "orchestrator" is you. '
      + 'When the user asked for the change, pass approval with their words quoted exactly. Without approval you may only lower a role\'s effort, or move a model already in that role\'s candidates to the front at no higher effort; propose anything else to the user first. '
      + 'Changes apply from each role\'s next request; running members keep their model until then.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('show'), Type.Literal('model'), Type.Literal('effort'), Type.Literal('preset')]),
      role: Type.Optional(Type.String({ description: 'Role name, or "all" (model and effort).' })),
      value: Type.Optional(Type.String()),
      approval: Type.Optional(Type.String({ description: 'The user\'s words that asked for this change, quoted exactly as they wrote them.' })),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }], details: {} });
      const t = teamTarget(team.id, true);
      const table = () => [`Routes for ${t.label}:`, routeTable(t.roles, ctx.modelRegistry, readOverrides(t.scope), t.current ? { role: 'orchestrator', ...t.current } : undefined)].join('\n');
      if (p.action === 'show') {
        const running = routeRows(t, ctx.modelRegistry, pi.getThinkingLevel(), leadLevel).filter(r => r.running.length && r.role !== 'orchestrator')
          .map(r => `${r.role}: ${r.running.join(', ')}`);
        return text([table(), ...(running.length ? ['', 'Running members:', ...running] : [])].join('\n'));
      }
      if (p.approval && !approvedBy(ctx, p.approval)) {
        throw new Error('approval must quote words the user wrote to you or that the main session mailed you; none of them contain it. Quote the user exactly, or ask the user first.');
      }
      const actor: RouteActor = p.approval ? { by: 'lead', basis: `user: ${p.approval}` } : { by: 'lead', basis: 'lead decision' };
      const value = p.value?.trim();
      if (!value) throw new Error(`${p.action} needs a value.`);
      let notes: string[];
      if (p.action === 'preset') {
        if (!p.approval) throw new Error('Routing through another preset needs the user\'s approval: propose it to the user, then pass their words as approval.');
        notes = applyPreset(ctx, t, value === 'reset' ? null : value, actor);
      } else {
        if (!p.role) throw new Error(`${p.action} needs a role.`);
        const roles = p.role === 'all' ? Object.keys(t.roles) : [p.role];
        for (const r of roles) if (!Object.hasOwn(t.roles, r)) throw new Error(`Unknown role ${r}. Roles: ${Object.keys(t.roles).join(', ')}.`);
        const reset = value === 'reset';
        if (p.action === 'effort' && !reset && !isLevel(value)) throw new Error(`Unknown level ${value}. Use off, minimal, low, medium, high, xhigh or max.`);
        if (reset && !p.approval) throw new Error('A reset can raise a role back to the preset\'s level; ask the user and pass their words as approval.');
        const rows = new Map(routeRows(t, ctx.modelRegistry, pi.getThinkingLevel(), leadLevel).map(r => [r.role, r]));
        const overrides = readOverrides(t.scope);
        // Check every role before changing any, so a refused "all" changes nothing.
        const plan = roles.map(r => {
          const now = rows.get(r)!.level;
          const next = p.action === 'effort' ? (reset ? null : value as ThinkingLevel)
            : reset ? null : parseModel(value, t.cwd, now);
          if (!p.approval && next !== null) {
            if (p.action === 'effort' && rank(next) >= rank(now)) throw new Error(`${r} runs at ${now}; on your own you may only lower its effort. Ask the user to raise it.`);
            if (p.action === 'model') {
              const chain = effectiveModels(t.roles[r], overrides[r]).map(key);
              if (!chain.includes(key(next))) throw new Error(`${key(next)} is not one of ${r}'s candidates (${chain.join(', ')}); ask the user to bring in another model.`);
              const level = next.split(':').pop()!;
              if (rank(level) > rank(now)) throw new Error(`${r} runs at ${now}; on your own you may not raise it to ${level}.`);
            }
          }
          return [r, next] as const;
        });
        notes = [];
        for (const [r, next] of plan) {
          notes.push(p.action === 'effort' ? applyEffort(pi, t, r, next as ThinkingLevel | null, leadLevel, actor) : await applyModel(pi, ctx, t, r, next, actor));
        }
      }
      if (ctx.hasUI) ctx.ui.notify(`pi-team routes (${p.approval ? 'you asked' : 'lead decision'}): ${notes[0]}${notes.length > 1 ? ` (+${notes.length - 1})` : ''}`, 'info');
      return text([...notes, cacheNote, '', table()].join('\n'));
    },
  });
}
