<#
.SYNOPSIS
    Registers the AgentManager core to start at logon (foundation DESIGN section 4.3).

.DESCRIPTION
    Creates the scheduled task `\AgentManager\AgentManager Core` in the **current
    user's** context: no admin rights, survives reboot, restarts on failure, and
    keeps DPAPI CurrentUser secrets and the user's own network context working -
    the four properties section 4.3 chose Task Scheduler for, and the ones a SYSTEM
    service breaks.

    The action is `wscript.exe "<install>\launch-core.vbs"`, never `node.exe`
    directly, because a console executable launched by a task in an interactive
    session flashes a window at every logon.

    Split out from `Install-AgentManager.ps1` so autostart can be toggled without
    reinstalling (section 4.4). Idempotent: an existing task is replaced with the
    current definition rather than duplicated, and the script reports which
    happened.

.PARAMETER InstallRoot
    The install root. Defaults to the parent of this script's directory.

.PARAMETER TaskName
    Overrides the task name inside `\AgentManager\`. For tests and for running a
    second install side by side; the default is DESIGN section 4.3's name.

.PARAMETER DryRun
    Change nothing. Emit the exact XML that would be registered, validate it
    against the Task Scheduler service, and report the plan.

.PARAMETER XmlPath
    Write the task XML to this file. Useful with `-DryRun` for review, and for
    the test suite.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Register-Autostart.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Register-Autostart.ps1 -DryRun -XmlPath .\task.xml
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $InstallRoot,
    [string] $TaskName,
    [string] $XmlPath,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AgentManager.Common.ps1')

$resolvedInstallRoot = Resolve-AMInstallRoot -InstallRoot $InstallRoot -ScriptRoot $PSScriptRoot
$taskPath = Get-AMTaskPath -TaskName $TaskName
$plan = New-AMPlan

Write-Host "AgentManager autostart registration"
Write-Host "  install root : $resolvedInstallRoot"
Write-Host "  task         : $taskPath"

$launcher = Join-Path $resolvedInstallRoot 'launch-core.vbs'
if (-not (Test-Path -LiteralPath $launcher)) {
    # Registering a task whose action does not exist produces a silent failure at
    # logon rather than an error now, which is the worst possible time to find out.
    throw "The windowless launcher is missing: $launcher (DESIGN 4.3). Autostart was not registered."
}

$xml = New-AMAutostartTaskXml -InstallRoot $resolvedInstallRoot -LauncherPath $launcher -TaskPath $taskPath
$validation = Test-AMTaskXml -Xml $xml
Write-Host "  xml          : $($validation.Validator) says $(if ($validation.Valid) { 'valid' } else { $validation.Reason })"

if (-not [string]::IsNullOrWhiteSpace($XmlPath)) {
    $directory = Split-Path -Path $XmlPath -Parent
    if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    Write-AMUtf8NoBom -Path $XmlPath -Content $xml
    Add-AMPlanStep -Plan $plan -Action 'write task xml' -Target $XmlPath -Performed $true | Out-Null
}

$existing = Get-AMScheduledTask -TaskName $TaskName
$verb = if ($null -eq $existing) { 'register scheduled task' } else { 'replace scheduled task' }

if ($DryRun) {
    Add-AMPlanStep -Plan $plan -Action $verb -Target $taskPath `
        -Detail "action: wscript.exe `"$launcher`"" -Performed $false | Out-Null
    Write-AMPlan -Plan $plan -DryRun
    return
}

if (-not $validation.Valid) {
    throw "The task XML was rejected by $($validation.Validator): $($validation.Reason)"
}

$parts = Split-AMTaskPath -TaskPath $taskPath
# `-Force` replaces an existing registration in place, which is what makes a
# re-run idempotent instead of an error or a duplicate.
Register-ScheduledTask -Xml $xml -TaskPath $parts.Folder -TaskName $parts.Name -Force | Out-Null
Add-AMPlanStep -Plan $plan -Action $verb -Target $taskPath `
    -Detail "action: wscript.exe `"$launcher`"" -Performed $true | Out-Null

Write-AMPlan -Plan $plan
Write-Host ""
Write-Host "The core will start at your next logon, with no console window."
Write-Host "To start it now without logging off:  Start-ScheduledTask -TaskPath '$($parts.Folder)' -TaskName '$($parts.Name)'"
