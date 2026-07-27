# network-investigation — データスキーマ

Corstack の原則「filesystem as database」(`CLAUDE.md`)に従い、DB エンジンは使わない。
このプラグインの扱うデータのうち **真実(source of truth)は Central / Mist(外部)側にある**。
Corstack が持つのは、そこから導出した「サイト→プラットフォーム対応表」だけ(再生成可能)。

## スコープ(instructions/13_network_investigation_scaffold.md)

- 対象プラットフォームは **Central / Mist のみ**(CLAB は対象外)。
- Insight Agent は独立エージェント化せず **共通関数 `runInsightAgent()`**。対話・スケジューラ・UI ボタンの
  3 箇所すべてがこの関数を呼ぶ。
- Central / Mist への問い合わせは、既存プラグイン(Discussion Panel)と同じ **`claude` CLI subprocess** 方式。
  `--mcp-config` に含める MCP サーバーを対応表に基づいて動的に絞り込む(= ルーティングスキップ)。
- 対応表は **事前生成 + 手動更新ボタン** 方式。Central と Mist が同一サイトを重複管理しない前提で、
  両プラットフォームのサイト一覧を `platform` ラベル付きでマージするだけ(名前突き合わせはしない)。

## 配置(Corstack 側・書き込み先)

```
data/network-investigation/
  site-platform-map.json   ← サイト→プラットフォーム対応表(導出データ・再生成可能)
  query-history.jsonl      ← クエリ実行履歴(追記専用)。タイムライン + 共通検索の対象
  site-status.json         ← 地図ピン用のサイト状態キャッシュ(health 等・導出データ)
```

`data/` は `.gitignore` 済み(GitHub にアップロードしない)。
スケジュール設定は秘匿情報を含まないため git 管理下の `plugins/network-investigation/` に置く(Task 5):

- `scheduled-queries.json` — 定期実行の対象クエリ `[{ id, query, site?, enabled, model? }]`(CRUD 対象)。`model` は UI からは常に明示的に付く(既定 sonnet)。旧・未指定の `model` 欠落エントリは実行時に `CORSTACK_NETINV_MODEL` → `"sonnet"` にフォールバック
- `schedule-config.json` — 実行時刻・頻度 `{ hour, minute, frequency: "daily"|"weekly", dayOfWeek?, enabled }`
- `tool-labels.json` — MCP ツール名 → 人間向け日本語ラベル(View の SSE ログ・履歴詳細で使う)

`schedule-config.json` の変更時は `schedule.ts` の `regenerateLaunchd()` が launchd plist
(`~/Library/LaunchAgents/com.kshimono.corstack-network-investigation.plist`)を再生成し、
`launchctl unload`→`load` し直す(実行時刻・頻度の変更を実スケジューラへ反映する)。

### `query-history.jsonl` の構造(1行1レコード・追記専用)

