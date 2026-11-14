# Gera o Aurora para Linux (.AppImage e .deb) numa maquina Linux, por SSH (ADR-003, docs/13-linux.md).
# - Usa a interface JA GERADA no Windows (apps/desktop/dist): o mesmo app, com o mesmo servidor embutido.
#   (a maquina do servidor tem processador sem AVX2: o TypeScript 7 e o Vite nativos nao rodam la)
# - Compila so a parte nativa la, com prioridade baixa (nice), e traz os pacotes para
#   apps/desktop/src-tauri/target/linux/. A ASSINATURA e feita aqui (a chave nunca sai deste PC).
# - Gere na base mais antiga suportada (Ubuntu 24.04 / Mint 22): app compilado num Linux mais novo
#   (ex.: Kali, Debian testing) exige glibc mais nova e nao abre no Ubuntu.
# Antes, uma vez: scripts/autorizar-ssh.ps1 -Server <host> e as dependencias de docs/13-linux.md.
# Uso: powershell -File scripts/build-linux.ps1 [-Server mfs@192.168.50.107]
# Obs.: mensagens sem acento de proposito (PowerShell 5.1 le .ps1 sem BOM como ANSI).
param([string] $Server = 'mfs@192.168.50.107')
$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Version = (Get-Content (Join-Path $Root 'apps\desktop\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
$Dist = Join-Path $Root 'apps\desktop\dist\index.html'
if (-not (Test-Path $Dist)) { throw 'Interface nao gerada (apps/desktop/dist). Rode antes o build do Windows (pnpm release faz isso).' }
$Ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')

Write-Host "Conferindo acesso SSH a $Server..."
ssh @Ssh $Server 'test -x ~/dev/node/bin/node && test -x ~/.cargo/bin/cargo'
if ($LASTEXITCODE -ne 0) { throw "Sem acesso a $Server ou sem Node/Rust em ~/dev/node e ~/.cargo (docs/13-linux.md)." }

# codigo + interface pronta, sem node_modules, builds, dados ou chaves
$Tgz = Join-Path $env:TEMP "aurora-linux-$Version.tgz"
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
& $Tar -czf $Tgz -C $Root --exclude=node_modules --exclude=target --exclude=.git `
  --exclude=tools --exclude=data --exclude=releases --exclude=*.key --exclude=.env* --exclude=*.db --exclude=gen `
  apps packages scripts package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json
if ($LASTEXITCODE -ne 0) { throw 'falha ao compactar o codigo' }
scp @Ssh $Tgz "${Server}:/tmp/aurora-linux.tgz"
if ($LASTEXITCODE -ne 0) { throw 'falha ao enviar o codigo' }
Remove-Item -LiteralPath $Tgz -Force

# pasta de codigo nova a cada versao; o cache do Rust (CARGO_TARGET_DIR) fica entre versoes
$Remote = @'
set -e
export PATH="$HOME/dev/node/bin:$HOME/.cargo/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CARGO_TARGET_DIR="$HOME/dev/aurora-target"
# o WebRTC do LiveKit (voz nativa) exige clang 21+; o Ubuntu 24.04 vem com o 18 (apt.llvm.org tem o 21)
# ordem: clang oficial do LLVM na pasta do usuario (~/dev/llvm-21, sem sudo) ou clang-21+ do sistema
if [ -x "$HOME/dev/llvm-21/bin/clang++" ]; then export CC="$HOME/dev/llvm-21/bin/clang" CXX="$HOME/dev/llvm-21/bin/clang++"
else for v in 23 22 21; do if command -v clang++-$v >/dev/null; then export CC=clang-$v CXX=clang++-$v; break; fi; done; fi
case "$(${CXX:-clang++} --version 2>/dev/null | grep -o "version [0-9]*" | cut -d" " -f2)" in
  2[1-9]|[3-9][0-9]) ;;
  *) echo "ERRO: falta o clang 21 ou mais novo nesta maquina (docs/13-linux.md, secao Maquina de build)."; exit 3;;
esac
rm -rf ~/dev/aurora-release && mkdir -p ~/dev/aurora-release
tar -xzf /tmp/aurora-linux.tgz -C ~/dev/aurora-release && rm -f /tmp/aurora-linux.tgz
cd ~/dev/aurora-release
nice -n 19 pnpm install --frozen-lockfile >/dev/null
cd apps/desktop
nice -n 19 pnpm exec tauri build --bundles appimage,deb --config '{"bundle":{"createUpdaterArtifacts":false},"build":{"beforeBuildCommand":""}}'
'@
Write-Host "Compilando no Linux ($Server, prioridade baixa; a primeira vez demora)..."
# vai como arquivo: o PowerShell 5.1 come as aspas de argumentos para programas externos (o JSON quebrava)
$Script = Join-Path $env:TEMP 'aurora-build-linux.sh'
[IO.File]::WriteAllText($Script, ($Remote -replace "`r", ''), (New-Object Text.UTF8Encoding $false))
scp @Ssh $Script "${Server}:/tmp/aurora-build-linux.sh"
if ($LASTEXITCODE -ne 0) { throw 'falha ao enviar o roteiro de build' }
Remove-Item -LiteralPath $Script -Force
ssh @Ssh $Server 'bash /tmp/aurora-build-linux.sh; s=$?; rm -f /tmp/aurora-build-linux.sh; exit $s'
if ($LASTEXITCODE -ne 0) { throw "build no Linux falhou (codigo $LASTEXITCODE)" }

$Out = Join-Path $Root 'apps\desktop\src-tauri\target\linux'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
foreach ($Pair in @(@('appimage', "Aurora_${Version}_amd64.AppImage"), @('deb', "Aurora_${Version}_amd64.deb"))) {
  scp @Ssh "${Server}:dev/aurora-target/release/bundle/$($Pair[0])/$($Pair[1])" (Join-Path $Out $Pair[1])
  if ($LASTEXITCODE -ne 0) { throw "falha ao trazer $($Pair[1])" }
}
Write-Host "Pacotes Linux em $Out"
