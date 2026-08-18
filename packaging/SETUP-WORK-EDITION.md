# Setting up AgentManager — work edition

This archive is a transfer copy of the AgentManager repository, built on {{BUILD_DATE}} from
commit **`{{COMMIT}}`** (`{{COMMIT_SUBJECT}}`), intended for a second Windows machine that should run **the core service and
the manager web UI, entirely locally**. No remote access, nothing reachable from another
machine.

The source tree is the tracked contents of that commit exactly — no files were removed or
edited to make this "work edition" build. The compiled `dist/` and `app/web/` are the only
additions, and they were built from that same commit.

Read this file first. It is the only file in the archive written for you rather than for
the project's own developers, and there are a few places where the rest of the
documentation describes features this edition does not run (see §8). If you already have
AgentManager installed and are here to update it, go straight to §7.

---

## 1. What "work edition" means, and what it does not mean

AgentManager ships as **one codebase with two editions** (architecture decision D6 in
`docs/architecture.md`). The edition is a *configuration value*, not a different build:

| | home edition | work edition (this one) |
|---|---|---|
| Remote listener module | loaded and started | **never loaded** |
| Non-loopback listeners | one, proven (Tailscale or a declared proxy LAN address) | **zero** |
| Autostart at logon | registered | **not registered** |
| `/api/remote/*` routes | present | absent from the route table |
| Default auth mode | `subscription` | `env` (see §5 — you will probably want to change this) |

Nothing has been deleted from this archive to achieve that. The remote module's source,
tests, docs and migrations are all present, exactly as they are in the repository. They
are simply never loaded when `edition` is `work`, and the config validator **refuses to
start at all** if a work-edition config also sets `modules.remote.enabled: true`.

**"No listen ports" means nothing bound to a non-loopback interface.** The core *does*
listen on `127.0.0.1:7477` — that is how the web UI is served to your own browser. That
loopback listener is required, and it is not reachable from any other machine.

You do not have to configure any of this. It is the work edition's bind-time invariant:
the core asserts after startup that every listener it owns is a loopback address, and
**exits fatally** if that is ever untrue. If you want to see the proof rather than take
my word for it, run `npm run test:boundary` (125 tests; it boots real processes and reads
the real socket table via `netstat`).

---

## 2. Prerequisites

- **Windows 10 or later.** The installer refuses anything older.
- **Node.js 22 or newer.** `package.json` pins `engines: { "node": ">=22" }`, and
  `scripts/AgentManager.Common.ps1` enforces major version 22 as the floor.
  - **Node 25 works.** It did not always: a pooled keep-alive socket left open at process
    exit made Node 25 abort with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
    during teardown, which made the installer report "the core did not answer /healthz
    within 60 s" against a core that was perfectly healthy. Fixed in commit **6fa2efb**
    (`fix(cli): close probe connections so health does not abort at exit`), which is
    included in this archive. If you see that assertion, you are running an older build,
    not a broken Node.
- **PowerShell 5.1** (the Windows built-in) is enough. All scripts declare
  `#Requires -Version 5.1`.
- **No administrator rights needed.** The installer is deliberately non-admin: it writes
  only under `%LOCALAPPDATA%` and your own Start Menu.

---

## 3. Unpack and install dependencies

Unpack the archive wherever you want the application to live — for example
`C:\Users\<you>\AgentManager`.

> **The unpacked folder is the install root.** The installer does not copy files
> somewhere else; it defaults `-InstallRoot` to the parent of the `scripts\` directory it
> is run from. So put the folder where you actually want it *before* installing, and do
> not move it afterwards without re-running the installer.

Then, from inside that folder:

```powershell
npm ci
```

`npm ci` installs exactly what `package-lock.json` pins. `node_modules` is deliberately
**not** in this archive — it is large, and it contains platform-specific binaries that
should be resolved on the machine that will use them.

### If `npm ci` fails on better-sqlite3

`better-sqlite3` is the one native dependency. Its install script may try a `node-gyp`
build, which fails on machines without Visual Studio Build Tools / Python. You do not
need that build:

```powershell
npm ci --ignore-scripts
```

better-sqlite3 ships precompiled binaries in `node_modules/better-sqlite3/prebuilds/`,
including `win32-x64.node`, and they load fine. (For what it is worth, the machine this
archive was built on has no `build/Release` directory at all — it has been running on the
prebuild the whole time.)

If you use `--ignore-scripts`, no other dependency in this project needs a postinstall
step, so nothing else is skipped that matters.

---

## 4. Run the installer

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Install-AgentManager.ps1 -Edition work
```

