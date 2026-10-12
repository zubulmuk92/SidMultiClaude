' launcher/SidMultiClaude.vbs - console-free fallback launcher (lead decision L4).
' Used by scripts/install.ps1 when csc.exe cannot build SidMultiClaude.exe. No supervisor: it only starts the hidden
' server with --open (window style 0 = hidden, no console). The server itself enforces the single instance: a second
' launch asks the running one (named pipe) to open a window and exits 0. The launcher never builds a URL.
' Usage: wscript.exe SidMultiClaude.vbs "<node.exe>" "<app>\src\server\main.ts"
Option Explicit
Dim sh, fso, node, main, cmd
If WScript.Arguments.Count < 2 Then
  MsgBox "Raccourci invalide : relancez l'installation (npm run install-app).", 16, "SidMultiClaude"
  WScript.Quit 2
End If
node = WScript.Arguments(0)
main = WScript.Arguments(1)
Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(node) Or Not fso.FileExists(main) Then
  MsgBox "Node.js ou l'application est introuvable : relancez l'installation (npm run install-app).", 16, "SidMultiClaude"
  WScript.Quit 2
End If
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(main)))
cmd = """" & node & """ """ & main & """ --open"
sh.Run cmd, 0, False
WScript.Quit 0
