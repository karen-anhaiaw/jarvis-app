# Install JARVIS as a Windows desktop app (Mac JARVIS.app equivalent)
# Creates launcher under %LOCALAPPDATA%\JARVIS and a Desktop shortcut.
# Double-click: bootstrap -> build UI -> start backend.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$AppInstallDir = Join-Path $env:LOCALAPPDATA "JARVIS"
$IconPng = Join-Path $RepoDir "app\ui\public\jarvis-icon.png"
$IconIco = Join-Path $AppInstallDir "jarvis.ico"
$LauncherCmd = Join-Path $AppInstallDir "jarvis.cmd"
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "JARVIS.lnk"
$LogFile = Join-Path $env:TEMP "jarvis.log"

Write-Host "Installing JARVIS Windows app..."
Write-Host "  Repo: $RepoDir"
Write-Host "  Install: $AppInstallDir"

New-Item -ItemType Directory -Force -Path $AppInstallDir | Out-Null

# Icon (.ico from existing PNG)
function Convert-PngToIco {
  param([string]$PngPath, [string]$IcoPath)

  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($PngPath)
  try {
    $sizes = @(16, 32, 48, 64, 128, 256)
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms

    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$sizes.Count)

    $imageData = New-Object System.Collections.Generic.List[byte[]]
    $offset = 6 + (16 * $sizes.Count)

    foreach ($size in $sizes) {
      $bmp = New-Object System.Drawing.Bitmap $size, $size
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.DrawImage($img, 0, 0, $size, $size)
      $g.Dispose()

      $pngMs = New-Object System.IO.MemoryStream
      $bmp.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
      $bytes = $pngMs.ToArray()
      $pngMs.Dispose()
      $bmp.Dispose()

      $w = if ($size -ge 256) { 0 } else { $size }
      $h = $w
      $bw.Write([byte]$w)
      $bw.Write([byte]$h)
      $bw.Write([byte]0)
      $bw.Write([byte]0)
      $bw.Write([uint16]1)
      $bw.Write([uint16]32)
      $bw.Write([uint32]$bytes.Length)
      $bw.Write([uint32]$offset)
      $offset += $bytes.Length
      $imageData.Add($bytes) | Out-Null
    }

    foreach ($bytes in $imageData) {
      $bw.Write($bytes)
    }

    $bw.Flush()
    [System.IO.File]::WriteAllBytes($IcoPath, $ms.ToArray())
    $bw.Dispose()
    $ms.Dispose()
  } finally {
    $img.Dispose()
  }
}

if (Test-Path $IconPng) {
  Write-Host "Generating jarvis.ico..."
  Convert-PngToIco -PngPath $IconPng -IcoPath $IconIco
} else {
  Write-Host "Warning: jarvis-icon.png not found; shortcut will use default icon."
}

# CMD launcher (mirrors Contents/MacOS/jarvis + app/start.sh build step)
# Critical PATH entries:
#   - nodejs
#   - Git\usr\bin  (openssl used by TLS cert generation)
#   - Git\cmd / Git\bin
$cmd = @"
@echo off
setlocal EnableExtensions
title JARVIS
cd /d "%~dp0"

set "RepoDir=$RepoDir"
set "JarvisDir=%RepoDir%\app"
set "LogFile=$LogFile"
set "Bash=C:\Program Files\Git\bin\bash.exe"
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\usr\bin;C:\Program Files\Git\cmd;C:\Program Files\Git\bin;%PATH%"

echo. > "%LogFile%"
call :log --- bootstrap ---

if exist "%Bash%" (
  "%Bash%" "%RepoDir%\scripts\bootstrap.sh"
  if errorlevel 1 call :log (bootstrap failed, continuing)
) else (
  call :log (Git bash not found; skipping bootstrap.sh)
)

where openssl >nul 2>&1
if errorlevel 1 (
  call :log FATAL: openssl not found in PATH (needed for TLS^). Expected under Git\usr\bin.
  goto :fail
)
for /f "delims=" %%v in ('openssl version 2^>nul') do call :log openssl ok: %%v

call :log --- build + start ---
cd /d "%JarvisDir%"
call "%JarvisDir%\start.cmd"
set "code=%ERRORLEVEL%"
if not "%code%"=="0" (
  call :log JARVIS exited with code %code%
  call :log See also: %USERPROFILE%\.jarvis\logs\jarvis.log
  echo.
  pause
  exit /b %code%
)
exit /b 0

:fail
echo.
pause
exit /b 1

:log
echo %*
>>"%LogFile%" echo [%date% %time%] %*
goto :eof
"@
Set-Content -Path $LauncherCmd -Value $cmd -Encoding ASCII

# Remove old PowerShell / hidden VBS launchers if present
Remove-Item (Join-Path $AppInstallDir "jarvis.ps1") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $AppInstallDir "jarvis.vbs") -Force -ErrorAction SilentlyContinue

# Desktop shortcut -> visible CMD console via jarvis.cmd
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $LauncherCmd
$Shortcut.Arguments = ""
$Shortcut.WorkingDirectory = $AppInstallDir
$Shortcut.Description = "J.A.R.V.I.S. - build UI and start"
$Shortcut.WindowStyle = 1
if (Test-Path $IconIco) {
  $Shortcut.IconLocation = "$IconIco,0"
}
$Shortcut.Save()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($WshShell) | Out-Null

Write-Host ""
Write-Host "JARVIS installed."
Write-Host "  Launcher: $LauncherCmd"
Write-Host "  Desktop:  $ShortcutPath"
Write-Host "  Log:      $LogFile"
Write-Host ""
Write-Host "Double-click JARVIS on the Desktop to bootstrap, build, and start (CMD)."