Pass `-Edition work` explicitly. If you omit it, the script prompts — and while the
prompt's fallback is `work`, being explicit is better than relying on that.

Useful flags:

- `-DryRun` — prints the full plan and changes nothing. Worth running first.
- `-DesktopShortcut` — also creates a desktop shortcut (Start Menu one is created by default).
- `-NoShortcuts`, `-NoStart` — skip those steps.
- `-DataRoot <path>` — override `%LOCALAPPDATA%\AgentManager`.

The script is **idempotent**: re-running it makes no second backup, does not clobber your
`config.json` (it merges only the `edition` key), and writes nothing inside the library
directory. What it does, in order:

1. Verifies Windows and Node.
2. Creates the data-root tree at `%LOCALAPPDATA%\AgentManager` and tightens its ACL to
   your user account, including the `library\` directory.
3. Writes `%LOCALAPPDATA%\AgentManager\config\config.json` with `"edition": "work"`.
4. Runs `agentmanager migrate` to create the SQLite schema.
5. **Skips autostart registration** — and says so, with the reason: *"the work edition
   does not start a background runner at logon"*. No scheduled task is created. If you
   later decide you want one, that is `scripts\Register-Autostart.ps1`, run deliberately
   by you; nothing in this edition does it for you.
6. Creates a Start Menu shortcut. Note it points at the **core launcher**, not at a
   desktop app — see §9.
7. Starts the core (windowless, via `launch-core.vbs`) and waits for `/healthz`.
8. Prints the local URL and the next two steps.

The core will be at **`http://127.0.0.1:7477`** unless that port is taken; the port
actually bound is always published in `%LOCALAPPDATA%\AgentManager\run\core.port`.

---

## 5. Authentication

