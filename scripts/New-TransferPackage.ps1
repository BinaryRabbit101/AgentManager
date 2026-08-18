<#
.SYNOPSIS
    Builds the work-edition transfer zip for another machine.

.DESCRIPTION
    A repeatable version of the packaging done by hand on 2026-08-17. It exists
    because a transfer archive assembled from memory is an archive nobody can
    check: what went in, what was deliberately left out, and whether a secret
    travelled with it are all questions this script answers the same way every
    time.

    What it does, in order:

      1. Rebuilds `dist\` and `app\web` so the payload matches HEAD rather than
         whatever was compiled last.
      2. Runs the edition boundary suite - the tests that prove the work edition
         opens no non-loopback listener and refuses `modules.remote.enabled`.
         Skippable with `-SkipTests`, and skipping is reported in the summary.
      3. Stages `git archive HEAD` (tracked files only, so nothing untracked and
         nothing ignored can slip in) plus the two build outputs, which are
         git-ignored and therefore have to be added deliberately.
      4. Stamps `packaging\SETUP-WORK-EDITION.md` with the real commit, subject
         and date, and writes it to the archive root.
      5. **Audits.** Fails - loudly, before writing a zip - if `.env`, a
         `node_modules` directory, or the value of any secret in the repository's
         `.env` is present in the staged tree.
      6. Compresses to `-Destination`, defaulting to the Desktop.

    **Nothing is stripped from the source.** The remote module ships intact and
    is inert by configuration; "two editions, one codebase" is architecture D6,
    and a build that deleted code to make a work edition would break the very
    tests step 2 runs.

.PARAMETER Destination
    Directory to write the zip into. Defaults to the current user's Desktop,
    which is where a OneDrive/SharePoint-synced folder usually lives.

.PARAMETER RepoRoot
    The repository. Defaults to the parent of this script's directory.

.PARAMETER SkipTests
    Skip the boundary suite. Faster, and the summary says the guarantee is
    unverified for this build.

.PARAMETER SkipBuild
    Reuse the existing `dist\` and `app\web`. Only sensible immediately after a
    build; the summary flags it.

.PARAMETER Force
    Overwrite an existing zip of the same name.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\New-TransferPackage.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\New-TransferPackage.ps1 -Destination D:\Transfer -Force
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $Destination,
    [string] $RepoRoot,
    [switch] $SkipTests,
    [switch] $SkipBuild,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
    throw "No package.json under $RepoRoot - point -RepoRoot at the repository."
}

if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = [Environment]::GetFolderPath('Desktop') }
$Destination = [System.IO.Path]::GetFullPath($Destination)
if (-not (Test-Path $Destination)) { throw "Destination does not exist: $Destination" }

Push-Location $RepoRoot
try {
    # --- Provenance --------------------------------------------------------
    $commit = (& git rev-parse --short HEAD).Trim()
    $subject = (& git log -1 --pretty=%s).Trim()
    $dirty = (& git status --porcelain)
    $buildDate = (Get-Date).ToString('yyyy-MM-dd')

    Write-Host "AgentManager transfer package"
    Write-Host "  repository : $RepoRoot"
    Write-Host "  commit     : $commit  $subject"
    Write-Host "  destination: $Destination"
    Write-Host ""

    # A dirty tree is allowed - `git archive` packages HEAD regardless - but the
    # difference between what was built and what was packaged is exactly the
    # confusion this warning exists to prevent.
    if ($dirty) {
        Write-Warning ("The working tree has uncommitted changes. The archive takes tracked files " +
            "from HEAD ($commit), but dist\ and app\web are built from the working tree - so they " +
            "may not match the sources beside them. Commit first for a coherent package.")
    }

    # --- 1. Build ----------------------------------------------------------
    if ($SkipBuild) {
        Write-Host "[skip] build - reusing the existing dist\ and app\web"
    }
    else {
        Write-Host "[1/5] building (npm run rebuild)..."
        & npm run rebuild
        if ($LASTEXITCODE -ne 0) { throw "npm run rebuild failed with exit code $LASTEXITCODE." }
    }
    foreach ($required in @('dist\main.js', 'app\web')) {
        if (-not (Test-Path (Join-Path $RepoRoot $required))) {
            throw "$required is missing after the build step; the package would not run."
        }
    }

    # --- 2. The guarantee --------------------------------------------------
    if ($SkipTests) {
        Write-Host "[skip] boundary suite - the no-listener guarantee is UNVERIFIED for this build"
    }
    else {
        Write-Host "[2/5] running the edition boundary suite..."
        & npm run test:boundary
        if ($LASTEXITCODE -ne 0) {
            throw ("The boundary suite failed. That suite is what proves the work edition cannot " +
                "listen beyond loopback, so no package is written from a red tree.")
        }
    }

    # --- 3. Stage ----------------------------------------------------------
    Write-Host "[3/5] staging..."
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("agentmanager-package-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
    New-Item -ItemType Directory -Path $staging | Out-Null

    try {
        # Tracked files at HEAD. `git archive` cannot emit an untracked file, so
        # `.env` cannot reach the staging tree by this route even by mistake.
        $tarball = Join-Path $staging 'tracked.tar'
        & git archive --format=tar --output=$tarball HEAD
        if ($LASTEXITCODE -ne 0) { throw "git archive failed with exit code $LASTEXITCODE." }

        $payload = Join-Path $staging 'payload'
        New-Item -ItemType Directory -Path $payload | Out-Null
        & tar -xf $tarball -C $payload
        if ($LASTEXITCODE -ne 0) { throw "extracting the git archive failed with exit code $LASTEXITCODE." }
        Remove-Item $tarball -Force

        # The build outputs are git-ignored, so they are copied in deliberately.
        Copy-Item (Join-Path $RepoRoot 'dist') (Join-Path $payload 'dist') -Recurse
        Copy-Item (Join-Path $RepoRoot 'app') (Join-Path $payload 'app') -Recurse

        # --- 4. The setup guide, stamped with this build's provenance -------
        $template = Join-Path $RepoRoot 'packaging\SETUP-WORK-EDITION.md'
        if (-not (Test-Path $template)) { throw "Missing $template - the archive would ship without setup instructions." }
        $guide = [System.IO.File]::ReadAllText($template)
        $guide = $guide.Replace('{{COMMIT}}', $commit).Replace('{{COMMIT_SUBJECT}}', $subject).Replace('{{BUILD_DATE}}', $buildDate)
        if ($guide -match '\{\{[A-Z_]+\}\}') {
            throw "The setup guide still contains an unsubstituted placeholder: $($Matches[0])"
        }
        [System.IO.File]::WriteAllText(
            (Join-Path $payload 'SETUP-WORK-EDITION.md'),
            $guide,
            (New-Object System.Text.UTF8Encoding($false)))

        # --- 5. Audit -------------------------------------------------------
        #
        # The check that matters. `.env` holds a live OAuth token, and an archive
        # that carried it would hand a working credential to whoever opens the
        # zip - so this refuses to write one rather than warning about it.
        Write-Host "[4/5] auditing..."
        $problems = @()

        $envFiles = @(Get-ChildItem -Path $payload -Recurse -Force -Filter '.env' -File -ErrorAction SilentlyContinue)
        if ($envFiles.Count -gt 0) { $problems += "a .env file is present ($($envFiles.Count))" }

        $nodeModules = @(Get-ChildItem -Path $payload -Recurse -Force -Directory -Filter 'node_modules' -ErrorAction SilentlyContinue)
        if ($nodeModules.Count -gt 0) { $problems += "a node_modules directory is present" }

        # Every value in the repository's own .env is treated as a secret and
        # must not appear anywhere in the payload.
        $secretsChecked = 0
        $repoEnv = Join-Path $RepoRoot '.env'
        if (Test-Path $repoEnv) {
            foreach ($line in [System.IO.File]::ReadAllLines($repoEnv)) {
                if ($line -match '^\s*#') { continue }
                if ($line -notmatch '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$') { continue }
                $value = $Matches[1].Trim().Trim('"').Trim("'")
                # Short values are formats and flags, not credentials, and would
                # match half the tree.
                if ($value.Length -lt 16) { continue }
                $secretsChecked++
                $hit = Get-ChildItem -Path $payload -Recurse -File |
                    Select-String -SimpleMatch -Pattern $value -List -ErrorAction SilentlyContinue |
                    Select-Object -First 1
                if ($null -ne $hit) { $problems += "a secret from .env appears in $($hit.Path)" }
            }
        }

        if ($problems.Count -gt 0) {
            throw ("Audit failed, no archive written:`n  - " + ($problems -join "`n  - "))
        }

        $fileCount = @(Get-ChildItem -Path $payload -Recurse -File).Count

        # --- 6. Compress ----------------------------------------------------
        Write-Host "[5/5] compressing..."
        $zipPath = Join-Path $Destination "AgentManager-work-edition-$buildDate.zip"
        if ((Test-Path $zipPath) -and -not $Force) {
            throw "$zipPath already exists. Re-run with -Force to replace it."
        }
        if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
        Compress-Archive -Path (Join-Path $payload '*') -DestinationPath $zipPath -CompressionLevel Optimal

        $zip = Get-Item $zipPath
        Write-Host ""
        Write-Host "Package written."
        Write-Host "  path       : $($zip.FullName)"
        Write-Host "  size       : $([math]::Round($zip.Length / 1MB, 2)) MB"
        Write-Host "  files      : $fileCount"
        Write-Host "  commit     : $commit  $subject"
        Write-Host "  boundary   : $(if ($SkipTests) { 'SKIPPED - guarantee unverified' } else { 'passed' })"
        Write-Host "  build      : $(if ($SkipBuild) { 'reused existing dist\ and app\web' } else { 'rebuilt from the working tree' })"
        Write-Host "  audit      : no .env, no node_modules, $secretsChecked secret(s) checked and absent"
        Write-Host ""
        Write-Host "On the target machine, start with SETUP-WORK-EDITION.md at the archive root."
    }
    finally {
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