```jsonc
{
  "id": "c2d78134-…",           // runId(= 共通検索の focus 対象)
  "ts": "2026-07-22T06:08:13Z",
  "query": "Home サイトの障害を確認して",
  "site": "Home",                // サイト指定(なければ null)
  "resolvedPlatform": "central", // narrowing で確定した platform(不明なら null)
  "platformsUsed": ["central"],
  "mcpServers": ["central-mcp"],
  "source": "manual",            // "manual" | "scheduled"
  "model": "sonnet",             // この実行に使ったモデル(旧履歴には無い。未指定なら CORSTACK_NETINV_MODEL → "sonnet")
  "answerExcerpt": "…",          // 回答の先頭 200 字(タイムライン一覧用)
  "isError": false,
  // ---- 履歴詳細ビュー用(Task 4)。古い履歴には無いので読み手はオプショナル扱いにする ----
  "answer": "…",                 // 回答全文(Markdown)。suggested-actions ブロックは除去済み。
                                  //   本文中の ```chart / ```topology は残し、View が recharts / mermaid で描画する
  "calls": [                      // 呼び出したツールの最終状態
    { "server": "central-mcp", "platform": "central", "tool": "central_get_alerts",
      "status": "done", "detail": "site_id=…", "count": 3 }
  ],
  "judgments": [                  // モデル判断によるプラットフォーム省略(Task 1。無ければ [])
    { "platform": "central", "reason": "…" }
  ],
  "suggestedActions": [           // クリック可能な追い質問(Task 19。無ければ [])。
                                  //   モデルが本文末尾に出した ```suggested-actions を切り出したもの
    { "label": "AP一覧を確認", "query": "Home サイトのAP一覧を確認して", "site": "Home" }
  ]
}
```

整合性(追記)の責務は、書き込みを起こした側(`POST /query` の実行 = `runQuery`)だけが持つ。

### `site-status.json` の構造(導出キャッシュ)

```jsonc
{
  "statuses": {
    "<CENTRAL_SITE_ID>": { "siteId": "<CENTRAL_SITE_ID>", "platform": "central",
                    "health": 87, "devices": 4, "clients": 10, "alerts": 0 }
  },
  "updatedAt": "2026-07-22T06:20:00Z"
}
```

真実は Central / Mist 側。整合性管理は `POST /site-status/refresh`(= `refreshSiteStatus`)だけの責務。

### `site-platform-map.json` の構造

Central / Mist 双方のサイトを 1 対 1 で振り分けた対応表。`platform` ラベル付きの単純な配列。

```jsonc
[
  {
    "siteName": "Home",        // サイト名
    "platform": "central",     // "central" | "mist"
    "siteId": "<CENTRAL_SITE_ID>",     // Central の site_id / Mist の site UUID
    "lat": 35.0000000,         // 地図ピン用緯度(取得不可なら null)
    "lng": 135.0000000         // 地図ピン用経度(取得不可なら null)
  },
  {
    "siteName": "<SITE_C>",
    "platform": "mist",
    "siteId": "<MIST_SITE_ID>",
    "lat": 35.00000,
    "lng": 135.000000
  }
]
```

## 緯度経度の取得元(本タスクで確認)

| platform | サイト一覧 | 緯度経度 |
| --- | --- | --- |
| Central | `central_get_summary`(name・site_id) | `central_get_sites` の `location.lat` / `location.lng`(**取得可**) |
| Mist | `get_mist_config(resource_type='sites')`(id・name。**一覧には latlng 無し**) | サイト個別 `get_mist_config(resource_type='sites', resource_id=<id>)` の `latlng.lat` / `latlng.lng`(**取得可**) |

- Central は `central_get_sites` の `location` に緯度経度を持つため、**null にはならない**(住所未設定サイトのみ null 想定)。
- Mist は一覧レベルには `latlng` が無く、サイト個別取得で `latlng` を得る。

## MCP narrowing(ルーティングスキップ)

`plugins/network-investigation/mcp.ts`:

- `PLATFORM_TO_MCP_SERVER = { central: "central-mcp", mist: "mist-cloud" }`
- `writeNarrowedMcpConfig(platforms)` … 指定プラットフォームに対応する MCP サーバーだけを含む
  一時 mcp-config(`os.tmpdir()` 配下・揮発)を書き出し、そのパスを返す。
- MCP サーバー定義(接続先・トークン)は **リポジトリに複製せず** ユーザーのグローバル
  `~/.claude.json` の `mcpServers` から読む(秘匿情報を git 管理下に持ち込まない)。
- claude CLI は `--strict-mcp-config`(この config のサーバーだけ使う)+ `--mcp-config <tmp>` +
  `--dangerously-skip-permissions` + `--allowedTools mcp__<server>__*` で起動する。

サイト指定があるとき → 対応表から `platform` を引いて **その 1 つだけ** を config に含める。
サイト不明のとき → 両方を含める。

## API エンドポイント

すべて `/api/network-investigation` 配下にマウントする(`server/index.ts`)。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/site-map` | 現在の対応表(`site-platform-map.json`)を返す。未生成なら `entries: []` |
| POST | `/site-map/refresh` | 対応表を再生成して上書き。Central/Mist をそれぞれ専用 narrowing で取得しマージ。片方失敗でも他方は残す(両方失敗時のみ既存ファイルを保持) |
| GET | `/events` | **SSE**。MCP 呼び出しの見える化(`run_start` / `routing_decision` / `mcp_call` / `answer` / `history`)をリアルタイム配信する。pub/sub(Discussion Panel と同じ枠組み) |
| POST | `/query` | Insight Agent をバックグラウンド起動し、即 `{ runId }` を返す。進捗・結果は `/events` の SSE で流れる。`site` 指定時は対応表から platform を引き MCP を narrowing する |
| GET | `/history` | クエリ実行履歴(`query-history.jsonl`)を新しい順で返す |
| GET | `/site-status` | サイト状態キャッシュ(`site-status.json`)を返す |
| POST | `/site-status/refresh` | Central/Mist からサイト状態(health 等)を再取得して上書き |
| GET | `/scheduled-queries` | 定期実行の対象クエリ一覧(`scheduled-queries.json`)を返す |
| POST | `/scheduled-queries` | 定期実行クエリを追加(Task 5) |
| PUT | `/scheduled-queries/:id` | 定期実行クエリを編集(query / site / enabled) |
| DELETE | `/scheduled-queries/:id` | 定期実行クエリを削除 |
| GET | `/schedule-config` | 実行時刻・頻度(`schedule-config.json`)を返す |
| PUT | `/schedule-config` | 実行時刻・頻度を保存し、launchd plist を再生成して `unload`→`load` し直す |

