# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Claude Desk**（サブタイトル: Chat & Code on Amazon Bedrock）。claude.ai / Claude Desktop が使えない環境向けのローカルClaude環境で、Node.js/Expressサーバー + ビルドステップなしの静的フロントエンド（`public/` の3ファイル）のみで構成され、Docker/CDK/CloudFormationは使わない。社内PCから、Claude Codeと同じAWS認証情報・プロキシ・CA証明書設定で動かすことを前提にしている。

経路は2つあり、**呼び出し先も課金先も別**（README の「2つのモード」「課金の違い」を参照）:

- **ホーム経路** — `/api/chat` から Bedrock の Converse Stream API を直接呼ぶ。課金はAWSのBedrock利用料
- **Code経路** — `/api/code/*` からローカルの `claude` CLI を子プロセスとして起動する。課金はClaude Code側

v1.5.0 で「Claude Code Chat on AWS Bedrock」から「Claude Desk」に改名し、GitHubのリポジトリも `sho5sa10/Claude-Desk` に移動した。v1.4.0 以前のリリース資産のファイル名 (`bedrock-chat-vX.X.X.zip`) に旧名が残っているのは当時のままなので意図的。

## Commands

```bash
npm install       # 依存インストール
npm start         # node server.js を起動（既定ポート3210）
npm test          # node --test（code-agent/ のユニット・ワークフローテスト）
```

リント・ビルドの仕組みはない（`public/` の静的3ファイル + server.js + code-agent/ で、ビルドステップ不要）。テストは `test/` に `node --test` ベースで存在し、`code-agent/` 側（Claude Code連携・git操作・ワークフロー）のみを対象にする。`server.js` と `public/`（`index.html` / `app.js` / `styles.css`）にはテストがない（ブラウザ側のガード——例えば `quickStartInFlight` による二重セッション作成の防止——は、DOMテストの仕組みがないため回帰テストで担保できていない。ここを触るときは手で確認すること）。

テストは実際に一時gitリポジトリを作って `npm test` を走らせるため遅い。**`npm test` は `--test-concurrency=1` を付けている**——並列実行するとこのリポジトリがOneDrive上（Z:）にある環境で `waitFor: condition not met before timeout` が偶発的に出る（特に `test/workflow.test.js` の diff_ready 待ち）。直列だと73秒→119秒になるが、速さより決定性を優先している。このアプリの実装ワークフロー自身が対象リポジトリで `npm test` を実行するので、テストが不定期に落ちると「実装は正しいのにテスト失敗と報告される」ことになるため。このフラグを外さないこと。

起動は Windows なら `start.ps1`（`.\start.ps1`。PowerShellスクリプトなので `python .\start.ps1` のように別のインタプリタで実行すると構文エラーになる）、macOS/Linux なら `start.sh`（`./start.sh`。初回は `chmod +x start.sh` が必要な場合がある）を使う。両者はロジックを揃えてあるので、どちらか一方だけ直して他方を放置しないこと。初回起動時にリージョン・プロファイル・プロキシ・CA証明書・ポートを対話で聞き、`start.local.json`（Git管理外、JSON形式でOS間共通）に保存して次回以降はそれを読む。設定をやり直すときは `.\start.ps1 -Reconfigure` / `./start.sh --reconfigure`。この方式にしたのは、環境固有の値（社内プロキシURLや個人のホームディレクトリのパス）を公開リポジトリのスクリプトに書かないため。`start.sh` はJSONの読み書きに `jq` ではなく `node` を使っている（このアプリの必須依存なので新たな依存を増やさずに済む）。以下は対話では聞かない任意項目で、`start.local.json` に直接書く:

- `NODE_EXTRA_CA_CERTS` — Node と AWS CLI で別の証明書を使う環境向け（未指定なら `AWS_CA_BUNDLE` と同じ値）
- `LOGIN_COMMAND` — 認証切れ時に実行するログインコマンド（未指定なら `aws sso login`）
- `ALLOW_CROSS_REGION_INFERENCE` — `"1"` で東京リージョンのリージョンロックを解除し、`global.*`/`apac.*`/`us.*` の推論プロファイルも選べるようにする。既定は解除しない。詳細と判断材料は下の「リージョンロック」を参照

`start.ps1` はサーバー起動前に以下を自動で行う:
- ポート(既定3210)を掴んでいる古い`node.exe`プロセスを検出して終了させる（PowerShellウィンドウを×で閉じるとnode.exeが孤立して残ることがあるため）
- `aws sts get-caller-identity --profile <プロファイル>` でAWS認証状態を確認し、失効していれば `LOGIN_COMMAND`（既定 `aws sso login`）で再ログインを試行する（サーバー自体は起動できてもBedrock呼び出し時に `CredentialsProviderError` で応答が返らず「反応なし」に見える問題への対策）

