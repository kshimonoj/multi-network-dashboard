# 28: 日英切替(i18n)対応の文言棚卸し — 調査結果

調査日: 2026-07-28 / 対象コミット: `bd8d5fa`(作業ツリーの未コミット変更を含む)
**本調査ではコード変更を一切行っていない。**

---

## 0. サマリー

| 指標 | 件数 |
|---|---|
| i18n 対象の日本語文字列(総数) | **944** |
| ├ UI に直接出る文言 | 666 |
| ├ サーバ生成でUIに届く文言(APIエラー・note・reason 等) | 176 |
| └ LLM プロンプト(モデルへの指示文) | 102 |
| 動的生成文の箇所 | **34 関数 / 8 ファイル** |
| レイアウト崩れ懸念箇所 | **11** |
| (参考)console ログのみの日本語 = i18n 対象外 | 120 |

### 前提の訂正が 2 点

1. **タブは 4 つではなく 5 つ。** `src/main.tsx:50-56` の `TABS` は
   `Global Overview` / `Event / Alert` / `Webhook ログ` / `Streaming(Central)` / `ネットワーク調査`。
   `Event / Alert`(`global-overview/view/EventFeed.tsx`)は Global Overview プラグイン配下に
   実装されているが独立タブで、文言も 78 件ある。後続の分割案はこれを 1 タブとして数えている。

2. **Insight Agent には「日本語で答えろ」の強制指定が既にある。**
   タスク指示では「無いことを再確認する」とあったが、実際には
   `plugins/network-investigation/insight-agent.ts:76` に
   `"…その結果(ライブ情報)だけに基づいて日本語で簡潔に答える。"` がある。
   さらに system prompt 全体(BASE / BOTH_PLATFORMS / RICH_OUTPUT の 3 ブロック・約 40 行)が日本語で、
   **モデル出力を日本語前提でパースしている箇所がある**(§2.6 / §4-A)。ここが本件で最も設計判断を要する。

---

## 1. Task 1: 静的ラベルの棚卸し(タブ別)

### 1-1. タブ別集計

| タブ | UI 文言 | srv→UI | LLM prompt | i18n 対象計 | ファイル数 |
|---|---:|---:|---:|---:|---:|
| 共有 / シェル | 17 | 0 | 0 | **17** | 2 |
| Global Overview | 112 | 34 | 0 | **146** | 13 |
| Event / Alert | 50 | 28 | 0 | **78** | 2 |
| Webhook ログ | 79 | 32 | 0 | **111** | 8 |
| Streaming(Central) | 188 | 21 | 0 | **209** | 9 |
| ネットワーク調査 | 220 | 61 | 102 | **383** | 24 |
| **合計** | **666** | **176** | **102** | **944** | 58 |

分類の定義:
- **UI 文言** … `view/` 配下・`src/` 配下の文言、および UI にそのまま表示されるサーバ側カタログ
  (`central-streaming/catalog.ts` のイベント種別名、`decoder.ts` の要約文)
- **srv→UI** … API のエラーレスポンス `{error: "…"}`、`note` / `reason` フィールドなど、
  サーバで作られて画面に出るもの。翻訳対象だが辞書の置き場所が UI と異なる
- **LLM prompt** … モデルへの指示文。表示はされないが §2.6 の理由で i18n 設計に影響する
- **console ログ(120 件)は対象外**。運用者がサーバログを読むためのもので、翻訳しない前提

### 1-2. ファイル別の内訳(主要ファイル)

#### 共有 / シェル(17 件)

| ファイル:行 | 文言 | 種別 | 備考 |
|---|---|---|---|
| `src/main.tsx:38-39` | ネットワーク調査 / Central / Mist 横断 | プラグイン名 | |
| `src/main.tsx:51-55` | Global Overview / Event / Alert / Webhook ログ / Streaming(Central) / ネットワーク調査 + 各 sub 5 件 | タブラベル | **⚠ L-1** |
| `src/main.tsx:81,86,87` | ライト / ダーク / `${nextLabel}モードに切り替える(選択はこのブラウザに保存されます)` | ボタン・tooltip | 動的(§2.10) |
| `src/main.tsx:158` | 画面切替 | aria-label | |
| `src/shell.tsx:42` | (旧・未指定) | フォールバック値 | |
| `index.html:2` | `lang="ja"` 固定 | HTML 属性 | **⚠ 切替時に要更新** |

#### Global Overview(146 件)

