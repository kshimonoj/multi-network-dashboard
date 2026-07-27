# 01 — 依存関係調査 + Docker スパイク 調査結果

調査日: 2026-07-23
対象: `~/corstack/plugins/network-investigation/` → `/Users/kshimono/claude/multi-network-dashboard` への外出し
本ファイルは**調査・検証の記録のみ**。network-investigation のコード移植は行っていない。

---

## Task 1: 使用ポートの確認と選定 [B-05]

### 選定結果

**8092/tcp**

### 根拠

MacBook 上で実際に LISTEN しているポートを `lsof -nP -iTCP -sTCP:LISTEN` で列挙し、
Docker のポート公開を `docker ps -a --format "{{.Names}}\t{{.Ports}}"` で列挙し、
さらに `~/claude/**/docker-compose*.yml` の宣言済みホストポートも突き合わせた。

実測で使用中(2026-07-23 時点):

| 分類 | ポート |
|---|---|
| 実行中コンテナの公開ポート | 3001, 3002, 3007, 3010, 3011, 5201-5220, 8001, 8008, 8081, 8086, 8501 |
| ホストプロセスが LISTEN | 3001, 3002, 3007, 3010, 3011, 5000, 5201-5220, 6666, 6668, 7000, 7768, 8001, 8008, 8010, 8011, 8080, 8081, 8086, 8090, 8501, 8769, 11434, 24678, 49357, 53273, 53326, 57621, 58088 |
| compose ファイルで予約(停止中含む) | 3001, 3003, 3007, 8001, 8008, 8081 |
| 指示書の既知リスト | 3000, 3001, 3002, 3003, 3007, 3010, 3011, 3013, 5201, 8000, 8001, 8008, 8010, 8011, 8086, 8090, 8501, 5678 |

8092 は上記のいずれにも含まれず、`nc -z 127.0.0.1 8092` で未使用を確認済み。

選定理由:
- 本アプリは Corstack と同様に「単一 Express が UI と API を両方出す」構成になる見込みで、
  Corstack 本体(8090)の隣に置くと運用上の位置づけが分かりやすい。
- 8091 は将来の Corstack 側の拡張余地として空けておき、8092 を採る。

> 注: 8010(central-mcp-http)と 8011(TTL キャッシュプロキシ)は**既存インフラでそのまま流用**するため、
> 本プロジェクトでは触らない。

---

## Task 2: network-investigation の依存関係棚卸し [B-01]

### 2-1. プラグインディレクトリ外への参照(実測)

`plugins/network-investigation/` 配下の全 `.ts` / `.tsx` の import 文を全件抽出した結果、
**自プラグイン外を参照しているのは 1 ファイル・2 行だけ**だった。

| ファイル | 行 | 参照先 | 内容 |
|---|---|---|---|
| `view/NetworkInvestigation.tsx` | 2 | `../../../src/lib/types` | `PluginEntry` 型(**型のみ**。`id/name/sub?/icon?/order` の 5 フィールド) |
| `view/NetworkInvestigation.tsx` | 15 | `../../../src/lib/topbarModel` | `useSetTopbarModel` / `topbarModelLabel`(Corstack シェルのトップバー右上にモデル名を出す React Context) |

サーバー側(`api.ts` / `mcp.ts` / `insight-agent.ts` / `site-map.ts` / `schedule.ts`)は
**Corstack 本体のモジュールを一切 import していない**。外部依存は `express` と Node.js 標準のみ。

npm 依存(プラグインが直接使うもの): `express`, `react`, `recharts`(Chart.tsx), `mermaid`(Topology.tsx), `leaflet` + `leaflet/dist/leaflet.css`(SiteMap.tsx)。

### 2-2. Corstack 本体側のマウント方法(接続点)

`server/index.ts` の該当箇所:

```ts
const { router, searchIndex, getSummary } =
  await import("../plugins/network-investigation/api.js");
...
app.use("/api/network-investigation", networkInvestigationRouter);
```

- ルーターは `/api/network-investigation` 配下に丸ごとマウントされる(1 プラグイン = 1 プレフィクス)。
- 本体はプラグインから 3 つの export を要求する: `router`(必須)/ `searchIndex()`(共通検索)/ `getSummary()`(Home 概要)。
- `searchIndex` / `getSummary` は**Corstack シェル固有の集約機能**。独立アプリでは呼ぶ側が居なくなるので不要。
- フロントエンドは `src/lib/pluginViews.tsx` の `PLUGIN_VIEWS` テーブルで
  `"network-investigation" → NetworkInvestigation` として登録され、`src/App.tsx` が
  `/p/<pluginId>?focus=<id>` のルート(`src/lib/useRoute.ts`)に応じてマウントする。
