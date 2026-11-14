# Publica uma versao do app para ATUALIZACAO AUTOMATICA.
# 1) gera o app assinado com a chave em %USERPROFILE%\.aurora\updater (fora do repositorio)
# 2) copia o instalador para apps/server/releases/<versao>/ e escreve apps/server/releases/latest.json
# Os apps instalados (1.0.1+) pegam a versao nova sozinhos ao abrir.
# Uso: pnpm release -- -Notes "O que mudou"
#   -ServerUrl: servidor oficial embutido no app (como o discord.com). Padrao: o servidor oficial.
#   -Local: so para testes, o app aponta para http://localhost:3000.
#   -SkipLinux: so o Windows. -LinuxServer: maquina Linux do build (scripts/build-linux.ps1).
#   (a versao vem de apps/desktop/src-tauri/tauri.conf.json; para publicar no servidor: scripts/deploy.ps1)
# Obs.: mensagens sem acento de proposito (PowerShell 5.1 le .ps1 sem BOM como ANSI).
param([string] $Notes = '', [string] $ServerUrl = 'https://aurora.muriloferreira.dev', [switch] $Local, [switch] $SkipLinux, [string] $LinuxServer = 'mfs@192.168.50.107')
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
# 1.13.1 a 1.15.0 sairam sem o servidor embutido (a tela de login abria em localhost): agora o
# servidor oficial e o padrao, e so -Local tira.
if (-not $Local) {
  if ($ServerUrl -notmatch '^https://[A-Za-z0-9.-]+(:\d+)?/?$') { throw "ServerUrl deve ser https://host (recebido: $ServerUrl)" }
  $env:VITE_AURORA_SERVER_URL = $ServerUrl.TrimEnd('/')
  Write-Host "Servidor oficial embutido no app: $env:VITE_AURORA_SERVER_URL"
} else {
  Write-Host "AVISO: -Local: o app publicado aponta para http://localhost:3000 (so serve para testes)."
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
  Remove-Item Env:\VITE_AURORA_SERVER_URL -ErrorAction SilentlyContinue
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
  # O modelo do Defender muda varias vezes por dia (a 1.11.0 passou e foi acusada 30 min depois):
  # confere com as definicoes mais novas, e confere tambem o aurora.exe que vai dentro do instalador
  # (foi ele que o Defender apagou de quem atualizou).
  Write-Host 'Atualizando as definicoes do Defender...'
  & $MpCmdRun -SignatureUpdate 2>&1 | Out-Null
  $Targets = @((Join-Path $Bundle $Setup), (Join-Path $Root 'apps\desktop\src-tauri\target\release\aurora.exe'))
  foreach ($Target in $Targets) {
    Write-Host "Conferindo $(Split-Path $Target -Leaf) com o Microsoft Defender..."
    $Scan = & $MpCmdRun -Scan -ScanType 3 -File $Target -DisableRemediation 2>&1 | ForEach-Object { "$_" }
    $Threat = $Scan | Select-String -Pattern '^\s*Threat\s*:' | Select-Object -First 1
    if ($Threat) {
      throw ("O Defender acusou $(Split-Path $Target -Leaf) ($($Threat.Line.Trim())). Nada foi publicado. " +
        'Quase sempre e falso positivo de app novo sem certificado: aumente a versao (tauri.conf.json, Cargo.toml, package.json), ' +
        'gere de novo e, se continuar, envie o arquivo para analise em https://www.microsoft.com/wdsi/filesubmission')
    }
  }
  Write-Host 'Defender: nenhuma ameaca encontrada.'
} else {
  Write-Host 'AVISO: Microsoft Defender nao encontrado; o instalador nao foi conferido.'
}

# Linux: compila na maquina Linux com a MESMA interface (ja com o servidor embutido) e assina aqui.
$Platforms = [ordered]@{ 'windows-x86_64' = [ordered]@{ file = $Setup; signature = (Get-Content -LiteralPath $SigPath -Raw).Trim() } }
$LinuxFiles = @()
try {
  if (-not $SkipLinux) {
    & (Join-Path $PSScriptRoot 'build-linux.ps1') -Server $LinuxServer
    $LinuxDir = Join-Path $Root 'apps\desktop\src-tauri\target\linux'
    $Kinds = [ordered]@{ appimage = "Aurora_${Version}_amd64.AppImage"; deb = "Aurora_${Version}_amd64.deb" }
    Push-Location (Join-Path $Root 'apps\desktop')
    # o "signer sign" quer o CONTEUDO da chave na variavel (o build aceita o caminho)
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -LiteralPath $Key -Raw).Trim()
    try {
      foreach ($Kind in $Kinds.Keys) {
        $File = Join-Path $LinuxDir $Kinds[$Kind]
        Remove-Item -LiteralPath "$File.sig" -ErrorAction SilentlyContinue
        pnpm tauri signer sign $File | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$File.sig")) { throw "falha ao assinar $($Kinds[$Kind])" }
        $Entry = [ordered]@{ file = $Kinds[$Kind]; signature = (Get-Content -LiteralPath "$File.sig" -Raw).Trim() }
        $Platforms["linux-x86_64-$Kind"] = $Entry
        if ($Kind -eq 'appimage') { $Platforms['linux-x86_64'] = $Entry } # app sem tipo de instalacao
        $LinuxFiles += $File
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-Host 'AVISO: -SkipLinux: esta versao sai sem pacotes Linux (quem usa Linux nao recebe atualizacao).'
  }
} finally {
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY, Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

$Releases = Join-Path $Root 'apps\server\releases'
$Dest = Join-Path $Releases $Version
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -LiteralPath (Join-Path $Bundle $Setup) -Destination $Dest -Force
foreach ($File in $LinuxFiles) { Copy-Item -LiteralPath $File -Destination $Dest -Force }

$Manifest = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = $Platforms
}
[IO.File]::WriteAllText((Join-Path $Releases 'latest.json'), ($Manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

Write-Host "Publicado $Version em $Dest"
Write-Host "Instalador (para quem ainda nao tem o app): $(Join-Path $Bundle $Setup)"
foreach ($File in $LinuxFiles) { Write-Host "Linux: $File" }