**ブラウザは、サーバーが listen を始めてから開く**（v1.6.3 で修正）。以前は `node server.js` の前にブラウザを開いていたため、初回表示がエラーページになることがあった。起動ログは正常に出るので、サーバーが落ちているように見えて紛らわしい。`node server.js` は前景に置いたまま、127.0.0.1:PORT へ繋がるまで待つ役だけをバックグラウンドに逃がしている（`start.ps1` は `Start-Job` + `TcpClient`、`start.sh` は `exec` の前にバックグラウンド化したサブシェル + `node` のポーリング。`nc`/`curl` の有無に依存させないため node を使う）。**node をバックグラウンドに回さないこと**——コンソールとの親子関係が変わり、上のポート掃除で対処している「×で閉じると node.exe が孤立する」挙動に影響する。30秒待って listen しなければブラウザは開かない（開いてもエラーページになるだけで、原因はコンソールに出ている）。

サーバープロセスを長時間起動したままにすると、SDKが起動時にキャッシュした認証情報が古くなり、シェル上で再ログインしても反映されないことがある。チャットが無反応になったら、まず `start.ps1` を再実行してサーバー自体を再起動するのが最初の切り分け手順。

`Launch-ClaudeCodeBedrock-GUI.ps1`（Git管理外のローカルファイル）はClaude Code用の別ランチャーで、起動対象は VSCode / Claude Code の2択。Azure VM を検出すると社内Proxy、それ以外（物理PC）は Zscaler 直結として環境変数を設定する。Claude Desk自体は起動しないので、このアプリの起動経路は `start.ps1` / `start.sh` だけ。

## Architecture

### ファイル構成

- `server.js` — Express サーバー。Bedrock Runtime/Control プレーンへのアクセス、ファイル読み込み、SSEストリーミング、Claude Code連携エンドポイントのルーティングを担う。
- `public/index.html` / `public/styles.css` / `public/app.js` — フロントエンド。v1.6.0までは1ファイルだったが、2600行超えで見通しが悪くなったため`<style>`と`<script>`をそれぞれ切り出した（`<link rel="stylesheet">`・`<script src>`で読み込むだけで、ビルドツールは今も使わない。`express.static`が`public/`をそのまま配信する）。`<head>`直下の小さな即時実行`<script>`（テーマのFOUC防止）だけはHTML側に残している——外部ファイル化すると初回描画前に間に合わない可能性があるため。3ファイルとも同じ理由（機能追加のたびにこのファイルが肥大化する）で今後さらに分割される可能性がある。
- `code-agent/` — Claude Code（CLI）連携。`index.js`(一回きりの実装依頼) / `sessions.js`(継続する会話＋Plan→承認→編集→テスト→Diff→承認→Commitのワークフロー) / `claude-code.js`(CLIの起動とJSONLの正規化) / `git-adapter.js`・`git-info.js`・`test-runner.js`・`shell-utils.js`・`cli-config.js`(CLI自身の設定ファイルを読んでBedrock経由かを判定)。Claude Desk本体はCLIのJSONL出力を直接見ず、正規化済みイベントだけを受け取る。
- `test/`・`fixtures/` — `node --test` 用のテストと、Claude Code CLIを模した実行可能スタブ。

設定（システムプロンプト・応答スタイル・メモ・許可フォルダ・テンプレート等）はブラウザの `localStorage` にのみ保存される。会話履歴は `localStorage` を高速な正本としつつ、`data/history.json`（Git管理外）にサーバー側ミラーを持つ。社内PCではブラウザのサイトデータが消されることがあるための保険で、`/api/history` の読み取りが成功しなかったセッションでは書き込みを止める（`historyBackupHealthy`）——バックアップを空で上書きしないための保護なので、ここは緩めないこと。

### server.js の要点

