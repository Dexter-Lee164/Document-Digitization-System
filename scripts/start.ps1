<#
.SYNOPSIS
    Starts DocuVision: the Python CV/OCR service and the Express web app, in this one window.

.DESCRIPTION
    Runs "node scripts\dev.js", which starts the CV service on 127.0.0.1:8001, waits until it answers,
    starts the web app on http://localhost:3000 and opens the browser. Press Ctrl+C once to stop both.

.PARAMETER NoBrowser
    Do not open the browser automatically.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js was not found. Install Node.js from https://nodejs.org/ and run .\scripts\setup.ps1.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Host 'The packages are not installed yet. Run  .\scripts\setup.ps1  first.' -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path (Join-Path $Root '.venv\Scripts\python.exe'))) {
    Write-Host 'Note: no .venv found; DocuVision will look for Python on PATH. Run .\scripts\setup.ps1 to create the virtual environment.' -ForegroundColor Yellow
}

$nodeArgs = @((Join-Path $Root 'scripts\dev.js'))
if (-not $NoBrowser) { $nodeArgs += '--open' }
& node @nodeArgs
exit $LASTEXITCODE