| ファイル | 件数 | 主な内容 |
|---|---:|---|
| `view/GlobalOverview.tsx` | 52 | KPI カード見出し(総サイト数/総デバイス数/接続クライアント数/アラート合計)、サイト別内訳の表ヘッダ(サイト/デバイス計/クライアント/アラート/健全性)、更新ボタン、ポーリング間隔設定、注記文 |
| `view/SiteDetailPage.tsx` | 34 | セクション見出し(デバイス/接続クライアント/アラート/イベント/Health)、表ヘッダ、空状態、`← 一覧に戻る` |
| `view/SiteMap.tsx` | 14 | 凡例(Down あり/アラートあり/正常/デバイス未登録)、ポップアップの表ヘッダ |
| `view/types.ts` | 6 | `ALERT_LABEL`(Active / 過去24h)、`ALERT_DESC` |
| `view/Donut.tsx` | 1 | `${v} 台` |
| `api.ts` / `poller.ts` / `site-detail.ts` / `central-client.ts` / `mist-client.ts` / `aggregate.ts` / `rate-limit.ts` | 34 | API エラー文(スナップショット未生成です。/ 取得に失敗しました。/ Central の認証情報が未設定です 等)、`(サイト未割り当て)` |

#### Event / Alert(78 件)

| ファイル | 件数 | 主な内容 |
|---|---:|---|
| `global-overview/view/EventFeed.tsx` | 50 | `SEV_LABEL`(重大/警告/情報)、フィルタ見出し(種別/プラットフォーム/重要度/サイト/カテゴリ)、表ヘッダ(時刻/重要度/種別/サイト/カテゴリ/内容)、`調査する`、`自動更新なし` 注記、相対時刻 |
| `global-overview/events-feed.ts` | 28 | 取得元ラベル(Central アラート/Central イベント/Mist アラーム/Mist デバイスイベント/Mist クライアントイベント)、`note` 文(`org 一括・直近 ${hours}h` 等) |

#### Webhook ログ(111 件)

| ファイル | 件数 | 主な内容 |
|---|---:|---|
| `view/WebhookFeed.tsx` | 64 | 見出し `Webhook ログ`、取得元シート、フィルタ、表ヘッダ(受信時刻/重要度/ソース/サイト/カテゴリ/内容)、自動事前調査カード全体(実行中/完了/失敗、説明文 3 行)、`調査結果を見る` / `調査する`、関連情報(サイト状況)KPI |
| `view/investigate.ts` | 9 | 調査クエリ文(§2.2) |
| `view/types.ts` | 6 | `SEVERITY_LABEL`(重大/警告/情報/—) |
| `enrich.ts` | 9 | 自動事前調査クエリ(§2.5)、先読み不可の説明文 2 件 |
| `sheets-client.ts` / `poller.ts` / `mapping.ts` / `api.ts` | 23 | 設定エラー文(サービスアカウント鍵が見つかりません 等)、`(本文なし)`、`(無題)`、`列 ${A}` |

#### Streaming(Central)(209 件 — 最多)

| ファイル | 件数 | 主な内容 |
|---|---:|---|
| `catalog.ts` | 80 | **購読イベント種別カタログ**。カテゴリ 20 件(デバイス監視/コンフィグ/証明書管理/…)、ストリーム定義 5 件の `label`/`note`、AP Monitoring のイベント種別 14 件(状態: デバイス/統計: 無線 等) |
| `view/CentralStreaming.tsx` | 52 | 接続状態、保存と Retention、フィルタ、表ヘッダ、受信/停止トグル、切断テスト、フッタ解説文(4 行) |
| `decoder.ts` | 30 | **受信イベントの要約文を組み立てる**(§2.9)。`対象: ${x}` / `変更 ${n} 項目` / `${who} が ゾーン ${z} を 入場` 等 |
| `view/types.ts` | 16 | 接続状態ラベル(未接続/接続中…/接続済み/再接続中/エラー)、流量ラベル(流量: 小/中/大) |
| `ws-client.ts` | 14 | 再接続理由文(`切断されました(code=…)`、`401(トークン失効)`、`デコード失敗: ${msg}`) |
| `api.ts` / `token.ts` / `store.ts` | 7 | 設定エラー、強制切断メッセージ |
| `view/investigate.ts` | 10 | 調査クエリ文(§2.4) |

#### ネットワーク調査(383 件 — 機能密度が最も高い)

