# Publica uma versao do app para ATUALIZACAO AUTOMATICA.
# 1) gera o app assinado com a chave em %USERPROFILE%\.aurora\updater (fora do repositorio)
# 2) copia o instalador para apps/server/releases/<versao>/ e escreve apps/server/releases/latest.json
# Os apps instalados (1.0.1+) pegam a versao nova sozinhos ao abrir.
# Uso: pnpm release -- -Notes "O que mudou"      (a versao vem de apps/desktop/src-tauri/tauri.conf.json)
# Obs.: mensagens sem acento de proposito (PowerShell 5.1 le .ps1 sem BOM como ANSI).
param([string] $Notes = '')
$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Version = (Get-Content (Join-Path $Root 'apps\desktop\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
$KeyDir = Join-Path $env:USERPROFILE '.aurora\updater'
$Key = Join-Path $KeyDir 'aurora.key'
$PasswordFile = Join-Path $KeyDir 'aurora.key.password'
if (-not (Test-Path $Key)) { throw "Chave de assinatura nao encontrada em $Key. Sem ela os apps instalados recusam atualizacoes." }

$env:TAURI_SIGNING_PRIVATE_KEY = $Key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$Cargo = Join-Path $env:USERPROFILE '.cargo\bin'
if ($env:PATH -notlike "*$Cargo*") { $env:PATH = "$Cargo;$env:PATH" }

Write-Host "Gerando Aurora $Version (assinado)..."
Push-Location (Join-Path $Root 'apps\desktop')
try {
  pnpm tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build falhou (codigo $LASTEXITCODE)" }
} finally {
  Pop-Location
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY, Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

$Bundle = Join-Path $Root 'apps\desktop\src-tauri\target\release\bundle\nsis'
$Setup = "Aurora_${Version}_x64-setup.exe"
$SigPath = Join-Path $Bundle "$Setup.sig"
if (-not (Test-Path $SigPath)) { throw "Assinatura nao foi gerada: $SigPath" }

$Releases = Join-Path $Root 'apps\server\releases'
$Dest = Join-Path $Releases $Version
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -LiteralPath (Join-Path $Bundle $Setup) -Destination $Dest -Force

$Manifest = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = @{ 'windows-x86_64' = [ordered]@{ file = $Setup; signature = (Get-Content -LiteralPath $SigPath -Raw).Trim() } }
}
[IO.File]::WriteAllText((Join-Path $Releases 'latest.json'), ($Manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

Write-Host "Publicado $Version em $Dest"
Write-Host "Instalador (para quem ainda nao tem o app): $(Join-Path $Bundle $Setup)"
