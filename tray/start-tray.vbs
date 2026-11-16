' Start the tray host with no console window.
' Keep this file ASCII-only: Windows Script Host reads .vbs as ANSI, so UTF-8
' comments would corrupt the script.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
script = here & "\dsh-gateway-tray.ps1"
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"
shell.Run command, 0, False
