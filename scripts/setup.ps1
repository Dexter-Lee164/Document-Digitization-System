<#
.SYNOPSIS
    One-time setup of DocuVision on Windows 10/11 (safe to run again).

.DESCRIPTION
    1. Checks Node.js (22.13 or newer; v26.5.1 is the target) and installs the npm packages.
    2. Creates .env from .env.example and generates SESSION_SECRET and CV_SERVICE_TOKEN.
    3. Finds Python 3.11 / 3.12, creates the virtual environment .venv and installs cv-service\requirements.txt.
    4. Finds Tesseract OCR and, if it is not on PATH, writes TESSERACT_CMD into .env.
    5. Initialises the SQLite database.
    6. Runs a self-check (Python packages, Tesseract).

.PARAMETER PythonExe
    Optional full path to a python.exe to use for the virtual environment.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
#>
[CmdletBinding()]
param(
    [string]$PythonExe = ''
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "    [ok] $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    [!]  $Text" -ForegroundColor Yellow }
function Stop-Setup([string]$Text) { Write-Host ''; Write-Host "    [x]  $Text" -ForegroundColor Red; exit 1 }

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $lines = [System.IO.File]::ReadAllLines($Path)
    $found = $false
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match ('^\s*' + $Key + '\s*=')) { $lines[$i] = "$Key=$Value"; $found = $true; break }
    }
    if (-not $found) { $lines = $lines + "$Key=$Value" }
    # UTF-8 without a byte-order mark, so that both services read the first line correctly.
    [System.IO.File]::WriteAllLines($Path, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-EnvValue([string]$Path, [string]$Key) {
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match ('^\s*' + $Key + '\s*=(.*)$')) { return $Matches[1].Trim() }
    }
    return ''
}

function Get-PythonVersion([string]$Exe, [string[]]$Prefix) {
    $ErrorActionPreference = 'Continue'   # a missing or Store-stub python must not abort the search
    try {
        $out = & $Exe @Prefix -c "import sys; print('%d.%d.%d' % sys.version_info[:3])" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
        return [version](($out | Select-Object -First 1).ToString().Trim())
    } catch {
        return $null
    }
}

function Find-Tesseract {
    $onPath = Get-Command tesseract -ErrorAction SilentlyContinue
    if ($onPath) { return @{ Path = $onPath.Source; OnPath = $true } }
    $folders = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs')) | Where-Object { $_ }
    foreach ($folder in $folders) {
        $candidate = Join-Path $folder 'Tesseract-OCR\tesseract.exe'
        if (Test-Path $candidate) { return @{ Path = $candidate; OnPath = $false } }
    }
    return $null
}

# ---------------------------------------------------------------- 1. Node.js and npm packages
Write-Step 'Checking Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-Setup 'Node.js was not found. Install Node.js (v26.5.1 recommended) from https://nodejs.org/ and run this script again.'
}
$nodeVersion = [version]((& node -v).Trim().TrimStart('v'))
if ($nodeVersion -lt [version]'22.13.0') {
    Stop-Setup "Node.js $nodeVersion is too old. DocuVision needs 22.13 or newer (v26.5.1 recommended). Your Node.js installation was not changed."
}
if ($nodeVersion.Major -ne 26) { Write-Note "Node.js $nodeVersion found. The project targets v26.5.1 and needs 22.13+; this version is accepted." }
else { Write-Ok "Node.js $nodeVersion" }

$npm = 'npm'
if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { $npm = 'npm.cmd' }

Write-Step 'Installing Node.js packages (npm install)'
& $npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Stop-Setup 'npm install failed. Check your internet connection and the messages above.' }
Write-Ok 'npm packages installed'

# ---------------------------------------------------------------- 2. .env
Write-Step 'Creating .env'
& node (Join-Path $Root 'scripts\ensure-env.js')
if ($LASTEXITCODE -ne 0) { Stop-Setup 'Could not create .env.' }
$envFile = Join-Path $Root '.env'

