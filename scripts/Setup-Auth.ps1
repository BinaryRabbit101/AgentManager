<#
.SYNOPSIS
    Stores the Claude subscription token for the core (foundation DESIGN section 4.4, section 3.3).

.DESCRIPTION
    section 4.4, in full: "Run `claude setup-token` interactively, read the resulting
    token **from the console into a SecureString** (never echoed, never a
    parameter), pipe it over stdin to `agentmanager secrets set
    claude.oauthToken --stdin`, verify with a trivial SDK round-trip, and report
    success without printing the token. Also warns if `ANTHROPIC_API_KEY` is set
    in the user or machine environment."

    The token exists in four places it must not: the console, the PowerShell
    history, the process command line, and a log file. Each is closed here, and
    the closure is a property of the mechanism rather than of care taken:

    * **Console** - `Read-Host -AsSecureString` echoes nothing, and nothing
      downstream writes the value or any fragment of it. The CLI's confirmation
      deliberately omits even the four-character preview `secrets list` is
      allowed to show.
    * **History** - the value never appears in a command. It is typed at a
      prompt, not as an argument, so PSReadLine has nothing to persist. No
      caller here interpolates it into a command string, and there is no
      `Invoke-Expression` anywhere in this file.
    * **Command line** - the child process is started with the argument list
      `secrets set claude.oauthToken --stdin` and the value written to its
      redirected stdin. Task Manager, `Get-CimInstance Win32_Process` and ETW
      process-start records therefore see the key name and nothing else. See
      `Send-AMSecretFromSecureString` in AgentManager.Common.ps1 for the BSTR
      lifetime.
    * **Log file** - the CLI attaches no logger for this verb, so nothing is
      written to `core.log` for section 5.4's redactor to have to catch; the redactor
      remains the backstop, not the first line of defence.

.PARAMETER InstallRoot
    The install root. Defaults to the parent of this script's directory.

.PARAMETER DataRoot
    Overrides `%LOCALAPPDATA%\AgentManager`.

.PARAMETER Key
    The secret key to store under. Defaults to section 3.3's `claude.oauthToken`.

.PARAMETER SkipTokenCommand
    Do not run `claude setup-token`; just prompt for a token you already have.

.PARAMETER DryRun
    Prompt for nothing and store nothing. Report the prerequisites, the warning
    checks and the exact command line the token would be handed to - which is
    the thing worth reviewing, since the token is not in it.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Setup-Auth.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $InstallRoot,
    [string] $DataRoot,
    [string] $Key = 'claude.oauthToken',
    [switch] $SkipTokenCommand,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AgentManager.Common.ps1')

$resolvedInstallRoot = Resolve-AMInstallRoot -InstallRoot $InstallRoot -ScriptRoot $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Get-AMDefaultDataRoot }
$resolvedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)

Write-Host "AgentManager authentication setup"
Write-Host "  install root : $resolvedInstallRoot"
Write-Host "  data root    : $resolvedDataRoot"
Write-Host "  secret key   : $Key"
Write-Host ""

# --- The ANTHROPIC_API_KEY warning (architecture D2, DESIGN section 3.5) ----------
#
# A key present in the *user* or *machine* environment silently overrides
# subscription auth for every process started afterwards, including the
# scheduled task's core - which is why the persisted scopes are checked and not
# just this session's.

$scopes = @(
    [pscustomobject]@{ Name = 'process'; Value = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'Process') }
    [pscustomobject]@{ Name = 'user';    Value = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User') }
    [pscustomobject]@{ Name = 'machine'; Value = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'Machine') }
)
$setIn = @($scopes | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Value) } | ForEach-Object { $_.Name })
if ($setIn.Count -gt 0) {
    Write-Warning ("ANTHROPIC_API_KEY is set in the $($setIn -join ', ') environment. It silently " +
        "overrides subscription auth (architecture D2), so the token you are about to store will be ignored " +
        "while it is there. Remove it, or set auth.mode explicitly in config.json.")
}
else {
    Write-Host "  ANTHROPIC_API_KEY is not set in the process, user or machine environment. Good."
}

