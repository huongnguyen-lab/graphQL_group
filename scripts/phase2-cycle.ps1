param(
  [int]$InitialDelaySeconds = 7200,
  [int]$RunSeconds = 3600,
  [int]$RestSeconds = 900,
  [int]$MaxCycles = 0
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $Root 'logs'
$StatePath = Join-Path $Root 'data\phase2-cycle-state.json'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StatePath) | Out-Null

function Write-State {
  param(
    [string]$Status,
    [int]$Cycle,
    [int]$NodePid = 0,
    [string]$Message = ''
  )

  [PSCustomObject]@{
    updated_at = (Get-Date).ToUniversalTime().ToString('o')
    status = $Status
    cycle = $Cycle
    node_pid = $NodePid
    message = $Message
    initial_delay_seconds = $InitialDelaySeconds
    run_seconds = $RunSeconds
    rest_seconds = $RestSeconds
    max_cycles = $MaxCycles
  } | ConvertTo-Json -Depth 5 | Set-Content -Path $StatePath -Encoding UTF8
}

Write-State -Status 'waiting_initial_delay' -Cycle 0 -Message "Waiting $InitialDelaySeconds seconds before crawling."
Start-Sleep -Seconds $InitialDelaySeconds

$cycle = 0
while ($true) {
  $cycle++
  if ($MaxCycles -gt 0 -and $cycle -gt $MaxCycles) {
    Write-State -Status 'stopped_max_cycles' -Cycle ($cycle - 1) -Message 'Reached MaxCycles.'
    break
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $LogDir "phase2-cycle-$timestamp.out.log"
  $err = Join-Path $LogDir "phase2-cycle-$timestamp.err.log"

  Write-State -Status 'starting' -Cycle $cycle -Message 'Starting phase2-all.js.'
  $proc = Start-Process -FilePath 'node' `
    -ArgumentList 'phase2-all.js' `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -WindowStyle Hidden `
    -PassThru

  Write-State -Status 'running' -Cycle $cycle -NodePid $proc.Id -Message "Running for up to $RunSeconds seconds."
  $finished = $proc.WaitForExit($RunSeconds * 1000)

  if ($finished) {
    Write-State -Status 'completed' -Cycle $cycle -NodePid $proc.Id -Message "phase2-all.js exited with code $($proc.ExitCode)."
    break
  }

  Write-State -Status 'resting' -Cycle $cycle -NodePid $proc.Id -Message "Stopping crawler after $RunSeconds seconds; resting for $RestSeconds seconds."
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds $RestSeconds
}
