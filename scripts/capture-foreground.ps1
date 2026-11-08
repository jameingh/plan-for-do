Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinApi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out WinRect r);
  public struct WinRect { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -TypeDefinition $sig -Language CSharp

$h = [WinApi]::GetForegroundWindow()
$buf = New-Object System.Text.StringBuilder 512
[void][WinApi]::GetWindowText($h, $buf, $buf.Capacity)
$title = $buf.ToString()
Write-Output ("foreground window: " + $title)

# Guard: never capture (or click) unless our own window is really on top.
if ($title.IndexOf([char]0x671D + [char]0x66AE) -lt 0) {
  Write-Output "ABORT: foreground is not the planfordo window"
  exit 0
}

$rc = New-Object WinApi+WinRect
[void][WinApi]::GetWindowRect($h, [ref]$rc)
$w = $rc.Right - $rc.Left
$hh = $rc.Bottom - $rc.Top
if ($w -le 0 -or $hh -le 0) { Write-Output "ABORT: bad window rect"; exit 0 }

$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rc.Left, $rc.Top, 0, 0, (New-Object System.Drawing.Size $w, $hh))
$out = Join-Path $PSScriptRoot "..\tmp\foreground-capture.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("saved: " + (Resolve-Path $out) + " " + $w + "x" + $hh)