### SSE 見える化(Task 1/2 の実体)

`runInsightAgent()` は `claude` を `--output-format stream-json --verbose` で起動し、NDJSON を
**1行ずつ**パースして `tool_use` / `tool_result` を取り出す(既存プラグインは全出力を一括
バッファして最終 `result` だけを見るが、このプラグインはツール呼び出しを逐次配信する)。
`mcp.ts` の `runClaudeWithMcp({ onEvent })` がその逐次パースを担い、`insight-agent.ts` が
「呼び出し(calling)→ 完了(done/error)」の `McpCallEvent` へ変換、`api.ts` が SSE へ流す。

**ルーティングスキップ**は SSE 最初の `routing_decision` イベントで示す:
`{ used: string[], skipped: string[], reason: string, resolvedPlatform }`。サイトが対応表で
引ければ `used=[そのサーバー] / skipped=[もう一方]`、引けない/未指定なら両方を `used` にする。

**2種類の「省略」を別イベント・別の見た目で示す(Task 1)**:

- `routing_decision` の `skipped` … サイト管理による省略(`--mcp-config` にそもそも含めない)。グレースケールのロゴバッジ。
- `platform_judgment` … `{ platform, reason }`。サイト未指定(両方接続)なのに、モデルが片方を明示的に
  不要と判断して省略した宣言。SYSTEM_PROMPT が指示する `[判断] <platform>は不要と判断: <理由>` を
  assistant テキストから検出して emit する。View では吹き出しアイコン付きの別バッジで示す。
  サイト未指定時は SYSTEM_PROMPT に「原則 Central/Mist 両方を呼び、省略するなら必ず宣言する」を足す。

## スケジュール実行(Task 6 / Task 5)

- 共通ランナー `runScheduledInvestigation()`(`api.ts`)が `scheduled-queries.json` の
  `enabled:true` を **逐次**実行し、それぞれ `query-history.jsonl` へ `source:"scheduled"` で
  追記する(`schedule-config.json` の `enabled:false` なら何もしない)。最後に
  `refreshSiteStatus()` も呼ぶ(地図ピンの health を新鮮に保つ)。
