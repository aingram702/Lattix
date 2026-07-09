# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for Lattix. Build from the project root (the folder that
# contains `server/`, `client/`, and `requirements.txt`):
#
#     pyinstaller installer/lattix.spec
#
# Produces dist/Lattix/Lattix.exe plus its dependencies (a onedir bundle),
# which installer/lattix.iss then wraps into LattixSetup.exe.

import os
import sys
from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.getcwd())
IS_WINDOWS = sys.platform.startswith("win")
# The .ico and Windows version resource only apply to a Windows build; passing
# them on Linux/macOS is at best ignored and at worst an error, so gate them.
EXE_ICON = os.path.join(ROOT, "installer", "lattix.ico") if IS_WINDOWS else None
EXE_VERSION = os.path.join(ROOT, "installer", "version_info.txt") if IS_WINDOWS else None

hiddenimports = []
for pkg in ("uvicorn", "anyio", "fastapi", "starlette"):
    hiddenimports += collect_submodules(pkg)

a = Analysis(
    [os.path.join(ROOT, "installer", "lattix_launcher.py")],
    pathex=[ROOT],
    binaries=[],
    # Ship the entire single-page client (html/css/js/vendor/icons) as data.
    datas=[(os.path.join(ROOT, "client"), "client")],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Lattix",
    console=False,               # windowed app; the server runs in the background
    icon=EXE_ICON,
    version=EXE_VERSION,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Lattix",
)
