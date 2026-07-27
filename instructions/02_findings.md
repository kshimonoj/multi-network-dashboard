# 02 — network-investigation 本移植 調査結果

調査・移植日: 2026-07-23
対象: `~/corstack/plugins/network-investigation/` → `/Users/kshimono/claude/multi-network-dashboard`

---

## Task 1: styles.css の CSS 変数依存(B-04b)

### 1-1. 実際に参照されている変数(全件)

`view/*.css` `view/*.tsx` を `grep -ohE 'var\(--[a-zA-Z0-9-]+'` で全件抽出した結果、**12 個**。

| 変数 | 定義元 | ダーク値 | ライト値 |
|---|---|---|---|
| `--accent` | `~/corstack/src/styles.css:13,31` | `#4fd1c5` | `#0f9488` |
| `--accent-amber` | 同 `:14,32` | `#f2a65a` | `#b5691e` |
| `--border` | 同 `:8,26` | `#262d38` | `#dfe2e1` |
| `--border-soft` | 同 `:9,27` | `#1e242e` | `#e9ebe9` |
| `--mono` | 同 `:17` | `"IBM Plex Mono", monospace` | (共通) |
| `--panel` | 同 `:6,24` | `#1a1f27` | `#ffffff` |
| `--panel-2` | 同 `:7,25` | `#1f2530` | `#eef0ee` |
| `--radius` | 同 `:16` | `3px` | (共通) |
| `--sans` | 同 `:18` | `"IBM Plex Sans", "IBM Plex Sans JP", sans-serif` | (共通) |
| `--text` | 同 `:10,28` | `#e7eaee` | `#1c2024` |
| `--text-dim` | 同 `:12,30` | `#5b6472` | `#93999f` |
| `--text-muted` | 同 `:11,29` | `#8892a0` | `#5c6570` |

**定義元は `~/corstack/src/styles.css` の 1 ファイルのみ**(`:root` と `html[data-theme="light"]` の 2 ブロック)。
他のグローバル CSS に分散してはいなかった。

### 1-2. 切り出した内容 → `src/theme.css`

上記 12 個をそのまま複製し、加えて以下だけを足した。Corstack のテーマシステム全体(シェルの
レイアウト・アイコンツールバー・テーマ切替 UI・`--shadow`・`--bg-raise` 等)は**持ち込んでいない**。

- `--bg`(body の下地。view 側では未参照だが背景が白抜けするため必要)
- `* { box-sizing: border-box }` と `body`(margin/背景/フォント/高さ)のベースライン
- 本アプリ独自のシェル 1 段分(`.app-shell` / `.app-bar` / `.app-title` / `.app-sub` / `.app-model` / `.app-body`)

`html[data-theme="light"]` の値も同じものを入れてあるが、テーマ切替 UI は持たない
(`index.html` の `data-theme` を書き換えれば効く)。

### 1-3. グローバル CSS クラスへの依存

`view/*.tsx` の `className` を全件抽出した結果、使われているのは
**`ni-*` 接頭辞のクラスと、その修飾子(`primary` / `sm` / `error` / `focused` / `off` / `skipped`)だけ**。
修飾子はすべて `view/styles.css` 内に定義がある(`.ni-btn.primary` `.ni-root .sm` など)。
**Corstack シェル側のクラス(`.app` `.row-top` `.brand` 等)への依存は 0 件。**

### 1-4. フォント

`--sans` / `--mono` が指す IBM Plex は Corstack の `index.html` が Google Fonts から読んでいた。
本アプリの `index.html` にも同じ `<link>` をコピーした(未読み込みでも fallback で動くが、
等幅表示のトーンが変わるため入れてある)。

---

## Task 2: schedule.ts の旧スケジュール ⇄ node-cron 対応表

### 2-1. 移植元(launchd)の実行タイミング

真実は `plugins/network-investigation/schedule-config.json`。launchd の
`StartCalendarInterval` を `schedule.ts` の `buildPlist()` がこの JSON から生成していた。

| 項目 | 内容 |
|---|---|
| plist ラベル | `com.kshimono.corstack-network-investigation` |
| plist の位置 | `~/Library/LaunchAgents/<ラベル>.plist` |
| 実行するもの | `/bin/bash ~/corstack/scripts/network-investigation-refresh.sh` → `npx tsx scripts/network-investigation-refresh.ts` → `runScheduledInvestigation()` |
| **移植時点の実際の設定** | **`{ hour: 7, minute: 0, frequency: "daily", enabled: true }` = 毎日 07:00(マシンのローカル時刻 = JST)** |
| `RunAtLoad` | `false`(load 時に即実行はしない) |
| ログ | `~/corstack/logs/network-investigation-refresh.log` |
| 1 回の実行内容 | `scheduled-queries.json` の `enabled:true` を**逐次**実行 → 各件を `query-history.jsonl` へ追記 → 最後に `refreshSiteStatus()`(地図ピンの health 更新) |
| 対象クエリ(2 件) | ① 「全サイトの健全性(health)を確認し、健全性が低い、またはアラートのあるサイトを挙げて」(site 未指定)<br>② 「Home サイトの障害・アラートと端末の接続状況を確認して」(site=Home) |

