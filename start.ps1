# Claude Code Chat on AWS Bedrock launcher (Windows)
# 使い方: PowerShell で  .\start.ps1
#
# 初回はいくつか質問されます。回答は start.local.json に保存され、
# 次回以降は聞かれずにそのまま起動します。
# 設定をやり直したいときは:  .\start.ps1 -Reconfigure

param(
    [switch]$Reconfigure
)

Set-Location -Path $PSScriptRoot

$configPath = Join-Path $PSScriptRoot "start.local.json"

function Read-SavedConfig {
    if (Test-Path $configPath) {
        try { return Get-Content $configPath -Raw | ConvertFrom-Json } catch { return $null }
    }
    return $null
}

function Ask([string]$Prompt, [string]$Default) {
    $suffix = if ($Default) { " [$Default]" } else { " [空欄でOK]" }
    $answer = Read-Host "$Prompt$suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer
}

$config = Read-SavedConfig
if (-not $config -or $Reconfigure) {
    Write-Host ""
    Write-Host "=== 初回セットアップ ===" -ForegroundColor Cyan
    Write-Host "わからない項目は空欄のままEnterで進めてください。あとで $configPath を直接編集しても、"
    Write-Host ".\start.ps1 -Reconfigure でやり直しても構いません。"
    Write-Host ""

    $region  = Ask "AWSリージョン（例: us-east-1。空欄ならAWSプロファイル側の設定から自動解決）" ""
    $profile = Ask "AWSプロファイル名（'aws configure --profile 名前' で作ったもの。空欄ならdefault）" ""

    $useProxy = Read-Host "社内プロキシ経由でAWSに接続する必要がありますか？ (y/N)"
    $proxy = ""
    $caBundle = ""
    if ($useProxy -match "^[yY]") {
        $proxy    = Ask "プロキシURL（例: http://proxy.example.co.jp:8080）" ""
        $caBundle = Ask "SSLインスペクション用CA証明書のパス（PEM形式。不要なら空欄）" ""
    }

    $port = Ask "起動ポート番号" "3210"

    $config = [pscustomobject]@{
        AWS_REGION    = $region
        AWS_PROFILE   = $profile
        HTTPS_PROXY   = $proxy
        AWS_CA_BUNDLE = $caBundle
        PORT          = $port
    }
    $config | ConvertTo-Json | Set-Content -Path $configPath -Encoding utf8
    Write-Host ""
    Write-Host "設定を $configPath に保存しました。次回からはこの画面は出ません。" -ForegroundColor Green
    Write-Host ""
}

if ($config.AWS_REGION)  { $env:AWS_REGION  = $config.AWS_REGION }
if ($config.AWS_PROFILE) { $env:AWS_PROFILE = $config.AWS_PROFILE }
if ($config.HTTPS_PROXY) { $env:HTTPS_PROXY = $config.HTTPS_PROXY }
if ($config.AWS_CA_BUNDLE) {
    $env:AWS_CA_BUNDLE = $config.AWS_CA_BUNDLE
    $env:NODE_EXTRA_CA_CERTS = $config.AWS_CA_BUNDLE
}
$env:PORT = if ($config.PORT) { $config.PORT } else { "3210" }

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
