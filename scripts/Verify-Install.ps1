<#
.SYNOPSIS
    The foundation M10 acceptance criteria that no test can run, as a checklist.

.DESCRIPTION
    Three of foundation IMPLEMENTATION section 10's criteria are not automatable in a
    repository, and pretending otherwise would be worse than saying so:

      * "A clean non-admin install **on a fresh Windows 11 user account**
        completes end to end" - needs an account that does not exist yet.
      * "**Log off and back on**: the scheduled task starts the core with no
        visible console window, and `/healthz` answers before the desktop app is
        opened" - needs a logon session transition, which a process inside the
        session cannot cause.
      * "`Setup-Auth.ps1` stores a **working** token" - "working" means a real
        SDK round trip against the owner's plan, which costs quota and needs a
        browser sign-in.

    Everything else in section 10 is covered by `src/cli/cli.test.ts` and
    `src/cli/scripts.test.ts`, and each item below names the test that covers its
    automatable half, so the split is explicit rather than a silent omission.

    This script prints the checklist and, where it can, runs the *local* half of
    each check so the manual step is as short as possible.

.PARAMETER InstallRoot
    The install root. Defaults to the parent of this script's directory.

.PARAMETER DataRoot
    Overrides `%LOCALAPPDATA%\AgentManager`.

.PARAMETER TaskName
    Overrides the autostart task name.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Verify-Install.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $InstallRoot,
    [string] $DataRoot,
    [string] $TaskName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AgentManager.Common.ps1')

$resolvedInstallRoot = Resolve-AMInstallRoot -InstallRoot $InstallRoot -ScriptRoot $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Get-AMDefaultDataRoot }
$resolvedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)

$checks = @(
    [pscustomobject]@{
        Id        = 'M10-fresh-account-install'
        Criterion = 'A clean non-admin install on a fresh Windows 11 user account completes end to end: data root created and ACL''d, config written with the chosen edition, schema migrated, autostart registered (home) or skipped (work), core reachable at the printed URL.'
        Why       = 'Needs a Windows account that does not exist yet, and a profile with no %LOCALAPPDATA%\AgentManager.'
        Automated = 'src/cli/scripts.test.ts - "Install-AgentManager.ps1" runs the real script against a temp data root and asserts the tree, the ACL, config.json''s edition, the migrated schema and the skipped/registered autostart decision. src/cli/cli.test.ts covers the migrate verb underneath it.'
        Steps     = @(
            'Create a standard (non-administrator) local user in Settings > Accounts > Other users.',
            'Sign in as that user. Copy the install root there, or run the installer from a shared folder.',
            'powershell -ExecutionPolicy Bypass -File .\Install-AgentManager.ps1 -Edition home',
            'Confirm no UAC prompt appeared at any point.',
            'Confirm the printed URL opens the app in a browser.',
            'Run Test-AgentManagerHealth.ps1 and confirm edition, data root, task state and quick_check all read as expected.'
        )
    },
    [pscustomobject]@{
        Id        = 'M10-logon-no-console'
        Criterion = 'Log off and back on: the scheduled task starts the core with no visible console window, and /healthz answers before the desktop app is opened.'
        Why       = 'A logon transition cannot be caused from inside the session, and "no visible window" is a claim about what a person sees.'
        Automated = 'src/cli/scripts.test.ts - "launch-core.vbs" asserts the launcher runs node with window style 0 and does not wait, and "Register-Autostart.ps1" asserts the task action is wscript.exe running that launcher rather than node.exe directly. Those two facts are what make the window invisible; seeing that it is invisible is this check.'
        Steps     = @(
            'Register autostart (home edition does this at install; otherwise run Register-Autostart.ps1).',
            'Sign out of Windows completely - not lock, sign out.',
            'Sign back in and watch the screen during the first few seconds: no console window must flash, not even briefly.',
            'Without opening the desktop app, run: Invoke-RestMethod http://127.0.0.1:7477/healthz',
            'It must answer {status:"ok",...}. If the port differs, read it from <dataRoot>\run\core.port.',
            'Open Task Scheduler > \AgentManager > AgentManager Core and confirm Last Run Result is 0x0.',
            'Reboot and repeat once: the trigger is At Log On, so a cold boot is the case that matters.'
        )
    },
    [pscustomobject]@{
        Id        = 'M10-setup-auth-working-token'
        Criterion = 'Setup-Auth.ps1 stores a WORKING token, with the value never appearing in the console, the PowerShell history, the process command line, or any log file.'
        Why       = 'Proving the token works needs a real SDK round trip against the owner''s Claude plan: a browser sign-in and real quota.'
        Automated = 'src/cli/scripts.test.ts - "Setup-Auth.ps1" drives the real Send-AMSecretFromSecureString against a temp data root and asserts the value reaches the store while appearing in neither the child command line, nor stdout/stderr, nor any log file; src/cli/cli.test.ts asserts the CLI refuses a value passed as an argument at all. The four channels are covered; "working" is not.'
        Steps     = @(
            'powershell -ExecutionPolicy Bypass -File .\Setup-Auth.ps1',
            'Complete the browser sign-in that "claude setup-token" opens, and paste the token at the prompt.',
            'Watch the prompt as you paste: no characters must appear.',
            'Immediately afterwards, press the up arrow a few times and inspect (Get-PSReadLineOption).HistorySavePath - the token must not be in that file.',
            'While it is running, from a second window: Get-CimInstance Win32_Process -Filter "name=''node.exe''" | Select CommandLine - the token must not be there. (The window is short; run the command in a loop if you want to catch it.)',
            'Select-String -Path <dataRoot>\state\logs\*.log -SimpleMatch ''<first 8 characters of the token>'' must return nothing.',
            'Finally, the part only you can do: start any agent from the UI and confirm it answers. That is the SDK round trip.'
        )
    }
)