# --- Prerequisites ---------------------------------------------------------

$node = Resolve-AMNodeExe -InstallRoot $resolvedInstallRoot
if ($null -eq $node) { throw "Node.js was not found. Looked for $resolvedInstallRoot\node\node.exe and node.exe on PATH." }
$entry = Resolve-AMEntryPoint -InstallRoot $resolvedInstallRoot
if ($null -eq $entry) { throw "The core bundle was not found under $resolvedInstallRoot (expected dist\main.js or app\main.js)." }

if ($DryRun) {
    $wouldRun = ConvertTo-AMCommandLine -Arguments @($entry, 'secrets', 'set', $Key, '--stdin', '--data-root', $resolvedDataRoot)
    Write-Host ""
    Write-Host "Dry run - nothing was prompted for and nothing was stored."
    Write-Host "  The token would be written to the standard input of:"
    Write-Host "    $node $wouldRun"
    Write-Host "  Note what is not in that command line: the token."
    return
}

# --- 1. `claude setup-token` ----------------------------------------------

if (-not $SkipTokenCommand) {
    $claude = Get-Command -Name 'claude' -ErrorAction SilentlyContinue
    if ($null -eq $claude) {
        Write-Warning "The 'claude' CLI is not on PATH; skipping 'claude setup-token'. Paste a token you already have, or install Claude Code first."
    }
    else {
        Write-Host "Running 'claude setup-token'. Complete the browser sign-in, then copy the token it prints."
        Write-Host ""
        & claude setup-token
        Write-Host ""
    }
}

# --- 2. Read it into a SecureString ---------------------------------------
#
# `-AsSecureString` is the whole point: the characters never reach the screen,
# never reach $Matches, and never become a String in this scope.

$secure = Read-Host -Prompt "Paste the token (it will not be shown)" -AsSecureString
if ($null -eq $secure -or $secure.Length -eq 0) {
    throw "No token was entered; nothing was stored."
}

# --- 3. Hand it to the CLI over stdin -------------------------------------

$result = Send-AMSecretFromSecureString -InstallRoot $resolvedInstallRoot -Key $Key -Value $secure -DataRoot $resolvedDataRoot
$secure.Dispose()

if ($result.ExitCode -ne 0) {
    throw "agentmanager secrets set failed (exit $($result.ExitCode)): $($result.StdErr)$($result.StdOut)"
}
Write-Host $result.StdOut.TrimEnd()

# --- 4. Verify -------------------------------------------------------------
#
# By metadata, not by reading the value back: `secrets list` reports the key, the
# provider that encrypted it and when - enough to prove the round trip through
# the store worked - while decrypting it here would put the plaintext back in
# this process for no gain.

$listed = Invoke-AMCli -InstallRoot $resolvedInstallRoot -DataRoot $resolvedDataRoot -Arguments @('secrets', 'list')
if ($listed.ExitCode -ne 0 -or $listed.StdOut -notmatch [regex]::Escape($Key)) {
    throw "The secret was written but '$Key' does not appear in 'agentmanager secrets list'. Something is wrong with the secret store."
}
Write-Host ""
Write-Host "Verified: '$Key' is in the store."

Write-Host ""
Write-Host "Done. The token was never shown, never passed as an argument, and never written to a log."
Write-Host "The core reads it at session start (runner attachAuthEnv, DESIGN 3.2); restart the core if it is running:"
Write-Host "  Invoke-RestMethod -Method Post http://127.0.0.1:<port>/api/service/shutdown"
Write-Host ""
Write-Host "An end-to-end SDK round trip is the one check this script cannot make without spending"
Write-Host "plan quota: start any agent from the UI and confirm it answers. See Verify-Install.ps1."