- 起動口は `server/index.ts`(port 8090、dev は Vite middleware モード / prod は `dist/` 静的配信)。
  `.env` の読み込みは `process.loadEnvFile(ROOT/.env)` で本体が行い、プラグインは `process.env` を見るだけ。

### 2-3. データパス(filesystem-as-DB)

| パス | 定義箇所 | 解決方法 |
|---|---|---|
| `data/network-investigation/` | `api.ts:41`, `site-map.ts:21` | `path.resolve(__dirname, "../../data/network-investigation")` |
| `query-history.jsonl` | `api.ts:42` | 上記 DATA_DIR 配下 |
| `site-status.json` | `api.ts:43` | 上記 DATA_DIR 配下 |
| `site-platform-map.json` | `site-map.ts:22` | 上記 DATA_DIR 配下 |
| `scheduled-queries.json` / `schedule-config.json` | `schedule.ts:19-20` | `path.join(__dirname, ...)`(プラグイン内・git 管理下) |
| `tool-labels.json` | `view/toolLabels.ts:5` | `import ... from "../tool-labels.json"`(プラグイン内) |

**結論: Corstack 本体の共通パス解決ロジックには依存していない。**
各ファイルが自前で `fileURLToPath(import.meta.url)` から `__dirname` を作り、そこからの相対で解決している。
`../../data/...` という「プラグインから見て 2 階層上」の相対だけが暗黙の前提で、
新アプリのディレクトリ構成に合わせて定数 1 個を書き換えれば済む。

### 2-4. 本体リポジトリ側にある「プラグイン外の実装」

| パス | 役割 | 移植時の扱い |
|---|---|---|
| `scripts/network-investigation-refresh.ts` | launchd から呼ばれる定期実行エントリ。`runScheduledInvestigation()` を import して1回叩くだけ | 要複製(数行) |
| `scripts/network-investigation-refresh.sh` | 上記の launchd 用ラッパ。PATH に Homebrew を足して `npx tsx` する | **Docker 化で不要**(コンテナ内の cron / ホスト側 launchd どちらにするかは要判断) |
| `plugins/registry.json` | プラグイン一覧(id/name/icon/order) | 単一アプリでは不要 |
| `logs/network-investigation-refresh.log` | 定期実行ログ出力先 | 出力先の再定義が必要 |

### 2-5. 他プラグイン・home-summary との連携

全リポジトリを `grep -rn "network-investigation"` で走査した結果:

- **他プラグイン(Topic Watch / Clips / Discussion Panel 等)からの参照は 0 件。**
  逆に network-investigation が他プラグインのデータを読む箇所も 0 件。プラグイン間結合は無い。
- home-summary 連携は `api.ts` の `getSummary()`(対応表のサイト数を申告)を
  `server/index.ts` の `summaryProviders` 配列に登録している一方向のみ。
- 共通検索連携も `api.ts` の `searchIndex()`(query-history を検索対象として申告、
  URL は `/p/network-investigation?focus=<id>`)を `searchProviders` に登録している一方向のみ。
- トップバーの固定モデル表(`fixedModels`)には**含まれていない**(対話系は画面で選ぶため)。

### 2-6. 環境変数

プラグインが読む環境変数は `CORSTACK_NETINV_MODEL`(`mcp.ts:205`)のみ。
`~/corstack/.env` には**未設定**のため、実運用では既定値 `"sonnet"` にフォールバックしている。
`.env` の他のキー(IMAP / Telegram / Clips トークン等)はすべて他プラグイン用で、無関係。

### 2-7. 分類:「そのままコピーで完結」vs「複製・簡略化が必要」

#### A. そのままコピーで完結する(無改変で動く)

| 対象 | 備考 |
|---|---|
| `mcp.ts` | 外部依存は Node 標準のみ。`claude` CLI を PATH から起動、`~/.claude.json` を `os.homedir()` 基準で読む。**ただし後述の Docker 起因の 2 点(D-1/D-2)を除く** |
| `insight-agent.ts` | import は同一ディレクトリの `mcp.js` / `site-map.js` のみ |
| `schedule.ts` の設定 I/O 部分 | `scheduled-queries.json` / `schedule-config.json` の読み書きは `__dirname` 基準で自己完結 |
| `view/` の 15 ファイル中 14 ファイル | `Chart.tsx` `Markdown.tsx` `Topology.tsx` `SiteMap.tsx` `SseLog.tsx` `Timeline.tsx` `HistoryDetail.tsx` `LogoBadge.tsx` `ScheduleEditor.tsx` `SuggestedActions.tsx` `safeHref.ts` `toolLabels.ts` `types.ts` `api.ts` `styles.css` — すべて相対 import のみ |
| `tool-labels.json` / `scheduled-queries.json` / `schedule-config.json` / `schema.md` | データ・ドキュメント |

#### B. 複製・簡略化が必要

