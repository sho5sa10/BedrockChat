# Bedrock Chat launcher (Windows / 社内プロキシ環境)
# 使い方: PowerShell で  .\start.ps1
# ------------------------------------------------------------------
# 既に環境変数が設定済み（Claude Code ランチャー経由で起動した場合など）なら
# それを使い、未設定の場合のみ下記の既定値にフォールバックします。
if (-not $env:AWS_REGION)  { $env:AWS_REGION  = "ap-northeast-1" }
if (-not $env:AWS_PROFILE) { $env:AWS_PROFILE = "claude-code" }
if (-not $env:AWS_CA_BUNDLE) { $env:AWS_CA_BUNDLE = "C:\Users\shogo.sato\.aws\cacert.pem" }
if (-not $env:NODE_EXTRA_CA_CERTS) { $env:NODE_EXTRA_CA_CERTS = "C:\Users\shogo.sato\ZscalerRootCertificate.crt" }
if (-not $env:PORT) { $env:PORT = "3210" }

# HTTPS_PROXY が未設定の場合のみ、Azure VM か物理PC かを自動判定
# （すでに設定済みならランチャー側の判定・指定をそのまま使う）
if (-not $env:HTTPS_PROXY) {
    try {
        $null = Invoke-WebRequest -Uri "http://169.254.169.254/metadata/instance?api-version=2021-02-01" `
            -Headers @{"Metadata"="true"} -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        $env:HTTP_PROXY  = "http://proxygate20.nic.nec.co.jp:8080/"
        $env:HTTPS_PROXY = $env:HTTP_PROXY
        Write-Host "[Proxy] Azure VM を検出。社内Proxy を設定: $env:HTTPS_PROXY" -ForegroundColor Green
    } catch {
        Write-Host "[Proxy] 物理PC を検出。Proxy 未設定（Zscaler経由）" -ForegroundColor Yellow
    }
}
# ------------------------------------------------------------------

Set-Location -Path $PSScriptRoot

# 前回の起動時にPowerShellウィンドウを「×」で閉じるなどした場合、node.exe が
# コンソール終了イベントを受け取れずポートを掴んだまま孤立して残ることがある。
# 起動前にポートを使用中のプロセスを検出し、node.exe なら自動終了させる。
$existingPids = Get-NetTCPConnection -LocalPort $env:PORT -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($existingPid in $existingPids) {
    try {
        $proc = Get-Process -Id $existingPid -ErrorAction Stop
        if ($proc.ProcessName -eq "node") {
            Write-Host "[Cleanup] ポート $($env:PORT) を使用している古い BedrockChat プロセス (PID $existingPid) を終了します" -ForegroundColor Yellow
            Stop-Process -Id $existingPid -Force
            Start-Sleep -Milliseconds 500
        } else {
            Write-Host "[警告] ポート $($env:PORT) は別プロセス (PID $existingPid, $($proc.ProcessName)) が使用中です。手動で終了してください。" -ForegroundColor Red
        }
    } catch {}
}

# AWSのセッションが切れている場合、サーバーだけ起動できてもチャット送信時に
# CredentialsProviderError で応答が返らず「反応なし」に見える。起動前に検出する。
Write-Host "[Auth] AWS認証状態を確認中..." -ForegroundColor Cyan
$identityCheck = aws sts get-caller-identity --profile $env:AWS_PROFILE 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[Auth] 認証切れ、または未ログインです。再ログインします..." -ForegroundColor Yellow
    Write-Host $identityCheck -ForegroundColor DarkYellow
    aws login --profile $env:AWS_PROFILE
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[Auth] ログインに失敗しました。手動で 'aws login --profile $($env:AWS_PROFILE)' を実行してください。" -ForegroundColor Red
        Read-Host "Enterキーで終了"
        exit 1
    }
    Write-Host "[Auth] 再ログイン成功" -ForegroundColor Green
} else {
    Write-Host "[Auth] 認証は有効です。" -ForegroundColor Green
}

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
