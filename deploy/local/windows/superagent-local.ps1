# Manage the independent dsh-superagent instance on Windows: profile superagent-local, panel 127.0.0.1:<PanelPort>.
# Usage:  .\superagent-local.ps1 [status|start|stop|restart]
#
# This is the Windows counterpart of ../scripts/dsh-superagent (which drives tmux on POSIX). It starts
# `dsh <profile> --no-open` as a hidden child process and waits for the panel port instead of a tmux window.
param(
  [ValidateSet('status','start','stop','restart')][string]$Action = 'status',
  [string]$ProfileName = 'superagent-local',
  [int]$PanelPort = 3084,
  [string]$WorkDir = 'D:\dsh-superagent-local',
  # dsh-superagent locks the state directory with proper-lockfile(stale: 30 s). Starting a new process
  # immediately after a kill fails with "Lock file is already being held", so a restart waits past it.
  [int]$LockReleaseSeconds = 32
)
$ErrorActionPreference = 'Stop'
$DshCli = 'C:\Users\sss\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$LogDir = Join-Path $env:USERPROFILE '.dsh\logs'

function Get-PanelPid {
  $c = Get-NetTCPConnection -LocalPort $PanelPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.OwningProcess }
  return $null
}

function Get-PanelUrl {
  $log = Get-ChildItem $LogDir -Filter "$ProfileName-*.out.log" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($log) {
    $m = Select-String -Path $log.FullName -Pattern "http://127\.0\.0\.1:$PanelPort/\?token=\S+" | Select-Object -Last 1
    if ($m) { return $m.Matches[0].Value }
  }
  return $null
}

function Show-Status {
  $panelPid = Get-PanelPid
  if ($panelPid) {
    Write-Output "running: panel on http://127.0.0.1:$PanelPort (pid $panelPid)"
    $url = Get-PanelUrl
    if ($url) { Write-Output "url: $url" }
  } else {
    Write-Output "stopped: nothing is listening on 127.0.0.1:$PanelPort"
  }
}

function Stop-Instance {
  $panelPid = Get-PanelPid
  if (-not $panelPid) { Write-Output 'stopped: nothing to do'; return }
  taskkill /PID $panelPid /T /F | Out-Null
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; if (-not (Get-PanelPid)) { break } }
  if (Get-PanelPid) { Write-Output 'stop failed: the panel is still listening' } else { Write-Output "stopped (pid $panelPid)" }
}

function Start-Instance {
  if (Get-PanelPid) { Write-Output 'already running'; Show-Status; return }
  # The Executor's ticket environment must not leak into this launcher's own process.
  $cleanPath = (($env:PATH -split ';') | Where-Object { $_ -and ($_ -notlike '*state\superagent\worker-bin*') }) -join ';'
  $env:PATH = $cleanPath
  Remove-Item Env:GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue
  Remove-Item Env:GIT_CONFIG_NOSYSTEM -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $LogDir "$ProfileName-$ts.out.log"
  $err = Join-Path $LogDir "$ProfileName-$ts.err.log"
  Start-Process -FilePath $DshCli -ArgumentList @($ProfileName, '--no-open') -WorkingDirectory $WorkDir -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Seconds 2; if (Get-PanelPid) { break } }
  Show-Status
}

switch ($Action) {
  'status'  { Show-Status }
  'start'   { Start-Instance }
  'stop'    { Stop-Instance }
  'restart' { Stop-Instance; Start-Sleep -Seconds $LockReleaseSeconds; Start-Instance }
}
