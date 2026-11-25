import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { LazyMcp, errorText, toContent, type McpTool } from '../mcp/client.ts';

// Loaded only into members whose role lists mcp: ["blender"]. The member gets the mcp-for-blender tools
// under Pi's MCP names (mcp__blender__<tool>) so Blender skills that name them still match. Nothing runs
// until the first call: then launch.py starts a private headless Blender on a free port plus the server.
// It stops with the member. There is no idle stop: an unsaved scene would be lost.
export const blenderTools = ['execute_blender_code', 'get_scene_info', 'look', 'search_assets', 'import_asset', 'get_addon_status'];
export const toolName = (tool: string) => `mcp__blender__${tool}`;

// Used until this host has listed the server once; later starts read the cached definitions.
const fallback: Record<string, McpTool> = {
  execute_blender_code: { name: 'execute_blender_code', description: 'Execute Python (bpy) code in Blender and return its output.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Python code to run in Blender' } }, required: ['code'] } },
  get_scene_info: { name: 'get_scene_info', description: 'Summarize the current Blender scene and its objects.', inputSchema: { type: 'object', properties: {} } },
};

export default function blenderMcp(pi: ExtensionAPI) {
  const server = new LazyMcp({
    name: 'blender',
    command: () => ({ command: 'python3', args: [fileURLToPath(new URL('./launch.py', import.meta.url))] }),
    // Covers resolving the latest mcp-for-blender release and launching Blender.
    startTimeoutMs: 420_000,
    callTimeoutMs: 900_000,
  });
  pi.on('session_shutdown', () => server.close());
  process.once('exit', () => server.close());
  const cached = server.cachedTools();
  for (const name of blenderTools) {
    const known = cached?.find(t => t.name === name) ?? fallback[name];
    pi.registerTool({
      name: toolName(name),
      label: `Blender ${name}`,
      description: known?.description ?? `mcp-for-blender ${name}. Blender starts on the first call.`,
      parameters: (known?.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true }) as any,
      async execute(_id, params, signal) {
        await server.ensure();
        if (!server.tools?.some(t => t.name === name)) throw new Error(`${name} is not offered by this mcp-for-blender release.`);
        const result = await server.call(name, params, signal);
        const content = toContent(result);
        if (result.isError) throw new Error(errorText(content) || `${name} failed.`);
        return { content, details: {} };
      },
    });
  }
}
