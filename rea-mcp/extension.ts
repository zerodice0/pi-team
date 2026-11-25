import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { LazyMcp, errorText, toContent } from '../mcp/client.ts';

// Loaded only into members whose role lists mcp: ["rea"]. REA (https://github.com/morluto/rea) offers
// about 200 tools whose definitions run to millions of characters, so the member gets three fixed
// gateway tools instead: find a tool, read its schema, call it. `rea mcp` starts on the first gateway
// call, stops after PI_TEAM_REA_IDLE_MINUTES (default 10) without a call, and stops with the member.
// Ghidra's JVM runs in its own process group, but REA stops it on SIGTERM and when its stdin closes
// (checked on macOS: shutdown, idle stop and a SIGKILLed pi leave no java or decompile process).
export const reaTools = ['rea_tools', 'rea_tool_schema', 'rea_call'];

const find = (name: string, extra: string[]) =>
  [...(process.env.PATH ?? '').split(delimiter).map(dir => join(dir, name)), ...extra].find(p => p && existsSync(p));
// Homebrew's ghidra formula puts only a ghidraRun wrapper on PATH; pacman installs /opt/ghidra.
const ghidraDir = () => process.env.GHIDRA_INSTALL_DIR
  ?? ['/opt/homebrew/opt/ghidra/libexec', '/usr/local/opt/ghidra/libexec', '/home/linuxbrew/.linuxbrew/opt/ghidra/libexec', '/opt/ghidra', '/usr/share/ghidra']
    .find(dir => existsSync(join(dir, 'support', 'analyzeHeadless')));

// Ghidra 12 needs a full JDK 25 or newer, and the java on PATH is often older (or missing, since
// Homebrew's openjdk formulas are keg-only). Keep a suitable JAVA_HOME, otherwise pick the newest
// JDK >= 25 among the usual Homebrew and Linux locations by reading each JDK's release file.
const jdkMajor = (home: string) => {
  try {
    const v = /^JAVA_VERSION="(\d+)/m.exec(readFileSync(join(home, 'release'), 'utf8'))?.[1];
    return v && existsSync(join(home, 'bin', 'javac')) ? Number(v) : 0;
  } catch { return 0; }
};
const subdirs = (dir: string, re: RegExp) => { try { return readdirSync(dir).filter(n => re.test(n)).map(n => join(dir, n)); } catch { return []; } };
const javaHome = () => {
  const env = process.env.JAVA_HOME;
  if (env && jdkMajor(env) >= 25) return undefined;
  const homes = [
    ...['/opt/homebrew/opt', '/usr/local/opt', '/home/linuxbrew/.linuxbrew/opt'].flatMap(dir => subdirs(dir, /^openjdk(@\d+)?$/))
      .flatMap(dir => [join(dir, 'libexec', 'openjdk.jdk', 'Contents', 'Home'), join(dir, 'libexec')]),
    ...subdirs('/Library/Java/JavaVirtualMachines', /./).map(dir => join(dir, 'Contents', 'Home')),
    ...subdirs('/usr/lib/jvm', /./),
  ].map(home => ({ home, major: jdkMajor(home) })).filter(j => j.major >= 25).sort((a, b) => b.major - a.major);
  return homes[0]?.home;
};

export default function reaMcp(pi: ExtensionAPI) {
  const minutes = Number(process.env.PI_TEAM_REA_IDLE_MINUTES ?? 10);
  const server = new LazyMcp({
    name: 'rea',
    command: () => {
      const rea = find('rea', ['/opt/homebrew/bin/rea', '/usr/local/bin/rea', '/home/linuxbrew/.linuxbrew/bin/rea']);
      if (!rea) throw new Error('rea is not installed (brew install rea).');
      const ghidra = ghidraDir();
      const java = ghidra ? javaHome() : undefined;
      const env = { ...(ghidra ? { GHIDRA_INSTALL_DIR: ghidra } : {}), ...(java ? { JAVA_HOME: java, PATH: `${join(java, 'bin')}${delimiter}${process.env.PATH ?? ''}` } : {}) };
      return { command: rea, args: ['mcp'], env: Object.keys(env).length ? env : undefined };
    },
    idleMs: minutes > 0 ? minutes * 60_000 : undefined,
    startTimeoutMs: 120_000,
    // Ghidra's first import and analysis can take several minutes (REA's own default startup allowance is 330s).
    callTimeoutMs: 3_600_000,
  });
  pi.on('session_shutdown', () => server.close());
  process.once('exit', () => server.close());
  const restartNote = (restarted: boolean) => restarted ? [{ type: 'text' as const, text: `REA was stopped after ${minutes} idle minutes and started again: targets and sessions opened before are closed; open them again.` }] : [];

  pi.registerTool({
    name: 'rea_tools',
    label: 'REA tools',
    description: 'List REA reverse-engineering tools (name and one-line summary). Filter with query words; every word must match the name or description. REA starts on first use.',
    parameters: Type.Object({ query: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }),
    async execute(_id, p) {
      const { restarted } = await server.ensure();
      const words = (p.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const tools = (server.tools ?? []).filter(t => words.every(w => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(w)));
      const lines = tools.slice(0, p.limit ?? 60).map(t => `${t.name}: ${(t.description ?? '').split('\n')[0].slice(0, 200)}`);
      const text = `${tools.length} of ${server.tools?.length ?? 0} tools match${tools.length > lines.length ? ` (showing ${lines.length})` : ''}. Read a schema with rea_tool_schema before rea_call.\n${lines.join('\n')}`;
      return { content: [...restartNote(restarted), { type: 'text' as const, text }], details: {} };
    },
  });
  pi.registerTool({
    name: 'rea_tool_schema',
    label: 'REA tool schema',
    description: 'Show the full description and input JSON schema of one REA tool.',
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, p) {
      const { restarted } = await server.ensure();
      const tool = server.tools?.find(t => t.name === p.name);
      if (!tool) throw new Error(`No REA tool named ${p.name}. Use rea_tools to search.`);
      return { content: [...restartNote(restarted), { type: 'text' as const, text: JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, null, 1) }], details: {} };
    },
  });
  pi.registerTool({
    name: 'rea_call',
    label: 'REA call',
    description: 'Call one REA tool with arguments that match its input schema (see rea_tool_schema).',
    parameters: Type.Object({ name: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    async execute(_id, p, signal) {
      const { restarted } = await server.ensure();
      if (!server.tools?.some(t => t.name === p.name)) throw new Error(`No REA tool named ${p.name}. Use rea_tools to search.`);
      const result = await server.call(p.name, p.arguments ?? {}, signal);
      const content = [...restartNote(restarted || result.restarted), ...toContent(result)];
      if (result.isError) throw new Error(errorText(content) || `${p.name} failed.`);
      return { content, details: {} };
    },
  });
}
