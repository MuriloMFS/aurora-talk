# Servidor de midia (voz) LiveKit para desenvolvimento/uso local no Windows.
# - Baixa a versao fixada do release OFICIAL (github.com/livekit/livekit) e confere o SHA-256.
# - Roda em modo --dev (chave "devkey" / segredo "secret"), aceitando conexoes da rede local.
# Uso:  pnpm voice     (ou: powershell -ExecutionPolicy Bypass -File scripts/livekit.ps1)
# Obs.: mensagens sem acento de proposito (PowerShell 5.1 le .ps1 sem BOM como ANSI).
param([switch] $DownloadOnly)
$ErrorActionPreference = 'Stop'

$Version = '1.13.11'
$Asset = "livekit_${Version}_windows_amd64.zip"
$BaseUrl = "https://github.com/livekit/livekit/releases/download/v$Version"
$ToolsDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\tools\livekit\$Version"))
$Exe = Join-Path $ToolsDir 'livekit-server.exe'

if (-not (Test-Path $Exe)) {
  New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
  $zip = Join-Path $ToolsDir $Asset
  $sums = Join-Path $ToolsDir 'checksums.txt'
  Write-Host "Baixando LiveKit $Version ($Asset)..."
  Invoke-WebRequest -Uri "$BaseUrl/$Asset" -OutFile $zip -UseBasicParsing
  Invoke-WebRequest -Uri "$BaseUrl/checksums.txt" -OutFile $sums -UseBasicParsing
  $line = Get-Content -LiteralPath $sums | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" } | Select-Object -First 1
  $expected = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
  Remove-Item -LiteralPath $sums -Force
  if (-not $expected -or $actual -ne $expected) {
    Remove-Item -LiteralPath $zip -Force
    throw "SHA-256 nao confere (esperado '$expected', obtido '$actual'). Download descartado."
  }
  Write-Host "SHA-256 conferido: $actual"
  Expand-Archive -Path $zip -DestinationPath $ToolsDir -Force
  Remove-Item -LiteralPath $zip -Force
}

if ($DownloadOnly) { Write-Host "Pronto: $Exe"; exit 0 }

Write-Host "LiveKit $Version em modo dev (ws://0.0.0.0:7880). Ctrl+C para parar."
& $Exe --dev --bind 0.0.0.0