Write-Host "AgentManager - manual verification checklist (foundation IMPLEMENTATION M10)"
Write-Host "install root : $resolvedInstallRoot"
Write-Host "data root    : $resolvedDataRoot"
Write-Host ""
Write-Host "Everything else in M10 is covered by the automated suite; run it with: npm test"
Write-Host ""

# --- The local half, run for you where it can be -------------------------

Write-Host "== Local facts (checked now, so the manual steps are shorter)"

$launcher = Join-Path $resolvedInstallRoot 'launch-core.vbs'
Write-Host "  launch-core.vbs present : $(Test-Path -LiteralPath $launcher)"

$task = Get-AMScheduledTask -TaskName $TaskName
if ($null -eq $task) {
    Write-Host "  autostart task          : not registered"
}
else {
    $actions = @($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" })
    Write-Host "  autostart task          : $($task.State)"
    Write-Host "  action                  : $($actions -join '; ')"
    $viaWscript = @($task.Actions | Where-Object { $_.Execute -match 'wscript\.exe$' }).Count -gt 0
    Write-Host "  windowless (wscript)    : $viaWscript   <- if this is False, a console WILL flash at logon"
}

$record = Get-AMPortRecord -DataRoot $resolvedDataRoot
if ($null -eq $record) {
    Write-Host "  core.port               : absent (the core is not running)"
}
else {
    Write-Host "  core.port               : port $($record.port), pid $($record.pid), started $($record.startedAt)"
}

$logs = Join-Path $resolvedDataRoot 'state\logs'
if (Test-Path -LiteralPath $logs) {
    Write-Host "  log files               : $(@(Get-ChildItem -LiteralPath $logs -Filter '*.log' -ErrorAction SilentlyContinue).Count)"
}

# --- The checklist --------------------------------------------------------

foreach ($check in $checks) {
    Write-Host ""
    Write-Host "== $($check.Id)"
    Write-Host "  criterion : $($check.Criterion)"
    Write-Host "  why manual: $($check.Why)"
    Write-Host "  automated : $($check.Automated)"
    Write-Host "  steps:"
    $index = 1
    foreach ($step in $check.Steps) {
        Write-Host ("    {0}. {1}" -f $index, $step)
        $index += 1
    }
}

Write-Host ""
Write-Host "Three checks. None of them can be automated in this repository; all three have"
Write-Host "an automated half named above, so what is left is only the part that needs a human."
