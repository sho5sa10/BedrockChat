# Bedrock Chat launcher (Windows / 社内プロキシ環境)
# 使い方: PowerShell で  .\start.ps1
# ------------------------------------------------------------------
# ↓ 環境に合わせて書き換えてください（Claude Code で使っている値と同じものでOK）
$env:AWS_REGION      = "us-east-1"
$env:AWS_PROFILE     = "bedrock"                       # 使っていなければこの行を削除
$env:HTTPS_PROXY     = "http://proxy.example.co.jp:8080"
$env:AWS_CA_BUNDLE   = "C:\certs\zscaler-root.pem"
$env:NODE_EXTRA_CA_CERTS = $env:AWS_CA_BUNDLE
$env:PORT            = "3210"
# ------------------------------------------------------------------

Set-Location -Path $PSScriptRoot

if (-not (Test-Path "node_modules")) {
    Write-Host "依存パッケージをインストールします..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install に失敗しました。プロキシ設定を確認してください:" -ForegroundColor Red
        Write-Host "  npm config set proxy $env:HTTPS_PROXY"
        Write-Host "  npm config set https-proxy $env:HTTPS_PROXY"
        Write-Host "  npm config set cafile $env:AWS_CA_BUNDLE"
        exit 1
    }
}

Start-Process "http://localhost:$($env:PORT)"
node server.js
