# Claude Desk — Chat & Code on Amazon Bedrock : launcher (Windows)
# 使い方: PowerShell で  .\start.ps1
#
# 初回はいくつか質問されます。回答は start.local.json に保存され、
# 次回以降は聞かれずにそのまま起動します。
# 設定をやり直したいときは:  .\start.ps1 -Reconfigure
#
# start.local.json は Git 管理外なので、環境固有の値（社内プロキシのURL、
# CA証明書のパス、SSO以外の独自ログインコマンド等）はすべてここに置く。
# 対話で聞かれない任意項目:
#   "LOGIN_COMMAND": "aws login"   … 認証切れ時に実行するログインコマンド
#                                     （未指定なら "aws sso login"）
#   "ALLOW_CROSS_REGION_INFERENCE": "1"
#          … 東京リージョンのリージョンロックを解除し、global./apac./us. の
#            推論プロファイルも選べるようにする。最新モデルは東京では
#            global.* としてしか提供されないため、jp.anthropic.* が追随するまでは
#            これがないと新しいモデルを使えない。ただし処理が東京外へ
#            ルーティングされうるので、データ所在地の要件がある環境では設定しないこと。

param(
    [switch]$Reconfigure
)

Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "  Claude Desk" -ForegroundColor Cyan -NoNewline
Write-Host "  —  Chat & Code on Amazon Bedrock"
Write-Host ""

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
    Write-Host "=== Claude Desk 初回セットアップ ===" -ForegroundColor Cyan
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
    # Node と AWS CLI で別の証明書を使う環境向けに、明示指定があればそちらを優先する。
    $env:NODE_EXTRA_CA_CERTS = if ($config.NODE_EXTRA_CA_CERTS) { $config.NODE_EXTRA_CA_CERTS } else { $config.AWS_CA_BUNDLE }
}
# 東京リージョンのリージョンロックを解除するオプトイン。既定では設定しない
# （東京外へ処理がルーティングされうるため）。対話では聞かず、必要な環境だけが
# start.local.json に直接書く。
if ($config.ALLOW_CROSS_REGION_INFERENCE) { $env:ALLOW_CROSS_REGION_INFERENCE = $config.ALLOW_CROSS_REGION_INFERENCE }
$env:PORT = if ($config.PORT) { $config.PORT } else { "3210" }

# 前回の起動時にPowerShellウィンドウを「×」で閉じるなどした場合、node.exe が
# コンソール終了イベントを受け取れずポートを掴んだまま孤立して残ることがある。
# 起動前にポートを使用中のプロセスを検出し、node.exe なら自動終了させる。
$existingPids = Get-NetTCPConnection -LocalPort $env:PORT -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($existingPid in $existingPids) {
    try {
        $proc = Get-Process -Id $existingPid -ErrorAction Stop
        if ($proc.ProcessName -eq "node") {
            Write-Host "[Cleanup] ポート $($env:PORT) を使用している古いサーバープロセス (PID $existingPid) を終了します" -ForegroundColor Yellow
            Stop-Process -Id $existingPid -Force
            Start-Sleep -Milliseconds 500
        } else {
            Write-Host "[警告] ポート $($env:PORT) は別プロセス (PID $existingPid, $($proc.ProcessName)) が使用中です。手動で終了してください。" -ForegroundColor Red
        }
    } catch {}
}

# AWSのセッションが切れている場合、サーバーだけ起動できてもチャット送信時に
# CredentialsProviderError で応答が返らず「反応なし」に見える。起動前に検出する。
$profileArgs = if ($env:AWS_PROFILE) { @("--profile", $env:AWS_PROFILE) } else { @() }
if (Get-Command aws -ErrorAction SilentlyContinue) {
    Write-Host "[Auth] AWS認証状態を確認中..." -ForegroundColor Cyan
    $identityCheck = & aws sts get-caller-identity @profileArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $loginCommand = if ($config.LOGIN_COMMAND) { $config.LOGIN_COMMAND } else { "aws sso login" }
        Write-Host "[Auth] 認証切れ、または未ログインです。'$loginCommand' で再ログインします..." -ForegroundColor Yellow
        Write-Host $identityCheck -ForegroundColor DarkYellow
        $loginParts = $loginCommand -split "\s+"
        & $loginParts[0] @($loginParts[1..($loginParts.Length - 1)]) @profileArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[Auth] ログインに失敗しました。Claude Desk は AWS の認証情報がないと Bedrock を呼び出せません。" -ForegroundColor Red
            Write-Host "[Auth] 手動で '$loginCommand $($profileArgs -join ' ')' を実行してから、もう一度 .\start.ps1 を実行してください。" -ForegroundColor Red
            Read-Host "Enterキーで終了"
            exit 1
        }
        Write-Host "[Auth] 再ログイン成功" -ForegroundColor Green
    } else {
        Write-Host "[Auth] 認証は有効です。" -ForegroundColor Green
    }
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Claude Desk の依存パッケージをインストールします..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install に失敗しました。プロキシ設定を確認してください:" -ForegroundColor Red
        Write-Host "  npm config set proxy $env:HTTPS_PROXY"
        Write-Host "  npm config set https-proxy $env:HTTPS_PROXY"
        Write-Host "  npm config set cafile $env:AWS_CA_BUNDLE"
        exit 1
    }
}

# ブラウザは、サーバーが実際に listen を始めてから開く。以前はここで先に
# Start-Process していたため、Edge がサーバーより先に繋ぎに行って「ページを
# 表示できません」になっていた（起動ログは正常に出るので、サーバーが落ちて
# いるように見えて紛らわしい）。
#
# node server.js は前景に置いたまま、待ち役だけをジョブに逃がしている。node を
# バックグラウンドに回すとコンソールとの親子関係が変わり、上のポート掃除で
# 対処している「ウィンドウを×で閉じると node.exe が孤立して残る」挙動に
# 影響しうるため。start.sh 側も同じ待ち方をしている。
$url = "http://localhost:$($env:PORT)"
$waitThenOpen = {
    param($Port, $Url)
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $client.Connect("127.0.0.1", [int]$Port)  # 接続できた = listen 開始
            Start-Process $Url
            return
        } catch {
            # まだ起動途中。次の周回で再試行する
        } finally {
            $client.Dispose()
        }
    }
    # タイムアウト時はブラウザを開かない。開いてもエラーページになるだけで、
    # 原因（ポート衝突など）はコンソールに出ている。
}
$browserJob = $null
try {
    $browserJob = Start-Job -ScriptBlock $waitThenOpen -ArgumentList $env:PORT, $url
} catch {
    Write-Host "ブラウザの自動起動に失敗しました。$url を手動で開いてください。" -ForegroundColor Yellow
}

node server.js

if ($browserJob) { Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue }
