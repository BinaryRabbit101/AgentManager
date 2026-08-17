<#
.SYNOPSIS
    Removes AgentManager's program files and logon task (foundation DESIGN section 4.4).

.DESCRIPTION
    section 4.4: "Stop the core, unregister the task, remove shortcuts and install root.
    Keeps the data root unless `-RemoveData` is given explicitly, and refuses to
    delete a library root that lives outside the data root."

    That last clause is the one worth spelling out. section 1.2 allows the library to be
    relocated - "e.g. `%USERPROFILE%\Documents\AgentManager-Library`" - and
    `git init`'d by the user. A relocated library is authored content that has
    nothing to do with this install's data root, and an uninstaller is the last
    program that should be recursively deleting a directory the user chose and
    put under version control. So `-RemoveData` removes the data root and stops
    there; a library outside it is reported and left alone, with its path
    printed so the owner can decide.

    Idempotent: an absent task, an absent core and an absent install root are all
    successes.

.PARAMETER InstallRoot
    The install root to remove. Defaults to the parent of this script's
    directory.

.PARAMETER DataRoot
    Overrides `%LOCALAPPDATA%\AgentManager`. Not removed unless `-RemoveData`.

.PARAMETER RemoveData
    Also delete the data root - the database, transcripts, logs and secrets.

.PARAMETER TaskName
    Overrides the autostart task name. Defaults to section 4.3's name.

.PARAMETER StartMenuRoot
    Overrides the Start-menu Programs directory. For tests.

.PARAMETER DesktopRoot
    Overrides the desktop directory. For tests.

.PARAMETER DryRun
    Report what would be removed and change nothing.

.PARAMETER PlanPath
    Write the action plan to this file as JSON.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Uninstall-AgentManager.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Uninstall-AgentManager.ps1 -RemoveData
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $InstallRoot,
    [string] $DataRoot,
    [switch] $RemoveData,
    [string] $TaskName,
    [string] $StartMenuRoot,
    [string] $DesktopRoot,
    [switch] $DryRun,
    [string] $PlanPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AgentManager.Common.ps1')

$resolvedInstallRoot = Resolve-AMInstallRoot -InstallRoot $InstallRoot -ScriptRoot $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Get-AMDefaultDataRoot }
$resolvedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)

$plan = New-AMPlan

Write-Host "AgentManager uninstall"
Write-Host "  install root : $resolvedInstallRoot"
Write-Host "  data root    : $resolvedDataRoot  (kept$(if ($RemoveData) { ' - no, -RemoveData was given' } else { '' }))"
Write-Host ""

# --- 1. Stop the core ------------------------------------------------------

if ($DryRun) {
    Add-AMPlanStep -Plan $plan -Action 'stop the core' -Target $resolvedDataRoot `
        -Detail 'POST /api/service/shutdown' -Performed $false | Out-Null
}
else {
    $stopped = Stop-AMCore -DataRoot $resolvedDataRoot
    Add-AMPlanStep -Plan $plan -Action 'stop the core' -Target $resolvedDataRoot `
        -Detail $stopped.Reason -Performed $stopped.Stopped | Out-Null
}

# --- 2. Unregister the task ------------------------------------------------

