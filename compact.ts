import { compact, getPackageDir, type CompactionSettings, type ExtensionAPI, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep the lead's context small. pi compacts by itself only near contextWindow - reserveTokens, about
// 980k tokens on the 1M-token models leads use, and ctx.compact() aborts a running turn first. Leads
// reached 450k before the old settle-only check compacted them, re-reading that on every tool call.
// So the lead compacts at turn ends as well: when tool results will start another request anyway, it
// writes the summary there and hands pi a compaction entry, which the next request already uses.
const instructions = 'Keep the team goal and user instructions verbatim, every decision and user answer, each member key with its role, latest run id, state and latest result, open questions, commits, and file paths. Drop file contents, command output and image details already summarized.';

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

export function leadCompaction(pi: ExtensionAPI, compactAt: number) {
  if (!(compactAt > 0)) return;
  let compacting = false;
  let fresh = true;
  let warned = false;
  // When a compaction cannot bring the context under the threshold (a large kept tail), wait for a
  // quarter of the threshold to accumulate again instead of compacting after every turn.
  let floor = 0;
  let measure = false;
  pi.on('turn_end', async (event, ctx) => {
    fresh = true;
    // Only where another request follows anyway; a run that ends is compacted when it settles.
    if (compacting || event.outcome !== 'completed' || !event.toolResults.length || event.entries.some(e => e.type === 'compaction')) return;
    const tokens = ctx.getContextUsage()?.tokens;
    const settings = settingsOf(pi);
    if (measure && tokens != null) { floor = tokens; measure = false; }
    else if (tokens != null && tokens < compactAt) floor = 0;
    if (!settings.enabled || tokens == null || tokens <= Math.max(compactAt, floor + compactAt / 4)) return;
    const message = event.message as { provider?: string; model?: string };
    const model = message.provider && message.model ? ctx.modelRegistry.find(message.provider, message.model) : undefined;
    const prepareCompaction = await loadPrepare();
    if (!model || !prepareCompaction) {
      if (!warned) tell(ctx, 'pi-team: cannot compact the lead between turns here; it compacts when a run ends.', 'warning');
      warned = true;
      return;
    }
    const preparation = prepareCompaction(ctx.sessionManager.getBranch(), settings);
    if (!preparation) return;
    compacting = true;
    try {
      tell(ctx, `pi-team: compacting the lead's ${Math.round(tokens / 1000)}k-token context before its next step.`, 'info');
      const streamFn = ((m, context, options) => ctx.modelRegistry.streamSimple(m, context, options)) as Parameters<typeof compact>[7];
      const result = await compact(preparation, model, undefined, undefined, instructions, ctx.signal, ctx.thinkingLevel, streamFn);
      fresh = false;
      measure = true;
      return { entries: [...event.entries, { type: 'compaction' as const, summary: result.summary, firstKeptEntryId: result.firstKeptEntryId, details: result.details, usage: result.usage }] };
    } catch (e) {
      tell(ctx, `pi-team: lead compaction failed: ${e instanceof Error ? e.message : String(e)}`, 'warning');
      return;
    } finally { compacting = false; }
  });
  // A run whose last response left the lead over the threshold compacts while it waits, so the
  // summary is written while the cache is still warm. Context usage keeps the last response's size
  // until a new response arrives, so judge again only after a turn has finished since then.
  pi.on('agent_settled', (_e, ctx) => {
    const tokens = ctx.getContextUsage()?.tokens;
    if (compacting || !fresh || tokens == null || tokens < compactAt) return;
    compacting = true;
    fresh = false;
    ctx.compact({
      customInstructions: instructions,
      onComplete: () => { compacting = false; },
      onError: e => { compacting = false; if (!/nothing to compact/i.test(e.message)) tell(ctx, `pi-team: lead compaction failed: ${e.message}`, 'warning'); },
    });
  });
}