Run this **after** the installer. The core does not need to be running, but the order
still matters — see "Why after the installer" below.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Setup-Auth.ps1
```

This runs `claude setup-token`, reads the resulting token from the console as a
`SecureString` (never echoed, never a command-line argument, never logged), and stores it
in the Windows DPAPI secret store under the key `claude.oauthToken`. Use `-DryRun` to see
exactly what it would do, including the command line the token would be handed to — the
point being that the token is not in it.

### The script tells you whether the token will actually be used

There is a real trap here, and the script catches it for you. `config/edition.work.json`
sets `"auth": { "mode": "env" }` — deliberately, because D6 describes the work edition as
authenticating "via whatever the workplace provides (API key/Bedrock)". Under `env` the
runner sets **no** auth environment variables at all and defers to the machine's own
environment. So a token stored on a default work-edition install is stored correctly and
then never read.

After storing the secret, `Setup-Auth.ps1` reads the effective `auth.mode` back from
`agentmanager health --json` and reports one of three outcomes:

- `auth.mode is "subscription": the core will use this token.` — you are done.
- A **warning** that `auth.mode is "env", not "subscription" - the runner will NOT use the
  token you just stored`, followed by the exact JSON to paste. Follow it.
- A warning that it *could not read* `auth.mode` at all, which means the config could not
  be resolved. Check `auth.mode` in your `config.json` yourself before trusting the setup.

So: run the script, read its last few lines, and act on them. For the common case — a
personal machine where you want to use your Claude Max subscription — the fix it prints is
to add this to `%LOCALAPPDATA%\AgentManager\config\config.json`:

```json
{
  "edition": "work",
  "auth": { "mode": "subscription" }
}
```

`config.json` is configuration layer 3 and the edition file is layer 2, so this overrides
it cleanly — it is the supported mechanism, not a hack. Restart the core afterwards.

Under `subscription`, the runner resolves `claude.oauthToken` into
`CLAUDE_CODE_OAUTH_TOKEN` for each session, and additionally *strips* `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK` and friends from the agent environment,
because the SDK would otherwise silently prefer them over your subscription. If the secret
is missing, sessions fail with a clear `secret_unresolved` error naming `Setup-Auth.ps1`.

**If you want API key or Bedrock auth instead**, leave `auth.mode` as `env`, set
`ANTHROPIC_API_KEY` (or the Bedrock variables) in the environment the core runs under, and
do not run `Setup-Auth.ps1` at all.

Either way: **do not set `ANTHROPIC_API_KEY` in the user or machine environment if you are
using subscription auth.** It silently overrides subscription auth for every process
started afterwards. Both `Setup-Auth.ps1` and the core's boot warning tell you if it is
set; believe them.

### Why after the installer

The check does not need a running core — `agentmanager health --json` reads `auth.mode`
from resolved configuration, and answers perfectly well with the core stopped. The reason
to install first is different, and it is about *which* configuration gets resolved.

Until the installer runs, `<dataRoot>\config\config.json` does not exist. With no
machine-local config to name an edition, resolution falls back to the shipped defaults in
`config/defaults.json` — and that file's edition is **`work`**, chosen so an unconfigured
install can never open a remote listener. `auth.mode` therefore resolves to `"env"`
regardless of which edition you actually intend to install.

Run `Setup-Auth.ps1` before the installer and you will get the `env` warning even on a
machine destined for the *home* edition. The warning would be accurate about the state of
the machine at that moment and misleading about the install you are in the middle of
creating. Once the installer has written `config.json` with your chosen edition, the check
reports the truth about *this* install — which is the thing you actually want to know.

### `.env` is not part of this

There is an `.env.example` in the archive. It is a template listing which keys exist, with
no values, and it is used **only** by `npm run test:live` — a developer command that spends
real plan quota. The installed service never reads it. Populating `.env` is not a
substitute for `Setup-Auth.ps1`, and the real `.env` from the source machine was
deliberately excluded from this archive.

---

## 6. Confirm it works

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Test-AgentManagerHealth.ps1
```

Read-only diagnostics: nothing is created, started, stopped or repaired. It reports the
edition, resolved data root, scheduled-task state, **listening ports**, the `/healthz`
payload, `PRAGMA quick_check` on the database, which secret provider is in use, whether
`ANTHROPIC_API_KEY` is present, and the last 50 log lines. Add `-Json` for machine-readable
output.

What a correct work-edition install looks like in that report:

- Edition: `work`.
- Listening ports: loopback only. Nothing on `0.0.0.0`, nothing on a LAN address.
- Scheduled task: absent. That is correct, not a failure.
- Tailscale section: *"Not checked: Tailscale applies to the home edition only."* Also
  correct — see §8.

Then open `http://127.0.0.1:7477` in a browser.

---

## 7. Updating an existing install

Everything above is the first install. When a newer archive arrives, you are replacing the
contents of the install root **in place** — and that is all. Nothing is re-registered,
because the installer registered *this folder* rather than a copy of it (§3): the Start
Menu shortcut, the data root and the edition all point at the path, not at the files.

> **Do not re-run `Install-AgentManager.ps1`, and do not re-run `Setup-Auth.ps1`.** Neither
> is harmful, but neither does anything an update needs.

### What is not in the archive, and therefore not at risk

All runtime state lives under `%LOCALAPPDATA%\AgentManager` and no part of it travels in
the zip: the database, the logs, the library and its git history, and the OAuth token in
the secret store. Your `config.json` there is the machine layer — it outranks the shipped
`config\defaults.json` that the archive *does* replace, so the `edition: work` you chose at
install time survives an update even though the defaults file underneath it changes.

### Two things to check in the new archive first

- **`package-lock.json`** — if it differs from the one you have, run `npm ci` after
  unpacking. If it does not, your `node_modules` is still exactly right and `npm ci` is
  wasted minutes. (`node_modules` is not in the archive. That is precisely why unpacking
  *over* an install works and unpacking into an empty folder leaves you with something that
  will not start.)
