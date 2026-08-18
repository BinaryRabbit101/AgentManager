/**
 * The M10 install/setup/autostart scripts, driven for real (DESIGN §4.4, §4.3).
 *
 * These are PowerShell and VBScript, so the runner is `child_process` — but the
 * scripts under test are the shipped ones, run as an operator would run them,
 * with only the roots redirected:
 *
 * - `-DataRoot`, `-StartMenuRoot` and `-DesktopRoot` point into a temp tree, so
 *   a real install happens and nothing outside that tree is touched.
 * - `-TaskName` is a per-run unique name, so no assertion can collide with a
 *   task this machine actually has, and nothing here registers one: every
 *   Task Scheduler path is exercised through `-DryRun`, which emits the exact
 *   XML that would be registered and validates it against the scheduler service
 *   without calling `RegisterTaskDefinition`.
 * - `launch-core.vbs` is run with `/plan`, which prints the command line it
 *   would run and exits instead of starting a service.
 *
 * Acceptance covered (foundation IMPLEMENTATION §10):
 *
 * | Criterion | Named test |
 * |---|---|
 * | data root created and ACL'd, config written with the chosen edition, schema migrated | "creates the data root tree, ACLs it, writes the edition and migrates the schema" |
 * | autostart registered (home) or skipped (work) | "skips autostart in the work edition" / "plans autostart registration in the home edition" |
 * | re-running is idempotent — no duplicate task, no config clobber, no write inside library/ | "re-running changes nothing…" (three assertions) |
 * | no visible console window at logon | "runs the core through wscript with window style 0" + "registers wscript.exe running the launcher, not node.exe" (the mechanism; seeing it is Verify-Install.ps1's M10-logon-no-console) |
 * | Setup-Auth: value never in the console, history, command line or a log file | "hands the token over stdin, never on the command line" and siblings |
 * | Test-AgentManagerHealth: one readable report with every listed section | "prints one report covering every section §4.4 names" |
 * | Uninstall without -RemoveData; refuses a library outside the data root | "keeps the data root…" / "refuses to delete a library root outside the data root" |
 *
 * The three criteria that genuinely cannot run here — a fresh Windows account, a
 * logon cycle, and a real SDK round trip — are `scripts/Verify-Install.ps1`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findInstallRoot } from '../config/index.js';

const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));
const scriptsDir = join(repoRoot, 'scripts');
const launcher = join(repoRoot, 'launch-core.vbs');
const bundle = join(repoRoot, 'dist', 'main.js');

const onWindows = process.platform === 'win32';
/** The install verbs need a built core; `npm run ci` builds before it tests. */
const built = onWindows && existsSync(bundle);

const POWERSHELL_TIMEOUT_MS = 180_000;

function powershellFile(script: string, args: readonly string[]): string {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
  );
}

function cscript(args: readonly string[]): string {
  return execFileSync('cscript.exe', ['//Nologo', ...args], {
    encoding: 'utf8',
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
  });
}

function script(name: string): string {
  return join(scriptsDir, name);
}

/** The six §4.4 scripts, the shared library, and the manual-checklist script. */
const SCRIPT_FILES = [
  'AgentManager.Common.ps1',
  'Install-AgentManager.ps1',
  'Register-Autostart.ps1',
  'Setup-Auth.ps1',
  'Test-AgentManagerHealth.ps1',
  'Uninstall-AgentManager.ps1',
  'Unregister-Autostart.ps1',
  'Verify-Install.ps1',
];

// ---------------------------------------------------------------------------
// Every script exists, parses, and is ASCII
// ---------------------------------------------------------------------------