| ファイル | 件数 | 主な内容 |
|---|---:|---|
| `view/shareText.ts` | 40 | **共有テキスト生成の全文言**(§2.7)。ヘッダラベル、区切り、省略注記 |
| `view/ScheduleEditor.tsx` | 30 | 定期実行設定(頻度/曜日/時刻、毎日/毎週、曜日 7 件、保存/取消/編集/削除、クエリ追加) |
| `view/SessionShare.tsx` | 24 | スレッド全体の印刷レイアウト + 共有ボタン(§2.8) |
| `view/ShareActions.tsx` | 23 | 単発の印刷レイアウト + 共有ボタン(§2.8) |
| `view/Timeline.tsx` | 21 | 実行タイムライン、定期実行サマリ(§2.11)、曜日 7 件、タグ(手動/定期/自動調査/失敗) |
| `view/NetworkInvestigation.tsx` | 19 | クエリ入力欄 placeholder、サイト/モデル選択、実行ボタン、スレッド見出し、サイト一覧パネル |
| `view/Turn.tsx` | 15 | ターン見出し、失敗タグ、呼び出したツール、モデル判断、`Sonnet(推定・旧履歴)` |
| `view/SseLog.tsx` | 12 | MCP 呼び出しログ(問い合わせ中…/完了・${n}件/失敗)、モデル判断、凡例 |
| `view/McpHealthNotice.tsx` | 10 | MCP 未接続警告(3 パターンの説明文) |
| `view/session.ts` | 7 | `SOURCE_LABEL`(手動/定期/自動調査)、`formatDuration` の `${x}秒` |
| `view/HistoryThread.tsx` / `SiteList.tsx` / `ToolCallRow.tsx` / `SuggestedActions.tsx` / `printClone.ts` / `Markdown.tsx` | 19 | 戻るリンク、空状態、失敗詳細、`続けて調べる`、印刷時の省略注記 |
| `tool-labels.json` | **32** | **MCP ツール名 → 日本語ラベル辞書**(サイト概要を取得/アラートを確認/…)。上記の 383 件には未計上 |
| `insight-agent.ts` | 58 | LLM system prompt(§2.6) |
| `site-map.ts` | 27 | サイト対応表生成用 LLM プロンプト |
| `api.ts` | 43 | narrowing 理由文(§2.12)、サイト状況取得用 LLM プロンプト、API エラー文 |
| `mcp.ts` / `mcp-health.ts` / `ollama-*.ts` / `schedule.ts` | 68 | MCP 接続診断メッセージ、cron 反映メッセージ(§2.13) |

> **注意**: `plugins/network-investigation/tool-labels.json` の 32 ラベルは JSON 資産のため
> 上記スクリプト集計(944)に含まれていない。**実質の翻訳対象は 944 + 32 = 976 件**。

---

## 2. Task 2: 動的生成文の棚卸し(最重要)

テンプレート文字列に変数を埋め込んで文章を組み立てている箇所。**34 関数 / 8 ファイル**。
単純な辞書引きでは対応できず、**辞書側にプレースホルダ付きテンプレートを持たせる必要がある**。

### 2-1〜2-4. 「調査する」ボタンのクエリ文生成(4 関数)

各タブの「調査する」ボタンは、日本語の調査クエリ文を組み立ててネットワーク調査タブへ渡す(実行はしない)。

| # | 関数 | ファイル:行 | 組み立てロジック |
|---|---|---|---|
| 2-1 | `buildInvestigationQuery()` | `global-overview/view/investigate.ts:20` | `${サイト名}(${Central\|Mist})で発生した以下の${アラート\|イベント}について、原因や影響範囲を調査して: [${重要度} / ${カテゴリ}] ${本文}(${時刻})` — **Global Overview / Event / Alert / SiteDetailPage の 3 画面が共用** |
| 2-2 | `buildWebhookInvestigationQuery()` | `webhook-feed/view/investigate.ts:18` | `${where}の Webhook 通知について、原因や影響範囲を調査して: [tags] ${message}(${when})。 対象デバイス: ${dev}。` — `where` はサイト名解決可否で分岐(Classic Central はサイト ID 非搭載) |
| 2-3 | `buildFollowUpQuery()` | `webhook-feed/view/investigate.ts:43` | 2-2 の結果に、自動事前調査の要約を踏まえた追記 3 文(`なお、このアラートについては既に…` / `重複する説明は省き、まだ分かっていない点(根本原因・再発の有無・影響範囲・次に取るべき対処)を掘り下げてください。`)+ `---` 区切りで要約本文を連結 |
| 2-4 | `buildStreamInvestigationQuery()` | `central-streaming/view/investigate.ts:14` | `New Central の Streaming API で受信した以下のイベントについて、背景・影響範囲・対応の要否を調査して: [tags] ${summary}(${when})。対象サイト: ${where}。関連デバイス: …。実行者: …。` |

