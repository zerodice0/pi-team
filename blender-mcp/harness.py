"""Serve the mcp-for-blender addon from a background (blender -b) Blender.

Run by launch.py: blender -b --factory-startup --python harness.py -- --addon PATH --port N --parent PID
The upstream addon refuses to start its socket server in background mode because bpy.app.timers
do not tick there. This keeps the addon's socket protocol and drains its command queue on the
main thread instead. It exits when stopped or when the launching process disappears.
"""
import argparse
import importlib.util
import os
import signal
import socket
import sys
import threading

import bpy


def parent_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--addon', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--parent', type=int, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    stopping = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda _signum, _frame: stopping.set())

    spec = importlib.util.spec_from_file_location('pi_team_blendermcp_addon', args.addon)
    addon = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = addon
    spec.loader.exec_module(addon)
    server = None
    registered = False
    try:
        addon.register()
        registered = True
        try:
            # Background mode has no window to create a GPU context for offscreen captures.
            import gpu
            gpu.init()
        except Exception as error:  # Rendering through bpy still works without it.
            print(f'PI_TEAM_BLENDER_MCP gpu.init failed: {error}', flush=True)
        server = addon.BlenderMCPServer(host='127.0.0.1', port=args.port)
        bpy.types.blendermcp_server = server
        server.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.socket.bind((server.host, server.port))
        server.socket.listen(5)
        server.running = True
        server.server_thread = threading.Thread(target=server._server_loop, daemon=True)
        server.server_thread.start()
        if hasattr(addon, '_register_edit_capture_handlers'):
            addon._register_edit_capture_handlers()
        print(f'PI_TEAM_BLENDER_MCP_READY port={args.port} pid={os.getpid()} blender={bpy.app.version_string}', flush=True)
        ticks = 0
        while not stopping.is_set():
            server._drain_command_queue()
            stopping.wait(0.02)
            ticks += 1
            if ticks % 50 == 0 and not parent_alive(args.parent):
                break
    finally:
        try:
            if server is not None:
                server.stop()
        finally:
            if registered:
                addon.unregister()
        print('PI_TEAM_BLENDER_MCP_STOPPED', flush=True)


if __name__ == '__main__':
    main()