- **`migrations\`** — new files mean a schema change. There is nothing for you to run: the
  core applies element-owned migrations at its next start. It is worth knowing so that a
  slower-than-usual first boot reads as expected rather than as a hang.

### The procedure

```powershell
# 1. Stop the core. This edition has no scheduled task (§4), so ask it over HTTP.
#    The port is in %LOCALAPPDATA%\AgentManager\run\core.port — 7477 unless you changed it.
Invoke-RestMethod -Method Post http://127.0.0.1:7477/api/service/shutdown

# 2. Delete the build outputs. The archive carries both, fully built.
Remove-Item -Recurse -Force .\dist, .\app

# 3. Unpack the new archive over this folder, replacing when prompted.

# 4. Only if package-lock.json changed:
npm ci                                                                    # or: npm ci --ignore-scripts

# 5. Start it again — the same launcher the Start Menu shortcut uses.
wscript.exe .\launch-core.vbs

# 6. Confirm.
powershell -ExecutionPolicy Bypass -File .\scripts\Test-AgentManagerHealth.ps1
```

Step 1 is not optional in practice. Windows will not overwrite a file the running core
holds open, and a core that survives the copy carries on serving the old `dist\main.js`
whatever is now on disk. `uptime` in `/api/health` resetting to a few seconds is how you
know step 5 actually replaced the process rather than finding one already running.

### Why step 2 is there

Unpacking over a folder **adds and overwrites; it never deletes.** Two kinds of leftover
accumulate if you skip it:

- **Old hashed web assets** in `app\web\assets\`, one set per build, ~400 KB each.
  `index.html` names the current hash, so they are dead weight rather than a hazard.
- **Source files deleted upstream** stay behind. Nothing imports them, so they cannot
  affect the running core — but they are still compiled by `npm run typecheck:web`, so a
  file that was deleted for a reason can fail a check on your machine that passes on the
  machine the archive was built on.

Deleting `dist\` and `app\` handles the first completely. It cannot handle the second,
because those files live in `src\` and `web\src\` alongside the ones you are keeping.

### If you want an exact tree rather than a merged one

Unpack beside the install instead of into it, carry `node_modules` across, and swap the two
folders. The install root path never changes, so nothing needs re-registering:

```powershell
# with the core stopped, from the parent directory
Expand-Archive .\AgentManager-work-edition-<date>.zip -DestinationPath .\AgentManager.new
Move-Item .\AgentManager\node_modules .\AgentManager.new\node_modules
Rename-Item .\AgentManager AgentManager.old
Rename-Item .\AgentManager.new AgentManager
cd .\AgentManager
wscript.exe .\launch-core.vbs
```

Keep `AgentManager.old` until the health check passes, then delete it. If you added
anything to the install root yourself — a `.env`, notes, a modified `config\` file — carry
it across before you do, because a swap is the one method that genuinely discards what you
do not move.

---

## 8. What is inert in this edition

The archive contains the complete project documentation, and a good deal of it describes
remote access. **None of it applies to this install.** Treat the following as background
reading about the home edition, not as setup you have missed:

| Location | What it describes | Status here |
|---|---|---|
| `docs/remote/` (README, DESIGN, IMPLEMENTATION) | The entire remote listener element — Tailscale binding, the proxy-host bind mode, bearer tokens, device pairing, QR codes | Module never loaded. Nothing to configure. |
| `docs/architecture.md` **D5** | "Remote access: Tailscale-only + bearer token", and its 2026-08-17 amendment about a household proxy host | Applies to the home edition only. |
| `README.md` — the "Remote access" bullet and tailnet mentions | Same | Same |
| `config/defaults.json` → the whole `remote: { ... }` block | Bind mode, ports, token TTLs, auth lockout, streaming tickets | Present and validated, never used. `modules.remote.enabled` is `false`, and the work edition **refuses to boot** if you set it `true`. |
| `config/edition.home.json` | The home edition's deltas — remote on, autostart on, notifications on | Not read. Only `edition.work.json` is. |
| `migrations/remote/` | Remote module's own schema migrations | Element-owned; applied only when the module loads. |
| `scripts/Test-AgentManagerHealth.ps1` — the Tailscale section | Detects a Tailscale network adapter | Prints "Not checked: Tailscale applies to the home edition only." |
| UI: Settings page, remote/pairing sections | Remote access status, pairing, device tokens | Hidden. The page instead states plainly: *"Remote access is not available in the work edition."* The routes do not exist to be disabled. |
| `docs/ui/DESIGN.md` — remote sections; `docs/foundation/DESIGN.md` — tailnet mentions | Design-level treatment of the above | Background only. |

`README.md` also notes that remote milestone M9 — the phone end-to-end pass — is the one
milestone still open. That is a home-edition concern and does not affect this install.

There is **no mini-PC-specific content** in this archive. The mini-PC appears only as
architectural prose — D5's amendment names it as the household's proxy host, in the
abstract — and as fixture data in the remote module's tests (a peer named `minipc` on the
placeholder tailnet `example-tailnet.ts.net`). There are no IP addresses, no deployment
configuration, and no credentials for it. That project lives elsewhere.

---

## 9. Other things worth knowing before you start

- **There is no packaged desktop app.** `docs/architecture.md` D3 describes the UI as
  "Electron-wrapped locally", and `electron/` source is present and typechecked — but
  `electron` is not a dependency in `package.json`, there is no Electron build script, and
  `npm run build` compiles `src/` only, so `dist/` contains no Electron output. `README.md`
  names this as one of the project's two open gaps. **Use the browser at
  `http://127.0.0.1:7477`.** The Start Menu shortcut launches the *core service*
  windowless via `launch-core.vbs`; it is not an application window.