補助関数: `fmtTime()`(2-2/2-4 に各 1)がフォールバック文言 `"時刻不明"` を持ち、`toLocaleString("ja-JP")` を**ハードコード**している(⚠ L-10)。

### 2-5. 自動事前調査(重大アラート検知時)のクエリ生成

| 関数 | ファイル:行 | 内容 |
|---|---|---|
| `buildAutoQuery()` | `webhook-feed/enrich.ts:151` | `${where}で重大アラートが発生しました。原因の見立てと影響範囲、確認すべき点を調査してください: [tags] ${message}(${whenLabel})。対象デバイス: ${dev}。` |

- 手動版(2-2)と体裁を揃える設計。`toLocaleString("ja-JP")` を同様にハードコード(`enrich.ts:163`)
- ここで生成したクエリはそのまま Insight Agent に渡り、**履歴 `query-history.jsonl` に永続化される**
- 先読み不可の説明文 2 件(`enrich.ts:305-306`)も動的に選ばれる:
  `Classic Central の Webhook はサイト ID を含まないため、サイト情報の先読み対象外です` /
  `サイト ID を Global Overview のスナップショットで解決できませんでした`
- 生成された要約は `WebhookFeed.tsx:630-651` の自動調査カードに表示される

### 2-6. Insight Agent の system prompt / クエリ前処理 ★最重要

| 関数・定数 | ファイル:行 | 内容 |
|---|---|---|
| `BASE_SYSTEM_PROMPT` | `insight-agent.ts:74-80` | 7 行。**`日本語で簡潔に答える` を明示的に指定している**(:76) |
| `BOTH_PLATFORMS_RULE` | `insight-agent.ts:83-90` | 8 行。サイト指定なし時のみ付加。`[判断] Central は不要と判断: <理由>` の**出力フォーマットを日本語で規定** |
| `RICH_OUTPUT_RULE` | `insight-agent.ts:95-111` | 16 行。suggested-actions / chart / topology の指示。`query はそのまま実行できる完結した日本語クエリにする`(:101)と**再度日本語を強制** |
| `buildSystemPrompt(bothPlatforms)` | `insight-agent.ts:114-116` | 上記 3 ブロックを条件付き連結。**Ollama 版(`ollama-agent.ts`)も同じ関数を使う** |

**クエリの前処理は無い。** ユーザー入力のクエリ文はそのまま `--query` に渡される
(言語指定の付加・書き換えは行っていない)。言語制御は system prompt のみが担っている。

> **★ i18n 設計上の最大の論点**
> `detectPlatformJudgment()`(`insight-agent.ts:151-162`)が
> 正規表現 `/\[判断\]\s*(.+?)\s*(?:は|が)?\s*不要と判断\s*[:：]\s*(.+)/` で
> **モデル出力の日本語をパースしている**。さらに `:158-159` で `セントラル` / `ミスト` の
> カタカナ表記も判定に使う。
> system prompt を英語化すると、モデルは `[Judgment] Central is not needed: …` を出すため
> **この正規表現が一致せず、「モデル判断による省略」表示(SseLog.tsx / Turn.tsx)が無言で壊れる。**
> プロンプトと出力パーサは必ずセットで扱う必要がある。

その他の LLM プロンプト(表示されないが日本語):
- `site-map.ts:36-56` — サイト対応表(緯度経度)取得用。出力は JSON なので翻訳不要
- `api.ts:520-535` — サイト状況(health/devices/clients/alerts)取得用。同上

### 2-7. mailto 共有の件名・本文組み立て(13 関数)

`plugins/network-investigation/view/shareText.ts`。**単発**と**スレッド全体**の 2 系統。

