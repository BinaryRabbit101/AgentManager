' launch-core.vbs - the windowless launcher stub of foundation DESIGN section 4.3.
'
' > "`launch-core.vbs` is a three-line stub that runs `<install>\node\node.exe
' > <install>\app\main.js` with window style 0, because a Task Scheduler action
' > running a console executable in an interactive session flashes a console
' > window at every logon. (A packaged windowless launcher executable replaces
' > the stub post-v1; the stub is the simplest thing that works and needs no
' > build tooling.)"
'
' Window style 0 with bWaitOnReturn = False is the whole trick: wscript.exe is
' itself windowless, so the console the core would otherwise own is never
' created, and this script exits immediately while the core keeps running. The
' scheduled task's action is wscript.exe - not node.exe - for exactly this
' reason.
'
' Two reconciliations with section 4.3's sketch, both deliberate:
'
'   * The entry point is `dist\main.js` when present, `app\main.js` otherwise.
'     package.json's `files` list emits the built core to `dist\` and the web
'     bundle to `app\web\` (vite.config.ts), so `<install>\app\main.js` is the
'     design's shorthand rather than the built layout. Both are accepted.
'   * The runtime is `<install>\node\node.exe` when present, `node.exe` on PATH
'     otherwise, so a development checkout with no bundled runtime still starts.
'
' Usage:
'   wscript.exe "<install>\launch-core.vbs"          start the core, windowless
'   cscript.exe //Nologo "<...>\launch-core.vbs" /plan
'                                                    print what would be run and
'                                                    exit without starting it
'   ...  /install:"C:\some\root"                     override the install root
'
' `/plan` exists so the launcher is testable: the one thing that can be wrong
' here is the command line, and printing it is how a test reads it without
' starting a service.

Option Explicit

Dim fso, shell, args
Dim installRoot, nodeExe, entryPoint, commandLine, planOnly

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

planOnly = False
installRoot = fso.GetParentFolderName(WScript.ScriptFullName)

Dim i, arg
For i = 0 To args.Count - 1
  arg = args(i)
  If LCase(arg) = "/plan" Then
    planOnly = True
  ElseIf LCase(Left(arg, 9)) = "/install:" Then
    installRoot = Mid(arg, 10)
  End If
Next

' Strip a trailing separator so the joins below never produce "root\\dist".
If Len(installRoot) > 1 And Right(installRoot, 1) = "\" Then
  installRoot = Left(installRoot, Len(installRoot) - 1)
End If

nodeExe = installRoot & "\node\node.exe"
If Not fso.FileExists(nodeExe) Then
  nodeExe = "node.exe"
End If

entryPoint = installRoot & "\dist\main.js"
If Not fso.FileExists(entryPoint) Then
  entryPoint = installRoot & "\app\main.js"
End If

commandLine = """" & nodeExe & """ """ & entryPoint & """"

If planOnly Then
  WScript.Echo "installRoot=" & installRoot
  WScript.Echo "node=" & nodeExe
  WScript.Echo "entry=" & entryPoint
  WScript.Echo "command=" & commandLine
  WScript.Echo "windowStyle=0"
  WScript.Echo "wait=False"
  WScript.Quit 0
End If

If Not fso.FileExists(entryPoint) Then
  ' No console exists to print to at logon, so this goes where a scheduled task's
  ' failures are actually read: the Application event log, and a non-zero exit
  ' that Task Scheduler records as the last run result.
  shell.LogEvent 1, "AgentManager: cannot start, no core bundle at " & entryPoint
  WScript.Quit 2
End If

' Window style 0 = hidden. bWaitOnReturn = False so this stub exits at once and
' the core outlives it.
shell.Run commandLine, 0, False
WScript.Quit 0
