# #756 probe: the "other app" that holds the foreground while the probe's
# Electron window tries to take it. A plain WinForms window in its own
# process, big enough to cover the probe window, titled so helper.ps1 can
# find it. Closed by the probe (process kill) when the run ends.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class H {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
}
"@
[H]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'probe-756-holder'
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(0, 0)
$f.Size = New-Object System.Drawing.Size(1100, 800)
$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true
$tb.Dock = 'Fill'
$tb.Text = 'switchboard.ai #756 probe - this window stands in for the app you are typing in.'
$f.Controls.Add($tb)
[System.Windows.Forms.Application]::Run($f)
