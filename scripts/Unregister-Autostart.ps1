<#
.SYNOPSIS
    Removes the AgentManager logon task (foundation DESIGN section 4.3, section 4.4).

.DESCRIPTION
    The other half of `Register-Autostart.ps1`, split out so autostart can be
    toggled without reinstalling. Removing the task does **not** stop a running
    core - section 4.1 makes the core an independent process that nothing else owns -
    so this script says so rather than leaving the operator to wonder.

    Idempotent, in the way that matters for an uninstaller: a task that is not
    registered is a success, not an error.

.PARAMETER TaskName
    Overrides the task name inside `\AgentManager\`. Defaults to section 4.3's name.

.PARAMETER DryRun
    Report what would be removed and change nothing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Unregister-Autostart.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $TaskName,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AgentManager.Common.ps1')

$taskPath = Get-AMTaskPath -TaskName $TaskName
$plan = New-AMPlan

$existing = Get-AMScheduledTask -TaskName $TaskName
if ($null -eq $existing) {
    Add-AMPlanStep -Plan $plan -Action 'unregister scheduled task' -Target $taskPath `
        -Detail 'not registered; nothing to do' -Performed $false | Out-Null
    Write-AMPlan -Plan $plan -DryRun:$DryRun
    return
}

if ($DryRun) {
    Add-AMPlanStep -Plan $plan -Action 'unregister scheduled task' -Target $taskPath `
        -Detail "state: $($existing.State)" -Performed $false | Out-Null
    Write-AMPlan -Plan $plan -DryRun
    return
}

$parts = Split-AMTaskPath -TaskPath $taskPath
Unregister-ScheduledTask -TaskPath $parts.Folder -TaskName $parts.Name -Confirm:$false | Out-Null
Add-AMPlanStep -Plan $plan -Action 'unregister scheduled task' -Target $taskPath -Performed $true | Out-Null

Write-AMPlan -Plan $plan
Write-Host ""
Write-Host "The core will no longer start at logon. A core that is running now keeps running"
Write-Host "(it is an independent process, DESIGN 4.1); stop it from the tray or with"
Write-Host "  Invoke-RestMethod -Method Post http://127.0.0.1:<port>/api/service/shutdown"