# ---------------------------------------------------------------- 3. Python virtual environment
Write-Step 'Preparing the Python environment'
$venvPython = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    $candidates = @()
    if ($PythonExe) { $candidates += , @{ Exe = $PythonExe; Prefix = @() } }
    $candidates += , @{ Exe = 'py'; Prefix = @('-3.12') }
    $candidates += , @{ Exe = 'py'; Prefix = @('-3.11') }
    $candidates += , @{ Exe = 'python'; Prefix = @() }
    $candidates += , @{ Exe = 'python3'; Prefix = @() }

    $chosen = $null
    $fallback = $null
    foreach ($c in $candidates) {
        $v = Get-PythonVersion $c.Exe $c.Prefix
        if (-not $v -or $v.Major -ne 3) { continue }
        if ($v.Minor -eq 11 -or $v.Minor -eq 12) { $chosen = $c; $chosen.Version = $v; break }
        if ($v.Minor -ge 10 -and -not $fallback) { $fallback = $c; $fallback.Version = $v }
    }
    if (-not $chosen -and $fallback) {
        $chosen = $fallback
        Write-Note "Python $($chosen.Version) will be used. 3.11 or 3.12 is the target; other 3.x versions usually work but are less tested."
    }
    if (-not $chosen) {
        Stop-Setup 'Python 3.11 or 3.12 was not found. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH") and run this script again.'
    }
    Write-Host "    Creating .venv with Python $($chosen.Version) ..."
    $pythonForVenv = $chosen.Exe
    $pythonPrefix = $chosen.Prefix
    & $pythonForVenv @pythonPrefix -m venv (Join-Path $Root '.venv')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPython)) { Stop-Setup 'Could not create the virtual environment (.venv).' }
    Write-Ok 'virtual environment created'
} else {
    Write-Ok 'virtual environment .venv already exists'
}

Write-Host '    Installing Python packages (this can take a few minutes the first time) ...'
& $venvPython -m pip install --upgrade pip --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { Write-Note 'Could not upgrade pip; continuing with the installed version.' }
& $venvPython -m pip install -r (Join-Path $Root 'cv-service\requirements.txt') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { Stop-Setup 'pip could not install cv-service\requirements.txt. Check your internet connection and the messages above.' }
Write-Ok 'Python packages installed'

# ---------------------------------------------------------------- 4. Tesseract
Write-Step 'Looking for Tesseract OCR'
$configured = Get-EnvValue $envFile 'TESSERACT_CMD'
if ($configured) {
    if (Test-Path $configured) { Write-Ok "TESSERACT_CMD in .env points to $configured" }
    else { Write-Note "TESSERACT_CMD in .env ($configured) does not exist. Fix the path or clear the value to use auto-detection." }
} else {
    $tess = Find-Tesseract
    if ($tess -and $tess.OnPath) {
        Write-Ok "Tesseract found on PATH: $($tess.Path)"
    } elseif ($tess) {
        Set-EnvValue $envFile 'TESSERACT_CMD' $tess.Path
        Write-Ok "Tesseract found at $($tess.Path) and saved as TESSERACT_CMD in .env"
    } else {
        Write-Note 'Tesseract OCR was not found. The web app still works, but text recognition is unavailable until it is installed:'
        Write-Host '         winget install --id UB-Mannheim.TesseractOCR -e'
        Write-Host '         (or download the installer from https://github.com/UB-Mannheim/tesseract/wiki)'
        Write-Host '         Then run this script again, or set TESSERACT_CMD in .env to the full path of tesseract.exe.'
    }
}

# ---------------------------------------------------------------- 5. Database
Write-Step 'Initialising the SQLite database'
& $npm run db:init
if ($LASTEXITCODE -ne 0) { Stop-Setup 'Database initialisation failed (see the message above).' }

# ---------------------------------------------------------------- 6. Self-check
Write-Step 'Self-check'
& node (Join-Path $Root 'scripts\start-cv.js') --check
$checkCode = $LASTEXITCODE

Write-Host ''
if ($checkCode -eq 0) {
    Write-Host 'Setup complete.' -ForegroundColor Green
} elseif ($checkCode -eq 2) {
    Write-Host 'Setup complete, except for Tesseract (see above). Install it and run .\scripts\setup.ps1 again to enable text recognition.' -ForegroundColor Yellow
} else {
    Write-Host 'Setup finished, but the self-check found a problem (see above).' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Start DocuVision with:   .\scripts\start.ps1     (or: npm run dev)'
Write-Host 'Then open:               http://localhost:3000'