| # | 関数 | 行 | 生成する文言 |
|---|---|---:|---|
| a | `buildShareHeader()` | 126 | `■ 対象サイト : …` / `■ 実行日時   : …` / `■ 調査クエリ : …` / `■ 対象基盤   : …` / `■ 使用ツール : …` / `■ モデル     : …` — **全角スペースで桁揃え**(⚠ L-9) |
| b | `buildShareText()` | 141 | `【ネットワーク調査レポート】` + header + `── 調査結果 ──` + 本文(コピー用) |
| c | `buildSubject()` | 153 | `[ネットワーク調査] ${サイト} ${日時}` |
| d | `buildMailBody()` | 169 | メール専用の簡易ヘッダ 3 行(`対象サイト:` / `実行日時:` / `調査クエリ:`)+ `── 調査結果 ──` + 本文 + `詳細はダッシュボードでご確認ください` |
| e | `buildMailtoHref()` | 201 | mailto URL を組み立て、1900 文字上限に**二分探索で本文を切り詰める** |
| f | `stripMarkdown()` | 70 | Markdown → プレーンテキスト。`(グラフはダッシュボード上で表示されます)` / `(トポロジ図はダッシュボード上で表示されます)` を差し込む(:83-84)。**箇条書きを `・` に変換**(:98)も日本語前提 |
| g | `siteLabel()` / `SITE_ANY_LABEL` | 49 / 30 | `指定なし(全サイト横断)` |
| h | `sessionSiteLabel()` | 242 | `${サイト列挙} ほか(指定なし(全サイト横断))` |
| i | `sessionPeriodLabel()` | 263 | `2026-07-23 10:14 〜 10:22`(同日なら終端は時刻のみ) |
| j | `buildSessionSubject()` | 273 | `[ネットワーク調査] ${サイト} ${日時}(${n}ターン)` |
| k | `buildSessionShareText()` | 303 | `【ネットワーク調査レポート(調査スレッド)】` + `■ 期間` / `■ ターン数` + 各ターン `── ターン i/n ・ 日時 ・ サイト ──` / `■ クエリ:` / `(このターンは失敗しました)…` |
| l | `buildSessionMailBody()` | 345 | `── 調査サマリ ──` + `…(中間の ${n} ターンは省略)` + `全 ${n} ターンの回答全文・グラフ・トポロジ図はダッシュボードでご確認ください` |
| m | `buildSessionMailtoHref()` | 387 | ターン数 × 要点長の二重二分探索で 1900 文字に収める |

さらに `summarizeAnswer()`(:281)は `^[・\s]+` を剥がす処理を持ち、f の `・` 変換と対になっている。
**`TRUNCATED_NOTE`**(:36)= `…(以下省略)\n\n※本文が長いため冒頭のみ引用しています。詳細はダッシュボードでご確認ください。`

> **文字数上限の再計算が必要**: `MAILTO_MAX_URL_LENGTH = 1900` は
> 「日本語 1 文字 = URL エンコードで 9 文字」を前提に設計されている(:159-166 のコメント)。
> 英語は 1 文字 = 1 文字なので、同じ 1900 でも**約 9 倍の本文が載る**。
> 切り詰めロジック自体は二分探索なので壊れないが、`MAIL_QUERY_MAX = 60`(:167)/
> `MAIL_SESSION_QUERY_MAX = 40`(:336)/ `turnLimit = 120`(:346)といった
> **文字数ベースの定数は言語別に持つのが妥当**。

### 2-8. 印刷 / PDF 出力のレイアウト

| ファイル:行 | 内容 |
|---|---|
| `ShareActions.tsx:52-91` | 単発レポート。`<h1>ネットワーク調査レポート</h1>`、`Multi Network Dashboard — Central / Mist 横断`、メタ表の `<th>`(対象サイト/実行日時/調査クエリ/対象基盤/使用ツール/モデル)、`<h2>調査結果</h2>`、フッタ `出力: ${日時} ・ ${origin}` |
| `SessionShare.tsx:72-126` | スレッド版。上記に加え `<th>期間` / `<th>ターン数` / `<th>最初のクエリ`、各ターン見出し `ターン ${i}/${n} ・ ${日時} ・ ${サイト}`、`クエリ: …`、`使用ツール: … ・ モデル: …`、`(このターンは失敗しました)` |
| `printClone.ts:71-74` | `MISSING_NOTE` — 画面に SVG が無い場合の差し込み文言 `(グラフは省略。ダッシュボードで表示できます)` / `(トポロジ図は省略。ダッシュボードで表示できます)` |
| `styles.css:1180-1203` | `.ni-print-meta th { width: 22%; white-space: nowrap; }` — メタ表の見出し列(⚠ L-8) |

いずれも **JSX を組み立てて `body` 直下にポータルで生やし、`window.print()` を呼ぶ**方式。
文言はコンポーネント内に直書きで、共有テキスト(2-7)とは**別々に同じラベルを持っている**
(例: `対象サイト` は shareText.ts と ShareActions.tsx と SessionShare.tsx の 3 箇所)。
i18n 化の際は共通キーに寄せる余地がある。

