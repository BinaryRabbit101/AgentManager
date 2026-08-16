# Foundation

The Node service skeleton and every cross-cutting concern no feature element owns. This element exists so roster, runner, orchestrator, etc. don't each invent their own storage, config, and logging — their designs must build on what is decided here.

## Responsibilities

- **Storage**: one decision for the whole app — where roster definitions, project registry, session history/transcripts, and orchestrator mailboxes live. Leaning: SQLite for structured state + plain files for personas/transcripts (git-friendly), but the design decides.
- **Config & editions**: the config system that makes home vs. work a configuration, not a fork (architecture D6) — which modules start, bind addresses, concurrency cap, auth mode.
- **Secrets**: safe storage of `CLAUDE_CODE_OAUTH_TOKEN` and remote bearer tokens on Windows (DPAPI / Windows Credential Manager vs. plain `.env`), and keeping them out of git.
- **Service lifecycle on Windows**: how the "always-running" core actually runs — Task Scheduler / NSSM-style service vs. started by the Electron app; survive reboots for the home edition; the PowerShell install/setup scripts.
- **Logging**: core service logs (distinct from agent session transcripts), rotation, where the UI reads them from.
- **Module system**: how elements register with the core so the work edition can cleanly omit the remote listener.

## Depends on

Nothing. Everything depends on it — design this first (in parallel with roster/projects is fine, but its storage and config decisions must land before runner/orchestrator design).

## Open questions for design

- SQLite + files split as above, or single store?
- Does the core run headless with Electron as a pure client, or does Electron own the core process locally? (Remote access while the desktop app is closed argues for headless.)
- One config file vs. layered (defaults → edition → machine-local)?
- Windows autostart mechanism that a non-admin install can use.
