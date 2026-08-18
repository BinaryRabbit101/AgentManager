<#
.SYNOPSIS
    Replaces an installed AgentManager with the contents of a newer transfer
    archive.

.DESCRIPTION
    The counterpart to `Install-AgentManager.ps1`: that script sets an install
    up, this one moves it to a newer build. It is the procedure in the transfer
    archive's `SETUP-WORK-EDITION.md` section 7, as a script, because the steps
    have an order that matters and two of them are easy to get wrong by hand.

    What it does, in order:

      1. Resolves the source (an unpacked archive folder, or the `.zip` itself -
         a zip is expanded to a temporary folder and cleaned up afterwards) and
         checks it really is an AgentManager tree with build output in it.
      2. Compares `package-lock.json` and `migrations\` between the two trees,
         and reports whether `npm ci` is needed and whether the next boot will
         apply a schema change. Neither is guessed at the end; both are known
         before anything is touched.
      3. Stops the running core through `POST /api/service/shutdown`. This is
         first because Windows will not overwrite a file a live process holds
         open, and because a core that survives the copy carries on serving the
         old `dist\main.js` whatever is now on disk.
      4. Mirrors the source over the install root with robocopy, **excluding
         `node_modules`, `.git` and `.env`**.
      5. Starts the core again through `launch-core.vbs` - the same windowless
         path the installer and the logon task use - and waits for `/healthz`.

    **`node_modules` is the reason a mirror is safe here.** It is deliberately
    not in the archive, so a purge without that exclusion would delete the
    dependencies and leave an install that cannot start; `/XD node_modules` is
    what makes the difference between a mirror and a wipe. `.git` is excluded
    for the same reason - an archive has none, so mirroring into a checkout
    would otherwise delete its history - and `.env` because the archive never
    carries one and there is no reason to remove a file the service does not
    read anyway.

    **Nothing under the data root is touched.** The database, logs, library,
    secrets and `config.json` live in `%LOCALAPPDATA%\AgentManager`, outside
    everything this script writes to. The edition you installed with survives,
    because the machine `config.json` outranks the shipped
    `config\defaults.json` that the archive does replace.

    **The installer is not re-run, and does not need to be.** It registered the
    install *root* - a path - rather than the files inside it, so replacing the
    contents leaves the Start Menu shortcut, the data root and the edition all
    still pointing at the right place.

.PARAMETER Source
    The new build: either the folder an archive was unpacked into, or the
    archive `.zip` itself.

.PARAMETER InstallRoot
    The install being updated. Defaults to the parent of this script's
    directory, which is correct when you run the *installed* copy of this
    script. Running the copy inside the new archive instead is also fine - then
    this parameter is required, and the script says so rather than mirroring a
    folder over itself.

.PARAMETER DataRoot
    Overrides the data root used to find `run\core.port` and to start the core.

.PARAMETER KeepExtras
    Copy without deleting: files that exist only in the install root are left
    alone. Slightly safer, and it leaves behind whatever the new build dropped -
    stale hashed web assets, and source files deleted upstream that
    `npm run typecheck:web` will still compile.

.PARAMETER NoStart
    Do not start the core afterwards. The update is still complete.

.PARAMETER StartTimeoutSeconds
    How long to wait for `/healthz` after starting. Default 60.

.PARAMETER DryRun
    Change nothing; print the plan. The file comparison runs for real and
    robocopy runs in list-only mode, so the dry run describes the real one.

.PARAMETER PlanPath
    Write the action log to this file as JSON.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\Update-AgentManager.ps1 -Source C:\Users\me\Downloads\AgentManager-work-edition-2026-08-18.zip

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\Update-AgentManager.ps1 -Source ..\AgentManager-new -DryRun
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Source,
    [string] $InstallRoot,
    [string] $DataRoot,
    [switch] $KeepExtras,
    [switch] $NoStart,
    [int] $StartTimeoutSeconds = 60,
    [switch] $DryRun,
    [string] $PlanPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AgentManager.Common.ps1')

function Get-AMHashOrNull {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-AMFileNames {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @(Get-ChildItem -LiteralPath $Path -File -Recurse | ForEach-Object { $_.Name })
}

$resolvedInstallRoot = Resolve-AMInstallRoot -InstallRoot $InstallRoot -ScriptRoot $PSScriptRoot
if (-not (Test-AMInstallRoot -Path $resolvedInstallRoot)) {
    throw "This is not an AgentManager install root: $resolvedInstallRoot (no config\defaults.json). Pass -InstallRoot."
}
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Get-AMDefaultDataRoot }
$resolvedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)

# --- 1. Resolve the source -------------------------------------------------

$temporarySource = $null
$resolvedSource = [System.IO.Path]::GetFullPath($Source)
if (-not (Test-Path -LiteralPath $resolvedSource)) { throw "No such source: $resolvedSource" }

if (Test-Path -LiteralPath $resolvedSource -PathType Leaf) {
    if ([System.IO.Path]::GetExtension($resolvedSource) -ne '.zip') {
        throw "-Source must be a folder or a .zip archive, not $resolvedSource"
    }
    $temporarySource = Join-Path ([System.IO.Path]::GetTempPath()) ('agentmanager-update-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
    New-Item -ItemType Directory -Path $temporarySource | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($resolvedSource, $temporarySource)
    $resolvedSource = $temporarySource
}

try {
    if (-not (Test-AMInstallRoot -Path $resolvedSource)) {
        throw "The source is not an AgentManager tree: $resolvedSource (no config\defaults.json)."
    }
    if ($resolvedSource.TrimEnd('\') -ieq $resolvedInstallRoot.TrimEnd('\')) {
        throw ('The source and the install root are the same folder: ' + $resolvedInstallRoot +
            '. If you are running this script from inside the new archive, pass -InstallRoot pointing at the existing install.')
    }

    # Build output is not tracked, so a source assembled by hand can be missing
    # it. Mirroring that over a working install would leave nothing to start.
    foreach ($required in @('dist\main.js', 'app\web\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $resolvedSource $required))) {
            throw "The source has no $required - it carries no build output, so it cannot replace a working install."
        }
    }

    $plan = New-AMPlan
    $mode = if ($KeepExtras) { 'copy (extras kept)' } else { 'mirror (extras removed)' }

    Write-Host 'AgentManager update'
    Write-Host "  install root : $resolvedInstallRoot"
    Write-Host "  data root    : $resolvedDataRoot  (not touched)"
    Write-Host "  source       : $resolvedSource"
    Write-Host "  mode         : $mode"
    Write-Host ''

    # --- 2. What this update will and will not require ---------------------

    $lockChanged = (Get-AMHashOrNull -Path (Join-Path $resolvedSource 'package-lock.json')) -ne
                   (Get-AMHashOrNull -Path (Join-Path $resolvedInstallRoot 'package-lock.json'))

    $installedMigrations = Get-AMFileNames -Path (Join-Path $resolvedInstallRoot 'migrations')
    $sourceMigrations = Get-AMFileNames -Path (Join-Path $resolvedSource 'migrations')
    $newMigrations = @($sourceMigrations | Where-Object { $installedMigrations -notcontains $_ })

    if ($lockChanged) {
        Write-Host "  package-lock.json differs - run 'npm ci' after this finishes."
    }
    else {
        Write-Host '  package-lock.json unchanged - the existing node_modules is still correct.'
    }
    if ($newMigrations.Count -gt 0) {
        Write-Host "  $($newMigrations.Count) new migration file(s) - the core applies them at its next start."
    }
    else {
        Write-Host '  no new migrations.'
    }
    Write-Host ''

    $lockDetail = if ($lockChanged) { 'changed - npm ci needed' } else { 'unchanged' }
    Add-AMPlanStep -Plan $plan -Action 'compare package-lock.json' -Detail $lockDetail -Performed $true | Out-Null
    Add-AMPlanStep -Plan $plan -Action 'compare migrations' -Detail "$($newMigrations.Count) new" -Performed $true | Out-Null

    # --- 3. Stop the core --------------------------------------------------

    if ($DryRun) {
        Add-AMPlanStep -Plan $plan -Action 'stop the core' -Target $resolvedDataRoot `
            -Detail 'POST /api/service/shutdown' -Performed $false | Out-Null
    }
    else {
        $stopped = Stop-AMCore -DataRoot $resolvedDataRoot
        Add-AMPlanStep -Plan $plan -Action 'stop the core' -Target $resolvedDataRoot `
            -Detail $stopped.Reason -Performed $stopped.Stopped | Out-Null
    }

    # --- 4. Replace the tree -----------------------------------------------
    #
    # /XD node_modules is not a nicety: the archive does not carry it, so a
    # purge without that exclusion deletes the dependencies and leaves an
    # install that cannot start. .git is excluded so mirroring into a checkout
    # cannot delete its history, and .env because the archive never has one.

    $robocopyArgs = @($resolvedSource, $resolvedInstallRoot, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:2')
    if (-not $KeepExtras) { $robocopyArgs += '/PURGE' }
    $robocopyArgs += @('/XD', 'node_modules', '.git', '/XF', '.env')
    if ($DryRun) { $robocopyArgs += '/L' }

    & robocopy @robocopyArgs | Out-Null
    $robocopyExit = $LASTEXITCODE

    # Robocopy reports what it did as a bit field: 0-7 are all success (1 copied,
    # 2 extras present, 4 mismatched), 8 and above are failures. Treating any
    # non-zero code as an error is the classic way to break a working script.
    if ($robocopyExit -ge 8) {
        throw "robocopy failed with exit code $robocopyExit. The install root may be half-updated; re-run this script once the cause is fixed."
    }

    $copyAction = if ($KeepExtras) { 'copy the new tree' } else { 'mirror the new tree' }
    Add-AMPlanStep -Plan $plan -Action $copyAction -Target $resolvedInstallRoot `
        -Detail "robocopy exit $robocopyExit; kept node_modules, .git, .env" -Performed (-not $DryRun) | Out-Null

    # --- 5. Start it again -------------------------------------------------

    $url = $null
    if ($NoStart -or $DryRun) {
        $skipReason = if ($DryRun) { 'dry run' } else { '-NoStart was given' }
        Add-AMPlanStep -Plan $plan -Action 'start the core' -Detail $skipReason -Performed $false | Out-Null
    }
    else {
        $launcher = Join-Path $resolvedInstallRoot 'launch-core.vbs'
        if (-not (Test-Path -LiteralPath $launcher)) { throw "Missing $launcher - cannot start the core." }
        $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
        Start-Process -FilePath $wscript -ArgumentList (ConvertTo-AMCommandLine -Arguments @($launcher)) -WindowStyle Hidden | Out-Null

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
            Add-AMPlanStep -Plan $plan -Action 'start the core' -Detail 'answered /healthz' -Performed $true | Out-Null
        }
    }

    Write-Host ''
    Write-AMPlan -Plan $plan -PlanPath $PlanPath -DryRun:$DryRun
    Write-Host ''

    if ($DryRun) {
        Write-Host 'Dry run - nothing was changed.'
    }
    else {
        Write-Host 'Update complete.'
        if ($lockChanged) {
            Write-Host "  NEXT: run 'npm ci' in $resolvedInstallRoot (package-lock.json changed), then restart the core."
        }
        if (-not [string]::IsNullOrWhiteSpace($url)) { Write-Host "  Core: $url" }
        Write-Host '  Verify: powershell -ExecutionPolicy Bypass -File .\scripts\Test-AgentManagerHealth.ps1'
    }
}
finally {
    if ($null -ne $temporarySource -and (Test-Path -LiteralPath $temporarySource)) {
        Remove-Item -LiteralPath $temporarySource -Recurse -Force -ErrorAction SilentlyContinue
    }
}