### 2-2. node-cron への対応(`buildCronExpression()`)

| ScheduleConfig | launchd `StartCalendarInterval` | node-cron 式 |
|---|---|---|
| `frequency: "daily"`, `hour: H`, `minute: M` | `{ Hour: H, Minute: M }` | `"M H * * *"` |
| `frequency: "weekly"`, `hour: H`, `minute: M`, `dayOfWeek: D` | `{ Hour: H, Minute: M, Weekday: D }` | `"M H * * D"` |
| `enabled: false` | plist を `launchctl unload` | ジョブを `stop()` して破棄(再登録しない) |
| **移植時点の実設定(毎日 07:00)** | `{ Hour: 7, Minute: 0 }` | **`"0 7 * * *"`** |

- **曜日番号はそのまま使える**: launchd の `Weekday` も node-cron の曜日フィールドも `0=日曜 … 6=土曜`。
- **タイムゾーン**: launchd は「マシンのローカル時刻(JST)」で発火していた。コンテナの既定 TZ は
  UTC なので、そのままだと 9 時間ずれる。`docker-compose.yml` で `TZ: Asia/Tokyo` を渡し、
  `cron.schedule(..., { timezone: CRON_TZ })` に明示的に渡している。
- **API の対応**: `regenerateLaunchd()` → `applySchedule()`。位置づけ(plist 再生成 → unload → load)は同じで、
  「既存ジョブを stop → 新しい cron 式で再登録」に置き換えた。
- **実行対象は無改変**: `runScheduledInvestigation()`(api.ts)および `runInsightAgent()` は移植元のまま。
  cron のコールバックからこれを呼ぶだけ(`server/index.ts` の `initSchedule(runScheduledInvestigation)`)。
- **別プロセス起動口は廃止**: `scripts/network-investigation-refresh.ts` / `.sh` は複製していない。
  cron ジョブはアプリ本体プロセス内で動く(SSE も同じプロセスから流れるため、定期実行の進捗も
  ブラウザを開いていればリアルタイムに見える。launchd 版は別プロセスだったので見えなかった)。

### 2-3. 設定ファイルの置き場の変更

| | 移植元 | 本アプリ |
|---|---|---|
| `scheduled-queries.json` | `plugins/network-investigation/`(git 管理) | `data/network-investigation/`(bind mount で永続) |
| `schedule-config.json` | 同上 | 同上 |

Docker イメージを作り直しても UI で編集した設定が消えないようにするため。
`plugins/network-investigation/*.json` は**初期シード**として残し、`data/` 側が無いときだけ
起動時に複製する(`seedScheduleFiles()`)。

---

## Task 3-4: 移植で加えた変更の一覧

### 新規作成

| ファイル | 内容 |
|---|---|
| `index.html` | Vite エントリ。`data-theme="dark"` + IBM Plex 読み込み |
| `vite.config.ts` / `tsconfig.json` | Corstack のものをほぼそのまま |
| `src/main.tsx` | `NetworkInvestigation` を 1 枚だけマウントする最小シェル。`?focus=<id>` を解釈 |
| `src/shell.tsx` | `PluginEntry` 型 + `topbarModel`(`useSetTopbarModel` / `topbarModelLabel`)のローカル実装 |
| `src/theme.css` | 上記 Task 1 の切り出し |
| `server/index.ts` | Express 起動口。API マウント + cron 初期化 + dev(Vite middleware)/prod(dist 静的配信) |

`src/shell.tsx` は指示どおり **no-op スタブ**だが、Context 自体は生かしてある
(`main.tsx` が受け取った値をタイトル行の右端に `model: sonnet` として出す)。

### 既存コードへの変更(サーバー側)

| ファイル | 変更 |
|---|---|
| `api.ts` | `DATA_DIR` を本アプリの `data/` へ(env `NETINV_DATA_DIR` で上書き可)/ `regenerateLaunchd` → `applySchedule` |
| `site-map.ts` | `DATA_DIR` 同上(**DATA_DIR の書き換えはこの 2 箇所**) |
| `mcp.ts` | ①`~/.claude.json` の読み先を env `NETINV_CLAUDE_JSON` で上書き可に(Docker では `/host/claude.json`)<br>②`CENTRAL_MCP_HOST` があるとき、MCP 定義の `url` / `args` 内の `127.0.0.1` / `localhost` を差し替え(D-1 対応)<br>③一時ディレクトリ名を `corstack-*` → `multi-network-dashboard-*` にリネーム<br>④既定モデルの env を `NETINV_MODEL`(`CORSTACK_NETINV_MODEL` も互換で残す) |
| `schedule.ts` | launchd 連携(plist 生成 / `launchctl`)を **node-cron に全面置き換え**。設定 JSON を `data/` へ移動 + 初回シード |
| `insight-agent.ts` | **変更なし** |