- **リージョンロック**: `JAPAN_ONLY = REGION === "ap-northeast-1" && !ALLOW_CROSS_REGION` の場合、`isJapanOnlyModel()` が `jp.anthropic.*` とプレフィックスなしの `anthropic.*`（基礎モデル）のみを許可する。`global.*`/`apac.*`/`us.*` などのクロスリージョン推論プロファイルは、`/api/models` の一覧・`/api/chat` の実行・`/api/title` のいずれからも拒否される（`/api/chat` は403を返す）。これはAWSのガードレール通知（東京リージョン以外へのルーティング検知）を受けて追加した制約なので、**既定を変えるときは意図を確認すること**。
  - **`ALLOW_CROSS_REGION_INFERENCE=1` で解除できる**（v1.6.3 追加。`start.local.json` に書く任意項目で、対話では聞かない）。既定は解除しない——このアプリは同僚にも配るので、データ所在地の要件がある環境の保護を黙って外すことになる。解除は各環境が明示的に選ぶ形にしている。
  - 解除が必要になる理由: 最新モデル（Opus 5 / Sonnet 5 / Fable 5）は東京では `global.*` としてのみ提供される。プレフィックスなしの `anthropic.claude-opus-5` は `list-foundation-models` には出るが `inferenceTypesSupported` が `INFERENCE_PROFILE` のみで `ON_DEMAND` を含まないため直接呼べない（`/api/models` の line ~566 がそれを弾いているのは正しい。通すと選べるのに実行時エラーになるモデルが並ぶ）。東京で `jp.*` が存在するのは haiku-4-5 / sonnet-4-5 / sonnet-4-6 / opus-4-7 / opus-4-8 のみ。つまりロックを掛けたままでは、`jp.*` が追随するまで新しいモデルを使えない。
  - 解除が黙って効かないように、サイドバー下部の表示を「東京限定」→「東京外へルーティング可」に切り替え（`/api/config` の `crossRegionAllowed`）、起動時のコンソールにも1行出す。逆にロックが有効なときは、最新モデルが一覧に無い理由と解除方法を起動時に案内する（以前は黙って消えるだけで、モデル非対応と誤解されうる状態だった）。
  - **解除してよいかの判断根拠（実測）**: この環境では、社内の公式セットアップスクリプトが `~/.claude/settings.json` の `env` に `ANTHROPIC_DEFAULT_SONNET_MODEL = "global.anthropic.claude-sonnet-5"` を書き込む。つまり `global.*`（クロスリージョン）が標準構成であり、このフラグを立てることは標準から外れる操作ではなく**標準に揃える**操作になる。一方、文書側の構築ガイドは推奨モデルを `apac.anthropic.*` と記述しているが、そのプロファイルは実アカウントに存在しない（`apac.*` は Claude 3 系と Sonnet 4 止まり）。文書がスクリプトの実装に追い越されている状態なので、**文書ではなく現物で確認すること**: `aws bedrock list-inference-profiles --region ap-northeast-1`。
  - ただしこれは「この環境ではそうだった」という実測にすぎず、配布先の環境でも同じとは限らない。だから既定は解除しない。
  - このリポジトリは**公開**なので、判断根拠を書くときも社内のプロジェクト名・文書名・プロキシのホスト名といった固有値は書かないこと（モデルIDやAWSの一般的な仕様は書いてよい）。
