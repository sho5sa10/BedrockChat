#!/usr/bin/env bash
# Claude Desk — Chat & Code on Amazon Bedrock : launcher (macOS / Linux)
# 使い方:  ./start.sh
#
# 初回はいくつか質問されます。回答は start.local.json に保存され、
# 次回以降は聞かれずにそのまま起動します。
# 設定をやり直したいときは:  ./start.sh --reconfigure
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
#   "ALLOW_ANTHROPIC_DIRECT": "1"
#          … Codeタブが起動する claude CLI に対する Bedrock 経由の強制を解除する。
#            既定では Claude Desk が CLAUDE_CODE_USE_BEDROCK と
#            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC を立てて起動するので、
#            「通信先は Bedrock だけ」が保たれる。これを設定すると CLI 自身の
#            設定に委ねられ、Anthropic へ直接通信しうる（自動アップデートや
#            テレメトリも既定に戻る）。
#
# start.ps1（Windows版）と対になっている。ロジックを変更したら両方に反映すること。

set -u
cd "$(dirname "${BASH_SOURCE[0]}")"

RECONFIGURE=0
if [ "${1:-}" = "--reconfigure" ]; then
  RECONFIGURE=1
fi

printf "\n  \033[36mClaude Desk\033[0m  —  Chat & Code on Amazon Bedrock\n\n"

CONFIG_PATH="$(pwd)/start.local.json"

# node は必須依存なので、jq を新たに要求せずJSONの読み書きはnodeに任せる。
node_get() {
  # node_get <key> <default>
  node -e '
    const fs = require("fs");
    const [path, key, def] = process.argv.slice(1);
    try {
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      const v = data[key];
      process.stdout.write(v == null ? def : String(v));
    } catch { process.stdout.write(def); }
  ' "$CONFIG_PATH" "$1" "$2"
}

ask() {
  # ask <prompt> <default> -> echoes the answer
  local prompt="$1" default="$2" suffix answer
  if [ -n "$default" ]; then suffix=" [$default]"; else suffix=" [空欄でOK]"; fi
  read -r -p "$prompt$suffix: " answer || true
  if [ -z "$answer" ]; then echo "$default"; else echo "$answer"; fi
}

CONFIG_EXISTS=0
[ -f "$CONFIG_PATH" ] && CONFIG_EXISTS=1

if [ "$CONFIG_EXISTS" -eq 0 ] || [ "$RECONFIGURE" -eq 1 ]; then
  printf "\n\033[36m=== Claude Desk 初回セットアップ ===\033[0m\n"
  echo "わからない項目は空欄のままEnterで進めてください。あとで $CONFIG_PATH を直接編集しても、"
  echo "./start.sh --reconfigure でやり直しても構いません。"
  echo ""

  REGION=$(ask "AWSリージョン（例: us-east-1。空欄ならAWSプロファイル側の設定から自動解決）" "")
  PROFILE=$(ask "AWSプロファイル名（'aws configure --profile 名前' で作ったもの。空欄ならdefault）" "")

  read -r -p "社内プロキシ経由でAWSに接続する必要がありますか？ (y/N): " USE_PROXY || true
  PROXY=""
  CA_BUNDLE=""
  if [[ "$USE_PROXY" =~ ^[yY] ]]; then
    PROXY=$(ask "プロキシURL（例: http://proxy.example.co.jp:8080）" "")
    CA_BUNDLE=$(ask "SSLインスペクション用CA証明書のパス（PEM形式。不要なら空欄）" "")
  fi

  PORT=$(ask "起動ポート番号" "3210")

  node -e '
    const fs = require("fs");
    const [path, region, profile, proxy, caBundle, port] = process.argv.slice(1);
    fs.writeFileSync(path, JSON.stringify({
      AWS_REGION: region, AWS_PROFILE: profile, HTTPS_PROXY: proxy,
      AWS_CA_BUNDLE: caBundle, PORT: port,
    }, null, 2));
  ' "$CONFIG_PATH" "$REGION" "$PROFILE" "$PROXY" "$CA_BUNDLE" "$PORT"

  printf "\n\033[32m設定を %s に保存しました。次回からはこの画面は出ません。\033[0m\n\n" "$CONFIG_PATH"
fi

AWS_REGION_CFG=$(node_get AWS_REGION "")
AWS_PROFILE_CFG=$(node_get AWS_PROFILE "")
HTTPS_PROXY_CFG=$(node_get HTTPS_PROXY "")
AWS_CA_BUNDLE_CFG=$(node_get AWS_CA_BUNDLE "")
NODE_EXTRA_CA_CERTS_CFG=$(node_get NODE_EXTRA_CA_CERTS "")
LOGIN_COMMAND_CFG=$(node_get LOGIN_COMMAND "")
ALLOW_CROSS_REGION_CFG=$(node_get ALLOW_CROSS_REGION_INFERENCE "")
ALLOW_ANTHROPIC_DIRECT_CFG=$(node_get ALLOW_ANTHROPIC_DIRECT "")
PORT=$(node_get PORT "3210")

[ -n "$AWS_REGION_CFG" ] && export AWS_REGION="$AWS_REGION_CFG"
[ -n "$AWS_PROFILE_CFG" ] && export AWS_PROFILE="$AWS_PROFILE_CFG"
[ -n "$HTTPS_PROXY_CFG" ] && export HTTPS_PROXY="$HTTPS_PROXY_CFG"
if [ -n "$AWS_CA_BUNDLE_CFG" ]; then
  export AWS_CA_BUNDLE="$AWS_CA_BUNDLE_CFG"
  # Node と AWS CLI で別の証明書を使う環境向けに、明示指定があればそちらを優先する。
  export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS_CFG:-$AWS_CA_BUNDLE_CFG}"