### 2-9. Streaming イベントの要約文生成

`plugins/central-streaming/decoder.ts:220-353`。受信した protobuf をデコードし、
**イベント種別ごとに異なるロジックで 1 行要約を組み立てる**(表の「内容」列に出る)。

| 行 | 種別 | 組み立て |
|---|---|---|
| 228-235 | Audit Trail | `${action}` + `対象: ${target}` + `変更 ${n} 項目` |
| 254 | AP 状態 | `理由 ${down_reason}` |
| 262 | AP 無線 | `品質 ${channel_quality}` |
| 276-284 | Geofence | `${who} が ゾーン ${zone} を ${入場\|退場}(滞在 ${n} 秒)`、category = `アセットタグ` / `Wi-Fi クライアント` |
| 294-303 | Location | `${who} ${xy} 誤差 ${n} 観測 AP ${n} 未接続` |
| 311-318 | RSSI | `${近接\|生}` + `${client} @ ${ap}` + `接続中` / `未接続` |
| 353 | 共通 | フォールバック `(要約できる項目がありません)` |
| 154-168 | デコード失敗 | `未知のイベント種別のため本体をデコードできません: ${type}` / `カタログ未登録の type(${type})を ${messageName} として解釈しました` / `本体のデコードに失敗(${messageName}): ${err}` / `CloudEvent に本体(data)が入っていません` |

**保存済みイベント(`data/central-streaming/events.jsonl`)には要約が確定文字列として書かれる**ため、
言語切替しても過去分は日本語のまま残る点に注意(再デコードしない限り変わらない)。

### 2-10〜2-13. その他のテンプレート文字列

| # | 箇所 | ファイル:行 | 内容 |
|---|---|---|---|
| 2-10 | テーマ切替ボタン | `src/main.tsx:81-92` | `${ライト\|ダーク}モードに切り替える(選択はこのブラウザに保存されます)` — label / title / aria-label の 3 箇所で同じ変数を再利用 |
| 2-11 | 定期実行サマリ | `Timeline.tsx:23-26` | `定期実行: ${有効\|無効} ・ ${毎週${曜}曜 HH:MM\|毎日 HH:MM} ・ 対象 ${n} 件` |
| 2-12 | narrowing 理由 | `api.ts:168,177,188` | `サイト指定なし — Central / Mist 両方に問い合わせます` / `サイト「${s}」が対応表に見つからないため、両プラットフォームに問い合わせます` / `${site} は ${platform} 管理のため、${server} への問い合わせをスキップしました` — **履歴に永続化され SseLog に表示** |
| 2-13 | cron 反映メッセージ | `schedule.ts:213-254` | `定期実行は無効(cron ジョブを停止しました)` / `${毎週 曜日=n HH:MM\|毎日 HH:MM}(cron "…" / TZ=…)で定期実行を設定しました` / `cron 式が不正です: ${expr}` → `ScheduleEditor.tsx:151` が `反映しました: ${detail}` として表示 |
| — | 相対時刻 | `EventFeed.tsx:41-44`, `GlobalOverview.tsx:51-56`, `WebhookFeed.tsx:50-59`, `CentralStreaming.tsx:54-66` | `${n} 秒前` / `${n} 分前` / `${n} 時間前` / `${n} 日前` / `${n} 秒後` — **4 ファイルに重複実装**。英語は複数形(1 minute ago / 2 minutes ago)が要るため単純置換不可 |
| — | 実行時間 | `session.ts:65` | `${x}秒` |
| — | MCP 診断 | `mcp.ts:441-484`, `mcp-health.ts:177-234` | 接続診断の `reason` 8 パターン(`接続できませんでした` / `claude CLI の初期化時に接続に失敗しました(mcp_servers.status=failed)` / `ハンドシェイクは通りましたが、ツールが 1 件も登録されていません` 等)→ `McpHealthNotice.tsx` に表示 |
| — | Event/Alert の note | `events-feed.ts:147-285` | `org 一括・全 status(Active / Cleared)` / `サイト単位ループ ${ok}/${n} サイト・各 ${m} 件まで・直近 ${h}h` 等 6 パターン |

---

## 3. Task 3: タブ別の作業量目安

