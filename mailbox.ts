import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { addressPattern, getLead, getTeam, isLive, ledger, locked, log, members, mkdir, names, readJson, root, teamDir, teams, text, writeJson, type Participant, type LedgerEntry, type ToolReply } from './registry.ts';

export type Address = { team: string; key: string };
interface Message {
  v: 1; id: string; team: string; from: string; to: string; replyTo?: string; subject?: string;
  body: string; refs?: string[]; hops: number; sentAt: number;
}
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(at: number) {
  let bits = (BigInt(at) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let id = '';
  for (let i = 0; i < 26; i++, bits >>= 5n) id = alphabet[Number(bits & 31n)] + id;
  return id;
}
const idPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const mailbox = (team: string, key: string) => join(teamDir(team), 'inbox', key);
const address = (a?: Address) => a ? `${a.key}@${a.team}` : 'main';
const senderTeam = (m: Message) => m.from.includes('@') ? m.from.split('@')[1] : undefined;
function transition(m: Message, event: LedgerEntry['event'], reason?: string) {
  const { id, from, to, replyTo, subject, body } = m;
  const entry = { event, at: Date.now(), id, from, to, replyTo, subject, body: event === 'sent' ? body : undefined, reason };
  log(m.team, entry);
  const src = senderTeam(m);
  if (src && src !== m.team && getTeam(src)) log(src, entry);
}
function recipients(sender: Address | undefined, to: string): Address[] {
  if (!sender || (sender.key === 'lead' && to.startsWith('lead@'))) {
    if (!to.startsWith('lead@')) throw new Error('The main session can only send to lead@<team>.');
    const dest = to.slice(5);
    if (dest === '*' && sender) return teams().filter(t => t.id !== sender.team).map(t => ({ key: 'lead', team: t.id }));
    if (!getTeam(dest) || dest === sender?.team) throw new Error(`No other team lead at ${to}.`);
    return [{ key: 'lead', team: dest }];
  }
  if (!sender || to.includes('@') || (sender.key === 'lead' && (to === 'lead' || to === '*'))) {
    throw new Error(sender?.key === 'lead' ? 'Leads can only send to their own members or lead@<other team>.' : 'Members can only send within their own team.');
  }
  if (to === '*') return [{ key: 'lead', team: sender.team }, ...members(sender.team).filter(m => m.key !== sender.key && isLive(m)).map(m => ({ key: m.key, team: sender.team }))];
  if (to === 'lead') return [{ key: to, team: sender.team }];
  if (!addressPattern.test(to)) throw new Error(`Invalid member address: ${to}`);
  return [{ key: to, team: sender.team }];
}
export const sendParams = Type.Object({ to: Type.String(), body: Type.String(), subject: Type.Optional(Type.String({ maxLength: 256 })),
  replyTo: Type.Optional(Type.String()), refs: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 16 })) });
