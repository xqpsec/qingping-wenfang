# cover-compose.ps1 -- crop/resize the raw AI image to the platform cover size and draw title + pen name.
# Args: -Job <json file, UTF-8>  { src, out, width, height, title, penName }
# ASCII-only on purpose (Windows PowerShell 5.1 reads scripts as ANSI); all Chinese text comes from the UTF-8 json.
param([Parameter(Mandatory = $true)][string]$Job)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$j = [System.IO.File]::ReadAllText($Job, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$W = [int]$j.width; $H = [int]$j.height
$src = [System.Drawing.Image]::FromFile($j.src)
# center-crop to target aspect
$ta = $W / $H; $sa = $src.Width / $src.Height
$noText = ($j.noText -eq $true)
if ($sa -gt $ta) { $ch = $src.Height; $cw = [int]($ch * $ta); $cx = [int](($src.Width - $cw) / 2); $cy = 0 }
elseif ($noText) { $cw = $src.Width; $ch = [int]($cw / $ta); $cx = 0; $cy = [int](($src.Height - $ch) / 2) }  # AI-drawn text mode: centered crop, text sits in the safe area
else { $cw = $src.Width; $ch = [int]($cw / $ta); $cx = 0; $cy = [int](($src.Height - $ch) / 4) }
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.PixelOffsetMode = 'HighQuality'
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $W, $H), $cx, $cy, $cw, $ch, [System.Drawing.GraphicsUnit]::Pixel)
$src.Dispose()
if ($noText) { $g.Dispose(); $bmp.Save($j.out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); Write-Output "OK $W x $H (ai text)"; exit 0 }

function Fam($names) { foreach ($n in $names) { try { $f = New-Object System.Drawing.FontFamily $n; return $f } catch {} }; return [System.Drawing.FontFamily]::GenericSansSerif }
$fam = Fam @('Microsoft YaHei', 'SimHei', 'DengXian')

# top gradient so the title is readable on any image
$topH = [int]($H * 0.42)
$gr = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Rectangle 0, 0, $W, $topH), ([System.Drawing.Color]::FromArgb(170, 0, 0, 0)), ([System.Drawing.Color]::FromArgb(0, 0, 0, 0)), 90
$g.FillRectangle($gr, 0, 0, $W, $topH)

function DrawOutlined($text, $rect, $size, $fill, $align) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = $align; $sf.LineAlignment = 'Near'
  $path.AddString($text, $fam, [int][System.Drawing.FontStyle]::Bold, $size, $rect, $sf)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 20, 10, 5)), ([single]($size / 7)); $pen.LineJoin = 'Round'
  $g.DrawPath($pen, $path); $g.FillPath((New-Object System.Drawing.SolidBrush $fill), $path)
}

# title: split into at most 2 lines at a comma, otherwise in the middle
$t = [string]$j.title
$lines = @($t)
if ($t.Length -gt 9) {
  $i = $t.IndexOfAny([char[]]@([char]0xFF0C, [char]0x3001, ',', ' '))
  if ($i -gt 2 -and $i -lt $t.Length - 2) { $lines = @($t.Substring(0, $i), $t.Substring($i + 1)) }
  else { $m = [int][math]::Ceiling($t.Length / 2); $lines = @($t.Substring(0, $m), $t.Substring($m)) }
}
if ($j.titleLines) { $lines = @($j.titleLines) }
$maxLen = ($lines | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
$size = [math]::Min([single]($W * 0.86 / [math]::Max(1, $maxLen)), [single]($W * 0.13))
$y = [single]($H * 0.05)
$gold = [System.Drawing.Color]::FromArgb(255, 255, 226, 120)
foreach ($ln in $lines) {
  DrawOutlined $ln (New-Object System.Drawing.RectangleF 0, $y, $W, ($size * 1.5)) $size $gold 'Center'
  $y += $size * 1.22
}
if ($j.penName) {
  $ps = [single]($W * 0.042)
  DrawOutlined ([string]$j.penName + ' ' + [char]0x8457) (New-Object System.Drawing.RectangleF 0, ($H - $ps * 2.4), ($W - $W * 0.05), ($ps * 2)) $ps ([System.Drawing.Color]::White) 'Far'
}
$g.Dispose()
$bmp.Save($j.out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "OK $W x $H"
