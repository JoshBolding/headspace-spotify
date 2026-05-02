' Headspace Spotify — silent launcher.
' Double-click to launch the app with no visible console window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c npx electron .", 0, False
