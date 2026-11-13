# Autoriza a chave SSH deste PC no servidor (uma vez só). Quem digita a senha do Linux é você;
# depois disso o acesso (deploy, manutenção) é por chave, sem senha.
param([string] $Server = "mfs@192.168.50.107")
$ErrorActionPreference = "Stop"
$pub = Join-Path $env:USERPROFILE ".ssh\id_ed25519.pub"
if (-not (Test-Path $pub)) { throw "Chave publica nao encontrada em $pub. Gere uma com: ssh-keygen -t ed25519" }
Write-Host ""
Write-Host "Autorizando a chave deste PC em $Server." -ForegroundColor Cyan
Write-Host "Digite a senha do Linux quando o SSH pedir (ela nao aparece enquanto voce digita)." -ForegroundColor Cyan
Write-Host ""
Get-Content $pub -Raw | ssh -o StrictHostKeyChecking=accept-new $Server "mkdir -p ~/.ssh && chmod 700 ~/.ssh && tr -d '\r' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo CHAVE_AUTORIZADA"
if ($LASTEXITCODE -eq 0) { Write-Host "Pronto: a chave foi autorizada. Pode voltar para a conversa." -ForegroundColor Green }
else { Write-Host "Nao deu certo (codigo $LASTEXITCODE). Confira a senha e rode de novo." -ForegroundColor Red }
