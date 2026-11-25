import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Loaded only into members whose role lists mcp: ["blender"] (as a subagent-only extension), so the
// main session and the lead never start Blender. Pi's built-in MCP cannot be used here: pi-subagents
// resolves `mcp:` selections against MCP servers the parent session has already connected. Instead
// this extension is the MCP client. launch.py gives this member its own headless Blender on a free
// port plus the mcp-for-blender server, and each selected server tool becomes a regular tool named
// like Pi's MCP tools (mcp__blender__<tool>) so Blender skills that name those tools still match.
export const blenderTools = ['execute_blender_code', 'get_scene_info', 'look', 'search_assets', 'import_asset', 'get_addon_status'];
export const toolName = (tool: string) => `mcp__blender__${tool}`;

interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
interface McpContent { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private next = 1;
  private stderr = '';
  private exited: Error | undefined;
  constructor() {
    this.proc = spawn('python3', [fileURLToPath(new URL('./launch.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    createInterface({ input: this.proc.stdout }).on('line', line => this.receive(line));
    this.proc.on('exit', code => {
      this.exited = new Error(`Blender MCP stopped (exit ${code}). ${this.stderr.trim().split('\n').slice(-5).join(' ')}`);
      for (const p of this.pending.values()) p.reject(this.exited);
      this.pending.clear();
    });
    this.proc.on('error', error => { this.exited = error; });
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
  private write(message: unknown) { this.proc.stdin.write(`${JSON.stringify(message)}\n`); }
  request<T>(method: string, params: unknown, signal?: AbortSignal, timeoutMs = 900_000): Promise<T> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = () => { this.pending.delete(id); done(); reject(new Error('Cancelled.')); };
      const timer = setTimeout(() => { this.pending.delete(id); done(); reject(new Error(`${method} timed out.`)); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve: v => { done(); resolve(v); }, reject: e => { done(); reject(e); } });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method: string) { this.write({ jsonrpc: '2.0', method }); }
  close() { if (!this.exited) { this.proc.stdin.end(); setTimeout(() => this.proc.kill('SIGTERM'), 5000).unref(); } }
}

export default async function blenderMcp(pi: ExtensionAPI) {
  const client = new McpClient();
  pi.on('session_shutdown', () => client.close());
  process.once('exit', () => client.close());
  // Startup covers resolving the latest mcp-for-blender release and launching Blender.
  await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pi-team', version: '1' } }, undefined, 420_000);
  client.notify('notifications/initialized');
  const { tools } = await client.request<{ tools: McpTool[] }>('tools/list', {}, undefined, 60_000);
  for (const name of blenderTools) {
    const tool = tools.find(t => t.name === name);
    pi.registerTool({
      name: toolName(name),
      label: `Blender ${name}`,
      description: tool?.description ?? `Not offered by this mcp-for-blender release.`,
      parameters: (tool?.inputSchema ?? { type: 'object', properties: {} }) as any,
      async execute(_id, params, signal) {
        if (!tool) throw new Error(`${name} is not offered by this mcp-for-blender release.`);
        const result = await client.request<{ content?: McpContent[]; isError?: boolean }>('tools/call', { name, arguments: params ?? {} }, signal);
        const content = (result.content ?? []).map(c => c.type === 'image' && c.data
          ? { type: 'image' as const, data: c.data, mimeType: c.mimeType ?? 'image/png' }
          : { type: 'text' as const, text: c.text ?? c.resource?.text ?? JSON.stringify(c) });
        if (result.isError) throw new Error(content.flatMap(c => c.type === 'text' ? [c.text] : []).join('\n') || `${name} failed.`);
        return { content: content.length ? content : [{ type: 'text' as const, text: '(no output)' }], details: {} };
      },
    });
  }
}