- 起動口 `scripts/network-investigation-refresh.ts`(+ `.sh` ラッパ)を launchd から呼ぶ。
  plist: `~/Library/LaunchAgents/com.kshimono.corstack-network-investigation.plist`
  (`StartCalendarInterval` 毎日 07:00 / `RunAtLoad` false。competitor-comparison と同じパターン)。
- **実行時刻・頻度は `schedule-config.json`**、**対象クエリは `scheduled-queries.json`** で持つ。
  UI(Timeline 内の「定期実行を設定」)から両方を編集でき、時刻・頻度の保存時に plist を再生成する(Task 5)。
- タイムライン View は `GET /history` の履歴を時系列で描画する(キャッシュヒット/ミスは表示しない)。

## Insight Agent 共通関数

`plugins/network-investigation/insight-agent.ts` の `runInsightAgent(query, siteNameOrId?)`:

1. `siteNameOrId` があれば対応表から `platform` を引く(siteId 完全一致 → siteName 完全一致の順)。
2. `platform` 判明時はそれ 1 つ、不明時は両方を `--mcp-config` に含める。
3. narrowing した MCP config で `claude` を起動し、`query` を渡す(プロンプトの作り込み・SSE 逐次配信は次の指示ファイル)。

戻り値に `resolvedPlatform` / `platformsUsed` / `mcpServers` / `matchedSite` を含め、
narrowing 結果をコードレビュー・API レスポンスから確認できるようにしてある。

呼び出し元は次の 3 箇所(いずれも同じ `runInsightAgent()` を呼ぶだけ):
- (a) 対話エンドポイント … `POST /api/network-investigation/query`(`onMcpCall` 付きで SSE 配信)
- (b) スケジューラ(定期実行) … `runScheduledInvestigation()` → `runQuery()`
- (c) UI ボタン(手動実行) … View → `POST /query`

`onMcpCall`(任意)を渡すと、`--output-format stream-json --verbose` の逐次パースで
MCP 呼び出し/完了を1件ずつ受け取れる。省略時(スケジューラの内部・対応表生成)は素の実行。

## キャッシュ整合性・View の責務

`CLAUDE.md` の原則どおり、各キャッシュの整合性管理は **書き込みを起こしたハンドラだけの責務**
(`site-platform-map.json`→`/site-map/refresh`、`site-status.json`→`/site-status/refresh`、
`query-history.jsonl`→`runQuery`)。View はキャッシュ・楽観的更新を持たず、サーバーが返す
「今の値」を描画し、変更は SSE(`/events`)で通知を受けて今表示中のデータだけ refetch する。

## View(`plugins/network-investigation/view/`・実装済み)

`src/lib/pluginViews.tsx` に `network-investigation` として登録済み。構成:
- `NetworkInvestigation.tsx` … 本体(クエリ入力 + 実行 + SSE ログ + サイト一覧を1画面、下にタイムライン)
- `SseLog.tsx` … MCP 呼び出しのリアルタイム表示(ルーティングスキップ + calling/done 行)
- `SiteList.tsx` … サイト一覧(platform バッジ + health/devices/clients/alerts)。クリックでクエリ対象に指定
  - 旧 `SiteMap.tsx`(Leaflet ピン表示)は 03 で削除した。座標つきの地図表示は 05 の新規ダッシュボードへ移す
- `ShareActions.tsx` / `shareText.ts` … 調査結果1件の共有(印刷/PDF・mailto・クリップボード)
- `Timeline.tsx` … 実行履歴の時系列タイムライン(手動/定期)。共通検索の focus に対応
- `LogoBadge.tsx` … 正規化済みロゴバッジ(`public/logos/*.png`)。スキップ側はグレースケール

ロゴバッジは `scripts/generate-logo-badges.ts`(`npm run logo-badges`)が `src/assets/central.svg` /
`src/assets/mist.png` から 96×96 透過 PNG に正規化して `public/logos/` へ書き出す(favicon 生成と同じ
ワンショット方式。元画像が変わらない限り再生成不要)。
