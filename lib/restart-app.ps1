# dsh-oneclick-restart restarter.
#
# Started by the Windows scheduled task (DSHOneClickRestart) through the hidden
# wscript shell (restart-app.vbs), so it lives outside the DSH host process tree:
# the host can be killed by this script and still be relaunched by it.
#
# ASCII only on purpose: PowerShell 5.1 reads BOM-less files as ANSI, so any
# non-ASCII comment would be mangled. Keep this file plain ASCII.
#
# Flow: buffer delay -> WM_CLOSE (graceful) -> taskkill /T /F if it survives ->
# verify the target is really gone -> relaunch detached -> post-check -> drop the
# scheduled task.
param([string]$Config)
$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Config) { $Config = Join-Path $here 'target.json' }
$cfg = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
$log = $cfg.log

function L($m) {
  try { Add-Content -LiteralPath $log -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8 } catch { }
}
function Alive($id) { return [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }
function DropTask() {
  try { schtasks /delete /tn $cfg.task /f 2>&1 | Out-Null } catch { }
}

# Belt and suspenders: if we were still started attached to a visible console,
# hide that console window before doing anything else. When launched through
# wscript there is no visible window at all and this is a no-op.
try {
  $sig = '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();'
  $sig += '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
  $k = Add-Type -MemberDefinition $sig -Name DshHideConsole -Namespace DshRestart -PassThru -ErrorAction Stop
  $hwnd = $k::GetConsoleWindow()
  if ($hwnd -ne [IntPtr]::Zero) {
    $null = $k::ShowWindow($hwnd, 0)
    L 'own console window hidden'
  }
} catch { }

L "begin: mode=$($cfg.mode) pid=$($cfg.pid) exe=$($cfg.exe)"
Start-Sleep -Milliseconds ([int]$cfg.delayMs)

# The target pid must really be the one we mean to restart: if it is gone, do
# nothing at all - never start a second copy.
if (-not (Alive $cfg.pid)) {
  L "abort: pid $($cfg.pid) already gone"
  DropTask
  exit 0
}

$proc = Get-Process -Id $cfg.pid -ErrorAction SilentlyContinue
if ($proc) {
  try { $null = $proc.CloseMainWindow(); L 'sent WM_CLOSE' } catch { L "WM_CLOSE failed: $($_.Exception.Message)" }
  for ($i = 0; $i -lt 12; $i++) {
    if (-not (Alive $cfg.pid)) { break }
    Start-Sleep -Milliseconds 500
  }
}

if (Alive $cfg.pid) {
  L 'still alive; killing process tree'
  & taskkill.exe /PID $cfg.pid /T /F 2>&1 | Out-Null
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Alive $cfg.pid)) { break }
    Start-Sleep -Milliseconds 500
  }
}

if (Alive $cfg.pid) {
  L "abort: pid $($cfg.pid) survived termination"
  DropTask
  exit 1
}

if ($cfg.expectName) {
  $left = @(Get-Process -Name $cfg.expectName -ErrorAction SilentlyContinue)
  if ($left.Count -gt 0) {
    L ("abort: {0} process(es) named {1} still alive" -f $left.Count, $cfg.expectName)
    DropTask
    exit 1
  }
}

Start-Sleep -Milliseconds 900
try {
  # Start-Process uses ShellExecute, so the new GUI process gets its own window
  # station session and does NOT inherit this console: closing or destroying the
  # restarter's console can never take the relaunched DSH down with it.
  if ($cfg.args) {
    $new = Start-Process -FilePath $cfg.exe -ArgumentList $cfg.args -WorkingDirectory $cfg.workdir -PassThru
  } else {
    $new = Start-Process -FilePath $cfg.exe -WorkingDirectory $cfg.workdir -PassThru
  }
  if ($new) { L "relaunch issued: $($cfg.exe) pid=$($new.Id)" } else { L "relaunch issued: $($cfg.exe)" }
} catch {
  L "relaunch failed: $($_.Exception.Message)"
}

Start-Sleep -Milliseconds 2500
if ($cfg.expectName) {
  $n = @(Get-Process -Name $cfg.expectName -ErrorAction SilentlyContinue).Count
  L "post-check: $n process(es) named $($cfg.expectName)"
}
DropTask
L 'done'
