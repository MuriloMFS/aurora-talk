# Publica o Aurora no servidor Linux (API + gateway + site + voz), via SSH com chave.
# 1) gera o site (apps/site) e o servidor num arquivo so (apps/server/dist/aurora-server.mjs)
# 2) junta com a versao mais nova do instalador (apps/server/releases) e com deploy/linux
# 3) envia ao servidor e roda deploy/linux/install.sh la (sem sudo; servicos do systemd do usuario)
# Uso: pnpm deploy:server -- [-Server mfs@192.168.50.107] [-LiveKitUrl wss://voz.seudominio.com]
# Antes, uma vez: scripts/autorizar-ssh.ps1 (autoriza a chave SSH deste PC no servidor).
# Obs.: mensagens sem acento de proposito (PowerShell 5.1 le .ps1 sem BOM como ANSI).
param([string] $Server = 'mfs@192.168.50.107', [string] $LiveKitUrl = '')
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')

Write-Host "Conferindo acesso SSH a $Server..."
ssh @Ssh $Server 'true'
if ($LASTEXITCODE -ne 0) { throw "Sem acesso por chave a $Server. Rode antes: scripts/autorizar-ssh.ps1" }

Write-Host 'Gerando site e servidor...'
Push-Location $Root
try {
  pnpm --filter @aurora/site build
  if ($LASTEXITCODE -ne 0) { throw 'build do site falhou' }
  pnpm --filter @aurora/server bundle
  if ($LASTEXITCODE -ne 0) { throw 'pacote do servidor falhou' }
} finally { Pop-Location }

$Releases = Join-Path $Root 'apps\server\releases'
$Latest = Get-Content (Join-Path $Releases 'latest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Stage = Join-Path $env:TEMP ("aurora-deploy-" + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'bin'), (Join-Path $Stage 'releases') | Out-Null
Copy-Item (Join-Path $Root 'apps\server\dist\aurora-server.mjs*') (Join-Path $Stage 'bin')
Copy-Item (Join-Path $Root 'apps\site\dist') (Join-Path $Stage 'site') -Recurse
Copy-Item (Join-Path $Releases 'latest.json') (Join-Path $Stage 'releases')
Copy-Item (Join-Path $Releases $Latest.version) (Join-Path $Stage "releases\$($Latest.version)") -Recurse
# arquivos do Linux sempre com quebra de linha LF (o bash nao aceita CRLF)
foreach ($file in Get-ChildItem (Join-Path $Root 'deploy\linux') -File) {
  $text = [IO.File]::ReadAllText($file.FullName) -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $Stage $file.Name), $text, (New-Object Text.UTF8Encoding $false))
}

$Archive = "$Stage.tgz"
# tar do proprio Windows (o do Git Bash entende "C:" como computador remoto)
$Tar = Join-Path $env:SystemRoot 'System32/tar.exe'
& $Tar -czf $Archive -C $Stage .
if ($LASTEXITCODE -ne 0) { throw 'falha ao compactar' }
Write-Host ("Enviando {0:N1} MB (versao do app: {1})..." -f ((Get-Item $Archive).Length / 1MB), $Latest.version)
scp @Ssh $Archive "${Server}:/tmp/aurora-deploy.tgz"
if ($LASTEXITCODE -ne 0) { throw 'falha ao enviar' }

$InstallArgs = if ($LiveKitUrl) { "--livekit-url '$LiveKitUrl'" } else { '' }
$Remote = "rm -rf ~/aurora-deploy && mkdir -p ~/aurora-deploy && tar -xzf /tmp/aurora-deploy.tgz -C ~/aurora-deploy && rm -f /tmp/aurora-deploy.tgz && bash ~/aurora-deploy/install.sh $InstallArgs"
ssh @Ssh $Server $Remote
$code = $LASTEXITCODE
Remove-Item -Recurse -Force $Stage, $Archive -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "instalacao no servidor falhou (codigo $code)" }
Write-Host 'Deploy concluido.'
