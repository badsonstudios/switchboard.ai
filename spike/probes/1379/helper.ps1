# #756 probe helper: a long-lived PowerShell that answers one command per
# stdin line, so each measurement costs a pipe round trip rather than a
# PowerShell start-up.
#
#   fg              -> "pid|process|title" of the OS foreground window
#   at X Y          -> "pid|process|title" of the top-level window at a
#                      PHYSICAL screen point (is it stacked in front?)
#   grab [TITLE]    -> hand the foreground to the holder window (or the
#                      top-level window titled TITLE). Uses the
#                      ALT-key unlock so the HOLDER can take it; the probe
#                      checks the result with `fg` rather than trusting it.
#   shift           -> one Shift tap, delivered to whatever is foreground:
#                      "the user just typed in the other app". Shift types
#                      nothing.
#   quit
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class U {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
[U]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

function Describe([IntPtr]$h) {
  $p = 0
  [U]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  $t = New-Object System.Text.StringBuilder 256
  [U]::GetWindowText($h, $t, 256) | Out-Null
  $name = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
  return "$p|$name|$($t.ToString())"
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(' ')
  $out = 'ERR'
  switch ($parts[0]) {
    'fg' { $out = Describe ([U]::GetForegroundWindow()) }
    'at' {
      $pt = New-Object U+POINT
      $pt.X = [int]$parts[1]; $pt.Y = [int]$parts[2]
      $h = [U]::GetAncestor([U]::WindowFromPoint($pt), 2)
      $out = Describe $h
    }
    'grab' {
      $title = 'probe-756-holder'
      if ($parts.Length -gt 1) { $title = $parts[1] }
      $h = [U]::FindWindow([NullString]::Value, $title)
      if ($h -eq [IntPtr]::Zero) { $out = 'NOHOLDER' }
      else {
        # ALT down/up: the documented-in-folklore unlock for the probe's OWN
        # stand-in app. The product does not do this; see the findings note.
        [U]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
        [U]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
        $ok = [U]::SetForegroundWindow($h)
        $out = "grab=$ok"
      }
    }
    'click' {
      [U]::SetCursorPos([int]$parts[1], [int]$parts[2]) | Out-Null
      Start-Sleep -Milliseconds 60
      [U]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
      [U]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
      $out = 'OK'
    }
    'shift' {
      [U]::keybd_event(0x10, 0, 0, [IntPtr]::Zero)
      [U]::keybd_event(0x10, 0, 2, [IntPtr]::Zero)
      $out = 'OK'
    }
    'quit' { exit 0 }
  }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
