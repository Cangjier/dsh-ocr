using namespace Windows.Media.Ocr
using namespace Windows.Globalization
using namespace Windows.Graphics.Imaging

# OCR a PNG file and print the recognised lines as JSON.
#
# Windows ships an OCR engine, but it is only reachable through WinRT, which PowerShell 5.1
# cannot await directly. This wraps that up so the rest of the system can treat OCR as an
# ordinary command.
#
# Why this exists rather than "the agent looks at the screenshot": OCR returns text WITH pixel
# coordinates in about 140 ms for a full screen. That makes it usable inside an automation loop
# — find a label, click where the label is — whereas asking a model to read every frame costs
# seconds per step.
#
# Accuracy note, measured on a real screen: Chinese labels on a document page came out
# correctly, but small mixed-script text degraded (`TypeScript` was read as `TvoeScriDt`).
# Treat the text as a locator and a hint, not as ground truth for data extraction. That is why
# this is the zero-install fallback: install a real engine (`text_setup {action:"install"}`)
# whenever the text itself has to be right.
#
# Usage:
#   ocr.ps1 -Path shot.png [-Language zh-Hans-CN] [-Region x,y,w,h] [-Scale 3]
#
# Output: JSON { language, lineCount, elapsedMs, lines: [ { text, x, y, width, height } ] }

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Language = 'zh-Hans-CN',
  [string]$Region,
  [int]$Scale = 1
)

$ErrorActionPreference = 'Stop'

# Force UTF-8 on the way out. PowerShell 5.1 writes stdout using the console code page, so
# recognised Chinese reaches a Node parent as mojibake and every lookup silently fails: the OCR
# result is correct, but the caller cannot match against it.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Path)) { throw "no such image: $Path" }

# WinRT types must be written as bracketed literals carrying the ContentType marker:
#   [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
# A runtime lookup such as [Type]::GetType('...') returns a CLR shadow type instead, and an
# instance created from that shadow type is rejected by the engine with the baffling error
# "cannot convert Windows.Globalization.Language to Windows.Globalization.Language".

# PowerShell cannot await a WinRT IAsyncOperation; AsTask converts it to a .NET Task.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

# Load the image, cropping and upscaling when asked. Upscaling matters: the engine does much
# better on small UI text when the glyphs are physically larger in the bitmap. Coordinates are
# mapped back to the ORIGINAL image's space, so they can be used to click on the screen.
$source = [System.Drawing.Image]::FromFile((Resolve-Path $Path).Path)
try {
  if ($Region) {
    $parts = $Region.Split(',')
    $cropRect = New-Object System.Drawing.Rectangle([int]$parts[0], [int]$parts[1], [int]$parts[2], [int]$parts[3])
    $cropped = New-Object System.Drawing.Bitmap($cropRect.Width, $cropRect.Height)
    $cg = [System.Drawing.Graphics]::FromImage($cropped)
    $cg.DrawImage($source, (New-Object System.Drawing.Rectangle(0, 0, $cropRect.Width, $cropRect.Height)), $cropRect, [System.Drawing.GraphicsUnit]::Pixel)
    $cg.Dispose()
    $source.Dispose()
    $source = $cropped
  }
  if ($Scale -gt 1) {
    $scaled = New-Object System.Drawing.Bitmap([int]($source.Width * $Scale), [int]($source.Height * $Scale))
    $sg = [System.Drawing.Graphics]::FromImage($scaled)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($source, 0, 0, $scaled.Width, $scaled.Height)
    $sg.Dispose()
    $source.Dispose()
    $source = $scaled
  }

  $stream = New-Object System.IO.MemoryStream
  $source.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $stream.Position = 0
} finally {
  if ($source) { $source.Dispose() }
}

$decoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
$engineType = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$resultType = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]

$randomAccess = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream)
$decoder = Await ($decoderType::CreateAsync($randomAccess)) $decoderType
$softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) $bitmapType

# New-Object cannot resolve a WinRT type from a bare name (and `using namespace` does not help
# here), so the projected name with its ContentType marker is spelled out.
$languageName = 'Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime'
$engine = $engineType::TryCreateFromLanguage((New-Object $languageName -ArgumentList $Language))
if ($null -eq $engine) { $engine = $engineType::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw 'no OCR recognizer could be created for the requested language' }

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$result = Await ($engine.RecognizeAsync($softwareBitmap)) $resultType
$watch.Stop()
$stream.Dispose()

$offsetX = 0; $offsetY = 0
if ($Region) { $rp = $Region.Split(','); $offsetX = [int]$rp[0]; $offsetY = [int]$rp[1] }

# Map the coordinates back into the ORIGINAL image's space.
#
# The bitmap handed to the engine may have been upscaled by $Scale to help it read small text, so a
# coordinate the engine reports is $Scale times LARGER than the same point in the source image. The
# correction is therefore to MULTIPLY by $Scale before adding the crop offset.
#
# Multiplying here was a real bug, and a quiet one: every coordinate came out $Scale squared too large
# (four times, at a scale of 2), so a located control was clicked far from its true position. That
# looked exactly like failed input injection and sent several rounds of debugging after the wrong
# cause.
$factor = if ($Scale -gt 1) { $Scale } else { 1 }

$lines = @()
foreach ($line in $result.Lines) {
  $words = @($line.Words)
  if ($words.Count -eq 0) { continue }

  # The bounding box of the WHOLE line, not of its first word.
  #
  # Using only the first word's rectangle is a real bug that survived several rounds of
  # debugging: the engine splits CJK text into one word per glyph ("开 始 演 示 按 钮" is six
  # words), so the reported width was a single character (~62 px) rather than the label's full
  # extent, and the centre derived from it sat well to the left of the control. Clicks aimed
  # there missed a button that had been located perfectly, which looked like an input-injection
  # failure and sent the investigation in the wrong direction.
  #
  # WinRT struct members come back as arrays through PowerShell's member enumeration, so each
  # component is taken by index. The union spans every word in the line.
  $minX = [double]::MaxValue
  $minY = [double]::MaxValue
  $maxX = [double]::MinValue
  $maxY = [double]::MinValue
  foreach ($word in $words) {
    $rect = $word.BoundingRect
    $wx = [double](@($rect.X)[0])
    $wy = [double](@($rect.Y)[0])
    $ww = [double](@($rect.Width)[0])
    $wh = [double](@($rect.Height)[0])
    if ($wx -lt $minX) { $minX = $wx }
    if ($wy -lt $minY) { $minY = $wy }
    if (($wx + $ww) -gt $maxX) { $maxX = $wx + $ww }
    if (($wy + $wh) -gt $maxY) { $maxY = $wy + $wh }
  }

  $lines += [ordered]@{
    text   = $line.Text
    x      = [int]($offsetX + $minX / $factor)
    y      = [int]($offsetY + $minY / $factor)
    width  = [int](($maxX - $minX) / $factor)
    height = [int](($maxY - $minY) / $factor)
  }
}

Write-Output (([ordered]@{
  language  = $engine.RecognizerLanguage.LanguageTag
  lineCount = $lines.Count
  elapsedMs = [int]$watch.ElapsedMilliseconds
  lines     = $lines
} | ConvertTo-Json -Depth 5 -Compress))
