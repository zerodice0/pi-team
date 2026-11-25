#!/usr/bin/env python3
"""Stdio MCP server for one pi-team member: a private headless Blender plus mcp-for-blender.

pi starts this as the member's `blender` MCP server (see extension.ts). Each launch picks a free
port, starts its own background Blender with the addon bundled in the same mcp-for-blender
release, then runs that release's MCP server on stdin/stdout. Blender stops with this process,
so several members can model at once without sharing a scene.

stdout belongs to the MCP protocol; diagnostics go to stderr and Blender's output to a log file.
Environment: PI_TEAM_BLENDER (Blender executable), PI_TEAM_BLENDER_MCP (uv package spec,
default mcp-for-blender@latest), PI_TEAM_BLENDER_TIMEOUT (seconds to wait for Blender, default 120).
"""
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOGS = Path.home() / '.cache' / 'pi-team' / 'blender-mcp'


def note(message):
    print(f'pi-team blender-mcp: {message}', file=sys.stderr, flush=True)


def find(name, *extra):
    found = shutil.which(name)
    if found:
        return found
    for path in extra:
        if Path(path).expanduser().is_file():
            return str(Path(path).expanduser())
    return None


def resolve_release(uvx, spec):
    # Ask uv for the release once, then pin both the addon and the server to it.
    probe = ("import blender_mcp, importlib.metadata as m, pathlib;"
             "print(m.version('mcp-for-blender'));"
             "print(pathlib.Path(blender_mcp.__file__).parent / 'bundled' / 'addon.py')")
    specs = [spec] if '@latest' not in spec else [spec, spec.replace('@latest', '')]
    for candidate in specs:  # Fall back to the cached release when the index is unreachable.
        try:
            out = subprocess.run([uvx, '--quiet', '--from', candidate, 'python', '-c', probe], capture_output=True,
                                 text=True, timeout=180, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            continue
        lines = out.stdout.strip().splitlines()
        if out.returncode == 0 and len(lines) >= 2 and Path(lines[-1]).is_file():
            return lines[-2], lines[-1]
        note(f'uvx --from {candidate} failed: {(out.stderr or out.stdout).strip()[-500:]}')
    return None, None


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5):
            return True
    except OSError:
        return False


def stop(proc, grace=10):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(grace)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    blender = os.environ.get('PI_TEAM_BLENDER') or find('blender', '/Applications/Blender.app/Contents/MacOS/Blender', '~/.local/bin/blender')
    uvx = find('uvx', '/opt/homebrew/bin/uvx', '~/.local/bin/uvx', '/home/linuxbrew/.linuxbrew/bin/uvx')
    if not blender or not uvx:
        note(f'missing {"Blender" if not blender else "uvx (install uv)"}; set PI_TEAM_BLENDER or PATH.')
        return 1
    version, addon = resolve_release(uvx, os.environ.get('PI_TEAM_BLENDER_MCP', 'mcp-for-blender@latest'))
    if not addon:
        return 1
    LOGS.mkdir(parents=True, exist_ok=True)
    for old in sorted(LOGS.glob('*.log'), key=lambda p: p.stat().st_mtime)[:-20]:
        old.unlink(missing_ok=True)
    port = free_port()
    log = LOGS / f'{time.strftime("%Y%m%d-%H%M%S")}-{port}.log'
    blender_proc = server = None

    def shutdown(_signum, _frame):
        # Only unwind here: waiting on a child inside the handler would deadlock with the
        # interrupted wait() in the main thread. The finally block below stops both children.
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        with open(log, 'w') as out:
            blender_proc = subprocess.Popen(
                [blender, '-b', '--factory-startup', '--python', str(HERE / 'harness.py'), '--',
                 '--addon', addon, '--port', str(port), '--parent', str(os.getpid())],
                stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.time() + float(os.environ.get('PI_TEAM_BLENDER_TIMEOUT', '120'))
        while not port_open(port):
            if blender_proc.poll() is not None or time.time() > deadline:
                note(f'Blender did not start (exit {blender_proc.poll()}); log: {log}')
                return 1
            time.sleep(0.25)
        note(f'mcp-for-blender {version}, Blender pid {blender_proc.pid} on port {port}; log: {log}')
        env = dict(os.environ, BLENDER_HOST='127.0.0.1', BLENDER_PORT=str(port), DISABLE_TELEMETRY='true')
        server = subprocess.Popen([uvx, '--quiet', '--from', f'mcp-for-blender=={version}', 'mcp-for-blender'], env=env)
        return server.wait()
    finally:
        stop(server, 5)
        stop(blender_proc)


if __name__ == '__main__':
    sys.exit(main())
