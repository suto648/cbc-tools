' =============================================================
'  CbC Tools - single entry point.
'  Starts the tray agent with no console window at all.
'
'  ASCII ONLY on purpose: WSH reads .vbs using the system code
'  page, so Japanese text here would be mangled. All Japanese
'  lives on the PowerShell side (tray.ps1, saved with a BOM).
'
'  Usage:
'    cbc.vbs           - start and open the window
'    cbc.vbs /silent   - start without opening the window (logon task)
' =============================================================
Option Explicit

Dim sh, fso, here, ps1, extra, i, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1  = fso.BuildPath(here, "tray\tray.ps1")

If Not fso.FileExists(ps1) Then
    MsgBox "tray.ps1 not found:" & vbCrLf & ps1, 16, "CbC Tools"
    WScript.Quit 1
End If

extra = ""
For i = 0 To WScript.Arguments.Count - 1
    If LCase(WScript.Arguments(i)) = "/silent" Then extra = " -Silent"
Next

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """" & extra
sh.Run cmd, 0, False