| タブ | 静的ラベル | 動的生成文 | 作業量 | 主な難所 |
|---|---:|---:|---|---|
| 共有 / シェル | 17 | 1 | **小** | `html lang` 属性、i18n Context の設置そのもの |
| Global Overview | 146 | 1(共用) | **中** | 表ヘッダの固定幅、KPI ラベル |
| Event / Alert | 78 | 1(共用)+ note 6 | **小〜中** | 2-1 を Global Overview と共用しているので同時にやると効率的 |
| Webhook ログ | 111 | 3 | **中** | 自動事前調査の説明文が長い、`buildAutoQuery` は履歴に残る |
| Streaming(Central) | 209 | 8 | **中〜大** | `catalog.ts` の 80 件は機械的だが量が多い。`decoder.ts` の要約生成が 7 分岐 |
| ネットワーク調査 | 383 + 32(JSON) | 21 | **大** | 共有/印刷(13 関数)、LLM プロンプト、`[判断]` パーサ、`tool-labels.json` |

---

## 4. レイアウト崩れが懸念される箇所(11 件)

英語化で文字数が大きく増え、既存の固定幅・nowrap に収まらなくなる可能性がある箇所。
**厳密な判定はしていない。実装時に実物で確認する前提の候補リスト。**

| # | 箇所 | 現在の制約 | 懸念 |
|---|---|---|---|
| L-1 | タブの sub テキスト `src/main.tsx:51-55` | 制約なし(横並び) | 既に長い。`New Central / Classic Central / Mist(スプレッドシート経由)` → `(via Google Spreadsheet)` でさらに伸びる。5 タブ横並びが折り返す可能性 |
| L-2 | 重要度バッジ列 `.go-fc-sev` | `width: 70px` | `重大`(2字) → `Critical`(8字)。11px フォント + バッジ padding で **70px を超える見込み**。`.go-fsev` はバッジ表示 |
| L-3 | 操作列 `.go-fc-act` | `width: 84px` + `white-space: nowrap` | `調査する`(4字) → `Investigate`(11字)。**超過が濃厚** |
| L-4 | Webhook 操作列 `.wf-c-act` | `width: 128px` | `調査結果を見る` → `View investigation` / `調査する` → `Investigate`。2 ボタン縦積みなので L-3 より余裕はあるが要確認 |
| L-5 | 曜日ボタン `ScheduleEditor.tsx:19,197` / `Timeline.tsx:14` | `{w}曜` = 2 字 × 7 個 | `日`→`Sun` で **各ボタンが約 1.5〜2 倍**。7 個横並びの行が溢れる可能性が高い |
| L-6 | 頻度セレクト `.ni-sched-field .ni-select` | `min-width: 90px` | `毎日`/`毎週` → `Daily`/`Weekly` は収まる見込み。**低リスク** |
| L-7 | Streaming 全体トグル `CentralStreaming.tsx:270` | 制約なし | `受信中 — 停止する` → `Receiving — Stop` / `停止中 — 開始する` → `Stopped — Start`。ヘッダ右端のボタンなので要確認 |
| L-8 | 印刷メタ表 `.ni-print-meta th` | `width: 22%` + `white-space: nowrap` | `対象サイト`(5字) → `Target site`、`使用ツール` → `Tools used`。22% = A4 幅の約 37mm。**9.5pt なら収まる見込みだが `nowrap` なので溢れると表が崩れる** |
| L-9 | 共有テキストの桁揃え `shareText.ts:129-137, 308-314` | 全角スペースで `■ 対象サイト : ` を手動整列 | 英語ラベルは長さがバラバラで、**現在の整列が完全に崩れる**。等幅前提の見た目なので、辞書側で英語用の padding を持つか整列を諦める判断が要る |
| L-10 | 日時表示 10 箇所 | `toLocaleString("ja-JP", {hour12:false})` ハードコード | 英語 UI でも `2026/7/28 14:30:00` の日本形式のまま。`.go-fc-time { width: 150px }` に対し `en-US` は `7/28/2026, 2:30:00 PM` と長くなる。**ロケール切替 + 幅の両方に影響** |
| L-11 | 相対時刻 4 実装 | `${n} 秒前` 等 | 英語は複数形処理が必要(`1 minute ago` / `2 minutes ago`)。幅は問題ないが**辞書だけでは対応できない**(関数側の分岐が要る) |

---

## 5. 所見: 後続の実装指示ファイルの分割案

**最終決定はユーザーと相談してから行う。** 以下は作業量と依存関係からの提案。

### 依存関係

