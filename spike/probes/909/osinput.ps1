param([string]$op, [int]$x = 0, [int]$y = 0, [string]$text = '', [int]$expectPid = 0)
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class U {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
[U]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Windows.Forms

function FgInfo {
  $h = [U]::GetForegroundWindow(); $p = 0
  [U]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  $c = New-Object System.Text.StringBuilder 256; [U]::GetClassName($h, $c, 256) | Out-Null
  $t = New-Object System.Text.StringBuilder 256; [U]::GetWindowText($h, $t, 256) | Out-Null
  $name = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
  return @{ pid = $p; cls = $c.ToString(); title = $t.ToString(); name = $name }
}
$fg = FgInfo
if ($op -eq 'fg') { "$($fg.pid)|$($fg.name)|$($fg.cls)|$($fg.title)"; exit 0 }
# SAFETY: never send input unless the foreground window belongs to electron
if ($fg.name -ne 'electron') { "REFUSED fg=$($fg.name)|$($fg.cls)|$($fg.title)"; exit 3 }
switch ($op) {
  'click' { [U]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 80; [U]::mouse_event(2,0,0,0,[IntPtr]::Zero); [U]::mouse_event(4,0,0,0,[IntPtr]::Zero) }
  'type'  { [System.Windows.Forms.SendKeys]::SendWait($text) }
}
"OK fg=$($fg.name)|$($fg.cls)|$($fg.title)"
