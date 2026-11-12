param(
  [Parameter(Mandatory)] [string] $Setup,
  [Parameter(Mandatory)] [string] $ShotPath
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
}
"@
[W]::SetProcessDPIAware() | Out-Null

function Get-Family([int] $rootId) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, PrivatePageCount
  $ids = New-Object System.Collections.Generic.HashSet[int]
  [void]$ids.Add($rootId)
  do {
    $added = 0
    foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added++ } }
  } while ($added -gt 0)
  $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
}

function Show-Family([int] $rootId, [string] $label) {
  $fam = @(Get-Family $rootId)
  $ws = ($fam | Measure-Object WorkingSetSize -Sum).Sum / 1MB
  $pv = ($fam | Measure-Object PrivatePageCount -Sum).Sum / 1MB
  "{0}: {1} processos | working set {2:N0} MB | privada {3:N0} MB" -f $label, $fam.Count, $ws, $pv
  $fam | Sort-Object WorkingSetSize -Descending | ForEach-Object { "    {0,-22} WS {1,6:N0} MB  priv {2,6:N0} MB" -f $_.Name, ($_.WorkingSetSize/1MB), ($_.PrivatePageCount/1MB) }
}

# 1) instalação silenciosa (NSIS, por usuário)
$sw = [Diagnostics.Stopwatch]::StartNew()
$inst = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
$sw.Stop()
"instalacao: exit={0} em {1:N1}s" -f $inst.ExitCode, $sw.Elapsed.TotalSeconds
$entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Aurora*' } | Select-Object -First 1
$dir = if ($entry -and $entry.InstallLocation) { $entry.InstallLocation.Trim('"') } else { Join-Path $env:LOCALAPPDATA 'Aurora' }
"pasta: $dir"
$files = Get-ChildItem $dir -Recurse -File
"instalado em disco: {0:N2} MB ({1} arquivos)" -f (($files | Measure-Object Length -Sum).Sum/1MB), $files.Count
$exe = $files | Where-Object { $_.Extension -eq '.exe' -and $_.Name -notlike 'uninstall*' } | Select-Object -First 1
"executavel: $($exe.Name)"

# 2) abrir e medir tempo até a janela existir (proxy; não é "interativa")
$sw = [Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $exe.FullName -PassThru
while ($proc.MainWindowHandle -eq 0 -and $sw.ElapsedMilliseconds -lt 15000) { Start-Sleep -Milliseconds 25; $proc.Refresh() }
"janela criada em {0:N0} ms" -f $sw.ElapsedMilliseconds

Start-Sleep -Seconds 10
Show-Family $proc.Id "RAM aos 10 s"

# CPU ociosa: tempo de CPU da família em 30 s
$cores = [Environment]::ProcessorCount
$fam0 = @(Get-Family $proc.Id).ProcessId
$cpu0 = ($fam0 | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum
Start-Sleep -Seconds 30
$fam1 = @(Get-Family $proc.Id).ProcessId
$cpu1 = ($fam1 | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum
"CPU ociosa (30 s): {0:N2}% de 1 nucleo | {1:N3}% do total ({2} nucleos logicos)" -f (($cpu1-$cpu0)/30000*100), (($cpu1-$cpu0)/30000/$cores*100), $cores
Show-Family $proc.Id "RAM aos 40 s"

# 3) captura da janela (PrintWindow com conteúdo DirectComposition)
$proc.Refresh()
$r = New-Object W+RECT
[W]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[W]::PrintWindow($proc.MainWindowHandle, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($ShotPath, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
"captura: ${w}x${h} -> $ShotPath"

# 4) fechar
$proc.CloseMainWindow() | Out-Null
if (-not $proc.WaitForExit(5000)) { Stop-Process -Id $proc.Id -Force; 'fechado a forca' } else { 'fechado normalmente' }
Start-Sleep -Seconds 2

# 5) desinstalação silenciosa
$un = Get-ChildItem $dir -Filter 'uninstall*.exe' | Select-Object -First 1
$u = Start-Process -FilePath $un.FullName -ArgumentList '/S' -PassThru -Wait
Start-Sleep -Seconds 3
"desinstalacao: exit={0} | pasta ainda existe: {1} | entrada no registro: {2}" -f $u.ExitCode, (Test-Path (Join-Path $dir $exe.Name)), [bool](Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Aurora*' })
"dados do WebView restantes: $(Test-Path (Join-Path $env:LOCALAPPDATA 'app.aurora.desktop'))"
