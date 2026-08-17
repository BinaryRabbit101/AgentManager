<#
.SYNOPSIS
    Sets up AgentManager for the current Windows user (foundation DESIGN section 4.4).

.DESCRIPTION
    Non-admin and idempotent, in that order of importance. Every step below is
    section 4.4's list, and the script does nothing beyond it:

      1. Verify the Windows and Node prerequisites.
      2. Create the data-root tree (section 1.2) and tighten its ACL to the current
         user - **including creating and ACLing the library directory, and
         nothing further inside it**.
      3. Write the initial `config\config.json` with the chosen edition,
         preserving any keys already there.
      4. Run the DB migration to create the schema.
      5. Register autostart, unless `-NoAutostart` or the work edition.
      6. Create Start-menu and optional desktop shortcuts.
      7. Start the core and wait for `/healthz`.
      8. Print the local URL and next steps.

    **The library's contents are not this script's.** `git init`, `.gitignore`,
    `roster.json` and any seeded agents are the roster element's on first run
    (section 4.4, roster section 2.1), so there is exactly one component that knows the
    library's shape. This script creates the directory and ACLs it; the first
    core start does the rest.

    **Nothing here is PowerShell-only** (D1). Steps 2 and 4 are `agentmanager
    migrate`, step 7 is `agentmanager health --wait`; this script chooses when
    they run, not what they do.

    **Autostart defaults by edition** (section 4.3): on for `home`, because remote
    access while the app is closed is the point, and off for `work`, because a
    work machine should not have a background agent runner starting at logon
    unasked.

.PARAMETER Edition
    `home` or `work` (section 2.2). Prompted for if not supplied.

.PARAMETER DataRoot
    Overrides `%LOCALAPPDATA%\AgentManager`.

.PARAMETER InstallRoot
    The install root. Defaults to the parent of this script's directory, because
    section 1.2 puts `scripts\*.ps1` inside the install root.

.PARAMETER NoAutostart
    Skip the logon task even in the home edition.

.PARAMETER NoStart
    Do not start the core at the end. The install is still complete; the core
    applies element-owned migrations (section 1.3) at its first start.

.PARAMETER NoShortcuts
    Skip the Start-menu shortcut.

.PARAMETER DesktopShortcut
    Also create a desktop shortcut (the "optional" of section 4.4).

.PARAMETER StartMenuRoot
    Overrides the Start-menu Programs directory. For tests.

.PARAMETER DesktopRoot
    Overrides the desktop directory. For tests.

.PARAMETER TaskName
    Overrides the autostart task name, passed through to `Register-Autostart.ps1`.

.PARAMETER StartTimeoutSeconds
    How long to wait for `/healthz` after starting the core. Default 60.

.PARAMETER DryRun
    Change nothing; print the plan.

.PARAMETER PlanPath
    Write the action plan to this file as JSON.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-AgentManager.ps1 -Edition home

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-AgentManager.ps1 -Edition work -NoAutostart
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('home', 'work')]
    [string] $Edition,
    [string] $DataRoot,
    [string] $InstallRoot,
    [switch] $NoAutostart,
    [switch] $NoStart,
    [switch] $NoShortcuts,
    [switch] $DesktopShortcut,
    [string] $StartMenuRoot,
    [string] $DesktopRoot,
    [string] $TaskName,
    [int] $StartTimeoutSeconds = 60,
    [switch] $DryRun,
    [string] $PlanPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AgentManager.Common.ps1')

# --- 0. Resolve the two roots and the edition ------------------------------

$resolvedInstallRoot = Resolve-AMInstallRoot -InstallRoot $InstallRoot -ScriptRoot $PSScriptRoot
if (-not (Test-AMInstallRoot -Path $resolvedInstallRoot)) {
    throw "This is not an AgentManager install root: $resolvedInstallRoot (no config\defaults.json). Pass -InstallRoot."
}

if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Get-AMDefaultDataRoot }
$resolvedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)

if ([string]::IsNullOrWhiteSpace($Edition)) {
    # section 2.2: "the installer prompts if not supplied".
    $answer = Read-Host "Which edition? [home] full app with the remote listener, [work] localhost only"
    if ($answer -eq 'home') { $Edition = 'home' } else { $Edition = 'work' }
    Write-Host "Using the $Edition edition."
}

$plan = New-AMPlan

Write-Host "AgentManager install"
Write-Host "  edition      : $Edition"
Write-Host "  install root : $resolvedInstallRoot"
Write-Host "  data root    : $resolvedDataRoot"
Write-Host ""

# --- 1. Prerequisites ------------------------------------------------------

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "AgentManager installs on Windows only (this host reports $([Environment]::OSVersion.Platform))."
}
$osVersion = [Environment]::OSVersion.Version
if ($osVersion.Major -lt 10) {
    throw "Windows 10 or later is required (this host reports $osVersion)."
}