- **`/api/chat`**: Bedrock `ConverseStreamCommand` の結果をSSE (`data: {...}\n\n`) でクライアントにリレーする。イベント種別は `text`/`thinking`/`usage`/`stop`/`error`/`done`。クライアント切断の検知は `res.on("close", ...)` を使うこと（`req.on("close", ...)` はリクエスト本文の読み取り完了時に発火してしまい、ストリーミング中に誤って `AbortController` を中断させるバグの原因になった実績があるため、絶対に `req` 側では張らない）。
- **`/api/title`**: 会話の最初の一往復から短いタイトルを`ConverseCommand`（非ストリーミング）で生成する。リージョンロック対象外モデルの場合は黙って `{title: null}` を返す。
- **ファイル参照**: `/api/roots` で登録したフォルダのみ `/api/files` で列挙・添付可能。`insideRoots()` で絶対パス比較しており、登録フォルダ外への読み取りは常に拒否する。
- **zip添付**: `/api/zip/open`（`adm-zip`で展開し一覧を返す）と `/api/zip/extract`（個別ファイルを取り出す）の2段構成。展開結果は**ディスクに書かない**でメモリ上の `zipStore`（token→AdmZipインスタンス）に`ZIP_TTL_MS`(10分)だけ保持する。この設計は「サーバー側に何も残さない」という全体方針を踏襲したもの。画像・許可フォルダと同じ拡張子ホワイトリスト（`IMAGE_FORMATS`/`DOC_FORMATS`）でフィルタする。
- **プロキシ/CA証明書**: `HTTPS_PROXY`/`AWS_CA_BUNDLE`/`NODE_EXTRA_CA_CERTS` を読み、`NodeHttpHandler` の `httpsAgent` に反映する。Bedrockと同じエージェント設定を `BedrockRuntimeClient`/`BedrockClient` の両方で共有している。
- **リージョンの解決順**: `clientConfig` に `region` を渡していないのは意図的。自前で `AWS_REGION` を入れるとSDKのリゾルバを覆い隠し、`AWS_PROFILE` だけ設定している環境で `~/.aws/config` の `region` にフォールバックしなくなる（実際に us-east-1 に飛ぶ不具合になった）。`REGION` は `await runtime.config.region()` で確定させるため、`JAPAN_ONLY` の判定はこの解決より**後**に置くこと（前に置くと `let REGION` のTDZで起動時に ReferenceError になる）。
- **Claude Code連携**: `/api/code/*`（`requests` = 一回きりの実装依頼、`sessions` = 継続会話とワークフロー）。SSEは `/api/chat` とは別エンドポイント・別ペイロードで、状態も共有しない。リポジトリへのアクセス権は `allowedRoots`/`insideRoots()` を再利用し、新しいアクセス制御は作らない。gitを変更するのは `/workflow/commit` と `/plan/approve` のブランチ作成だけで、いずれも人間の操作を起点にしたときのみ。push / merge を行うコードは存在しないし、追加してはいけない。
- **Code経路のBedrockルーティングは保証されない**: `code-agent/claude-code.js` の `spawn()` は `env` を上書きせず、このNode.jsプロセスの環境変数をそのまま `claude` CLIに継承させるだけ。`CLAUDE_CODE_USE_BEDROCK` はこのアプリのどこにも設定していないため、CLIが実際にBedrock経由で動くかAnthropicに直接繋がるかは完全にCLI自身の設定次第（このアプリからは制御も保証もできない）。判定は `code-agent/cli-config.js` の `resolveBedrockRouting()` に集約し、`/api/config` が毎回解決して `codeUsesBedrock` / `codeBedrockSource` / `codeBedrockDetail` を返す。確認できなかったときだけ、Codeタブに切り替えた瞬間にクライアント側で警告バナーを出す（`setSidebarTab` 内、`showSetupBanner` 経由）。
  - **環境変数だけを見てはいけない**（v1.6.2 で修正した誤検知）: CLIの設定方法として推奨されるのは `settings.json` の `env` ブロックで、`start.ps1` / `start.sh` はそれをこのプロセスの環境変数には読み込まない。そのため `process.env` だけを見ていた実装では、**正しく設定してある環境に対して「Anthropicに直接通信している可能性があります」と警告していた**。狼少年になる警告は無視されるようになるので、CLI自身が読むのと同じ設定ファイルを読む。
  - 探索順（CLIの解決順に合わせる。すべて `test/cli-config.test.js` で担保）: 企業ポリシー `managed-settings.json`（Windows `C:\Program Files\ClaudeCode` / macOS `/Library/Application Support/ClaudeCode` / Linux `/etc/claude-code`）→ Repository の `.claude/settings.local.json` → `.claude/settings.json` → ユーザーの `~/.claude/settings.json`（`CLAUDE_CONFIG_DIR` があればそちら）→ 環境変数。設定ファイルを環境変数より先に見るのは、CLIが設定の `env` ブロックを継承した環境変数の上に適用するため。上位で明示的に `"0"` になっていたら下位で再有効化しない。ファイル名・`CLAUDE_CONFIG_DIR`・managed-settings の3パスはいずれも記憶に頼らず、インストール済みCLIバイナリ内の文字列を確認して決めた。
  - ハードブロックはしない設計。ラッパースクリプト、起動ごとのフラグ、Windowsのレジストリ経由のポリシーなど、ここから見えない設定手段が残るため。バナーの文言も「設定されていません」ではなく「確認できませんでした」にしてある（`enabled:false, source:null`）。設定ファイルで明示的に無効化されている場合（`source:"settings"`）だけは断定した文言を出す。
- **git操作の安全条件**（`code-agent/git-adapter.js`。緩めるときは意図を確認すること）: ①隔離ブランチの作成は作業ツリーがクリーンなときのみ ②commit と破棄はどちらも実行直前に「その隔離ブランチが実際にチェックアウトされているか」を検証し、違えば拒否する（Diff確認からボタン押下までの間に手動でブランチを切り替えられている可能性があるため。`git add -A` / `git checkout -- .` / `git clean -fd` が無関係な変更を巻き込むのを防ぐ）③`git clean` に `-x` は付けない（`start.local.json` や `data/` を消さないため）。①〜③はすべて `test/git-adapter.test.js` の回帰テストで担保している
- **Diffの網羅性**（`code-agent/git-info.js`）: 人間が承認する Diff は「Commitボタンが実際に commit する内容」と一致していなければならない。`git diff` は untracked ファイルもstaged済みの変更も見えないので、`git diff HEAD` + `status --porcelain -z -uall` の untracked 分（新規ファイルは `git diff --no-index /dev/null <file>` で内容も）を合成している（`-z` は日本語ファイル名が8進エスケープで返るのを避けるため、`-uall` は新規ディレクトリが `dir/` 1件にまとめられるのを避けるため）。`.gitignore` 対象は `git add -A` も拾わないので除外する。`test/git-info.test.js` で担保
- **履歴バックアップ**: `/api/history` の GET/POST で `data/history.json` を読み書きする。127.0.0.1のみ・単一ユーザー前提なので認証はなく、競合制御も「後書き優先」だけ。