```
29 (i18n 基盤)  ← 全ての前提
   ├─ 30 (共有/シェル)     ← 基盤直後。タブラベル・テーマトグル
   ├─ 31 (Global Overview + Event/Alert)  ← 2-1 を共用するので同時が効率的
   ├─ 32 (Webhook ログ)
   ├─ 33 (Streaming)
   └─ 34 (ネットワーク調査 UI)
        └─ 35 (共有/印刷/mailto + LLM プロンプト)  ← 34 と分けたい(性質が違う)
```

### 分割案(7 本)

| # | 内容 | 対象件数 | 備考 |
|---|---|---:|---|
| 29 | **i18n 基盤**。ダークモードと同じ軽量 Context + JSON 辞書、`html lang` 追従、言語トグル UI、複数形/日時ロケールのヘルパ | — | L-10 / L-11 のヘルパをここで用意しておくと後段が楽 |
| 30 | 共有 / シェル | 17 | 基盤の動作確認を兼ねる最小スコープ |
| 31 | Global Overview + Event / Alert | 224 | `investigate.ts`(2-1)を共用。L-2 / L-3 の対応もここ |
| 32 | Webhook ログ | 111 | `buildAutoQuery`(2-5)を含む。L-4 |
| 33 | Streaming(Central) | 209 | `catalog.ts` 80 件は機械的。`decoder.ts`(2-9)が本番。L-7 |
| 34 | ネットワーク調査 — 画面 UI のみ | 約 200 + `tool-labels.json` 32 | 共有/印刷を除いた画面部分。L-5 |
| 35 | ネットワーク調査 — 共有 / 印刷 / mailto / LLM プロンプト | 約 180 | **単独で 1 本にする価値がある**(下記) |

### 35 を分ける理由

1. **`shareText.ts` の 13 関数は文字数上限とセット**。`MAILTO_MAX_URL_LENGTH` /
   `MAIL_QUERY_MAX` / `turnLimit` を言語別に持つ設計判断が要り、他タブと性質が違う
2. **印刷レイアウト(2-8)は 3 ファイルに同じラベルが重複**しており、i18n 化のついでに
   共通キーへ寄せる整理が入る
3. **LLM プロンプトの英語化は「やるかどうか」自体が設計判断**。§2.6 の通り
   `detectPlatformJudgment()` の正規表現とセットで、UI 言語と回答言語を連動させるのか、
   UI は英語でも回答は日本語のままにするのか、で作業量が大きく変わる

### 先に決めておきたい論点(実装前にユーザー判断が要る)

| 論点 | 選択肢 |
|---|---|
| **A. UI 言語と Insight Agent の回答言語を連動させるか** | (a) 連動させる → `buildSystemPrompt` を言語別にし、`[判断]` マーカーを言語非依存の記号(例: `[SKIP:central]`)へ変更。**パーサの改修が必須** / (b) 連動させない → プロンプトは日本語固定。実装は最小だが英語 UI に日本語の回答が出る |
| **B. 履歴に残る動的生成文の扱い** | 調査クエリ(2-1〜2-5)・narrowing 理由(2-12)・Streaming 要約(2-9)は**生成時の言語で永続化**される。過去分を再翻訳するか、生成時の言語のまま表示するか |
| **C. 共有テキストの桁揃え(L-9)** | 全角スペース整列を英語でも維持するか、整列を諦めるか |
| **D. サーバ側文言(176 件)の辞書配置** | UI と同じ JSON を共有するか、サーバはエラーコードを返して UI 側で文言化するか(後者の方が筋は良いが改修範囲が広い) |
| **E. `tool-labels.json`(32 件)** | 日英 2 ファイルに分けるか、1 ファイル内で `{ja, en}` を持つか |

---

## 付録: 調査方法

- 対象: `src/**`, `plugins/**`, `server/**`, `index.html` の `.ts` / `.tsx` / `.css` / `.html`(計 84 ファイル)
- 日本語検出: `[ぁ-んァ-ヶ一-龥]`
- コメント(`//`, `/* */`)を除去したうえで、文字列リテラル(`'`/`"`/`` ` ``)と JSX テキストノードを抽出
- `console.log/warn/error/info/debug` の引数に含まれるものを別集計し、i18n 対象から除外
- `tool-labels.json` は JSON のため上記スクリプトの対象外。`labels` オブジェクトの 32 件を別途確認
- CSS の固定幅は `width:` / `min-width:` 宣言を全て抽出し、日本語ラベルが入る要素と突き合わせ
