# 01: 依存関係調査 + Dockerスパイク(multi-network-dashboard)

## PRECONDITIONS (from blindspot-pass)

### 前提・制約
- このタスクは「本移植」ではない。**調査とスパイク検証のみ**を行い、network-investigationのコード自体はまだ移植しない。
- 実装(02番以降)に進む前に、ここでの調査・検証結果をverified-report形式で確認する。
- git操作は禁止(commit/push/branch作成は行わない)。ファイル作成・変更のみ。

### DEFERRED(未確定のまま進める項目)
- [B-04] 独立Expressサーバーのエントリーポイント構成(Corstack本体からどこまで複製するか)は、本タスクの調査結果を見てから次の指示ファイルで判断する。今回は結論を出さなくてよい。

---

## 背景

`~/corstack/plugins/network-investigation/` の機能を、`/Users/kshimono/claude/multi-network-dashboard` に独立したDockerアプリとして外出しするプロジェクトの最初のステップ。
今回は移植そのものではなく、(A) 移植範囲の確定に必要な依存調査、(B) 移植の前提となるDocker基盤の疎通確認、の2つを行う。

## 既存インフラ(そのまま流用・変更しない)

- central-mcp-server: streamable-http常駐化済み、port 8010、作業ディレクトリ `~/claude/central-mcp-http/`、launchdで常駐管理
- central-mcp用TTLキャッシュプロキシ: port 8011(central-mcp-httpの手前段)
- mist-cloud: `mcp.ai.juniper.net`(Juniperホスト)。ローカルは`npx mcp-remote`が中継プロキシとして動くのみ

## タスク

### Task 1: 使用ポートの確認(B-05)

1. `docker ps --format "table {{.Names}}\t{{.Ports}}"` で現在MacBook上で使用中の全ポートを列挙する
2. 既知の使用済みポート(3000,3001,3002,3003,3007,3010,3011,3013,5201,8000,8001,8008,8010,8011,8086,8090,8501,5678)と突き合わせ、衝突しない空きポートを1つ選定する
3. 選定結果とその根拠を `instructions/01_findings.md` に記録する(後続タスクの報告にも使う)

### Task 2: network-investigationの依存関係棚卸し(B-01)

1. `~/corstack/plugins/network-investigation/` 配下の全ファイル(`site-map.ts`, `insight-agent.ts`, `mcp.ts`, `api.ts`, `view/`以下一式)を対象に、以下を`grep`等で調査する:
   - `~/corstack/`配下で、自プラグインディレクトリの**外**を参照しているimport(共通ミドルウェア、共通設定、共通型定義、他プラグインのデータ等)
   - Corstack本体のExpressアプリへのマウント方法(ルーティング登録箇所、`plugins/`外の起動エントリーポイントとの接続点)
   - filesystem-as-DB規約における実データパス(`data/`配下のどこを読み書きしているか)が、Corstack本体の共通パス解決ロジックに依存していないか
   - home-summary連携や他プラグイン(Topic Watch, Clips等)からの参照有無
2. 調査結果を「そのままコピーで完結する部分」と「Corstack本体側の共通処理を何らか複製・簡略化しないと動かない部分」に分けて `instructions/01_findings.md` に一覧化する
3. この段階ではコードの複製・変更は行わない。調査結果の記録のみ。

### Task 3: Docker最小骨格の作成

`/Users/kshimono/claude/multi-network-dashboard` に以下を作成する(コード移植はまだ行わない、疎通確認用の最小構成):

1. `docker-compose.yml`: Task 1で選定したポートを公開する単一サービス構成
2. `Dockerfile`: Node.js + Express の最小構成(空のサーバーでよい、`/health`エンドポイントのみ実装)
3. `~/.claude` と `~/.claude.json` をコンテナにボリュームマウントする設定を追加する
4. claude CLIをコンテナイメージ内にインストールする(pluginやMCP設定に必要なパッケージを含む)

### Task 4: 疎通スパイク検証(B-02, B-03)

コンテナを起動した状態で、以下を実際に実行し、結果を記録する:

1. **central-mcp接続確認**: コンテナ内から `curl http://host.docker.internal:8011/<適当なヘルスチェック相当のエンドポイント>` を実行し、到達可能か確認する。到達できない場合はエラー内容(接続拒否/名前解決失敗など)をそのまま記録する
2. **claude CLI認証確認**: コンテナ内で `claude --version` および認証情報を要するコマンド(例: `claude mcp list` 等の軽量コマンド)を実行し、マウントした`~/.claude`, `~/.claude.json`を使って認証が通るか確認する
3. **--strict-mcp-config動作確認**: コンテナ内でclaude CLIを`--strict-mcp-config`付きのsubprocessとして起動できるか(実際にnetwork-investigation用のMCP設定を使う必要はなく、空/ダミーのmcp-config.jsonでよい)を確認する
4. **mist-cloud中継確認**: コンテナ内で `npx mcp-remote <適当な検証コマンド>` (or `npx -y mcp-remote --help` レベルでよい)を実行し、npxパッケージの取得・実行がコンテナ内のネットワーク環境で可能か確認する
5. 各項目について成功/失敗と、失敗時は具体的なエラーメッセージを記録する

## 完了報告

完了報告は **verified-report形式**とすること。特に以下は必ずVERIFIED/UNVERIFIED/RISKSのいずれかに対応づけて報告すること:

- [B-01] network-investigationのCorstack本体への依存範囲(何が「そのまま移植可」で何が「複製・簡略化が必要」か)
- [B-02] コンテナ内でのclaude CLI認証・subprocess起動の可否
- [B-03] コンテナ内での`npx mcp-remote`実行の可否
- [B-05] 選定したポート番号とその根拠

`instructions/01_findings.md` の内容をそのまま報告に含めること。
