// Draw a 32x32 tray icon (dark rounded square + lock glyph) and wrap it as a
// single-image .ico. Kept dependency-free: System.Drawing draws, this script
// assembles the ICO container around the PNG payload.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BUILD = join(ROOT, 'build')
const PNG = join(BUILD, 'tray-icon.png')
const ICO = join(ROOT, 'tray', 'gateway.ico')

mkdirSync(BUILD, { recursive: true })
mkdirSync(join(ROOT, 'tray'), { recursive: true })

const draw = String.raw`
Add-Type -AssemblyName System.Drawing
$size = 32
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 23, 26, 33))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 7
$path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
$path.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
$path.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
$path.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
$path.CloseFigure()
$g.FillPath($bg, $path)

$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 122, 167, 255))
$g.FillRectangle($accent, 9, 15, 14, 11)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 122, 167, 255)), 3
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($pen, 11, 7, 10, 12, 180, 180)

$keyhole = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 23, 26, 33))
$g.FillEllipse($keyhole, 14, 18, 4, 4)
$g.FillRectangle($keyhole, 15, 21, 2, 3)

$g.Dispose()
$bmp.Save('${PNG.replaceAll('\\', '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'drawn'
`

execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', draw], { stdio: 'inherit' })

const png = readFileSync(PNG)
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // image count

const entry = Buffer.alloc(16)
entry.writeUInt8(32, 0) // width
entry.writeUInt8(32, 1) // height
entry.writeUInt8(0, 2) // palette
entry.writeUInt8(0, 3) // reserved
entry.writeUInt16LE(1, 4) // color planes
entry.writeUInt16LE(32, 6) // bits per pixel
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(6 + 16, 12)

writeFileSync(ICO, Buffer.concat([header, entry, png]))
console.log(`wrote ${ICO} (${(readFileSync(ICO).length / 1024).toFixed(1)} KB)`)
