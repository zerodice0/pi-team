import { compact, getPackageDir, type CompactionSettings, type ExtensionAPI, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep team contexts small. pi compacts by itself only near contextWindow - reserveTokens, about
// 980k tokens on the 1M-token models teams use, and ctx.compact() aborts a running turn first. Leads
// reached 450k and members 295k without compacting, re-reading that on every tool call. So team
// sessions compact at turn ends as well: when tool results will start another request anyway, the
// summary is written there and pi gets a compaction entry, which the next request already uses.
//
// A turn_end handler holds up the run while it works, so a summary that fails or hangs must never
// stop the session: every failure, abort or timeout returns no entries and the run goes on with its
// full context; after repeated failures the session stops trying.
const leadInstructions = 'Keep the team goal and user instructions verbatim, every decision and user answer, each member key with its role, latest run id, state and latest result, open questions, commits, and file paths. Drop file contents, command output and image details already summarized.';
const memberInstructions = 'Keep the task brief verbatim (Goal, Do, Do not, Done when, Limits, Report), every instruction from the lead, what is done and what is left, files changed, the notes file, checks run with their results, artifact paths and open problems. Drop file contents, command output and image details already summarized.';

type Prepare = (entries: SessionEntry[], settings: CompactionSettings) => Parameters<typeof compact>[0] | undefined;
// prepareCompaction is not exported; load it from the running pi so the cut follows pi's own rules.
let prepare: Promise<Prepare | undefined> | undefined;
const loadPrepare = () => prepare ??= (async () => {
  const file = join(getPackageDir(), 'dist', 'core', 'compaction', 'compaction.js');
  if (!existsSync(file)) return undefined;
  const mod = await import(pathToFileURL(file).href) as { prepareCompaction?: Prepare };
  return typeof mod.prepareCompaction === 'function' ? mod.prepareCompaction : undefined;
})().catch(() => undefined);

function settingsOf(pi: ExtensionAPI): CompactionSettings {
  const c = pi.getSettings().compaction as Partial<CompactionSettings> | undefined;
  return { enabled: c?.enabled !== false, reserveTokens: c?.reserveTokens ?? 16_384, keepRecentTokens: c?.keepRecentTokens ?? 20_000 };
}
const tell = (ctx: ExtensionContext, message: string, level: 'info' | 'warning') => { if (ctx.hasUI) ctx.ui.notify(message, level); };
const timeoutMs = () => Number(process.env.PI_TEAM_COMPACT_TIMEOUT_MS ?? 180_000);

interface Options {
  /** Tokens above which to compact, for the model that answered last. */
  threshold: (contextWindow: number) => number;
  instructions: string;
  who: string;
  /** Also compact after a run settles; only for sessions that wait for more input. */
  settle: boolean;
}
function turnCompaction(pi: ExtensionAPI, o: Options) {
  let compacting = false;
  let fresh = true;
  let warned = false;
  let failures = 0;
  let limit = 0;
  // When a compaction cannot bring the context under the threshold (a large kept tail), wait for a
  // quarter of the threshold to accumulate again instead of compacting after every turn.
  let floor = 0;
  let measure = false;
  pi.on('turn_end', async (event, ctx) => {
    fresh = true;
    try {
      // Only where another request follows anyway; a run that ends is not held up.
      if (compacting || failures >= 2 || event.outcome !== 'completed' || !event.toolResults.length || event.entries.some(e => e.type === 'compaction')) return;
      const message = event.message as { provider?: string; model?: string };
      const model = message.provider && message.model ? ctx.modelRegistry.find(message.provider, message.model) : undefined;
      if (!model?.contextWindow) return;
      limit = o.threshold(model.contextWindow);
      const tokens = ctx.getContextUsage()?.tokens;
      const settings = settingsOf(pi);
      if (measure && tokens != null) { floor = tokens; measure = false; }
      else if (tokens != null && tokens < limit) floor = 0;
      if (!(limit > 0) || !settings.enabled || tokens == null || tokens <= Math.max(limit, floor + limit / 4)) return;
      const prepareCompaction = await loadPrepare();
      if (!prepareCompaction) {
        if (!warned) tell(ctx, `pi-team: cannot compact the ${o.who} between turns here.`, 'warning');
        warned = true;
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const preparation = prepareCompaction(branch, settings);
      if (!preparation || !branch.some(e => e.id === preparation.firstKeptEntryId)) return;
      compacting = true;
      tell(ctx, `pi-team: compacting the ${o.who}'s ${Math.round(tokens / 1000)}k-token context before its next step.`, 'info');
      // Stop on the user's abort or after the timeout, and stop waiting even if the request ignores it.
      const controller = new AbortController();
      const stop = () => controller.abort();
      ctx.signal?.addEventListener('abort', stop, { once: true });
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<undefined>(resolve => { timer = setTimeout(() => { stop(); resolve(undefined); }, timeoutMs()); });
      try {
        const streamFn = ((m, context, options) => ctx.modelRegistry.streamSimple(m, context, options)) as Parameters<typeof compact>[7];
        const result = await Promise.race([compact(preparation, model, undefined, undefined, o.instructions, controller.signal, ctx.thinkingLevel, streamFn), timedOut]);
        if (!result?.summary?.trim()) throw new Error(controller.signal.aborted ? 'stopped or timed out' : 'empty summary');
        failures = 0;
        fresh = false;
        measure = true;
        return { entries: [...event.entries, { type: 'compaction' as const, summary: result.summary, firstKeptEntryId: result.firstKeptEntryId, details: result.details, usage: result.usage }] };
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', stop);
      }
    } catch (e) {
      failures++;
      tell(ctx, `pi-team: ${o.who} compaction skipped (${e instanceof Error ? e.message : String(e)}); continuing with the full context.${failures >= 2 ? ' Turn-end compaction is off for this session.' : ''}`, 'warning');
      return;
    } finally { compacting = false; }
  });
  if (!o.settle) return;
  // A run whose last response left the session over the threshold compacts while it waits, so the
  // summary is written while the cache is still warm. Context usage keeps the last response's size
  // until a new response arrives, so judge again only after a turn has finished since then.
  pi.on('agent_settled', (_e, ctx) => {
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens;
    const at = usage?.contextWindow ? o.threshold(usage.contextWindow) : limit;
    if (compacting || !fresh || !(at > 0) || tokens == null || tokens < at) return;
    compacting = true;
    fresh = false;
    try {
      ctx.compact({
        customInstructions: o.instructions,
        onComplete: () => { compacting = false; },
        onError: e => { compacting = false; if (!/nothing to compact|already compacted/i.test(e.message)) tell(ctx, `pi-team: ${o.who} compaction failed: ${e.message}`, 'warning'); },
      });
    } catch { compacting = false; }
  });
}

// The lead keeps a fixed threshold (PI_TEAM_LEAD_COMPACT_TOKENS, default 200k): 40% of its 1M-token
// window would let it grow to 400k.
export function leadCompaction(pi: ExtensionAPI, compactAt: number) {
  if (!(compactAt > 0)) return;
  turnCompaction(pi, { threshold: window => Math.min(compactAt, window * 0.8), instructions: leadInstructions, who: 'lead', settle: true });
}
// Members compact at a share of the context window of the model they run on (PI_TEAM_MEMBER_COMPACT_RATIO).
// The default 0.2 matches the lead's 200k on the 1M-token windows teams use; 0.4 would let a member reach
// 400k. A member exits when its run ends, so it does not compact after settling.
export function memberCompaction(pi: ExtensionAPI) {
  const ratio = Number(process.env.PI_TEAM_MEMBER_COMPACT_RATIO ?? 0.2);
  if (!(ratio > 0 && ratio < 1)) return;
  turnCompaction(pi, { threshold: window => Math.round(window * ratio), instructions: memberInstructions, who: 'member', settle: false });
}