$taskPath = Get-AMTaskPath -TaskName $TaskName
$task = Get-AMScheduledTask -TaskName $TaskName
if ($null -eq $task) {
    Add-AMPlanStep -Plan $plan -Action 'unregister scheduled task' -Target $taskPath `
        -Detail 'not registered' -Performed $false | Out-Null
}
elseif ($DryRun) {
    Add-AMPlanStep -Plan $plan -Action 'unregister scheduled task' -Target $taskPath -Performed $false | Out-Null
}
else {
    $parts = Split-AMTaskPath -TaskPath $taskPath
    Unregister-ScheduledTask -TaskPath $parts.Folder -TaskName $parts.Name -Confirm:$false | Out-Null
    Add-AMPlanStep -Plan $plan -Action 'unregister scheduled task' -Target $taskPath -Performed $true | Out-Null
}

# --- 3. Shortcuts ----------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($StartMenuRoot)) {
    $StartMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
}
if ([string]::IsNullOrWhiteSpace($DesktopRoot)) { $DesktopRoot = [Environment]::GetFolderPath('Desktop') }

$shortcutTargets = @(
    (Join-Path $StartMenuRoot 'AgentManager'),
    (Join-Path $DesktopRoot 'AgentManager.lnk')
)
foreach ($target in $shortcutTargets) {
    if (-not (Test-Path -LiteralPath $target)) {
        Add-AMPlanStep -Plan $plan -Action 'remove shortcut' -Target $target -Detail 'absent' -Performed $false | Out-Null
        continue
    }
    if ($DryRun) {
        Add-AMPlanStep -Plan $plan -Action 'remove shortcut' -Target $target -Performed $false | Out-Null
        continue
    }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    Add-AMPlanStep -Plan $plan -Action 'remove shortcut' -Target $target -Performed $true | Out-Null
}

# --- 4. The library-root guard --------------------------------------------
#
# Read before anything is deleted, because it decides what -RemoveData is
# allowed to touch.

$libraryRoot = Join-Path $resolvedDataRoot 'library'
$libraryRelocated = $false
$configured = Read-AMConfigJson -DataRoot $resolvedDataRoot
if ($configured.Contains('library') -and $null -ne $configured['library'] -and
    $configured['library'].PSObject.Properties.Name -contains 'root' -and
    -not [string]::IsNullOrWhiteSpace($configured['library'].root)) {
    $libraryRoot = [System.IO.Path]::GetFullPath($configured['library'].root)
}

$dataRootPrefix = $resolvedDataRoot.TrimEnd('\') + '\'
$libraryRelocated = -not $libraryRoot.TrimEnd('\').StartsWith($dataRootPrefix.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)

# --- 5. The install root ---------------------------------------------------
#
# Removed last, because this script lives inside it. PowerShell has the file
# open, so a delete of the running script's own directory can fail on the
# script itself; the removal is reported honestly either way.

if (-not (Test-Path -LiteralPath $resolvedInstallRoot)) {
    Add-AMPlanStep -Plan $plan -Action 'remove install root' -Target $resolvedInstallRoot `
        -Detail 'absent' -Performed $false | Out-Null
}
elseif ($DryRun) {
    Add-AMPlanStep -Plan $plan -Action 'remove install root' -Target $resolvedInstallRoot -Performed $false | Out-Null
}
else {
    try {
        Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force -ErrorAction Stop
        Add-AMPlanStep -Plan $plan -Action 'remove install root' -Target $resolvedInstallRoot -Performed $true | Out-Null
    }
    catch {
        Add-AMPlanStep -Plan $plan -Action 'remove install root' -Target $resolvedInstallRoot `
            -Detail "partially removed: $($_.Exception.Message). Delete the folder after this window closes." -Performed $false | Out-Null
    }
}

# --- 6. The data root, only when asked ------------------------------------

if (-not $RemoveData) {
    Add-AMPlanStep -Plan $plan -Action 'keep the data root' -Target $resolvedDataRoot `
        -Detail 'pass -RemoveData to delete the database, transcripts, logs and secrets' -Performed $false | Out-Null
}
elseif ($libraryRelocated) {
    # The refusal section 4.4 requires. Not a warning after the fact: the whole
    # -RemoveData step is declined, because the data root cannot be removed
    # without an answer about the library that only the owner can give.
    Add-AMPlanStep -Plan $plan -Action 'REFUSE to remove the data root' -Target $resolvedDataRoot `
        -Detail "library.root is $libraryRoot, outside the data root. Authored content is not an uninstaller's to delete." `
        -Performed $false | Out-Null
    Write-Warning ("The library root is $libraryRoot, which is outside the data root. " +
        "It holds your authored agents and may be a git repository, so nothing was deleted. " +
        "Move or back up the library, then re-run with -RemoveData, or delete $resolvedDataRoot by hand.")
}
elseif (-not (Test-Path -LiteralPath $resolvedDataRoot)) {
    Add-AMPlanStep -Plan $plan -Action 'remove the data root' -Target $resolvedDataRoot `
        -Detail 'absent' -Performed $false | Out-Null
}
elseif ($DryRun) {
    Add-AMPlanStep -Plan $plan -Action 'remove the data root' -Target $resolvedDataRoot `
        -Detail "library is inside it ($libraryRoot)" -Performed $false | Out-Null
}
else {
    Remove-Item -LiteralPath $resolvedDataRoot -Recurse -Force
    Add-AMPlanStep -Plan $plan -Action 'remove the data root' -Target $resolvedDataRoot -Performed $true | Out-Null
}

Write-Host ""
Write-AMPlan -Plan $plan -PlanPath $PlanPath -DryRun:$DryRun

if ($DryRun) { return }

Write-Host ""
if (-not $RemoveData) {
    Write-Host "The data root was kept: $resolvedDataRoot"
    Write-Host "  Your roster is at $libraryRoot; history, logs and secrets are under state\."
    Write-Host "  Re-installing over it picks everything up again."
}
elseif ($libraryRelocated) {
    Write-Host "Nothing under the data root was deleted. See the warning above."
}
else {
    Write-Host "The data root was removed. Nothing of this install remains."
}
