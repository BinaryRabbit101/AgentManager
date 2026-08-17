<#
.SYNOPSIS
    Shared helpers for the AgentManager install/setup scripts (foundation DESIGN section 4.4).

.DESCRIPTION
    Dot-sourced by every script in this directory. It exists so the six scripts
    agree about the five things they must not disagree about: where the install
    root is, where the data root is, how the core is invoked, what the scheduled
    task is called, and how a directory is ACL'd.

    Three rules hold throughout, and each one is a section 4.4 requirement rather than a
    style preference:

    * **Non-admin.** Nothing here elevates, writes outside the current user's
      profile, or touches HKLM. Task Scheduler is used in the current user's
      context (section 4.3), which is the entire reason it was chosen over a service.
    * **Idempotent.** Every mutating helper checks first and reports what it did.
      Re-running an install must be a no-op, not a second install.
    * **No secrets as parameters.** Nothing here takes a credential as an
      argument. `Send-AMSecretFromSecureString` is the one function that handles
      a secret at all, and it moves it over a redirected stdin - never a command
      line, never a temp file (section 3.5).

    PowerShell is confined to install/setup by CLAUDE.md, so these scripts do
    orchestration only: every effect they have is `agentmanager <verb>`, a
    Windows API, or a file copy.
#>

Set-StrictMode -Version Latest

# The scheduled task of DESIGN section 4.3, named once.
$script:AMTaskFolder = '\AgentManager'
$script:AMTaskName   = 'AgentManager Core'
$script:AMTaskPath   = "$script:AMTaskFolder\$script:AMTaskName"

# Minimum Node the core is built against (package.json `engines`).
$script:AMMinimumNodeMajor = 22

function ConvertTo-AMCommandLine {
    <#
    .SYNOPSIS
        Quotes an argument array into one Windows command line.
    .DESCRIPTION
        `ProcessStartInfo.ArgumentList` is .NET Core only, and Windows PowerShell
        5.1 runs on .NET Framework, so the command line has to be built by hand.
        The rule is the CRT's: wrap in quotes when the argument contains a space
        or a quote, double any embedded quote, and double the run of backslashes
        that immediately precedes a quote.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [string[]] $Arguments)

    $parts = @()
    foreach ($argument in $Arguments) {
        if ($argument -notmatch '[\s"]') {
            $parts += $argument
            continue
        }
        $escaped = $argument -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        $parts += """$escaped"""
    }
    return ($parts -join ' ')
}

