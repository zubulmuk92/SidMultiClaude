# scripts/install.ps1 - builds the optional helpers with the Windows csc.exe, records their SHA-256 and installs the
# Desktop + Start menu shortcuts. Run through `npm run install-app`.
# - csc available: launcher\SidMultiClaude.exe (GUI launcher + supervisor) and launcher\jobrun.exe (per-chat Job Object),
#   hashes in <DataDir>\state\helpers.json (the server only uses jobrun.exe when its hash matches: SPEC 0.2, S16).
# - csc missing or failing (lead decision Q3/L4): shortcuts start launcher\SidMultiClaude.vbs through wscript.exe (no
#   console window, no supervisor); isolation falls back to 'plain'. The app works fully without the helpers.
# Tests pass every target directory explicitly: they never touch the real Desktop, Start menu or data folder.
[CmdletBinding()]
param(
  [string]$AppDir = '',
  [string]$OutDir = '',
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'SidMultiClaude'),
  [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
  [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
  [string]$NodeExe = '',
  [string]$Csc = (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  [switch]$NoShortcuts,
  [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
if (-not $AppDir) { $AppDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
if (-not $OutDir) { $OutDir = Join-Path $AppDir 'launcher' }
if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source }
$main = Join-Path $AppDir 'src\server\main.ts'
$icon = Join-Path $AppDir 'assets\app.ico'
if (-not (Test-Path -LiteralPath $main)) { throw "main.ts introuvable : $main" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Build-Helper([string]$source, [string]$out, [string]$target, [bool]$withIcon) {
  if ($NoBuild -or -not (Test-Path -LiteralPath $Csc) -or -not (Test-Path -LiteralPath $source)) { return $false }
  $cscArgs = @('/nologo', "/target:$target", '/optimize+', "/out:$out")
  if ($withIcon -and (Test-Path -LiteralPath $icon)) { $cscArgs += "/win32icon:$icon" }
  $cscArgs += $source
  & $Csc @cscArgs | Out-Host
  return ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $out))
}
# .NET rather than Get-FileHash: started from PowerShell 7, Windows PowerShell inherits its PSModulePath and cannot load
# the script functions of Microsoft.PowerShell.Utility (Get-FileHash is one of them).
function Get-Sha256([string]$p) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($p))) -replace '-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

$launcherExe = Join-Path $OutDir 'SidMultiClaude.exe'
$jobrunExe = Join-Path $OutDir 'jobrun.exe'
$launcherOk = Build-Helper (Join-Path $AppDir 'launcher\SidMultiClaude.cs') $launcherExe 'winexe' $true
$jobrunOk = Build-Helper (Join-Path $AppDir 'launcher\jobrun.cs') $jobrunExe 'exe' $false

# helpers.json (same envelope as util/json-store: {v, data}); written only for what was built
$helpers = [ordered]@{}
if ($launcherOk) { $helpers['launcher'] = [ordered]@{ path = $launcherExe; sha256 = (Get-Sha256 $launcherExe) } }
if ($jobrunOk) { $helpers['jobrun'] = [ordered]@{ path = $jobrunExe; sha256 = (Get-Sha256 $jobrunExe) } }
$stateDir = Join-Path $DataDir 'state'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$json = ConvertTo-Json -Depth 5 -Compress -InputObject ([ordered]@{ v = 1; data = $helpers })
[IO.File]::WriteAllText((Join-Path $stateDir 'helpers.json'), $json, (New-Object Text.UTF8Encoding $false))

# shortcuts: the compiled launcher, else wscript.exe + the VBS fallback (both console-free)
$made = @()
if (-not $NoShortcuts) {
  $sh = New-Object -ComObject WScript.Shell
  foreach ($dir in @($DesktopDir, $StartMenuDir)) {
    if (-not $dir) { continue }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $lnk = $sh.CreateShortcut((Join-Path $dir 'SidMultiClaude.lnk'))
    if ($launcherOk) {
      $lnk.TargetPath = $launcherExe
      $lnk.Arguments = '"' + $NodeExe + '" "' + $main + '"'
    } else {
      $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
      $lnk.Arguments = '"' + (Join-Path $AppDir 'launcher\SidMultiClaude.vbs') + '" "' + $NodeExe + '" "' + $main + '"'
    }
    $lnk.WorkingDirectory = $AppDir
    if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Description = 'SidMultiClaude'
    $lnk.Save()
    $made += $lnk.FullName
  }
}
$mode = if ($launcherOk) { 'exe' } else { 'vbs' }
$isolation = if ($jobrunOk) { 'job' } else { 'plain' }
Write-Output ("SMC_INSTALL " + (ConvertTo-Json -Compress -InputObject ([ordered]@{ launcher = $mode; isolation = $isolation; shortcuts = $made; helpers = (Join-Path $stateDir 'helpers.json') })))
