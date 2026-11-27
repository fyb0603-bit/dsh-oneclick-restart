' dsh-oneclick-restart 的隐藏启动壳。
'
' 为什么要这一层：schtasks 拉起控制台程序时会分配一个控制台窗口，powershell 的
' -WindowStyle Hidden 只改窗体内核的外观时机，窗口对象仍然存在，用户能看到也能关掉；
' 一旦关掉，同一 console 的 CRT 会给所有附着进程投递 CTRL_CLOSE，连带把新起的 DSH 杀掉。
' 走 wscript + WScript.Shell.Run(cmd, 0, False)：窗口样式 0 = 不显示窗口，
' 且 wscript 本身没有控制台（GUI 子系统），powershell 随之拿到的是隐藏控制台。
'
' 参数全部自寻址：默认取脚本同目录的 restart-app.ps1 / target.json，
' 这样计划任务的 /tr 只有一条短命令，避免多层引号地狱。
Option Explicit

Dim fso, sh, here, ps1, cfg, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "restart-app.ps1")
cfg = fso.BuildPath(here, "target.json")

If WScript.Arguments.Count >= 1 Then ps1 = WScript.Arguments(0)
If WScript.Arguments.Count >= 2 Then cfg = WScript.Arguments(1)

cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden" & _
      " -ExecutionPolicy Bypass -File """ & ps1 & """ -Config """ & cfg & """"

sh.Run cmd, 0, False