function Write-AMUtf8NoBom {
    <#
    .SYNOPSIS
        Writes text as UTF-8 **without** a byte-order mark.
    .DESCRIPTION
        `Set-Content -Encoding utf8` emits a BOM on Windows PowerShell 5.1, and
        the config loader's `JSON.parse` (src/config/layers.ts) does not strip
        one - a BOM would make `config.json` fatally invalid at boot. Nothing
        these scripts write for the core to read may carry one.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-AMTaskPath {
    <#
    .SYNOPSIS
        `\AgentManager\AgentManager Core` - the task name fixed by DESIGN section 4.3.
    #>
    [CmdletBinding()]
    param([string] $TaskName)

    if ([string]::IsNullOrWhiteSpace($TaskName)) { return $script:AMTaskPath }
    if ($TaskName.StartsWith('\')) { return $TaskName }
    return "$script:AMTaskFolder\$TaskName"
}

function Split-AMTaskPath {
    <#
    .SYNOPSIS
        Splits a full task path into the folder and leaf the ScheduledTasks
        module wants as separate parameters.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $TaskPath)

    $leaf = Split-Path -Path $TaskPath -Leaf
    $folder = Split-Path -Path $TaskPath -Parent
    if ([string]::IsNullOrWhiteSpace($folder)) { $folder = '\' }
    if (-not $folder.EndsWith('\')) { $folder = "$folder\" }
    return [pscustomobject]@{ Folder = $folder; Name = $leaf }
}

function Get-AMDefaultInstallRoot {
    <#
    .SYNOPSIS
        `%LOCALAPPDATA%\Programs\AgentManager` (DESIGN section 1.2).
    #>
    [CmdletBinding()]
    param()
    return (Join-Path $env:LOCALAPPDATA 'Programs\AgentManager')
}

function Get-AMDefaultDataRoot {
    <#
    .SYNOPSIS
        `%LOCALAPPDATA%\AgentManager` (DESIGN section 1.2).
    #>
    [CmdletBinding()]
    param()
    return (Join-Path $env:LOCALAPPDATA 'AgentManager')
}

function Test-AMInstallRoot {
    <#
    .SYNOPSIS
        True when `$Path` looks like an install root.
    .DESCRIPTION
        The marker is `config\defaults.json`, exactly as `findInstallRoot` in
        `src/config/paths.ts` uses - one definition of "this is an install",
        shared by the service and the scripts.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Path 'config\defaults.json'))
}

function Resolve-AMInstallRoot {
    <#
    .SYNOPSIS
        The install root these scripts belong to.
    .DESCRIPTION
        Defaults to the parent of the `scripts\` directory the caller is running
        from, because section 1.2 puts `scripts\*.ps1` inside the install root. An
        explicit `-InstallRoot` wins, which is what lets the test suite run the
        real scripts against a repository checkout.
    #>
    [CmdletBinding()]
    param(
        [string] $InstallRoot,
        [Parameter(Mandatory)] [string] $ScriptRoot
    )

    if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
        return [System.IO.Path]::GetFullPath($InstallRoot)
    }
    return [System.IO.Path]::GetFullPath((Split-Path -Path $ScriptRoot -Parent))
}

function Resolve-AMNodeExe {
    <#
    .SYNOPSIS
        The Node runtime to run the core with.
    .DESCRIPTION
        `<install>\node\node.exe` first - section 1.2 ships a bundled runtime so an
        install does not depend on whatever Node the user happens to have - then
        `node.exe` on PATH for a development checkout.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $InstallRoot)

    $bundled = Join-Path $InstallRoot 'node\node.exe'
    if (Test-Path -LiteralPath $bundled) { return $bundled }

    $onPath = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $onPath) {
        $onPath = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue
    }
    if ($null -ne $onPath) { return $onPath.Source }
    return $null
}

function Resolve-AMEntryPoint {
    <#
    .SYNOPSIS
        The core's `main.js`.
    .DESCRIPTION
        DESIGN section 4.3 writes this as `<install>\app\main.js`. The build actually
        emits the core to `dist\` and the web bundle to `app\web\`
        (package.json `files`, vite.config.ts), so both are accepted and `dist\`
        is preferred. This is the one place that reconciliation lives.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $InstallRoot)

    foreach ($relative in @('dist\main.js', 'app\main.js')) {
        $candidate = Join-Path $InstallRoot $relative
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Test-AMNodeVersion {
    <#
    .SYNOPSIS
        Checks a Node executable satisfies package.json's `engines` floor.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $NodeExe)

    $reported = & $NodeExe '--version'
    $text = ($reported | Out-String).Trim()
    $major = 0
    if ($text -match '^v(\d+)\.') { $major = [int] $Matches[1] }
    return [pscustomobject]@{
        Version   = $text
        Major     = $major
        Satisfied = ($major -ge $script:AMMinimumNodeMajor)
        Required  = $script:AMMinimumNodeMajor
    }
}

function Invoke-AMCli {
    <#
    .SYNOPSIS
        Runs `agentmanager <args>` and returns its exit code and output.
    .DESCRIPTION
        The single call site for DESIGN section 4.4's "every action they take ... is also
        available through the core's CLI". Output is captured rather than echoed
        so the caller decides what the operator sees; `-PassThruOutput` echoes as
        well, for the verbs whose output *is* the report.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $InstallRoot,
        [Parameter(Mandatory)] [string[]] $Arguments,
        [string] $DataRoot,
        [switch] $PassThruOutput
    )

    $node = Resolve-AMNodeExe -InstallRoot $InstallRoot
    if ($null -eq $node) { throw "Node.js was not found. Looked for $InstallRoot\node\node.exe and node.exe on PATH." }
    $entry = Resolve-AMEntryPoint -InstallRoot $InstallRoot
    if ($null -eq $entry) { throw "The core bundle was not found under $InstallRoot (expected dist\main.js or app\main.js)." }

    $argv = @($entry) + $Arguments
    if (-not [string]::IsNullOrWhiteSpace($DataRoot)) { $argv += @('--data-root', $DataRoot) }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = ConvertTo-AMCommandLine -Arguments $argv
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::Start($psi)
    $out = $process.StandardOutput.ReadToEnd()
    $err = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    if ($null -eq $out) { $out = '' }
    if ($null -eq $err) { $err = '' }
    if ($PassThruOutput -and -not [string]::IsNullOrWhiteSpace($out)) { Write-Host $out.TrimEnd() }

    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        StdOut   = $out
        StdErr   = $err
        Command  = "$node $($psi.Arguments)"
    }
}

function Send-AMSecretFromSecureString {
    <#
    .SYNOPSIS
        Hands a SecureString to `agentmanager secrets set <key> --stdin` without
        the value ever leaving this process by any other route.

    .DESCRIPTION
        DESIGN section 3.5: secrets are "passed to SDK child processes through the
        environment block only - never a command line (visible in Task Manager),
        never a temp file". The same rule governs the installer's own hand-off,
        and this is the function that keeps it. Four properties, each deliberate:

        1. **The value is decrypted for the shortest possible window.** The BSTR
           produced by `SecureStringToBSTR` is freed with `ZeroFreeBSTR` in a
           `finally`, so the unmanaged buffer is overwritten even if the write
           throws. The managed `String` it produced is unavoidable - .NET strings
           are immutable and cannot be scrubbed - which is exactly why the window
           is one `Write` long.
        2. **It travels over stdin.** `RedirectStandardInput` plus a single
           `Write`; the child's command line is `<entry> secrets set <key>
           --stdin`, which is what Task Manager, `Get-CimInstance Win32_Process`
           and ETW process-start events will show.
        3. **Nothing echoes it.** The child prints a confirmation with no
           preview (see `src/cli/secrets.ts`), and nothing here writes the value
           to the host, to a variable that outlives the call, or to a log.
        4. **The PowerShell history never sees it.** The value arrived from
           `Read-Host -AsSecureString`, which is not a command; no caller
           interpolates it into a command string, so there is nothing for
           PSReadLine to persist.

        Returns the child's exit code, its output and the argument list it was
        given - the last so a caller (or a test) can assert the value is not in
        it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $InstallRoot,
        [Parameter(Mandatory)] [string] $Key,
        [Parameter(Mandatory)] [System.Security.SecureString] $Value,
        [string] $DataRoot
    )

    $node = Resolve-AMNodeExe -InstallRoot $InstallRoot
    if ($null -eq $node) { throw "Node.js was not found. Looked for $InstallRoot\node\node.exe and node.exe on PATH." }
    $entry = Resolve-AMEntryPoint -InstallRoot $InstallRoot
    if ($null -eq $entry) { throw "The core bundle was not found under $InstallRoot (expected dist\main.js or app\main.js)." }

    # The command line, in full. The secret is not in it and must never be.
    $argv = @($entry, 'secrets', 'set', $Key, '--stdin')
    if (-not [string]::IsNullOrWhiteSpace($DataRoot)) { $argv += @('--data-root', $DataRoot) }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = ConvertTo-AMCommandLine -Arguments $argv
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::Start($psi)

    $bstr = [IntPtr]::Zero
    try {
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        $process.StandardInput.Write($plain)
        $plain = $null
    }
    finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        # Closing stdin is what tells the child it has the whole value.
        $process.StandardInput.Close()
    }

    $out = $process.StandardOutput.ReadToEnd()
    $err = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    return [pscustomobject]@{
        ExitCode    = $process.ExitCode
        StdOut      = $out
        StdErr      = $err
        Arguments   = $argv
        CommandLine = "$node $($psi.Arguments)"
    }
}

function Grant-AMDirectoryAcl {
    <#
    .SYNOPSIS
        Grants the current user full control of a directory and drops inherited
        access (DESIGN section 4.4, "tighten its ACL to the current user").

    .DESCRIPTION
        The grant is issued **before** inheritance is stripped, for the reason
        `src/storage/acl.ts` gives: in the other order a directory whose only
        access came from an inherited ACE is briefly - and, if the second call
        fails, permanently - unreachable by its own owner.

        Best-effort by design, and reports which: a data root that exists but
        could not be ACL'd is better than an install that aborts, and the service
        applies the same tightening independently when it creates a root itself.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [switch] $DryRun
    )

    $principal = "$env:USERDOMAIN\$env:USERNAME"
    if ([string]::IsNullOrWhiteSpace($env:USERDOMAIN)) { $principal = $env:USERNAME }

    if ($DryRun) {
        return [pscustomobject]@{ Applied = $false; Principal = $principal; Reason = 'dry-run' }
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Applied = $false; Principal = $principal; Reason = 'missing' }
    }

    try {
        & icacls.exe $Path '/grant:r' "${principal}:(OI)(CI)F" '/Q' | Out-Null
        & icacls.exe $Path '/inheritance:r' '/Q' | Out-Null
        return [pscustomobject]@{ Applied = $true; Principal = $principal; Reason = 'ok' }
    }
    catch {
        return [pscustomobject]@{ Applied = $false; Principal = $principal; Reason = "icacls failed: $($_.Exception.Message)" }
    }
}

function New-AMPlan {
    <#
    .SYNOPSIS
        Starts an action log.
    .DESCRIPTION
        Every mutating script builds one of these, so `-DryRun` and a real run
        produce the *same* record and differ only in `Performed`. That is what
        makes the dry run a trustworthy description of the real one rather than a
        second code path that might not match.
    #>
    [CmdletBinding()]
    param()
    # The leading comma is load-bearing: PowerShell unrolls a collection on the
    # way out of a function, and an *empty* one unrolls to nothing at all, so a
    # bare `return $list` hands the caller $null. Wrapping it in a one-element
    # array makes the list itself the single output.
    return , ([System.Collections.ArrayList]::new())
}

function Add-AMPlanStep {
    [CmdletBinding()]
    param(
        # AllowEmptyCollection: a plan starts empty, and Mandatory alone rejects
        # an empty collection outright.
        [Parameter(Mandatory)] [AllowEmptyCollection()] [System.Collections.ArrayList] $Plan,
        [Parameter(Mandatory)] [string] $Action,
        [string] $Target = '',
        [string] $Detail = '',
        [bool] $Performed = $false
    )

    $step = [pscustomobject]@{
        Action    = $Action
        Target    = $Target
        Detail    = $Detail
        Performed = $Performed
    }
    $Plan.Add($step) | Out-Null
    return $step
}

function Write-AMPlan {
    <#
    .SYNOPSIS
        Prints the action log, and writes it as JSON when `-PlanPath` was given.
    #>
    [CmdletBinding()]
    param(
        # AllowEmptyCollection: a plan starts empty, and Mandatory alone rejects
        # an empty collection outright.
        [Parameter(Mandatory)] [AllowEmptyCollection()] [System.Collections.ArrayList] $Plan,
        [string] $PlanPath,
        [switch] $DryRun
    )

    $header = if ($DryRun) { 'Planned actions (dry run - nothing was changed):' } else { 'Actions:' }
    Write-Host $header
    foreach ($step in $Plan) {
        $mark = if ($step.Performed) { '[done]' } else { '[plan]' }
        $line = "  $mark $($step.Action)"
        if (-not [string]::IsNullOrWhiteSpace($step.Target)) { $line += " $($step.Target)" }
        if (-not [string]::IsNullOrWhiteSpace($step.Detail)) { $line += " - $($step.Detail)" }
        Write-Host $line
    }

    if (-not [string]::IsNullOrWhiteSpace($PlanPath)) {
        $directory = Split-Path -Path $PlanPath -Parent
        if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
        $json = ConvertTo-Json -InputObject @($Plan) -Depth 6
        Write-AMUtf8NoBom -Path $PlanPath -Content $json
    }
}

function Read-AMConfigJson {
    <#
    .SYNOPSIS
        Reads `<dataRoot>\config\config.json` (config layer 3) as an ordered
        hashtable, or an empty one when it does not exist.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $DataRoot)

    $path = Join-Path $DataRoot 'config\config.json'
    $result = [ordered]@{}
    if (-not (Test-Path -LiteralPath $path)) { return $result }

    $raw = Get-Content -LiteralPath $path -Raw
    if ($null -eq $raw -or [string]::IsNullOrWhiteSpace($raw)) { return $result }

    # PowerShell 5.1 has no -AsHashtable, so the PSCustomObject is walked.
    $parsed = ConvertFrom-Json -InputObject $raw
    foreach ($property in $parsed.PSObject.Properties) {
        $result[$property.Name] = $property.Value
    }
    return $result
}

function Write-AMConfigJson {
    <#
    .SYNOPSIS
        Writes config layer 3, **preserving every key it did not come to change**.

    .DESCRIPTION
        The idempotence criterion in foundation IMPLEMENTATION section 10 is explicit:
        re-running the installer must produce "no config clobber of user edits".
        So this is a merge, not a write: the file is read, the caller's keys are
        overlaid, and the result is written back only if it actually differs -
        which also keeps the file's mtime meaningful.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $DataRoot,
        [Parameter(Mandatory)] [hashtable] $Values
    )

    $directory = Join-Path $DataRoot 'config'
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $path = Join-Path $directory 'config.json'

    $existing = Read-AMConfigJson -DataRoot $DataRoot
    $merged = [ordered]@{}
    foreach ($key in $existing.Keys) { $merged[$key] = $existing[$key] }
    foreach ($key in $Values.Keys) { $merged[$key] = $Values[$key] }

    $json = (ConvertTo-Json -InputObject $merged -Depth 8)
    $before = ''
    if (Test-Path -LiteralPath $path) {
        $raw = (Get-Content -LiteralPath $path -Raw)
        if ($null -ne $raw) { $before = $raw }
    }

    $changed = ($before.Trim() -ne $json.Trim())
    if ($changed) {
        Write-AMUtf8NoBom -Path $path -Content $json
    }

    return [pscustomobject]@{ Path = $path; Changed = $changed; Keys = @($merged.Keys) }
}

function Get-AMPortRecord {
    <#
    .SYNOPSIS
        Reads `<dataRoot>\run\core.port` - step one of section 4.2's discovery procedure.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $DataRoot)

    $path = Join-Path $DataRoot 'run\core.port'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Stop-AMCore {
    <#
    .SYNOPSIS
        Asks a running core to shut down gracefully (`POST /api/service/shutdown`).
    .DESCRIPTION
        The API rather than `Stop-Process`, because section 4.2's graceful path is what
        interrupts in-flight sessions, checkpoints the WAL and removes the port
        file. A core that is not running is a success, not an error.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $DataRoot,
        [int] $TimeoutSeconds = 30
    )

    $record = Get-AMPortRecord -DataRoot $DataRoot
    if ($null -eq $record) { return [pscustomobject]@{ Stopped = $false; Reason = 'no core.port' } }

    $url = "http://127.0.0.1:$($record.port)/api/service/shutdown"
    try {
        Invoke-RestMethod -Method Post -Uri $url -TimeoutSec 10 -ErrorAction Stop | Out-Null
    }
    catch {
        return [pscustomobject]@{ Stopped = $false; Reason = "no answer at $url" }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-Path -LiteralPath (Join-Path $DataRoot 'run\core.port'))) {
            return [pscustomobject]@{ Stopped = $true; Reason = 'graceful' }
        }
        Start-Sleep -Milliseconds 250
    }
    return [pscustomobject]@{ Stopped = $false; Reason = 'timed out waiting for core.port to be removed' }
}

function New-AMAutostartTaskXml {
    <#
    .SYNOPSIS
        The scheduled-task definition of DESIGN section 4.3, verbatim.

    .DESCRIPTION
        > Task name:  \AgentManager\AgentManager Core
        > Trigger:    At log on of <current user>
        > Action:     wscript.exe "<install>\launch-core.vbs"
        > Principal:  current user, RunLevel = Limited, "Run only when user is logged on"
        > Settings:   RestartCount=3, RestartInterval=1min, ExecutionTimeLimit=0,
        >             DisallowStartIfOnBatteries=false, StopIfGoingOnBatteries=false,
        >             MultipleInstances=IgnoreNew, StartWhenAvailable=true

        XML rather than the `New-ScheduledTask*` cmdlet chain because the XML is
        the task's own format: what this function emits is exactly what
        `Register-ScheduledTask -Xml` registers and exactly what `-DryRun` shows
        the operator, with no second construction path between them.

        `RunLevel = Limited` is `LeastPrivilege`, and `LogonType =
        InteractiveToken` is "run only when the user is logged on" - the pair
        that keeps DPAPI CurrentUser secrets (section 3.1) and the user's own network
        context working, which is why section 4.3 rejected a SYSTEM service.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $InstallRoot,
        [string] $UserId,
        [string] $LauncherPath,
        [string] $TaskPath
    )

    if ([string]::IsNullOrWhiteSpace($TaskPath)) { $TaskPath = Get-AMTaskPath }
    if ([string]::IsNullOrWhiteSpace($UserId)) { $UserId = "$env:USERDOMAIN\$env:USERNAME" }
    if ([string]::IsNullOrWhiteSpace($LauncherPath)) {
        $LauncherPath = Join-Path $InstallRoot 'launch-core.vbs'
    }
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

    $escape = {
        param($text)
        return ($text -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;')
    }

    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>$(& $escape $UserId)</Author>
    <Description>Starts the AgentManager core service at logon. Windowless: the action is wscript.exe running launch-core.vbs, so no console flashes (foundation DESIGN 4.3).</Description>
    <URI>$(& $escape $TaskPath)</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$(& $escape $UserId)</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(& $escape $UserId)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(& $escape $wscript)</Command>
      <Arguments>"$(& $escape $LauncherPath)"</Arguments>
      <WorkingDirectory>$(& $escape $InstallRoot)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

    return $xml
}

function Test-AMTaskXml {
    <#
    .SYNOPSIS
        Validates task XML against the Task Scheduler itself, without registering
        anything.
    .DESCRIPTION
        `ITaskService.NewTask()` returns an unregistered definition whose
        `XmlText` setter parses and validates. Assigning to it therefore proves
        the XML would be accepted, while `RegisterTaskDefinition` - the call that
        actually changes the machine - is never made. Degrades to plain
        well-formedness when the COM service is unavailable.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Xml)

    try {
        $null = [xml] $Xml
    }
    catch {
        return [pscustomobject]@{ Valid = $false; Validator = 'xml'; Reason = $_.Exception.Message }
    }

    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $definition = $service.NewTask(0)
        $definition.XmlText = $Xml
        return [pscustomobject]@{ Valid = $true; Validator = 'Schedule.Service'; Reason = 'ok' }
    }
    catch {
        return [pscustomobject]@{ Valid = $false; Validator = 'Schedule.Service'; Reason = $_.Exception.Message }
    }
}

function Get-AMScheduledTask {
    <#
    .SYNOPSIS
        The autostart task, or `$null`. Never throws for "not registered".
    #>
    [CmdletBinding()]
    param([string] $TaskName)

    $path = Get-AMTaskPath -TaskName $TaskName
    $parts = Split-AMTaskPath -TaskPath $path
    try {
        return Get-ScheduledTask -TaskPath $parts.Folder -TaskName $parts.Name -ErrorAction Stop
    }
    catch {
        return $null
    }
}
