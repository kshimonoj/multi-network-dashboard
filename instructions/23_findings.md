# 23_findings — GitHub 公開前のセキュリティ監査

対象: `https://github.com/kshimonoj/multi-network-dashboard` への公開準備。
**本タスクでは push を行っていない**(ローカルコミットまで)。

---

## Task 1: リポジトリの現状

- 作業ディレクトリは **git 管理下ではなかった**(`.git` 無し / `git status` は `fatal: not a git repository`)。
- したがって **過去のコミット履歴は存在せず**、履歴に機密情報が残っている懸念は無い。
  履歴の書き換え(filter-repo 等)は不要。
- 本タスクの中で `git init -b main` を実行し、初回コミットを作成した。

---

## Task 2: `.gitignore` / `.dockerignore`

### `.gitignore`(拡張)

既存は 7 行(`node_modules/` `dist/` `.env` `data/` `*.log` `.DS_Store` `secrets/`)。
以下を追加した。

| 追加パターン | 理由 |
| --- | --- |
| `.env.*` + `!.env.example` | `.env.local` / `.env.production` 等の派生を一括除外。ひな形だけは残す |
| `*.pem` `*.key` `*.p12` | 鍵ファイル全般 |
| `service-account*.json` | `secrets/` 外に置かれたサービスアカウント鍵の取りこぼし防止 |
| `*.tsbuildinfo` | ビルド中間物 |
| `logs/` `npm-debug.log*` | ログ |
| `Thumbs.db` `.idea/` `.vscode/` | OS / エディタ |

`data/` は既に一括除外済みで、`data/network-investigation/query-history.jsonl` /
`data/global-overview/snapshot.json` / `data/webhook-feed/{feed,state,settings}.json` /
`data/central-streaming/events.jsonl` などの実行時生成データはすべて対象内。

### `.dockerignore`(微修正)

既存で `node_modules` `dist` `data` `.env` `.git` `*.log` `.DS_Store` `instructions` `secrets`
を除外しており、方針は崩れていなかった。念のため `.env.*` / `*.pem` / `*.key` を追加。
`Dockerfile` の `COPY` は `package.json` `tsconfig.json` `vite.config.ts` `index.html`
`src` `public` `server` `plugins` のみで、`.env` や `secrets/` を焼き込む経路は無い。

---

## Task 3: コミット対象ファイルの内容精査

### 3-1. 除外の実効性(確認済み)

`git add -A` 後のステージ内容に、`.env` / `secrets/` / `data/` / `dist/` /
`node_modules/` / `.DS_Store` は **1 件も含まれていない**。

さらに値ベースの突き合わせも行った。

- `.env` の各値を全ステージファイルに対して総当たり照合 →
  一致したのは `CENTRAL_BASE_URL` / `CENTRAL_TOKEN_URL` / `MIST_BASE_URL`(いずれも
  公開エンドポイントの URL。`.env.example` に意図的に記載しているもの)と `MIST_ORG_ID` のみ。
  **`CENTRAL_CLIENT_SECRET` / `CENTRAL_CLIENT_ID` / `MIST_API_TOKEN` /
  `CLAUDE_CODE_OAUTH_TOKEN` は一致ゼロ**。
  なお一致した `MIST_ORG_ID` は下表のとおり伏字化済み。
- `secrets/` のサービスアカウント JSON の各フィールドを同様に総当たり照合 →
  `private_key` / `private_key_id` / `client_email` / `client_id` は **一致ゼロ**。
  一致したのは `project_id`(= リポジトリ名と同一の文字列)と `universe_domain`
  (= `googleapis.com`)のみで、いずれも秘匿性は無い。

### 3-2. 実データの検出と伏字化

以下のパターンで全ステージファイルを走査した(UUID / MAC(コロン形式・12hex 連続)/
シリアル番号 / メールアドレス / 28 文字以上のトークン様文字列 / Bearer・Basic・secret 等の
代入 / PEM ヘッダ / スプレッドシート URL / IP アドレス / 緯度経度 / 7〜12 桁の数値 ID /
実サイト名 22 件の完全一致)。

検出された実データは、調査記録としての読みやすさを保つため
**ファイルは残したまま該当箇所だけをプレースホルダーに機械置換**した。

| ファイル | 置換内容 |
| --- | --- |
| `instructions/05_findings.md` | Mist org_id(UUID)→ `<MIST_ORG_ID>` x1 / Mist 組織名 → `<MIST_ORG_NAME>` x1 / 実サイト名 → `<SITE_D>` x1 |
| `instructions/08_findings.md` | 実サイト名 → `<SITE_A>` x1 / Mist site_id(UUID)→ `<MIST_SITE_ID>` x2 |
| `instructions/11_findings.md` | 実サイト名 → `<SITE_A>` x3, `<SITE_B>` x2 / Mist site_id → `<MIST_SITE_ID>` x1 / Central site_id → `<CENTRAL_SITE_ID>` x1 |
| `instructions/12_findings.md` | 実サイト名 → `<SITE_A>` x3 / Mist site_id → `<MIST_SITE_ID>` x1 / Central site_id → `<CENTRAL_SITE_ID>` x1 / 実機 MAC(AP・BSSID)→ `aa:bb:cc:dd:ee:ff` x2 / 実機クライアント MAC → `11:22:33:44:55:66` x1 |
| `instructions/17_findings.md` | 実サイト名 → `<SITE_D>` x2, `<SITE_E>` x2 / 実サイト ID(17 桁)→ `<SITE_ID>` x2 |
| `instructions/20_findings.md` | Central site_id → `<CENTRAL_SITE_ID>` x1 |
| `plugins/network-investigation/schema.md` | 実サイト名 → `<SITE_C>` x1 / Central site_id → `<CENTRAL_SITE_ID>` x3 / Mist site_id(UUID)→ `<MIST_SITE_ID>` x1 / 実サイトの緯度経度 2 サイト分(計 4 値)→ ダミー座標 |
| `plugins/global-overview/view/SiteMap.tsx` | コメント内の実サイト名 2 件 → `<SITE_X>` / `<SITE_Y>` |