- **The work edition is more conservative than the home edition in three ways you may
  notice**, all from `config/edition.work.json`:
  - `runner.maxConcurrent: 1` — one agent session at a time (home allows 2). Raise it in
    `config.json` if you want more.
  - `policy.allowPermissionElevation: false` — agents cannot request elevated tool
    permissions mid-session. This is a safety default for a work machine; change it
    knowingly or not at all.
  - `orchestrator.notify.enabled: false` — no outbound notifications.

- **All runtime state lives outside this folder**, under `%LOCALAPPDATA%\AgentManager`
  (database, logs, secrets, library, `run/core.port`). Nothing is written back into the
  install directory. That also means uninstalling by deleting this folder leaves your data
  behind; use `scripts\Uninstall-AgentManager.ps1` (and `-RemoveData` if you mean it).

- **`dist/` and `app/web/` are prebuilt in this archive** and are normally git-ignored.
  They were built fresh on {{BUILD_DATE}} from commit `{{COMMIT}}`, the same commit as the source
  here. If you change any source, rebuild with `npm run rebuild`.

- **The gate, if you want to verify the machine before trusting it:**
  ```powershell
  npm run test:boundary   # 125 tests — the D5/D6 edition and binding proofs
  npm run ci              # lint, typecheck (x3), build, build:web, full suite (~3,290 tests)
  ```
  Both passed at this commit immediately before this archive was created.

---

## 10. The short version

**First install** — from the unpacked folder:

```powershell
npm ci                                                                              # or: npm ci --ignore-scripts
powershell -ExecutionPolicy Bypass -File .\scripts\Install-AgentManager.ps1 -Edition work -DryRun
powershell -ExecutionPolicy Bypass -File .\scripts\Install-AgentManager.ps1 -Edition work
powershell -ExecutionPolicy Bypass -File .\scripts\Setup-Auth.ps1                   # AFTER the installer; read its last lines — see §5
powershell -ExecutionPolicy Bypass -File .\scripts\Test-AgentManagerHealth.ps1
start http://127.0.0.1:7477
```

**Update** (§7) — from the existing install root, which is where it already lives:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:7477/api/service/shutdown
Remove-Item -Recurse -Force .\dist, .\app
# unpack the new archive over this folder, replacing when prompted
npm ci                                                                              # only if package-lock.json changed
wscript.exe .\launch-core.vbs
powershell -ExecutionPolicy Bypass -File .\scripts\Test-AgentManagerHealth.ps1
```
