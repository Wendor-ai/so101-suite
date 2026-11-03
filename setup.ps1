# SO-101 Suite setup for Windows (PowerShell).
#
#   .\setup.ps1             install everything, detect your hardware, open the app
#   .\setup.ps1 -NoStart    install only (start later with: uv run so101 start)
#   .\setup.ps1 -DryRun     show what would happen, change nothing
#
# NOTE: Windows is UNTESTED so far. The macOS/Linux/Raspberry Pi path (setup.sh) is the one that has been run on real
# hardware. If something here fails, please open an issue and paste the output of:  uv run so101 doctor
#
# Safe to run again. It does not need administrator rights: uv goes into your own user folder and the packages into .\.venv.
# If PowerShell refuses to run this file, run once:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
param([switch]$NoStart, [switch]$DryRun, [Parameter(ValueFromRemainingArguments = $true)] $Rest)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Say($m)  { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Note($m) { Write-Host "    $m" }
function Run($cmd) { if ($DryRun) { Note "(dry run) $cmd" } else { Invoke-Expression $cmd } }

Say "SO-101 Suite setup (Windows, untested)"
Note "Folder: $PWD"

Say "1/3  Checking uv (installs Python and the packages)"
$uvDirs = @("$env:USERPROFILE\.local\bin", "$env:USERPROFILE\.cargo\bin")
foreach ($d in $uvDirs) { if (Test-Path $d) { $env:Path = "$d;$env:Path" } }
if (Get-Command uv -ErrorAction SilentlyContinue) {
  Note ("uv is already installed: " + (uv --version))
} else {
  Note "uv is not installed. Installing it for your user (no administrator rights needed) ..."
  Run 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"'
  foreach ($d in $uvDirs) { if (Test-Path $d) { $env:Path = "$d;$env:Path" } }
  if (-not $DryRun -and -not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Note "uv was installed but is not on PATH yet. Open a new PowerShell window and run .\setup.ps1 again."
    exit 1
  }
}

Say "2/3  Installing the app (Python 3.12 and the packages go into .\.venv; this can take a minute)"
Run "uv sync"

Say "3/3  Nothing else to set up on Windows"
Note "If the arm is not found later, check Device Manager > Ports (COM & LPT) for a 'USB Serial' or 'CH340/CH343' device."
Note "Windows may need the CH343 driver from the adapter maker (WCH); the app's checklist will say if the port is missing."

if (-not $NoStart) {
  Say "Starting the app: it looks at your hardware and opens the right page"
  Note "Stop it any time with Ctrl+C. Start it again later with: uv run so101 start"
  if ($DryRun) { Note "(dry run) uv run so101 setup $Rest"; exit 0 }
  & uv run so101 setup @Rest
} else {
  Say "All set"
  Note "Start the app with:  uv run so101 start"
  Note "Try it without any hardware:  uv run so101 demo"
}