`mcp.ts` の書き換えは接続先(`url` / `args`)の文字列のみで、`headers` / `env`(Mist の Bearer トークン)には
触れていない。

### 既存コードへの変更(view 側)

| ファイル | 変更 | 必須か |
|---|---|---|
| `view/NetworkInvestigation.tsx` | import 2 行を `../../../src/lib/types` / `../../../src/lib/topbarModel` → `../../../src/shell` に差し替え | **必須** |
| `view/ScheduleEditor.tsx` | ボタン文言 `時刻・頻度を保存(launchd 反映)` → `(cron 反映)` とコメント | 任意(表示文言のみ) |
| `view/api.ts` | `LaunchdSyncResult` の `plistPath: string` → `expression: string \| null` とコメント | 任意(型定義のみ) |

**想定外の依存は見つからなかった。** 機能上の変更が必要だったのは
`NetworkInvestigation.tsx` の 2 行だけで、残り 15 ファイルは無改変でそのまま動く
(上の 2 件は launchd 前提の文言・型名が残っていたのを実態に合わせただけ)。
なお、レスポンスのキー名 `launchd` は View との互換のため意図的に据え置いている。

---

## Task 5: 起動確認の実測

`docker compose up -d`(非 root `node` ユーザー / `NODE_ENV=production` / dist 静的配信)。

| # | 項目 | 結果 | 実測 |
|---|---|---|---|
| 1 | `/health` | ✅ | `{"ok":true,"service":"multi-network-dashboard","port":8092,...}` |
| 2 | 画面表示 | ✅ | `http://localhost:8092/` で network-investigation の 3 ペイン(コンソール / 地図 / タイムライン)が描画。console エラー 0 件 |
| 3 | 対応表の生成(手動更新ボタン相当) | ✅ | `POST /site-map/refresh` → Central 13 / Mist 9 = **22 サイト**、lat/lng 付き。両プラットフォームとも `ok:true` |
| 4 | サイト一覧表示 | ✅ | セレクトが Central / Mist の optgroup で表示。フッタ `22 サイト ・ Central 13 / Mist 9` |
| 5 | Insight Agent(サイト指定あり) | ✅ | `site=Tokyo` → `routing_decision` が `used=[central-mcp] skipped=[mist-cloud]`、`central_get_summary`(13 件)+ `central_get_sites`(1 件)を呼んで回答 |
| 6 | Insight Agent(サイト指定なし・UI から実行) | ✅ | `central_get_summary` / `get_mist_self` / `get_mist_stats` の 3 ツールを両プラットフォームで呼び、Markdown 回答 + 提案アクションチップ 1 件を描画 |
| 7 | SSE での MCP 可視化 | ✅ | ロゴバッジ(Central 橙 / Mist 緑)+ 日本語ラベル(`tool-labels.json`)+ `完了・13件` の件数がリアルタイム更新 |
| 8 | 地図ピン | ✅ | Leaflet に 22 サイトのピン。`POST /site-status/refresh` で health/devices/clients/alerts を 22 件取得しピンへ反映 |
| 9 | 定期実行(node-cron)の実発火 | ✅ | 実行時刻を 2 分後に設定 → **`01:20:00.822Z`(= JST 10:20:00)にジョブ発火**。2 クエリを逐次実行し `{"ok":true,"processed":2}`。履歴に `source:"scheduled"` が 2 件追加(うち `site=Home` は `central-mcp` のみに narrowing) |
| 10 | スケジュール設定 UI | ✅ | 「定期実行を設定」→ 時刻/頻度/有効の保存で `反映しました: 毎日 07:00(cron "0 7 * * *" / TZ=Asia/Tokyo)で定期実行を設定しました` を表示。シードした 2 クエリも一覧表示 |
| 11 | データ永続化 | ✅ | `docker compose up -d --build` で作り直した後も `./data/network-investigation/` の対応表 22 件・履歴が残存 |
| 12 | TZ | ✅ | コンテナ内 `date` → `Thu Jul 23 10:13:43 JST 2026` |

### 未検証・既知の制限

- **weekly の実発火は未検証。** cron 式の生成(`"30 9 * * 2"`)とジョブ登録の成功までは確認したが、
  実際に指定曜日に発火するところまでは待っていない(daily の実発火は確認済み)。
- **`enabled:false` での停止も実発火レベルでは未検証**(`applySchedule` が `stop()` を呼び
  `loaded:false` を返すところまで)。
- **Markdown の `_` がイタリックとして解釈される**: 回答中の `critical_alerts=1(total_alerts=1)` が
  `critical*alerts=1(total*alerts=1)` のように描画される。`view/Markdown.tsx` の既存挙動で、
  移植による退行ではない(Corstack 側でも同じ)。
- **`api.ts` の `searchIndex()` / `getSummary()` は残置**。Corstack シェル(共通検索 / Home 概要)
  専用の export で、本アプリでは誰も呼んでいない未使用コード。
- **Leaflet のタイルは OpenStreetMap から取得**するため、ブラウザ側にインターネット接続が要る。