$node = Resolve-AMNodeExe -InstallRoot $resolvedInstallRoot
if ($null -eq $node) {
    throw "Node.js was not found. Expected a bundled runtime at $resolvedInstallRoot\node\node.exe, or node.exe on PATH."
}
$nodeVersion = Test-AMNodeVersion -NodeExe $node
if (-not $nodeVersion.Satisfied) {
    throw "Node $($nodeVersion.Version) is too old; the core needs v$($nodeVersion.Required) or later ($node)."
}
Add-AMPlanStep -Plan $plan -Action 'verify prerequisites' `
    -Detail "Windows $osVersion, Node $($nodeVersion.Version) at $node" -Performed $true | Out-Null

$entry = Resolve-AMEntryPoint -InstallRoot $resolvedInstallRoot
if ($null -eq $entry) {
    throw "The core bundle is missing under $resolvedInstallRoot (expected dist\main.js or app\main.js). The install is incomplete."
}

# --- 2 & 4. The data-root tree and the schema ------------------------------
#
# One `agentmanager migrate` does both: it is `openStorage`, which bootstraps
# the section 1.2 tree (library directory included, contents excluded) and then applies
# foundation's core migration set behind a pre-migration backup. Re-running it is
# a no-op, which is where this script's idempotence comes from.

if ($DryRun) {
    Add-AMPlanStep -Plan $plan -Action 'create data root tree and apply the core schema' `
        -Target $resolvedDataRoot -Detail 'agentmanager migrate' -Performed $false | Out-Null
}
else {
    $migrate = Invoke-AMCli -InstallRoot $resolvedInstallRoot -DataRoot $resolvedDataRoot `
        -Arguments @('migrate', '--edition', $Edition)
    if ($migrate.ExitCode -ne 0) {
        throw "agentmanager migrate failed (exit $($migrate.ExitCode)):`n$($migrate.StdErr)$($migrate.StdOut)"
    }
    Write-Host $migrate.StdOut.TrimEnd()
    Add-AMPlanStep -Plan $plan -Action 'create data root tree and apply the core schema' `
        -Target $resolvedDataRoot -Detail 'agentmanager migrate' -Performed $true | Out-Null
}

# --- 2b. Tighten the ACLs --------------------------------------------------
#
# The data root first, then the library directory explicitly. section 4.4 singles the
# library out because it is the one directory section 1.2 allows to live *outside* the
# data root (`library.root`), so an ACL applied to the data root need not have
# reached it.

$acl = Grant-AMDirectoryAcl -Path $resolvedDataRoot -DryRun:$DryRun
Add-AMPlanStep -Plan $plan -Action 'tighten ACL to the current user' -Target $resolvedDataRoot `
    -Detail "principal $($acl.Principal); $($acl.Reason)" -Performed $acl.Applied | Out-Null

$libraryRoot = Join-Path $resolvedDataRoot 'library'
$configured = Read-AMConfigJson -DataRoot $resolvedDataRoot
if ($configured.Contains('library') -and $null -ne $configured['library'] -and
    $configured['library'].PSObject.Properties.Name -contains 'root' -and
    -not [string]::IsNullOrWhiteSpace($configured['library'].root)) {
    $libraryRoot = [System.IO.Path]::GetFullPath($configured['library'].root)
}

if (-not $DryRun -and -not (Test-Path -LiteralPath $libraryRoot)) {
    New-Item -ItemType Directory -Path $libraryRoot -Force | Out-Null
}
$libraryAcl = Grant-AMDirectoryAcl -Path $libraryRoot -DryRun:$DryRun
Add-AMPlanStep -Plan $plan -Action 'create and ACL the library directory (contents are the roster''s)' `
    -Target $libraryRoot -Detail $libraryAcl.Reason -Performed $libraryAcl.Applied | Out-Null

# --- 3. config.json --------------------------------------------------------
#
# A merge, not a write: re-running must not clobber a user's edits (section 10's
# idempotence criterion). Only `edition` is this script's to set.

if ($DryRun) {
    Add-AMPlanStep -Plan $plan -Action 'write config.json' `
        -Target (Join-Path $resolvedDataRoot 'config\config.json') `
        -Detail "edition = $Edition (other keys preserved)" -Performed $false | Out-Null
}
else {
    $written = Write-AMConfigJson -DataRoot $resolvedDataRoot -Values @{ edition = $Edition }
    Add-AMPlanStep -Plan $plan -Action 'write config.json' -Target $written.Path `
        -Detail $(if ($written.Changed) { "edition = $Edition" } else { 'already correct; left untouched' }) `
        -Performed $written.Changed | Out-Null
}

# --- 5. Autostart ----------------------------------------------------------

$wantAutostart = ($Edition -eq 'home') -and (-not $NoAutostart)
if (-not $wantAutostart) {
    $why = if ($NoAutostart) { '-NoAutostart was given' } else { 'the work edition does not start a background runner at logon (DESIGN 4.3)' }
    Add-AMPlanStep -Plan $plan -Action 'skip autostart registration' -Detail $why -Performed $false | Out-Null
}
else {
    $registerArgs = @{ InstallRoot = $resolvedInstallRoot }
    if (-not [string]::IsNullOrWhiteSpace($TaskName)) { $registerArgs['TaskName'] = $TaskName }
    if ($DryRun) { $registerArgs['DryRun'] = $true }
    & (Join-Path $PSScriptRoot 'Register-Autostart.ps1') @registerArgs
    Add-AMPlanStep -Plan $plan -Action 'register autostart' -Target (Get-AMTaskPath -TaskName $TaskName) `
        -Performed (-not $DryRun) | Out-Null
}

