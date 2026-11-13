# Publica uma versao do app para ATUALIZACAO AUTOMATICA.
# 1) gera o app assinado com a chave em %USERPROFILE%\.aurora\updater (fora do repositorio)
# 2) copia o instalador para apps/server/releases/<versao>/ e escreve apps/server/releases/latest.json
# Os apps instalados (1.0.1+) pegam a versao nova sozinhos ao abrir.
# Uso: pnpm release -- -Notes "O que mudou" -ServerUrl https://aurora.seudominio.com
#   -ServerUrl: servidor oficial embutido no app (como o discord.com); sem ele o app aponta para localhost.
#   (a versao vem de apps/desktop/src-tauri/tauri.conf.json; para publicar no servidor: scripts/deploy.ps1)
# Obs.: mensagens sem acento de proposito (PowerShell 5.1 le .ps1 sem BOM como ANSI).
param([string] $Notes = '', [string] $ServerUrl = '')
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
if ($ServerUrl) {
  if ($ServerUrl -notmatch '^https://[A-Za-z0-9.-]+(:\d+)?/?$') { throw "ServerUrl deve ser https://host (recebido: $ServerUrl)" }
  $env:VITE_AURORA_SERVER_URL = $ServerUrl.TrimEnd('/')
  Write-Host "Servidor oficial embutido no app: $env:VITE_AURORA_SERVER_URL"
} else {
  Write-Host "AVISO: sem -ServerUrl o app publicado aponta para http://localhost:3000 (so serve para testes)."
}
$Cargo = Join-Path $env:USERPROFILE '.cargo\bin'
if ($env:PATH -notlike "*$Cargo*") { $env:PATH = "$Cargo;$env:PATH" }

Write-Host "Gerando Aurora $Version (assinado)..."
Push-Location (Join-Path $Root 'apps\desktop')
try {
  pnpm tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build falhou (codigo $LASTEXITCODE)" }
} finally {
  Pop-Location
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY, Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD, Env:\VITE_AURORA_SERVER_URL -ErrorAction SilentlyContinue
}

$Bundle = Join-Path $Root 'apps\desktop\src-tauri\target\release\bundle\nsis'
$Setup = "Aurora_${Version}_x64-setup.exe"
$SigPath = Join-Path $Bundle "$Setup.sig"
if (-not (Test-Path $SigPath)) { throw "Assinatura nao foi gerada: $SigPath" }

# Microsoft Defender: o modelo de aprendizado de maquina dele as vezes acusa um instalador novo e sem
# certificado (ex.: "Trojan:Win32/Bearfoos.A!ml" no 1.4.0). Publicado assim, a atualizacao automatica
# faz o Defender apagar o app de quem atualizar. Por isso so publica o que o Defender aprova.
# -DisableRemediation: so verifica, nao mexe no arquivo.
$MpCmdRun = @(
  (Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform\CurrentVersion\MpCmdRun.exe'),
  (Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($MpCmdRun) {
  Write-Host 'Conferindo o instalador com o Microsoft Defender...'
  $Scan = & $MpCmdRun -Scan -ScanType 3 -File (Join-Path $Bundle $Setup) -DisableRemediation 2>&1 | ForEach-Object { "$_" }
  $Threat = $Scan | Select-String -Pattern '^\s*Threat\s*:' | Select-Object -First 1
  if ($Threat) {
    throw ("O Defender acusou o instalador ($($Threat.Line.Trim())). Nada foi publicado. " +
      'Quase sempre e falso positivo de app novo sem certificado: aumente a versao (tauri.conf.json, Cargo.toml, package.json), ' +
      'gere de novo e, se continuar, envie o arquivo para analise em https://www.microsoft.com/wdsi/filesubmission')
  }
  Write-Host 'Defender: nenhuma ameaca encontrada.'
} else {
  Write-Host 'AVISO: Microsoft Defender nao encontrado; o instalador nao foi conferido.'
}

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