| 対象 | 何が必要か | 規模 |
|---|---|---|
| **`view/NetworkInvestigation.tsx`** | `src/lib/types` の `PluginEntry` 型(5 行)と `src/lib/topbarModel` の `useSetTopbarModel` / `topbarModelLabel` を複製するか、単一アプリなので Context ごと削って props 直渡し/ローカル state に簡略化する | 小(型 5 行 + Context 1 個) |
| **`api.ts` の `searchIndex()` / `getSummary()`** | Corstack シェル(共通検索・Home 概要)専用の export。独立アプリでは呼び手が居ないので削除、または単一アプリ用の概要 API に読み替える | 小(2 関数) |
| **`api.ts` の DATA_DIR 定数** | `path.resolve(__dirname, "../../data/network-investigation")` が「プラグインが 2 階層下にある」前提。新構成のレイアウトに合わせて再定義。`site-map.ts` も同じ定数を持つので 2 箇所 | 小(定数 2 個) |
| **`schedule.ts` の launchd 連携** | `~/Library/LaunchAgents/com.kshimono.corstack-network-investigation.plist` の生成・`launchctl` 実行・`REPO_ROOT/scripts/*.sh` 参照。**コンテナ内には launchd も launchctl も存在しない**ため、そのままでは機能しない。cron / node-cron / ホスト側からの HTTP キック等への設計変更が必要 | **中〜大(要設計判断)** |
| **Express 起動エントリ** | `server/index.ts` から `express.json()` + router マウント + 静的配信 + Vite middleware の骨格を複製・簡略化する(**B-04: 本タスクでは結論を出さない**) | 中 |
| **Vite / React ビルド基盤** | `vite.config.ts` / `index.html` / `src/main.tsx` 相当、フォント読み込み、`data-theme="dark"`、`styles.css` のシェル側変数に依存している部分の洗い出し | 中 |
| **定期実行エントリ** | `scripts/network-investigation-refresh.ts`(数行)の複製 + `.sh` ラッパの Docker 向け置き換え | 小〜中 |

#### D. Docker 化に固有の要改修点(スパイクで判明・後述 Task 4 参照)

| ID | 箇所 | 内容 |
|---|---|---|
| **D-1** | `mcp.ts` の `readGlobalMcpServers()` | `~/.claude.json` の `central-mcp` は url が `http://127.0.0.1:8011/mcp`。コンテナ内の 127.0.0.1 はコンテナ自身を指すため、**`host.docker.internal` への書き換えが必須**。書き換えれば E2E で動作することを実測確認済み |
| **D-2** | `mcp.ts` の `spawn("claude", ...)` | `--dangerously-skip-permissions` は **root では拒否される**("cannot be used with root/sudo privileges")。コンテナを非 root ユーザーで動かす必要がある |
| **D-3** | 認証 | macOS では claude の認証情報は `~/.claude` ではなく**ログイン Keychain**("Claude Code-credentials")にある。`~/.claude` / `~/.claude.json` をマウントしても認証は引き継がれない。`CLAUDE_CODE_OAUTH_TOKEN` を環境変数で渡す必要がある |
| **D-4** | `mcp.ts:128,134` の一時パス | `AGENT_CWD = os.tmpdir()/corstack-network-investigation`、`MCP_CONFIG_DIR = os.homedir()/.cache/corstack-...`。コンテナ内でも動くが、名前は要リネーム。`~/.claude.json` を read-only マウントする方針なら HOME はコンテナ専用にする必要がある |
| **D-5** | `schedule.ts` | launchd/launchctl 非存在(上記 B 表と同じ) |

---

## Task 3: Docker 最小骨格

作成したファイル(`/Users/kshimono/claude/multi-network-dashboard/`):

| ファイル | 内容 |
|---|---|
| `Dockerfile` | `node:22-slim` + ca-certificates/curl/git/ripgrep + `@anthropic-ai/claude-code` グローバルインストール。**非 root(`node`, uid 1000)で実行**(D-2 のため) |
| `docker-compose.yml` | 単一サービス。`8092:8092` 公開。`~/.claude` / `~/.claude.json` を **read-only** マウント、コンテナ専用 HOME は名前付きボリューム。`extra_hosts: host.docker.internal:host-gateway` |
| `package.json` | express のみ |
| `server.js` | `/health` のみの最小 Express |
| `.env.example` | `CLAUDE_CODE_OAUTH_TOKEN` の取得方法を記載 |
| `.gitignore` | `.env` / `node_modules` / `data` を除外 |

マウント方針の理由:
- `~/.claude.json` は MCP サーバー定義(central-mcp / mist-cloud)の唯一の供給源だが、
  **Mist の Bearer トークンが平文で入っている**ため、リポジトリに複製せず read-only マウントで参照のみにする。