interface Send { to: string; body: string; subject?: string; replyTo?: string; refs?: string[] }
function storedMessages(owner: Address) {
  const dir = mailbox(owner.team, owner.key);
  return names(dir).sort().filter(n => n.endsWith('.json') && idPattern.test(n.slice(0, -5)))
    .map(n => readJson<Message>(join(dir, n))).filter((m): m is Message => !!m);
}
function history(team: string) {
  const events = ledger(team);
  const states = new Map<string, LedgerEntry>();
  for (const event of events) if (event.id) states.set(event.id, event);
  return { events, states };
}
export function send(sender: Address | undefined, p: Send) {
  if (!p.body.trim() || Buffer.byteLength(p.body) > 4096) throw new Error('Message body must be 1–4096 UTF-8 bytes.');
  if (p.replyTo && !idPattern.test(p.replyTo)) throw new Error('Invalid replyTo ID.');
  return locked(join(root, '.mail.lock'), () => {
    if (sender && !getTeam(sender.team)) throw new Error('Your team is closed.');
    const dest = recipients(sender, p.to);
    if (!dest.length) throw new Error('There are no recipients.');
    const src = sender?.team;
    const parent = p.replyTo && sender ? storedMessages(sender).find(m => m.id === p.replyTo) : undefined;
    if (p.replyTo && (!parent || dest.length !== 1 || address(dest[0]) !== parent.from)) throw new Error('Replies must target the original sender of a message in your inbox.');
    const hops = parent ? parent.hops + 1 : 1;
    if (hops > 5) throw new Error('Message hop limit is 5.');
    const now = Date.now();
    const scope = new Map([...new Set([...dest.map(d => d.team), ...(src ? [src] : [])])].map(team => [team, history(team)]));
    const from = address(sender);
    if (parent && src) {
      const state = scope.get(src)!.states.get(parent.id)?.event;
      if (state === 'closed' || state === 'undelivered') throw new Error('Cannot reply to a closed or undelivered message.');
    }
    const mainRate = join(root, 'main-rate.json');
    const recent = sender
      ? scope.get(sender.team)!.events.filter(e => e.event === 'sent' && e.at > now - 60_000 && e.from === from).map(e => e.at)
      : (readJson<number[]>(mainRate) ?? []).filter(at => at > now - 60_000);
    if (recent.length + dest.length > 20) throw new Error('Sender limit is 20 messages per minute.');
    for (const [team, { events }] of scope) {
      if (events.filter(e => e.event === 'sent').length + dest.filter(d => team === src || d.team === team).length > 500) throw new Error(`Team ${team} message limit is 500.`);
    }
    if (!sender) writeJson(mainRate, [...recent, ...dest.map(() => now)]);
    return dest.map(d => {
      const message: Message = { v: 1, id: ulid(now), team: d.team, from, to: address(d), replyTo: p.replyTo, subject: p.subject, body: p.body, refs: p.refs, hops, sentAt: now };
      transition(message, 'sent');
      if (d.key !== 'lead' && !members(d.team).some(m => m.key === d.key && isLive(m))) {
        transition(message, 'undelivered', 'Member is not live.');
        return { id: message.id, to: message.to, state: 'undelivered' };
      }
      try { writeJson(join(mailbox(d.team, d.key), `${message.id}.json`), message); }
      catch (e) {
        transition(message, 'undelivered', `Mailbox write failed: ${String(e)}`);
        return { id: message.id, to: message.to, state: 'undelivered' };
      }
      if (parent) transition(parent, 'replied');
      return { id: message.id, to: message.to, state: 'sent' };
    });
  });
}
function renderMessage(m: Message) {
  return `Team message ${m.id} from ${m.from}${m.replyTo ? ` (reply to ${m.replyTo})` : ''}${m.subject ? `: ${m.subject}` : ''}\n${m.body}${m.refs?.length ? `\nRefs: ${m.refs.join(', ')}` : ''}`;
}
function deadlock(owner: Address) {
  const path = join(teamDir(owner.team), 'wait-release.json');
  const lead = getLead(owner.team);
  const live = [lead, ...members(owner.team)].filter((p): p is Participant => !!p && isLive(p));
  const self = live.find(p => p.key === owner.key);
  if (self?.waitSince === undefined) return false;
  const identity = (p: Participant) => `${p.sessionId}:${p.waitSince}`;
  const key = identity(self);
  if (readJson<string[]>(path)?.includes(key)) return true;
  if (live.some(p => p.waitSince === undefined || Date.now() - p.waitSince < 5000)) return false;
  return locked(join(root, `.wait-${owner.team}.lock`), () => {
    const current = [getLead(owner.team), ...members(owner.team)].filter((p): p is Participant => !!p && isLive(p));
    if (readJson<string[]>(path)?.includes(key)) return true;
    if (!current.length || current.some(p => p.waitSince === undefined || Date.now() - p.waitSince < 5000)) return false;
    writeJson(path, current.map(identity), false);
    return true;
  });
}
export function registerMailbox(pi: ExtensionAPI, getOwner: () => Address | undefined, update: (state: Participant['state']) => void) {
  let drain: (() => void) | undefined;
  let close: (() => void) | undefined;
  let lastDelivery = 0;
  let waiting = false;
  let waiter: (() => void) | undefined;
  let cancelWait: (() => void) | undefined;
  const owner = () => { const a = getOwner(); if (!a) throw new Error('Team session is not registered.'); return a; };
  pi.on('session_start', (_e, ctx) => {
    const a = getOwner();
    if (!a) return;
    const dir = mailbox(a.team, a.key);
    mkdir(dir);
    const seen = new Set<string>();
    drain = () => {
      const pending = names(dir).sort().filter(n => !seen.has(n) && n.endsWith('.json') && idPattern.test(n.slice(0, -5)));
      if (!pending.length) return;
      locked(join(root, '.mail.lock'), () => {
        const { states } = history(a.team);
        for (const filename of pending) {
          const m = readJson<Message>(join(dir, filename));
          if (!m) continue;
          if (states.get(m.id)?.event === 'sent') {
            pi.sendMessage({ customType: 'pi-team-mail', content: renderMessage(m), display: true, details: m },
              ctx.isIdle() && a.key !== 'lead' ? { deliverAs: 'nextTurn' } : { deliverAs: 'steer', triggerTurn: a.key === 'lead' });
            transition(m, 'delivered');
            lastDelivery++;
          }
          seen.add(filename);
        }
      });
      waiter?.();
    };
    const safeDrain = () => { try { drain?.(); } catch (e) { if (ctx.hasUI) ctx.ui.notify(String(e), 'warning'); else console.error(e); } };
    const watcher = watch(dir, { persistent: false }, safeDrain);
    watcher.on('error', () => watcher.close());
    const timer = setInterval(safeDrain, 1000).unref();
    const initial = setTimeout(safeDrain, 0).unref();
    close = () => { watcher.close(); clearInterval(timer); clearTimeout(initial); };
  });
  pi.on('session_shutdown', () => {
    close?.(); drain = undefined;
    cancelWait?.();
    const a = getOwner();
    if (!a || a.key === 'lead') return;
    locked(join(root, '.mail.lock'), () => {
      const { states } = history(a.team);
      for (const m of storedMessages(a)) if (states.get(m.id)?.event === 'sent') transition(m, 'undelivered', 'Member exited before delivery.');
    });
  });
  pi.registerTool({ name: 'team_peers', label: 'Team peers', description: 'List your team addresses and live member states; leads may also see other leads.', parameters: Type.Object({}),
    async execute() {
      const a = owner();
      return text(JSON.stringify({ self: a.key, lead: getLead(a.team), members: members(a.team), ...(a.key === 'lead' ? { otherLeads: teams().filter(t => t.id !== a.team).map(t => address({ team: t.id, key: 'lead' })) } : {}) }));
    } });
  pi.registerTool({ name: 'team_send', label: 'Send team message', description: 'Send to a peer address. Use replyTo with the received message ID for a threaded reply.', parameters: sendParams,
    async execute(_id, p) { return text(JSON.stringify(send(owner(), p))); } });
  pi.registerTool({ name: 'team_inbox', label: 'Team inbox', description: 'Read received messages or close a message by ID.', parameters: Type.Object({ close: Type.Optional(Type.String()) }),
    async execute(_id, p) {
      const a = owner();
      if (p.close) locked(join(root, '.mail.lock'), () => {
        const m = storedMessages(a).find(m => m.id === p.close);
        if (!m) throw new Error('Message not found.');
        const state = history(a.team).states.get(m.id)?.event;
        if (state === 'delivered' || state === 'replied') transition(m, 'closed');
      });
      const { states } = history(a.team);
      return text(storedMessages(a).filter(m => states.get(m.id)?.event !== 'closed').map(renderMessage).join('\n\n') || 'Inbox empty.');
    } });
  pi.registerTool({ name: 'team_wait', label: 'Wait for team mail', description: 'Wait for mail for at most 120 seconds; returns early on team deadlock.', parameters: Type.Object({ seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) }),
    async execute(_id, p, signal, _update, ctx: ExtensionContext) {
      if (waiting) throw new Error('Already waiting for mail.');
      const a = owner();
      const baseline = lastDelivery;
      const started = Date.now();
      const seconds = p.seconds ?? 120;
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120) throw new Error('Wait must be between 1 and 120 seconds.');
      waiting = true;
      try {
        update('waiting');
        const { promise, resolve } = Promise.withResolvers<ToolReply>();
        const finish = (reason: string) => {
          clearInterval(timer); signal?.removeEventListener('abort', abort); waiter = cancelWait = undefined;
          resolve(text(reason));
        };
        const abort = () => finish('Wait cancelled.');
        cancelWait = () => finish('Session ended.');
        waiter = () => { if (lastDelivery > baseline) finish('New team mail delivered.'); };
        const timer = setInterval(() => {
          if (Date.now() >= started + seconds * 1000) return finish('Wait timed out.');
          try {
            if (deadlock(a)) {
              const message = 'Team deadlock: all live participants waited for 5 seconds.';
              if (ctx.hasUI) ctx.ui.notify(message, 'warning');
              finish(message);
            }
          } catch (e) { finish(`Could not check team wait state: ${String(e)}`); }
        }, 250);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else try { drain?.(); } catch (e) { finish(`Could not read team inbox: ${String(e)}`); }
        return await promise;
      } finally { waiting = false; update('working'); }
    } });
}
