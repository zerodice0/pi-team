import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// A stdio MCP client for member-only servers (see blender-mcp/ and rea-mcp/). pi-subagents resolves
// `mcp:` selections only against servers the parent session already connected, so a server meant for
// one member is started by that member's own extension instead of Pi's built-in MCP.
//
// The server starts on the first call, not when the member starts, and stops with the member. With
// idleMs it also stops after that long without a call and starts again on the next one, losing any
// server-side state (open targets, scenes) in between.

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
export interface McpContent { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }
export interface McpResult { content?: McpContent[]; structuredContent?: unknown; isError?: boolean }
interface Options { name: string; command: () => { command: string; args: string[]; env?: Record<string, string> }; idleMs?: number; startTimeoutMs: number; callTimeoutMs: number }
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

class Connection {
  readonly proc: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private next = 1;
  stderr = '';
  exited: Error | undefined;
  constructor(name: string, command: string, args: string[], env?: Record<string, string>) {
    // detached: the server gets its own process group so stop() also ends engines it started
    // (Blender, Ghidra's JVM) instead of leaving them behind.
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, detached: true });
    this.proc.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    createInterface({ input: this.proc.stdout }).on('line', line => this.receive(line));
    const fail = (error: Error) => {
      this.exited ??= error;
      for (const p of this.pending.values()) p.reject(this.exited);
      this.pending.clear();
    };
    this.proc.on('exit', code => fail(new Error(`${name} MCP server stopped (exit ${code}). ${this.stderr.trim().split('\n').slice(-5).join(' ')}`)));
    this.proc.on('error', error => fail(new Error(`${name} MCP server could not start: ${error.message}`)));
  }
  private receive(line: string) {
    let message: { id?: number; method?: string; result?: unknown; error?: { message: string } };
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      // Server-initiated requests: answer ping, decline anything else.
      this.write(message.method === 'ping' ? { jsonrpc: '2.0', id: message.id, result: {} } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not supported' } });
      return;
    }
    const p = message.id !== undefined ? this.pending.get(message.id) : undefined;
    if (!p) return;
    this.pending.delete(message.id!);
    if (message.error) p.reject(new Error(message.error.message));
    else p.resolve(message.result);
  }
  private write(message: unknown) { if (!this.exited) this.proc.stdin.write(`${JSON.stringify(message)}\n`); }
  request<T>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = () => { this.pending.delete(id); done(); this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }); reject(new Error('Cancelled.')); };
      const timer = setTimeout(() => { this.pending.delete(id); done(); reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve: v => { done(); resolve(v); }, reject: e => { done(); reject(e); } });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method: string) { this.write({ jsonrpc: '2.0', method }); }
  stop() {
    if (this.exited) return;
    const group = (signal: NodeJS.Signals) => { try { process.kill(-this.proc.pid!, signal); } catch { /* already gone */ } };
    this.proc.stdin.end();
    group('SIGTERM');
    setTimeout(() => { if (!this.exited) group('SIGKILL'); }, 5000).unref();
  }
}

export class LazyMcp {
  private connection: Connection | undefined;
  private starting: Promise<Connection> | undefined;
  private idle: NodeJS.Timeout | undefined;
  private active = 0;
  private stoppedForIdle = false;
  tools: McpTool[] | undefined;
  private options: Options;
  constructor(options: Options) { this.options = options; }
  private get cacheFile() { return join(homedir(), '.cache', 'pi-team', 'mcp', `${this.options.name}-tools.json`); }
  /** Tool definitions from the last time this host listed the server, without starting it. */
  cachedTools(): McpTool[] | undefined {
    try { return JSON.parse(readFileSync(this.cacheFile, 'utf8')); } catch { return undefined; }
  }
  private async start() {
    const { command, args, env } = this.options.command();
    const connection = new Connection(this.options.name, command, args, env);
    try {
      await connection.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pi-team', version: '1' } }, this.options.startTimeoutMs);
      connection.notify('notifications/initialized');
      const { tools } = await connection.request<{ tools: McpTool[] }>('tools/list', {}, 120_000);
      this.tools = tools;
      try { mkdirSync(join(this.cacheFile, '..'), { recursive: true }); writeFileSync(this.cacheFile, JSON.stringify(tools)); } catch { /* the cache only helps the next start */ }
      return connection;
    } catch (error) {
      connection.stop();
      throw error;
    }
  }
  private async connect() {
    if (this.connection && !this.connection.exited) return this.connection;
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    this.connection = await this.starting;
    return this.connection;
  }
  /** Starts the server if needed. `restarted` is true when an idle stop discarded earlier state. */
  async ensure(): Promise<{ restarted: boolean }> {
    const fresh = !this.connection || !!this.connection.exited;
    await this.connect();
    const restarted = fresh && this.stoppedForIdle;
    this.stoppedForIdle = false;
    this.arm();
    return { restarted };
  }
  async call(name: string, args: unknown, signal?: AbortSignal): Promise<McpResult & { restarted: boolean }> {
    this.active++;
    clearTimeout(this.idle);
    try {
      const { restarted } = await this.ensure();
      const result = await this.connection!.request<McpResult>('tools/call', { name, arguments: args ?? {} }, this.options.callTimeoutMs, signal);
      return { ...result, restarted };
    } finally {
      this.active--;
      this.arm();
    }
  }
  private arm() {
    clearTimeout(this.idle);
    if (!this.options.idleMs || this.active) return;
    this.idle = setTimeout(() => {
      if (this.active || !this.connection || this.connection.exited) return;
      this.stoppedForIdle = true;
      this.connection.stop();
    }, this.options.idleMs);
    this.idle.unref();
  }
  close() { clearTimeout(this.idle); this.connection?.stop(); }
}

/** Convert an MCP tool result into Pi tool content; image blocks stay images. */
export function toContent(result: McpResult, maxText = 200_000) {
  const content = (result.content ?? []).map(c => c.type === 'image' && c.data
    ? { type: 'image' as const, data: c.data, mimeType: c.mimeType ?? 'image/png' }
    : { type: 'text' as const, text: c.text ?? c.resource?.text ?? JSON.stringify(c) });
  if (!content.length && result.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
  for (const c of content) if (c.type === 'text' && c.text.length > maxText) c.text = `${c.text.slice(0, maxText)}\n… truncated ${c.text.length - maxText} characters.`;
  return content.length ? content : [{ type: 'text' as const, text: '(no output)' }];
}
export const errorText = (content: ReturnType<typeof toContent>) => content.flatMap(c => c.type === 'text' ? [c.text] : []).join('\n');