- `~/.claude` を read-write でコンテナの `$HOME` に被せると、コンテナ内 claude の session/history が
  ホストの `~/.claude` を汚す。そのため `/host/claude:ro` に置き、コンテナは自前の HOME を持つ。
  read-only であること、およびホスト `~/.claude` が汚染されていないことを実測確認済み。

---

## Task 4: 疎通スパイク検証の結果 [B-02, B-03]

全項目、`docker compose` で起動したコンテナ(非 root `node` ユーザー)内で実行。

| # | 検証項目 | 結果 | 実測内容 |
|---|---|---|---|
| 0 | コンテナ /health | ✅ 成功 | `curl http://127.0.0.1:8092/health` → `{"ok":true,"service":"multi-network-dashboard","port":8092,...}` |
| 1 | central-mcp 到達性 | ✅ 成功 | `GET http://host.docker.internal:8011/mcp` → **HTTP 405**(Method Not Allowed = HTTP 層まで到達)。さらに `POST /mcp` で MCP `initialize` を投げ **HTTP 200 + `serverInfo.name = "central-mcp-cache-proxy"`** を取得。TTL キャッシュプロキシとの JSON-RPC ハンドシェイクまで成立 |
| 2a | claude CLI 起動 | ✅ 成功 | `claude --version` → `2.1.218 (Claude Code)` |
| 2b | `claude mcp list` | △ 部分成功 | `clab-mcp: ✔ Connected` / `mist-cloud: ✔ Connected` / **`central-mcp: ✘ Failed to connect`**。原因は D-1(`127.0.0.1` がコンテナ自身を指す)。`host.docker.internal` に書き換えた mcp-config を使えば接続できることを #4 で確認 |
| 2c | マウントした `~/.claude`/`~/.claude.json` での認証 | ❌ **失敗** | `claude --print` → `{"is_error":true, "result":"Not logged in · Please run /login"}`。ホスト `~/.claude/.credentials.json` は**存在せず**、認証情報は macOS ログイン Keychain(`security find-generic-password -s "Claude Code-credentials"`)にある。マウントでは引き継がれない(D-3) |
| 2d | `CLAUDE_CODE_OAUTH_TOKEN` での認証 | ✅ 成功 | Keychain から取り出した access token を環境変数で渡すと `{"is_error":false, "result":"SPIKE_OK"}` |
| 3a | `--dangerously-skip-permissions`(root) | ❌ **失敗** | `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`(D-2) |
| 3b | `--strict-mcp-config` + `--dangerously-skip-permissions`(非 root) | ✅ 成功 | 空 config (`{"mcpServers":{}}`) で `--print --output-format json --strict-mcp-config --mcp-config empty.json --dangerously-skip-permissions --model sonnet` → `is_error=false, result="SPIKE_OK"` |
| 4a | `npx mcp-remote` の取得・実行 | ✅ 成功 | `npx -y mcp-remote --help` は mcp-remote 側が `--help` を URL として解釈して `ERR_INVALID_URL` になるが、**パッケージのダウンロードと実行自体は成功**(`/home/node/.npm/_npx/.../mcp-remote/dist/` に展開)。ネットワーク・npx 実行環境に問題なし |
| 4b | mist-cloud E2E(npx mcp-remote 経由の実ツール呼び出し) | ✅ 成功 | `--strict-mcp-config --mcp-config mist.json --allowedTools "mcp__mist-cloud__*"` で `get_mist_self` を実行 → `is_error=false, result="MIST_OK"` |
| 5 | central-mcp E2E(実ツール呼び出し) | ✅ 成功 | `~/.claude.json` の url を `host.docker.internal` に書き換えた mcp-config で `central_get_summary` を実行 → `is_error=false, result="SITES=13"` |

### 検証で判明した必須の改修(再掲)

1. **非 root で動かす**(`--dangerously-skip-permissions` が root を拒否)→ Dockerfile に `USER node` を反映済み
2. **`CLAUDE_CODE_OAUTH_TOKEN` を渡す**(macOS Keychain 認証はマウントで引き継がれない)
   → 長期トークンはホストで `claude setup-token` を実行して発行する。
     Keychain の access token は短命(今回の実測値で発行から数時間)なので恒久運用には不適
3. **central-mcp の url を `127.0.0.1` → `host.docker.internal` に書き換える**
   → `mcp.ts` の `writeNarrowedMcpConfig()` に 1 行足すだけで済む(実測で E2E 成立を確認)

### セキュリティ上の注意

- `~/.claude.json` には Mist の Bearer トークンが平文で格納されており、`claude mcp list` の
  出力にもそのまま表示される。ログ・スクリーンショット・git への混入に注意が必要。
  本ファイルにはトークン値を記載していない。
- `.env`(`CLAUDE_CODE_OAUTH_TOKEN` を含む)は `.gitignore` 済み。
