# Build LattixSetup.exe on Windows.
#
# Usage (from the project root, in PowerShell):
#     ./installer/build.ps1
#
# Requirements:
#   * Python 3.10+ on PATH
#   * Inno Setup 6+ (ISCC.exe) — https://jrsoftware.org/isinfo.php
#     (the script auto-detects the usual install location)
#
# Output: installer/Output/LattixSetup.exe

$ErrorActionPreference = "Stop"

# Always run from the project root (the parent of this script's folder).
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "Building Lattix from $root" -ForegroundColor Cyan

# 1. Isolated virtual environment with runtime + build deps.
if (-not (Test-Path ".venv-build")) {
    python -m venv .venv-build
}
$py = Join-Path $root ".venv-build\Scripts\python.exe"
& $py -m pip install --upgrade pip
& $py -m pip install -r requirements.txt
& $py -m pip install -r installer/requirements-build.txt

# 2. Freeze the app into dist\Lattix\Lattix.exe (+ dependencies).
if (Test-Path "build") { Remove-Item "build" -Recurse -Force }
if (Test-Path "dist")  { Remove-Item "dist"  -Recurse -Force }
& $py -m PyInstaller --noconfirm installer/lattix.spec
if (-not (Test-Path "dist\Lattix\Lattix.exe")) {
    throw "PyInstaller did not produce dist\Lattix\Lattix.exe"
}

# 3. Compile the Inno Setup installer.
$iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
    throw "ISCC.exe (Inno Setup 6) not found. Install from https://jrsoftware.org/isdl.php"
}

& $iscc "installer\lattix.iss"

Write-Host ""
Write-Host "Done -> installer\Output\LattixSetup.exe" -ForegroundColor Green