プレースホルダーはファイル間で一貫している(同じ `<SITE_A>` は同じサイトを指す)ので、
調査記録としての読み替えは可能なまま。

**伏字にしなかったもの(判断)**

- サイト名 `Home` / `Tokyo` / `Test Site` / `Demo Site` — 一般名詞であり、
  組織・拠点が推測できない(タスク指示の許容範囲)。
- `plugins/network-investigation/scheduled-queries.json` の `id`(UUID 2 件)—
  `node:crypto` の `randomUUID()` でアプリが自己生成したクエリ ID。
  Central / Mist のテナント識別子ではない。同ファイルはシード(初回起動時の複製元)として
  意図的に同梱されているもの(`schedule.ts` の `SEED_QUERIES_PATH`)。
- `instructions/08_findings.md` の `https://10.255.255.1` — 到達不能性の検証に使った
  ブラックホール宛先で、実在の機器ではない。
- `instructions/17_findings.md` の `114c6324…` / `ab1046ae…` / `c4b4d998…` —
  それぞれ Webhook 行のハッシュ ID と本アプリの runId。アプリ内部で生成した値で、
  テナント由来の識別子ではない。
- `Asia/Tokyo`(タイムゾーン)、`webhook-log`(スプレッドシートの表示名)、
  デバイスのモデル名(`EX4300-VC` 等)。

### 3-3. ソースコードの確認

`plugins/*/proto/` 配下の `.proto` は Central Streaming API のスキーマ定義のみで、
実データ・実サンプルの埋め込みは無い。TypeScript / TSX 側もフィールド名の参照のみで、
テスト用のハードコードされた実データは見つからなかった(唯一の例外が上記
`SiteMap.tsx` のコメント内サイト名で、これは伏字化済み)。

### 3-4. 副次的な修正(NUL バイトの可視化)

`instructions/12_findings.md` と `plugins/webhook-feed/mapping.ts` に生の NUL バイトが
含まれており、git が両ファイルを **binary 扱い**していた(GitHub 上で差分が見られない)。

- `12_findings.md`(3 箇所)— Central の `sourceName` に NUL パディングが載る件の記録。
  文中の生 NUL を `\0` という表記に置換。文意は変わらない。
- `mapping.ts`(2 箇所)— `CLASSIC_COLS` の `header` に「決して一致しない」番兵として
  生 NUL が入っていた。`"\u0000"` エスケープ表記に置換。**文字列の値は完全に同一**で、
  挙動は変わらない。`npm run typecheck` 相当(`tsc --noEmit`)が exit 0 で通ることを確認済み。

### 3-5. 再スキャン結果

伏字化後に同じパターンで再走査し、以下を確認した。

- UUID: 残存は `scheduled-queries.json` のアプリ生成 ID 2 件のみ(上記の判断どおり許容)
- MAC: 残存はすべてダミー値(`aa:bb:cc:dd:ee:ff` / `11:22:33:44:55:66` / `aabbccddeeff`)
- 実サイト名 22 件のうち固有性のあるもの: **残存ゼロ**
- Central site_id / Mist site_id / Mist org_id / 実座標: **残存ゼロ**
- binary 扱いのテキストファイル: **ゼロ**

---

## Task 4: README

`README.md`(英語)と `README.ja.md`(日本語)を新規作成した。CLAUDE.md の規約どおり
冒頭で相互にリンクし、構成・セクション・表を同一に保っている。

記載内容:

- 概要と、Corstack の `network-investigation` プラグインから外出しした経緯
- 4 機能の説明(ネットワーク調査 / Global Overview / Webhook ログ / Central Streaming)
- 必要なもの・セットアップ手順(`cp .env.example .env` → `docker compose up`)
- 環境変数は **変数名と用途のみ**の表(値は一切書かない)
- ディレクトリ構成、`data/` をファイルとして持つ設計方針
- Webhook セットアップガイドである別リポジトリ
  [`central-mist-webhook-to-google-sheets`](https://github.com/kshimonoj/central-mist-webhook-to-google-sheets) へのリンク
- `instructions/` の実データはプレースホルダーに置換済みである旨の注記

---

## Task 5: ローカルコミット

- `git init -b main`
- `git remote add origin https://github.com/kshimonoj/multi-network-dashboard.git`
- `git add -A` → `git commit`

**`git push` は実行していない。**

---

## 次に同じことをする人へ

- `.gitignore` は `git init` の直後・最初のコミットの前に整備する。今回は init 前に
  整備できたが、既にコミット済みだと履歴の書き換えが必要になり難易度が跳ね上がる。
- 調査記録(`*_findings.md`)に検証中の出力をそのまま貼ると実データが混入する。
  貼る時点で伏字にするか、リポジトリ外に置く運用にする。
- 監査で `grep` を使うときは、Claude Code のシェルで `grep` が **関数(ugrep)に
  シャドウされている**ことがある。ファイル一覧を渡した走査が黙って 0 件になるので、
  `xargs /usr/bin/grep ... < filelist` のように実バイナリを明示するか、
  既知の文字列で必ずサニティチェックする。
- パターンマッチだけに頼らず、`.env` と `secrets/` の**実際の値を突き合わせる**
  照合を最後に必ず走らせる。パターンでは拾えない形の漏洩を検出できる。