### public/（index.html / app.js / styles.css）の要点

以下のJSに関する記述は `public/app.js`、CSSに関する記述は `public/styles.css` を指す（v1.6.1 で `index.html` から切り出した）。

- 状態はすべて `threads`（配列）に集約し、`localStorage` の `chat.threads`/`chat.current`（＋サーバーミラー）に永続化する。スレッドは `{id, title, messages, at, pinned, archived}` に加え、Claude Codeスレッドでは `kind:"claude-code"`, `repoPath`, `repoLabel`, `mode`, `sessionId`, `workflow` を持つ。サイドバーは Home（Bedrockチャット）と Code（Claude Codeスレッド）にタブ分割されている（`sidebarTab`）。
- Bedrockへの送信は `runBedrockTurn()` に集約されている。新規送信 (`send`)・再生成 (`regenerateBedrock`)・編集後の再送信 (`startEditMessage`) はいずれもここを経由する。Claude Code側は別系統（`sendClaudeCode` / `attachCcTurn` / SSE再接続の `ensureCcConnection`）。**メッセージ配列は分岐を持たない単純な配列**なので、再生成や編集・巻き戻し (`rewindToMessage`) は「そのメッセージ以降を切り捨てて再送信」という設計（ChatGPT初期版と同様）。会話の分岐（同じ地点から複数の応答を保持して切り替え表示）は未実装で、木構造への変更が必要になる。
- コンテキスト使用量バー（`updateContextBar` / `showContextUsage`）は、モデルごとの実際の上限をBedrock APIから取得する手段がないため、Claude系の標準値 `CONTEXT_WINDOW = 200000` を固定で使っている既知の近似。usage はアシスタントメッセージの `meta.usage` に保存し、そこから最後の値を読む。
- テーマは「OS設定に追従 / light / dark」の3状態。ライトがCSS変数の既定値で、`@media(prefers-color-scheme:dark) :root:not([data-theme="light"])` と `:root[data-theme="dark"]` の2箇所にダーク値を持つ。新しい色を追加する際はハードコードせず、必ずこの3箇所すべてに変数を定義すること（`<head>` 内の即時実行スクリプトがFOUC防止のため `localStorage` の `chat.theme` を読んで即座に属性をセットしている）。
- 応答スタイル（`stylePreset`）とメモ（`memo`）は `buildSystemPrompt()` で `system` フィールドと結合されるだけで、サーバー側には保持されない軽量実装（claude.aiの「記憶」機能の簡易版という位置づけ）。
- **Artifactsプレビュー（HTML/SVG/XML限定の簡易版）**: `md()` がコードブロックの言語タグを見て `PREVIEWABLE_LANGS` に含まれる場合だけ、コードブロックのヘッダ（`.pre-head`）に「プレビュー」ボタンを付け、`togglePreview()` が `sandbox="allow-scripts"`（`allow-same-origin`は付けない）の`<iframe srcdoc>`で描画する。sandboxだけでは`<img src>`等の外部リソース読み込みを防げないため、`srcdoc`の先頭に`Content-Security-Policy: default-src 'none'`のmetaタグを必ず注入して外部通信を遮断している——これを外すとClaude Deskの「通信先はBedrockとローカルの`claude` CLIだけ」という方針が崩れるので、この2つ（sandbox属性とCSP注入）はセットで維持すること。React実行やコード実行(Analysisツール)は未実装。
- **`md()`内のコードブロック復元プレースホルダーに関する既知の罠**: `blocks.push(...)` の直後で `return \` ${blocks.length - 1} \`` としてNUL文字で挟んだプレースホルダーを生成し、関数末尾の `.replace(/ (\d+) /g, ...)` で実ブロックに戻している。ここを編集する際、生成側と復元側のプレースホルダー文字が食い違うと（例: NUL文字のつもりが通常のスペースになる等）、コードブロックが描画されず本文が欠落する。この箇所を編集した後は、実際にコードブロックを含む応答を表示させて確認すること。
