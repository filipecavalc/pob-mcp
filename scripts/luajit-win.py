"""Minimal `luajit` command-line stand-in for Windows.

Runs a Lua script on the lua51.dll (LuaJIT) that ships in a Path of Building
checkout's runtime/ folder, so no separate LuaJIT install is needed and the
interpreter is ABI-compatible with PoB's native modules (lua-utf8, lzip, ...).

Usage (cwd = <PathOfBuilding>/src, as the bridge spawns it):
    python -I luajit-win.py <script.lua> [args...]

Configure the MCP server with:
    POB_CMD  = <path to python.exe>
    POB_ARGS = -I <this file> <pob-mcp>/lua/vanilla_stdio_bridge.lua
"""
import ctypes
import os
import sys

LUA_GLOBALSINDEX = -10002


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: luajit-win.py <script.lua> [args...]\n")
        return 2

    runtime = os.environ.get("POB_RUNTIME") or os.path.join(os.getcwd(), "..", "runtime")
    runtime = os.path.abspath(runtime)
    dll = os.path.join(runtime, "lua51.dll")
    if not os.path.isfile(dll):
        sys.stderr.write(f"luajit-win: lua51.dll not found in {runtime} (set POB_RUNTIME)\n")
        return 2

    # Native modules and ffi.load('zlib1') resolve their DLLs through the normal search path.
    os.environ["PATH"] = runtime + os.pathsep + os.environ.get("PATH", "")
    os.add_dll_directory(runtime)

    lua = ctypes.CDLL(dll)
    lua.luaL_newstate.restype = ctypes.c_void_p
    lua.luaL_openlibs.argtypes = [ctypes.c_void_p]
    lua.luaL_loadfile.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    lua.lua_pcall.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    lua.lua_tolstring.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    lua.lua_tolstring.restype = ctypes.c_char_p
    lua.lua_createtable.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    lua.lua_pushstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    lua.lua_rawseti.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    lua.lua_setfield.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p]

    L = lua.luaL_newstate()
    lua.luaL_openlibs(L)  # package.path/cpath pick up LUA_PATH/LUA_CPATH from the environment

    # Global `arg`, as the luajit CLI sets it: arg[0] = script, arg[1..n] = arguments.
    script = sys.argv[1]
    lua.lua_createtable(L, len(sys.argv) - 1, 0)
    for i, value in enumerate(sys.argv[1:]):
        lua.lua_pushstring(L, value.encode("utf-8"))
        lua.lua_rawseti(L, -2, i)
    lua.lua_setfield(L, LUA_GLOBALSINDEX, b"arg")

    rc = lua.luaL_loadfile(L, script.encode("utf-8")) or lua.lua_pcall(L, 0, 0, 0)
    if rc:
        msg = lua.lua_tolstring(L, -1, None)
        sys.stderr.write("luajit-win: " + (msg.decode("utf-8", "replace") if msg else "unknown error") + "\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
