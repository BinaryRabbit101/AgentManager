<#
.SYNOPSIS
    Diagnostics for support (foundation DESIGN section 4.4).

.DESCRIPTION
    section 4.4's list, in order: "edition, resolved data root, task state and last run
    result, listening ports, `/healthz` payload, `PRAGMA quick_check`, secret
    provider in use, presence of `ANTHROPIC_API_KEY`, Tailscale interface
    detection (home edition), and the last 50 log lines. Prints a
    copy-pasteable summary."

    Read-only throughout: nothing is created, started, stopped or repaired. A
    diagnostic that changes what it inspects cannot tell you what was wrong.

    The division of labour is deliberate. Everything that is a fact about the
    *install* comes from `agentmanager health --json` - one implementation,
    equally available to the UI and to a remote support session - and this script
    adds only what is Windows-shaped and genuinely outside the core: the
    scheduled task, the listening-socket table, and the tailnet interface.

.PARAMETER InstallRoot
    The install root. Defaults to the parent of this script's directory.

.PARAMETER DataRoot
    Overrides `%LOCALAPPDATA%\AgentManager`.

.PARAMETER TaskName
    Overrides the autostart task name. Defaults to section 4.3's name.

.PARAMETER LogLines
    How many trailing log lines to print. Default 50, as section 4.4 says.

.PARAMETER Json
    Emit the whole report as JSON instead of the readable summary.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Test-AgentManagerHealth.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $InstallRoot,
    [string] $DataRoot,
    [string] $TaskName,
    [int] $LogLines = 50,
    [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AgentManager.Common.ps1')

$resolvedInstallRoot = Resolve-AMInstallRoot -InstallRoot $InstallRoot -ScriptRoot $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Get-AMDefaultDataRoot }
$resolvedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)

# --- The core's own report -------------------------------------------------

$core = $null
$coreError = $null
try {
    $result = Invoke-AMCli -InstallRoot $resolvedInstallRoot -DataRoot $resolvedDataRoot -Arguments @('health', '--json')
    if ($result.ExitCode -eq 0) { $core = $result.StdOut | ConvertFrom-Json }
    else { $coreError = "agentmanager health exited $($result.ExitCode): $($result.StdErr)" }
}
catch {
    $coreError = $_.Exception.Message
}

# --- The scheduled task (section 4.3) --------------------------------------------

$taskPath = Get-AMTaskPath -TaskName $TaskName
$task = Get-AMScheduledTask -TaskName $TaskName
$taskReport = [ordered]@{
    Path          = $taskPath
    Registered    = ($null -ne $task)
    State         = ''
    LastRunTime   = ''
    LastTaskResult = ''
    NextRunTime   = ''
    Action        = ''
}
if ($null -ne $task) {
    $taskReport['State'] = [string] $task.State
    try {
        $info = Get-ScheduledTaskInfo -InputObject $task
        $taskReport['LastRunTime'] = [string] $info.LastRunTime
        # 0 = success; 267009 = currently running; 267011 = has not yet run.
        $taskReport['LastTaskResult'] = [string] $info.LastTaskResult
        $taskReport['NextRunTime'] = [string] $info.NextRunTime
    }
    catch {
        $taskReport['LastTaskResult'] = "unavailable: $($_.Exception.Message)"
    }
    $actions = @($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" })
    $taskReport['Action'] = ($actions -join '; ')
}

# --- Listening ports -------------------------------------------------------
#
# The socket table is the independent second claim: `agentmanager health` says
# what the core *published*, and this says what the OS reports is bound. section 6.3
# makes that pairing the boundary check, and a support report is exactly where a
# disagreement between the two needs to be visible.

$listeners = @()
try {
    $connections = Get-NetTCPConnection -State Listen -ErrorAction Stop
    foreach ($connection in $connections) {
        $owner = ''
        try { $owner = (Get-Process -Id $connection.OwningProcess -ErrorAction Stop).ProcessName }
        catch { $owner = "pid $($connection.OwningProcess)" }
        $listeners += [pscustomobject]@{
            Address = $connection.LocalAddress
            Port    = $connection.LocalPort
            Process = $owner
            Pid     = $connection.OwningProcess
        }
    }
}
catch {
    $listeners = @()
}

$corePid = $null
if ($null -ne $core -and $null -ne $core.core -and $core.core.PSObject.Properties.Name -contains 'pid') {
    $corePid = $core.core.pid
}
$coreListeners = @($listeners | Where-Object { $null -ne $corePid -and $_.Pid -eq $corePid })

# --- Tailscale (home edition only, D5) -------------------------------------

$tailscale = [ordered]@{ Checked = $false; InterfacePresent = $false; Addresses = @(); Note = '' }
$edition = if ($null -ne $core) { $core.edition } else { 'unknown' }
if ($edition -eq 'home') {
    $tailscale['Checked'] = $true
    try {
        $adapters = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.InterfaceDescription -match 'Tailscale' -or $_.Name -match 'Tailscale' })
        $tailscale['InterfacePresent'] = ($adapters.Count -gt 0)
        foreach ($adapter in $adapters) {
            $addresses = @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress })
            $tailscale['Addresses'] += $addresses
        }
    }
    catch {
        $tailscale['Note'] = "adapter enumeration failed: $($_.Exception.Message)"
    }
    if (-not $tailscale['InterfacePresent'] -and [string]::IsNullOrWhiteSpace($tailscale['Note'])) {
        $tailscale['Note'] = 'No Tailscale interface on this machine. That is expected when remote.bind is "proxy" (architecture D5 amendment): the tailnet lives on the proxy host.'
    }
}
else {
    $tailscale['Note'] = 'Not checked: Tailscale applies to the home edition only.'
}