# --- 6. Shortcuts ----------------------------------------------------------
#
# A shortcut to the *web UI*, not to the core: section 4.1 makes the core a background
# service and the UI a client of it, so the thing a user clicks is a URL.

function New-AMShortcut {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Target,
        [string] $Arguments = '',
        [string] $Description = ''
    )

    $directory = Split-Path -Path $Path -Parent
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = $Target
    $link.Arguments = $Arguments
    $link.Description = $Description
    $link.Save()
}

if ($NoShortcuts) {
    Add-AMPlanStep -Plan $plan -Action 'skip shortcuts' -Detail '-NoShortcuts was given' -Performed $false | Out-Null
}
else {
    if ([string]::IsNullOrWhiteSpace($StartMenuRoot)) {
        $StartMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    }
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $launcher = Join-Path $resolvedInstallRoot 'launch-core.vbs'
    $shortcutPath = Join-Path $StartMenuRoot 'AgentManager\Start AgentManager Core.lnk'

    if ($DryRun) {
        Add-AMPlanStep -Plan $plan -Action 'create Start-menu shortcut' -Target $shortcutPath -Performed $false | Out-Null
    }
    else {
        New-AMShortcut -Path $shortcutPath -Target $wscript -Arguments "`"$launcher`"" `
            -Description 'Start the AgentManager core service (windowless)'
        Add-AMPlanStep -Plan $plan -Action 'create Start-menu shortcut' -Target $shortcutPath -Performed $true | Out-Null
    }

    if ($DesktopShortcut) {
        if ([string]::IsNullOrWhiteSpace($DesktopRoot)) { $DesktopRoot = [Environment]::GetFolderPath('Desktop') }
        $desktopPath = Join-Path $DesktopRoot 'AgentManager.lnk'
        if ($DryRun) {
            Add-AMPlanStep -Plan $plan -Action 'create desktop shortcut' -Target $desktopPath -Performed $false | Out-Null
        }
        else {
            New-AMShortcut -Path $desktopPath -Target $wscript -Arguments "`"$launcher`"" `
                -Description 'Start the AgentManager core service (windowless)'
            Add-AMPlanStep -Plan $plan -Action 'create desktop shortcut' -Target $desktopPath -Performed $true | Out-Null
        }
    }
}

# --- 7. Start the core and wait for /healthz -------------------------------

$url = $null
if ($NoStart -or $DryRun) {
    Add-AMPlanStep -Plan $plan -Action 'start the core' `
        -Detail $(if ($DryRun) { 'dry run' } else { '-NoStart was given' }) -Performed $false | Out-Null
}
else {
    $launcher = Join-Path $resolvedInstallRoot 'launch-core.vbs'
    if (Test-Path -LiteralPath $launcher) {
        # The same windowless path the scheduled task uses, so what the installer
        # starts and what logon starts are one mechanism.
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') `
            -ArgumentList "`"$launcher`"" -WindowStyle Hidden | Out-Null
    }
    else {
        Start-Process -FilePath $node -ArgumentList (ConvertTo-AMCommandLine -Arguments @($entry, '--data-root', $resolvedDataRoot)) `
            -WindowStyle Hidden | Out-Null
    }

    $wait = Invoke-AMCli -InstallRoot $resolvedInstallRoot -DataRoot $resolvedDataRoot `
        -Arguments @('health', '--json', '--wait', "$StartTimeoutSeconds")
    if ($wait.ExitCode -ne 0) {
        Write-Warning "The core did not answer /healthz within $StartTimeoutSeconds s. Run Test-AgentManagerHealth.ps1 for details."
        Add-AMPlanStep -Plan $plan -Action 'start the core' -Detail 'started, but /healthz did not answer in time' -Performed $true | Out-Null
    }
    else {
        try {
            $report = $wait.StdOut | ConvertFrom-Json
            $url = $report.core.url
        }
        catch {
            $url = $null
        }
        Add-AMPlanStep -Plan $plan -Action 'start the core' -Detail "answering at $url" -Performed $true | Out-Null
    }
}

# --- 8. Report -------------------------------------------------------------

Write-Host ""
Write-AMPlan -Plan $plan -PlanPath $PlanPath -DryRun:$DryRun

if ($DryRun) { return }

Write-Host ""
Write-Host "AgentManager is installed."
if ($null -ne $url) {
    Write-Host "  Open       : $url"
}
else {
    Write-Host "  Open       : http://127.0.0.1:<port> - the port is published in $resolvedDataRoot\run\core.port"
}
Write-Host "  Next steps :"
Write-Host "    1. Sign in to Claude:   powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\Setup-Auth.ps1`""
Write-Host "    2. Check the install:   powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\Test-AgentManagerHealth.ps1`""
if ($Edition -eq 'work') {
    Write-Host "    (work edition: no remote listener, localhost only, and no logon task.)"
}