describe('the §4.4 script set', () => {
  it('ships every script DESIGN §4.4 names, plus the launcher stub of §4.3', () => {
    for (const name of SCRIPT_FILES) expect(existsSync(script(name))).toBe(true);
    expect(existsSync(launcher)).toBe(true);
  });

  it.runIf(onWindows)(
    "parses under PowerShell's own parser, with no errors in any script",
    () => {
      // ParseFile is the parser the shell itself uses, so this is the real
      // syntax check rather than a lint approximation.
      const command = [
        `$errors = $null; $tokens = $null; $bad = @();`,
        `foreach ($f in (Get-ChildItem -LiteralPath '${scriptsDir.replaceAll("'", "''")}' -Filter '*.ps1')) {`,
        `  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors) | Out-Null;`,
        `  if ($errors.Count -gt 0) { foreach ($e in $errors) { $bad += "$($f.Name):$($e.Extent.StartLineNumber): $($e.Message)" } }`,
        `}`,
        `if ($bad.Count -eq 0) { 'PARSE-OK' } else { $bad -join "\`n" }`,
      ].join(' ');

      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
      );
      expect(output.trim()).toBe('PARSE-OK');
    },
    POWERSHELL_TIMEOUT_MS,
  );

  it('contains no character outside ASCII', () => {
    // Not a style rule. Windows PowerShell 5.1 reads a BOM-less script as ANSI,
    // which turns a UTF-8 em dash into a run that ends in U+201D — and
    // PowerShell accepts a smart quote as a string delimiter, so one dash in a
    // comment silently breaks the parse of everything after it. Keeping the
    // files ASCII removes the trap rather than depending on a BOM surviving
    // every editor and every git filter.
    // Every `.ps1` in the folder, not just SCRIPT_FILES: the trap belongs to the
    // file format, so a script outside §4.4's named set (New-TransferPackage,
    // Update-AgentManager) breaks in exactly the same way and would otherwise be
    // unguarded.
    const everyScript = readdirSync(scriptsDir)
      .filter((name) => name.endsWith('.ps1'))
      .map(script);
    expect(everyScript.length).toBeGreaterThanOrEqual(SCRIPT_FILES.length);

    for (const name of [...everyScript, launcher]) {
      const text = readFileSync(name, 'utf8');
      const offenders = [...new Set([...text].filter((c) => c.codePointAt(0)! > 126))];
      expect({ file: name, offenders }).toEqual({ file: name, offenders: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// launch-core.vbs (§4.3)
// ---------------------------------------------------------------------------

describe.runIf(onWindows)('launch-core.vbs', () => {
  it(
    'runs the core through wscript with window style 0 and does not wait',
    () => {
      const plan = cscript([launcher, '/plan']);
      // Window style 0 plus bWaitOnReturn=False is exactly what makes the logon
      // start invisible and lets the stub exit while the core keeps running.
      expect(plan).toContain('windowStyle=0');
      expect(plan).toContain('wait=False');
      expect(plan).toMatch(/command=.*main\.js/);
    },
    POWERSHELL_TIMEOUT_MS,
  );

  it.runIf(built)(
    'prefers the built dist\\main.js entry point when one is present',
    () => {
      expect(cscript([launcher, '/plan'])).toContain(join('dist', 'main.js'));
    },
    POWERSHELL_TIMEOUT_MS,
  );

  it(
    'falls back to app\\main.js for the install layout DESIGN §4.3 describes',
    () => {
      const plan = cscript([launcher, '/plan', '/install:C:\\nowhere-at-all']);
      expect(plan).toContain('entry=C:\\nowhere-at-all\\app\\main.js');
      expect(plan).toContain('installRoot=C:\\nowhere-at-all');
    },
    POWERSHELL_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Register-Autostart / Unregister-Autostart (§4.3)
// ---------------------------------------------------------------------------

describe.runIf(onWindows)('Register-Autostart.ps1', () => {
  let workdir: string;
  let xmlPath: string;
  let output: string;
  let xml: string;
  const taskName = `AgentManager Core (m10 test ${String(process.pid)})`;

  beforeAll(() => {
    workdir = mkdtempSync(resolve(tmpdir(), 'am-task-'));
    xmlPath = join(workdir, 'task.xml');
    output = powershellFile(script('Register-Autostart.ps1'), [
      '-InstallRoot',
      repoRoot,
      '-TaskName',
      taskName,
      '-XmlPath',
      xmlPath,
      '-DryRun',
    ]);
    xml = readFileSync(xmlPath, 'utf8');
  }, POWERSHELL_TIMEOUT_MS);

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('registers wscript.exe running the launcher, not node.exe directly', () => {
    // The whole reason a console does not flash at logon.
    expect(xml).toMatch(/<Command>.*\\wscript\.exe<\/Command>/);
    expect(xml).toContain('launch-core.vbs');
    expect(xml).not.toMatch(/<Command>.*node\.exe<\/Command>/);
  });

  it('uses the At-logon trigger and the current-user, least-privilege principal', () => {
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('carries every setting DESIGN §4.3 specifies, with its stated value', () => {
    expect(xml).toContain('<Count>3</Count>');
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
  });

  it('names the task under \\AgentManager\\, as §4.3 fixes it', () => {
    expect(xml).toContain(`<URI>\\AgentManager\\${taskName}</URI>`);
    expect(output).toContain(`\\AgentManager\\${taskName}`);
  });

  it('is accepted by the Task Scheduler service itself, without registering it', () => {
    // ITaskService.NewTask().XmlText parses and validates; RegisterTaskDefinition
    // is what would change the machine, and is never called on this path.
    expect(output).toContain('Schedule.Service says valid');
    expect(output).toContain('[plan] register scheduled task');
    expect(output).not.toContain('[done] register scheduled task');
  });

  it(
    'is idempotent about an absent task: unregistering one reports it and exits 0',
    () => {
      const removed = powershellFile(script('Unregister-Autostart.ps1'), [
        '-TaskName',
        taskName,
        '-DryRun',
      ]);
      expect(removed).toContain('not registered; nothing to do');
    },
    POWERSHELL_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Install-AgentManager.ps1 (§4.4)
// ---------------------------------------------------------------------------

describe.runIf(built)('Install-AgentManager.ps1', () => {
  let root: string;
  let dataRoot: string;
  let startMenu: string;
  let firstRun: string;
  const taskName = `AgentManager Core (m10 install ${String(process.pid)})`;

  const commonArgs = (): string[] => [
    '-InstallRoot',
    repoRoot,
    '-DataRoot',
    dataRoot,
    '-StartMenuRoot',
    startMenu,
    '-DesktopRoot',
    join(root, 'desktop'),
    '-TaskName',
    taskName,
    '-NoStart',
  ];

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'am-install-'));
    dataRoot = join(root, 'data');
    startMenu = join(root, 'startmenu');
    firstRun = powershellFile(script('Install-AgentManager.ps1'), [
      '-Edition',
      'work',
      ...commonArgs(),
    ]);
  }, POWERSHELL_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the data root tree, ACLs it, writes the edition and migrates the schema', () => {
    for (const relative of [
      'config',
      'library',
      'state',
      join('state', 'backups'),
      join('state', 'transcripts'),
      join('state', 'logs'),
      join('state', 'secrets'),
      'worktrees',
      'run',
      'cache',
    ]) {
      expect(existsSync(join(dataRoot, relative))).toBe(true);
    }
    expect(existsSync(join(dataRoot, 'state', 'agentmanager.db'))).toBe(true);
    expect(firstRun).toContain('schema version 1');

    const config = JSON.parse(readFileSync(join(dataRoot, 'config', 'config.json'), 'utf8')) as {
      edition: string;
    };
    expect(config.edition).toBe('work');
  });

  it('writes config.json without a BOM, which the loader would reject', () => {
    const bytes = readFileSync(join(dataRoot, 'config', 'config.json'));
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it('grants the current user only, with inheritance removed', () => {
    const acl = execFileSync('icacls.exe', [dataRoot], { encoding: 'utf8', windowsHide: true });
    const user = `${process.env['USERDOMAIN'] ?? ''}\\${process.env['USERNAME'] ?? ''}`;
    expect(acl).toContain(user);
    // /inheritance:r leaves exactly the granted ACE; the inherited BUILTIN and
    // NT AUTHORITY entries a temp directory starts with are gone.
    expect(acl).not.toContain('BUILTIN\\Administrators');
    expect(acl).not.toContain('NT AUTHORITY\\SYSTEM');
  });

  it('creates the library directory and writes nothing inside it', () => {
    // DESIGN §4.4: the installer creates and ACLs the library DIRECTORY only;
    // roster.json, .gitignore and any seeded agent are the roster's on first run.
    expect(existsSync(join(dataRoot, 'library'))).toBe(true);
    expect(readdirSync(join(dataRoot, 'library'))).toEqual([]);
  });

  it('skips autostart in the work edition', () => {
    expect(firstRun).toContain('skip autostart registration');
    expect(firstRun).toContain('the work edition does not start a background runner at logon');
  });

  it('creates a Start-menu shortcut to the windowless launcher', () => {
    const shortcut = join(startMenu, 'AgentManager', 'Start AgentManager Core.lnk');
    expect(existsSync(shortcut)).toBe(true);
  });

  it(
    're-running changes nothing: no second backup, no config clobber, no write in library/',
    () => {
      const backupsBefore = readdirSync(join(dataRoot, 'state', 'backups'));
      // A user edit the installer must preserve.
      const configFile = join(dataRoot, 'config', 'config.json');
      const edited = {
        ...(JSON.parse(readFileSync(configFile, 'utf8')) as object),
        http: { port: 7999 },
      };
      writeFileSync(configFile, JSON.stringify(edited, null, 2), 'utf8');
      // A file only the roster may own, to prove the installer does not touch it.
      writeFileSync(join(dataRoot, 'library', 'roster.json'), '{"schemaVersion":1}', 'utf8');

      const second = powershellFile(script('Install-AgentManager.ps1'), [
        '-Edition',
        'work',
        ...commonArgs(),
      ]);

      expect(second).toContain('applied        nothing; the schema was already up to date');
      expect(readdirSync(join(dataRoot, 'state', 'backups'))).toEqual(backupsBefore);

      const after = JSON.parse(readFileSync(configFile, 'utf8')) as {
        edition: string;
        http?: { port?: number };
      };
      expect(after.edition).toBe('work');
      expect(after.http?.port).toBe(7999);

      expect(readFileSync(join(dataRoot, 'library', 'roster.json'), 'utf8')).toBe(
        '{"schemaVersion":1}',
      );
      expect(readdirSync(join(dataRoot, 'library'))).toEqual(['roster.json']);
    },
    POWERSHELL_TIMEOUT_MS,
  );

  it(
    'plans autostart registration in the home edition',
    () => {
      const planned = powershellFile(script('Install-AgentManager.ps1'), [
        '-Edition',
        'home',
        '-InstallRoot',
        repoRoot,
        '-DataRoot',
        join(root, 'home-data'),
        '-StartMenuRoot',
        join(root, 'home-menu'),
        '-TaskName',
        taskName,
        '-NoStart',
        '-DryRun',
      ]);
      expect(planned).toContain('register scheduled task');
      expect(planned).not.toContain('[done] register scheduled task');
      // A dry run must leave no trace at all.
      expect(existsSync(join(root, 'home-data'))).toBe(false);
    },
    POWERSHELL_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Setup-Auth.ps1 (§4.4, §3.5)
// ---------------------------------------------------------------------------

describe.runIf(built)('Setup-Auth.ps1', () => {
  let root: string;
  let dataRoot: string;
  const token = 'sk-ant-oat01-M10-SCRIPTS-TEST-abcdefghijklmnop';

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'am-auth-'));
    dataRoot = join(root, 'data');
    powershellFile(script('Install-AgentManager.ps1'), [
      '-Edition',
      'work',
      '-InstallRoot',
      repoRoot,
      '-DataRoot',
      dataRoot,
      '-NoStart',
      '-NoShortcuts',
    ]);
  }, POWERSHELL_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(
    'hands the token over stdin, never on the command line, and never echoes it',
    () => {
      // Drives the real `Send-AMSecretFromSecureString` — the function
      // Setup-Auth.ps1 calls with what `Read-Host -AsSecureString` produced.
      // `Read-Host` itself is the one line no test can reach; it is
      // Verify-Install.ps1's M10-setup-auth-working-token.
      const driver = join(root, 'drive-secret.ps1');
      writeFileSync(
        driver,
        [
          'param([string] $Root, [string] $DataRoot, [string] $Token)',
          "Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'",
          ". (Join-Path $Root 'scripts\\AgentManager.Common.ps1')",
          '$secure = ConvertTo-SecureString -String $Token -AsPlainText -Force',
          "$r = Send-AMSecretFromSecureString -InstallRoot $Root -Key 'claude.oauthToken' -Value $secure -DataRoot $DataRoot",
          'Write-Output "EXIT=$($r.ExitCode)"',
          'Write-Output "CMDLINE=$($r.CommandLine)"',
          'Write-Output "STDOUT=$($r.StdOut.Trim())"',
          'Write-Output "STDERR=$($r.StdErr.Trim())"',
        ].join('\n'),
        'utf8',
      );

      const output = powershellFile(driver, [
        '-Root',
        repoRoot,
        '-DataRoot',
        dataRoot,
        '-Token',
        token,
      ]);

      expect(output).toContain('EXIT=0');
      // 1. The command line. What Task Manager and Win32_Process would show.
      const commandLine = /CMDLINE=(.*)/.exec(output)?.[1] ?? '';
      expect(commandLine).toContain('secrets set claude.oauthToken --stdin');
      expect(commandLine).not.toContain(token);
      // 2. The console. Not even the four-character preview.
      expect(output).not.toContain(token);
      expect(output).not.toContain(token.slice(-4));
      expect(output).toContain('stored secret "claude.oauthToken"');
      // 3. The store really has it, encrypted.
      const envelope = readFileSync(join(dataRoot, 'state', 'secrets', 'secrets.json'), 'utf8');
      expect(envelope).toContain('claude.oauthToken');
      expect(envelope).not.toContain(token);
      // 4. No log file anywhere under the data root carries it.
      const logs = join(dataRoot, 'state', 'logs');
      for (const file of existsSync(logs) ? readdirSync(logs) : []) {
        expect(readFileSync(join(logs, file), 'utf8')).not.toContain(token);
      }
    },
    POWERSHELL_TIMEOUT_MS,
  );

  it(
    'shows the command line it would use, and the token is not in it',
    () => {
      const dry = powershellFile(script('Setup-Auth.ps1'), [
        '-InstallRoot',
        repoRoot,
        '-DataRoot',
        dataRoot,
        '-DryRun',
      ]);
      expect(dry).toContain('secrets set claude.oauthToken --stdin');
      expect(dry).toContain('nothing was prompted for and nothing was stored');
    },
    POWERSHELL_TIMEOUT_MS,
  );

  it('never interpolates a secret into a command string anywhere in its source', () => {
    // The PowerShell history hazard is a source-level property: a value typed at
    // a prompt is not a command, so the only way it could reach PSReadLine is if
    // some line here built a command out of it.
    // A *call*, not a mention: the doc comment names Invoke-Expression to say it
    // is absent, and a scan that could not tell the two apart would be a scan
    // nobody could satisfy. A call is preceded by whitespace or an operator; the
    // documented mention is wrapped in backticks.
    const invokesExpression = /(?:^|[\s;|&(])(?:Invoke-Expression|iex)[\s(]/m;

    const source = readFileSync(script('Setup-Auth.ps1'), 'utf8');
    expect(source).toContain('-AsSecureString');
    expect(source).not.toMatch(invokesExpression);
    expect(source).not.toMatch(/Add-History/);

    const common = readFileSync(script('AgentManager.Common.ps1'), 'utf8');
    expect(common).toContain('RedirectStandardInput');
    expect(common).toContain('ZeroFreeBSTR');
    expect(common).not.toMatch(invokesExpression);
  });
});

// ---------------------------------------------------------------------------
// Test-AgentManagerHealth.ps1 and Uninstall-AgentManager.ps1 (§4.4)
// ---------------------------------------------------------------------------

describe.runIf(built)('Test-AgentManagerHealth.ps1', () => {
  let root: string;
  let dataRoot: string;

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'am-health-'));
    dataRoot = join(root, 'data');
    powershellFile(script('Install-AgentManager.ps1'), [
      '-Edition',
      'work',
      '-InstallRoot',
      repoRoot,
      '-DataRoot',
      dataRoot,
      '-NoStart',
      '-NoShortcuts',
    ]);
  }, POWERSHELL_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(
    'prints one report covering every section §4.4 names',
    () => {
      const report = powershellFile(script('Test-AgentManagerHealth.ps1'), [
        '-InstallRoot',
        repoRoot,
        '-DataRoot',
        dataRoot,
      ]);

      expect(report).toContain('edition        : work');
      expect(report).toContain(dataRoot);
      expect(report).toContain('quick_check    : ok');
      expect(report).toContain('user_version   : 1');
      expect(report).toContain('ANTHROPIC_API_KEY');
      expect(report).toContain('== Autostart task');
      expect(report).toContain('== Listening sockets owned by the core');
      expect(report).toContain('== Tailscale');
      expect(report).toContain('lines of core.log');
      expect(report).toContain('== Secrets');
    },
    POWERSHELL_TIMEOUT_MS,
  );

  it(
    'emits the same facts as JSON for a support tool to parse',
    () => {
      // `-TaskName` is not decoration: the scheduled task is *machine* state, not
      // data-root state, so without it this asserted "no task is registered"
      // against whatever the developer's own box happens to have. It passed
      // everywhere until AgentManager was installed on one (2026-08-17), and then
      // failed for the one reason a test must never fail: the software works.
      const absentTask = `\\AgentManager\\AgentManager Core (absent, scripts.test.ts)`;
      const json = powershellFile(script('Test-AgentManagerHealth.ps1'), [
        '-InstallRoot',
        repoRoot,
        '-DataRoot',
        dataRoot,
        '-TaskName',
        absentTask,
        '-Json',
      ]);
      const parsed = JSON.parse(json) as {
        Core: { edition: string; database: { quickCheck: string } };
        Task: { Registered: boolean };
      };
      expect(parsed.Core.edition).toBe('work');
      expect(parsed.Core.database.quickCheck).toBe('ok');
      expect(parsed.Task.Registered).toBe(false);
    },
    POWERSHELL_TIMEOUT_MS,
  );
});

describe.runIf(built)('Uninstall-AgentManager.ps1', () => {
  let root: string;
  let dataRoot: string;
  let fakeInstall: string;

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'am-uninstall-'));
    dataRoot = join(root, 'data');
    // A throwaway install root, so the removal is real without deleting the
    // repository this test is running from.
    fakeInstall = join(root, 'install');
    writeFileSync(join(root, 'placeholder'), '', 'utf8');
    powershellFile(script('Install-AgentManager.ps1'), [
      '-Edition',
      'work',
      '-InstallRoot',
      repoRoot,
      '-DataRoot',
      dataRoot,
      '-NoStart',
      '-NoShortcuts',
    ]);
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `New-Item -ItemType Directory -Path '${fakeInstall}\\config' -Force | Out-Null; ` +
          `Set-Content -LiteralPath '${fakeInstall}\\config\\defaults.json' -Value '{}' -Encoding ascii`,
      ],
      { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
    );
  }, POWERSHELL_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(
    'removes the install root and keeps the data root when -RemoveData is not given',
    () => {
      const output = powershellFile(script('Uninstall-AgentManager.ps1'), [
        '-InstallRoot',
        fakeInstall,
        '-DataRoot',
        dataRoot,
        '-TaskName',
        `AgentManager Core (m10 uninstall ${String(process.pid)})`,
        '-StartMenuRoot',
        join(root, 'startmenu'),
        '-DesktopRoot',
        join(root, 'desktop'),
      ]);

      expect(output).toContain('The data root was kept');
      expect(existsSync(fakeInstall)).toBe(false);
      expect(existsSync(join(dataRoot, 'state', 'agentmanager.db'))).toBe(true);
      expect(existsSync(join(dataRoot, 'library'))).toBe(true);
    },
    POWERSHELL_TIMEOUT_MS,
  );

  it(
    'refuses to delete a library root outside the data root, even with -RemoveData',
    () => {
      const outside = join(root, 'MyLibrary');
      writeFileSync(
        join(dataRoot, 'config', 'config.json'),
        JSON.stringify({ edition: 'work', library: { root: outside } }, null, 2),
        'utf8',
      );
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `New-Item -ItemType Directory -Path '${outside}' -Force | Out-Null`,
        ],
        { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
      );

      const output = powershellFile(script('Uninstall-AgentManager.ps1'), [
        '-InstallRoot',
        fakeInstall,
        '-DataRoot',
        dataRoot,
        '-RemoveData',
        '-TaskName',
        `AgentManager Core (m10 uninstall ${String(process.pid)})`,
        '-StartMenuRoot',
        join(root, 'startmenu'),
        '-DesktopRoot',
        join(root, 'desktop'),
      ]);

      expect(output).toContain('REFUSE to remove the data root');
      // The refusal is a refusal: neither the library nor the data root went.
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(join(dataRoot, 'state', 'agentmanager.db'))).toBe(true);
    },
    POWERSHELL_TIMEOUT_MS,
  );

  it(
    'removes the data root when the library is inside it',
    () => {
      writeFileSync(
        join(dataRoot, 'config', 'config.json'),
        JSON.stringify({ edition: 'work' }, null, 2),
        'utf8',
      );
      const output = powershellFile(script('Uninstall-AgentManager.ps1'), [
        '-InstallRoot',
        fakeInstall,
        '-DataRoot',
        dataRoot,
        '-RemoveData',
        '-TaskName',
        `AgentManager Core (m10 uninstall ${String(process.pid)})`,
        '-StartMenuRoot',
        join(root, 'startmenu'),
        '-DesktopRoot',
        join(root, 'desktop'),
      ]);

      expect(output).toContain('The data root was removed');
      expect(existsSync(dataRoot)).toBe(false);
    },
    POWERSHELL_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Verify-Install.ps1 — the criteria that cannot be automated
// ---------------------------------------------------------------------------

describe.runIf(onWindows)('Verify-Install.ps1', () => {
  it(
    'lists every M10 criterion that needs a human, and names its automated half',
    () => {
      const checklist = powershellFile(script('Verify-Install.ps1'), ['-InstallRoot', repoRoot]);
      for (const id of [
        'M10-fresh-account-install',
        'M10-logon-no-console',
        'M10-setup-auth-working-token',
      ]) {
        expect(checklist).toContain(id);
      }
      // Each item must say what *is* covered, so the split is explicit.
      expect(checklist).toContain('src/cli/scripts.test.ts');
      expect(checklist).toContain('src/cli/cli.test.ts');
    },
    POWERSHELL_TIMEOUT_MS,
  );
});
