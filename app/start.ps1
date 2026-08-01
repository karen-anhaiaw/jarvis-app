# JARVIS - full build & start (Windows)
# Builds UI (Vite), then starts the backend (tsx).
# Used by: Windows desktop launcher, manual start, restart flows.

$ErrorActionPreference = "Stop"

$JarvisDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $JarvisDir

# Python\bin must come BEFORE WindowsApps (Store stub) so python3.exe resolves.
$env:Path = @(
  (Join-Path $env:LOCALAPPDATA "Python\bin"),
  "C:\Program Files\nodejs",
  "C:\Program Files\Git\usr\bin",
  "C:\Program Files\Git\cmd",
  "C:\Program Files\Git\bin",
  $env:Path
) -join ";"

Write-Host "Building UI..."
Push-Location (Join-Path $JarvisDir "ui")
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "UI build failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

Write-Host "Starting JARVIS..."
$tsx = Join-Path $JarvisDir "..\node_modules\.bin\tsx.cmd"
if (Test-Path $tsx) {
  & $tsx src/main.ts
} else {
  npx tsx src/main.ts
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
