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
from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.getcwd())

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
    icon=os.path.join(ROOT, "installer", "lattix.ico"),
    version=os.path.join(ROOT, "installer", "version_info.txt"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Lattix",
)