# --- The log tail ----------------------------------------------------------

$logTail = @()
$logFile = Join-Path $resolvedDataRoot 'state\logs\core.log'
if (Test-Path -LiteralPath $logFile) {
    $logTail = @(Get-Content -LiteralPath $logFile -Tail $LogLines -ErrorAction SilentlyContinue)
}

# --- Assemble --------------------------------------------------------------

$report = [ordered]@{
    GeneratedAt = (Get-Date).ToUniversalTime().ToString('o')
    InstallRoot = $resolvedInstallRoot
    DataRoot    = $resolvedDataRoot
    Core        = $core
    CoreError   = $coreError
    Task        = [pscustomobject] $taskReport
    Listeners   = $coreListeners
    Tailscale   = [pscustomobject] $tailscale
    LogFile     = $logFile
    LogTail     = $logTail
}

if ($Json) {
    ConvertTo-Json -InputObject ([pscustomobject] $report) -Depth 12
    return
}

# --- The copy-pasteable summary -------------------------------------------

function Write-AMSection { param([string] $Title) Write-Host ''; Write-Host "== $Title" }

Write-Host "AgentManager health report - $($report.GeneratedAt)"
Write-Host "install root : $resolvedInstallRoot"
Write-Host "data root    : $resolvedDataRoot"

Write-AMSection 'Core'
if ($null -eq $core) {
    Write-Host "  could not run 'agentmanager health': $coreError"
}
else {
    Write-Host "  edition        : $($core.edition)"
    Write-Host "  config file    : $(if ($null -eq $core.configFile) { '(none; shipped defaults)' } else { $core.configFile })"
    if ($core.core.running) {
        Write-Host "  status         : running at $($core.core.url) (pid $($core.core.pid), since $($core.core.startedAt))"
        Write-Host "  /healthz       : $(ConvertTo-Json -InputObject $core.core.healthz -Compress)"
        if ($core.core.PSObject.Properties.Name -contains 'api' -and $null -ne $core.core.api) {
            Write-Host "  /api/health    : status $($core.core.api.status)"
            foreach ($module in @($core.core.api.modules)) {
                Write-Host "      module $($module.id): $($module.status)"
            }
            foreach ($condition in @($core.core.api.conditions)) {
                Write-Host "      condition [$($condition.level)] $($condition.id): $($condition.message)"
            }
        }
    }
    else {
        Write-Host "  status         : not running$(if ($core.core.stalePortFile) { ' (stale core.port on disk)' } else { '' })"
    }

    Write-AMSection 'Database'
    Write-Host "  file           : $($core.database.path)"
    Write-Host "  quick_check    : $($core.database.quickCheck)"
    Write-Host "  user_version   : $($core.database.schemaVersion)"
    Write-Host "  newest backup  : $(if ($null -eq $core.database.newestBackup) { '(none)' } else { $core.database.newestBackup })"

    Write-AMSection 'Secrets'
    Write-Host "  configured     : $($core.secrets.configured)"
    Write-Host "  provider used  : $(if ($null -eq $core.secrets.onDisk) { '(nothing stored yet)' } else { $core.secrets.onDisk })"
    Write-Host "  master.key     : $($core.secrets.masterKeyPresent)"
    Write-Host "  keys           : $(if (@($core.secrets.keys).Count -eq 0) { '(none)' } else { (@($core.secrets.keys) -join ', ') })"

    Write-AMSection 'Auth'
    Write-Host "  auth.mode          : $($core.auth.mode)"
    Write-Host "  ANTHROPIC_API_KEY  : $(if ($core.auth.anthropicApiKeyPresent) { 'SET - it overrides subscription auth (D2)' } else { 'not set' })"
}

Write-AMSection 'Autostart task'
Write-Host "  task           : $($taskReport['Path'])"
if (-not $taskReport['Registered']) {
    Write-Host "  registered     : no (expected in the work edition; run Register-Autostart.ps1 for home)"
}
else {
    Write-Host "  state          : $($taskReport['State'])"
    Write-Host "  action         : $($taskReport['Action'])"
    Write-Host "  last run       : $($taskReport['LastRunTime']) (result $($taskReport['LastTaskResult']))"
    Write-Host "  next run       : $($taskReport['NextRunTime'])"
}

Write-AMSection 'Listening sockets owned by the core'
if ($coreListeners.Count -eq 0) {
    Write-Host "  (none - the core is not running, or its pid is unknown)"
}
else {
    foreach ($listener in $coreListeners) {
        Write-Host "  $($listener.Address):$($listener.Port)  ($($listener.Process), pid $($listener.Pid))"
    }
}

Write-AMSection 'Tailscale'
Write-Host "  checked        : $($tailscale['Checked'])"
Write-Host "  interface      : $($tailscale['InterfacePresent'])"
if (@($tailscale['Addresses']).Count -gt 0) { Write-Host "  addresses      : $((@($tailscale['Addresses'])) -join ', ')" }
if (-not [string]::IsNullOrWhiteSpace($tailscale['Note'])) { Write-Host "  note           : $($tailscale['Note'])" }

Write-AMSection "Last $LogLines lines of core.log"
if ($logTail.Count -eq 0) {
    Write-Host "  (no log file at $logFile)"
}
else {
    foreach ($line in $logTail) { Write-Host "  $line" }
}

Write-Host ''
Write-Host 'Copy everything above into a support note. It contains no secret values:'
Write-Host 'secret keys are listed by name only, and the logger redacts at write time (DESIGN 5.4).'