fi
# 東京リージョンのリージョンロックを解除するオプトイン。既定では設定しない
# （東京外へ処理がルーティングされうるため）。対話では聞かず、必要な環境だけが
# start.local.json に直接書く。
[ -n "$ALLOW_CROSS_REGION_CFG" ] && export ALLOW_CROSS_REGION_INFERENCE="$ALLOW_CROSS_REGION_CFG"
# Codeタブの claude CLI に対する Bedrock 経由の強制を解除するオプトイン。
# 既定では設定しない（解除すると Anthropic へ直接通信しうるため）。
[ -n "$ALLOW_ANTHROPIC_DIRECT_CFG" ] && export ALLOW_ANTHROPIC_DIRECT="$ALLOW_ANTHROPIC_DIRECT_CFG"
export PORT

# 前回の起動を端末ごと閉じるなどした場合、node がポートを掴んだまま孤立して
# 残ることがある。起動前にポートを使用中のプロセスを検出し、node なら自動終了させる。
if command -v lsof >/dev/null 2>&1; then
  EXISTING_PIDS=$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  for pid in $EXISTING_PIDS; do
    proc_name=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    case "$proc_name" in
      *node*)
        printf "\033[33m[Cleanup] ポート %s を使用している古いサーバープロセス (PID %s) を終了します\033[0m\n" "$PORT" "$pid"
        kill "$pid" 2>/dev/null || true
        sleep 0.5
        ;;
      "")
        ;;
      *)
        printf "\033[31m[警告] ポート %s は別プロセス (PID %s, %s) が使用中です。手動で終了してください。\033[0m\n" "$PORT" "$pid" "$proc_name"
        ;;
    esac
  done
fi

# AWSのセッションが切れている場合、サーバーだけ起動できてもチャット送信時に
# CredentialsProviderError で応答が返らず「反応なし」に見える。起動前に検出する。
if command -v aws >/dev/null 2>&1; then
  echo -e "\033[36m[Auth] AWS認証状態を確認中...\033[0m"
  PROFILE_ARGS=()
  [ -n "${AWS_PROFILE:-}" ] && PROFILE_ARGS=(--profile "$AWS_PROFILE")
  if IDENTITY_CHECK=$(aws sts get-caller-identity "${PROFILE_ARGS[@]}" 2>&1); then
    echo -e "\033[32m[Auth] 認証は有効です。\033[0m"
  else
    LOGIN_COMMAND="${LOGIN_COMMAND_CFG:-aws sso login}"
    printf "\033[33m[Auth] 認証切れ、または未ログインです。'%s' で再ログインします...\033[0m\n" "$LOGIN_COMMAND"
    echo "$IDENTITY_CHECK"
    # shellcheck disable=SC2086
    if ! $LOGIN_COMMAND "${PROFILE_ARGS[@]}"; then
      echo -e "\033[31m[Auth] ログインに失敗しました。Claude Desk は AWS の認証情報がないと Bedrock を呼び出せません。\033[0m"
      printf "\033[31m[Auth] 手動で '%s %s' を実行してから、もう一度 ./start.sh を実行してください。\033[0m\n" "$LOGIN_COMMAND" "${PROFILE_ARGS[*]:-}"
      exit 1
    fi
    echo -e "\033[32m[Auth] 再ログイン成功\033[0m"
  fi
fi

if [ ! -d node_modules ]; then
  echo -e "\033[36mClaude Desk の依存パッケージをインストールします...\033[0m"
  if ! npm install; then
    echo -e "\033[31mnpm install に失敗しました。プロキシ設定を確認してください:\033[0m"
    echo "  npm config set proxy $HTTPS_PROXY"
    echo "  npm config set https-proxy $HTTPS_PROXY"
    echo "  npm config set cafile $AWS_CA_BUNDLE"
    exit 1
  fi
fi

URL="http://localhost:$PORT"

open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "$URL" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" 2>/dev/null || true
  fi
}

# ブラウザは、サーバーが実際に listen を始めてから開く。以前はここで先に
# open していたため、ブラウザがサーバーより先に繋ぎに行ってエラーページに
# なっていた（起動ログは正常に出るので、サーバーが落ちているように見えて
# 紛らわしい）。下の exec でこのシェルは node に置き換わるが、その前に
# バックグラウンドへ逃がした待ち役は別プロセスなので生き残る。
# start.ps1 側も同じ待ち方をしている。
if command -v open >/dev/null 2>&1 || command -v xdg-open >/dev/null 2>&1; then
  (
    # listen 待ちのポーリングは node で行う。start.local.json の読み書きを
    # jq ではなく node でやっているのと同じ理由で、nc / curl の有無に
    # 依存させない（node はこのアプリの必須依存）。
    if node -e "const net=require('net');const port=$PORT;const deadline=Date.now()+30000;(function attempt(){const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>{s.destroy();if(Date.now()<deadline){setTimeout(attempt,250)}else{process.exit(1)}})})();" 2>/dev/null; then
      open_browser
    fi
    # タイムアウト時はブラウザを開かない。開いてもエラーページになるだけで、
    # 原因（ポート衝突など）はコンソールに出ている。
  ) &
else
  echo "ブラウザで $URL を開いてください。"
fi

exec node server.js
