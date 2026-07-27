# 17: Webhookログタブ(Central/Classic Central/Mist) + 自動事前調査 + 関連情報の自動先読み

## 前提・確定事項

- Google Sheetsの読み取りは**サービスアカウント方式**(非公開)を採用する。ユーザーがGoogle Cloudで作成したサービスアカウントのJSON鍵を`secrets/sheets-service-account.json`に配置済みの前提で進める(このファイルは`.gitignore`済みであること。無ければ最初に`.gitignore`へ追加すること)
- 対象スプレッドシートには`CentralLog`(New Central)・`ClassicCentralLog`(Classic Central)・`MistLog`(Mist)の3シートがあり、それぞれ本プロジェクトのWebhook連携(Google Apps Script)で書き込まれている
- ポーリング間隔はデフォルト5分、UIで変更可能にする
- 「調査する」ボタンは15番で実装済みの共有state(`pendingInvestigationQuery`)の仕組みをそのまま流用する
- 今回追加実装するアイデア: (1)重大アラートの自動事前調査、(2)関連情報の自動先読み。それ以外のアイデア(重複集約・再発検知・Rogue APクロスチェック)は今回のスコープ外

## タスク

### Task 1: Google Sheets読み取り基盤

1. `googleapis`(Node.js公式クライアント)を導入し、サービスアカウントJSON(`secrets/sheets-service-account.json`)を使って認証するモジュールを新設する
2. スプレッドシートID(ユーザーに確認するか、`.env`に`WEBHOOK_LOG_SPREADSHEET_ID`として設定してもらう想定でよい。無ければ環境変数が無いとエラーになる旨を完了報告に明記する)を`.env`から読み込む
3. `CentralLog`・`ClassicCentralLog`・`MistLog`それぞれの全行を取得できる関数を実装する
4. 差分検知のため、シートごとに「前回取得時点で読んだ最終行番号」を記録し、次回以降は新規行だけを取得する設計にする(状態はファイルベースの永続化でよい。例: `data/webhook-feed/state.json`)

### Task 2: バックエンドAPI・ポーリング

1. `GET /api/webhook-feed/snapshot`(キャッシュ済みの統合フィード一覧を返す)、`POST /api/webhook-feed/refresh`(手動更新)、`GET/POST /api/webhook-feed/settings`(ポーリング間隔の取得・変更)を実装する。パターンはGlobal Overviewの`poller.ts`・`settings.json`永続化の実装を踏襲してよい
2. 3シートの新規行を統合し、共通スキーマ(受信時刻、ソース[New Central/Classic Central/Mist]、重要度、サイト/デバイス識別子、メッセージ、生データ)にマッピングする。ソースごとにフィールド名が異なる(New Centralは`severity`/`siteId`、Classic Centralは`severity`/`device_id`、Mistは`severity`/`site_id`)ため、統合スキーマへの変換ロジックを1箇所にまとめる
3. デフォルトのポーリング間隔は5分(300000ms)とする
4. Google Sheets APIの呼び出し頻度・レート制限(読み取りは比較的緩いが、無駄なポーリングは避ける)を踏まえ、シートに新規行が無い場合はキャッシュを使い回す

### Task 3: フロントエンド「Webhookログ」タブ

1. 既存のタブシェル(ネットワーク調査 / Global Overview)に3つ目のタブ「Webhookログ」を追加する
2. New Central/Classic Central/Mistの統合フィードを一覧表示する。ソース別のバッジ・重要度での色分け・サイト/カテゴリでのフィルタ(EventFeed.tsxのパターンを参考にしてよい)を実装する
3. 各行に「調査する」ボタンを設置し、15番で実装済みの共有state(`pendingInvestigationQuery`)経由でネットワーク調査タブに連携する(クエリ文の組み立ては`buildInvestigationQuery()`と同様のパターンで、ソースごとのフィールド差異を吸収して自然な日本語文にする)
4. ポーリング間隔の設定UI(プルダウン、Global Overviewの実装パターンを踏襲)を設置する。Global Overviewの間隔設定とは独立した設定として扱う(混同しないよう「Webhookログの自動更新間隔」であることが分かるラベルにする)

### Task 4: アイデア1 — 重大アラートの自動事前調査

1. 新規に取得した行のうち、重要度が最上位(New Central: `Critical`、Classic Central: `Critical`、Mist: `severity`が重大相当のもの)に該当するものを検出する
2. 該当する行に対して、ユーザー操作を待たず**バックグラウンドでInsight Agentを自動実行**し、その回答要約を行に紐付けて保存する
3. コスト制御のため、**同一アラート(同じ`id`/`alertId`/`nid`等の識別子)に対しては1回だけ自動実行する**(既に自動調査済みなら再実行しない)。識別子の永続化(実行済みIDの記録)を行う
4. UI上では、行を開くと「AIによる自動事前調査」として要約が表示され、より詳しく聞きたい場合は通常の「調査する」ボタンでネットワーク調査タブに遷移して追加で質問できるようにする
5. この自動実行が発生した際は、Insight Agent実行の記録(タイムライン等)にも通常の調査と区別できる形(例: 「自動調査」タグ)で残るようにする

### Task 5: アイデア2 — 関連情報の自動先読み

1. Task 4と同じ対象(重大アラート)、またはデバイス/サイトが特定できる行について、11番で実装済みの`GET /api/global-overview/site-detail`(またはデバイス単位の情報)をバックグラウンドで先読みし、該当行のそばに表示する
2. 表示内容は、そのサイトの直近のHealth/SLE、他の未解決アラート件数など、状況把握に役立つ範囲でよい
3. 先読みのタイミング・対象範囲はTask 4と重複する可能性が高いため、実装上は同じトリガー処理にまとめてよい(処理の分離は必須ではない)
4. 先読みの呼び出しがGlobal OverviewのAPIレート制限(Central 4req/sec等)を圧迫しないよう、対象を重大アラートのみに絞る等の配慮をする

### Task 6: 動作確認

1. サービスアカウント経由でスプレッドシートの実データが正しく取得できることを確認する
2. 3ソース統合フィードが正しく表示され、フィルタ・「調査する」ボタンが動作することを確認する
3. ポーリング間隔の変更・永続化が動作することを確認する(Global Overviewの間隔設定と混同していないこと)
4. 重大アラートで自動事前調査・関連情報先読みが実際に発火し、妥当な内容が表示されることを確認する。同一アラートに対して重複実行されないことも確認する
5. `docker compose up -d --build`で反映し、`/health`と実画面を確認する

## 完了報告

verified-report形式で報告すること。特に:

- Google Sheets APIの認証・読み取りが実データで成功したか
- 3ソース統合フィードの表示・フィルタ・「調査する」の動作確認結果
- ポーリング間隔設定の動作確認結果(Global Overviewの設定と独立していること)
- 自動事前調査・関連情報先読みの実際の発火結果と、重複実行防止の確認結果
- `docker compose up -d --build`後の反映確認結果

git操作は行わないこと。サービスアカウントのJSON鍵の中身は報告に含めないこと。

---
**推奨モデル: Opus**(自動事前調査のトリガー条件・重複防止設計、関連情報先読みの対象範囲判断など、判断を伴う設計要素が多いタスクのため)
