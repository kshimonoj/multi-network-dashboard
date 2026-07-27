# 20: New Central Streaming APIタブの追加(multi-network-dashboard)

## 前提・確定事項

- Streaming APIはこちらから能動的にWebSocket(WSS)接続を張りに行く方式のため、Google Sheets中継は不要。multi-network-dashboardのバックエンドから直接接続する
- 認証は既存のCentral OAuth2トークン(05番で実装済みのclient_credentials方式)をそのまま流用する
- ペイロードはCloudEvents + Google Protocol Buffers(protobuf)の二段エンコード。JSONではない
- **自動調査(重大アラートの自動事前調査)は実装しない**。理由: 各イベント種別(AP Monitoring/Audit Trail/Geofence/Location/Location Analytics)のペイロードに重要度(severity)に相当するフィールドが存在せず、自動実行の判断基準を持てないため。継続的なテレメトリ・監査データとしての性質が強く、高頻度になりやすい点もコスト面で自動実行に向かない
- 「調査する」ボタンは15番で実装済みの共有state(`pendingInvestigationQuery`)をそのまま流用する

## タスク

### Task 0: 前提確認

1. お使いのCentralテナントがAdvance Tier Central Subscriptionであるか(Streaming APIの利用条件)を、実際に接続を試すことで確認する。契約がない場合は認証/権限エラーが返るはずなので、その場合は結果をそのまま報告し、以降のタスクは一時保留とする(コードは実装してよいが、実接続確認はできない旨を明記する)

### Task 1: 各イベント種別のproto定義の調査

1. 以下のドキュメントから、CloudEvent封筒(取得済み)に加え、各イベント種別固有のproto定義を取得する:
   - AP Monitoring: https://developer.arubanetworks.com/new-central/docs/streaming-api-event-ap-monitoring (または streaming-api-event-ap-events)
   - Audit Trail: https://developer.arubanetworks.com/new-central/docs/streaming-api-event-audit-trail (取得済み。19種類のサブタイプのevent-typesクエリパラメータあり)
   - Geofence: https://developer.arubanetworks.com/new-central/docs/streaming-api-event-geofence
   - Location: https://developer.arubanetworks.com/new-central/docs/streaming-api-event-location
   - Location Analytics: https://developer.arubanetworks.com/new-central/docs/streaming-api-event-location-analytics
2. 取得したproto定義を`instructions/20_findings.md`に記録し、`.proto`ファイルとして`plugins/central-streaming/proto/`配下に保存する
3. protobufのデコードには`protobufjs`(Node.js)を使う。CloudEvent封筒をデコード→`type`フィールドで判定→該当イベントのproto定義でペイロード部分をデコード、という二段構成で実装する

### Task 2: WebSocket接続管理

1. `plugins/central-streaming/ws-client.ts`(仮)に、WSS接続を管理するモジュールを新設する
2. 接続先URL: `wss://<central-base-url>/network-services/v1alpha1/<endpoint-path>`(endpoint-pathはイベント種別ごとに異なる。例: Audit Trailは`audit-trail-events`)
3. 認証: `Authorization: Bearer <access-token>`ヘッダー(WebSocketのHTTPアップグレードリクエストに含める。既存のCentral OAuth2トークン取得ロジックを流用)
4. トークン有効期限(2時間)に備え、期限が近づいたら新しいトークンを取得し、再接続する処理を実装する
5. 予期しない切断時の再接続ロジックを実装する(Central側は切断後15分間イベントをキューイングするため、15分以内に再接続できれば取りこぼしを最小化できる)
6. 有効/無効の手動トグルに応じて、接続の開始/切断を制御する。設定は永続化し、コンテナ再作成後も維持されるようにする(Global Overview/Webhookログの設定永続化パターンを踏襲)
7. 購読するイベント種別(AP Monitoring/Audit Trail/Geofence/Location/Location Analytics、Audit Trailはさらにサブタイプ)をユーザーが選択できるようにし、選択に応じて接続するエンドポイント・`event-types`クエリパラメータを切り替える。選択も永続化する

### Task 3: データの保存とRetention

1. 受信したイベントを、既存のプロジェクトのデータ永続化パターン(`data/`配下)に沿って保存する(ファイルベースでよい。SQLite等を新規導入するほどの規模ではないと判断すればJSON Lines形式等で構わない)
2. Retention設定(保持期間: 例 1日/3日/7日/30日、または最大件数)をユーザーが選択できるUIを用意し、設定に応じて定期的に古いレコードを削除するジョブを実装する。デフォルト値は妥当なもの(例: 7日)を設定する

### Task 4: フロントエンド「Streaming(Central)」タブ

1. 既存のタブシェルに新しいタブを追加する
2. 接続状態(未接続/接続中/再接続中/エラー)を表示する
3. 有効/無効の手動トグル、イベント種別選択(Audit Trailはサブタイプまで選べる二段階UI)、Retention設定のUIを実装する
4. 受信イベントの一覧表示(受信時刻・イベント種別・内容の要約・関連するサイト/デバイスが分かれば表示・「調査する」ボタン)を実装する。「調査する」は15番のpendingInvestigationQuery経由でネットワーク調査タブに連携する
5. ダークモード両テーマでの表示を確認する

### Task 5: 動作確認

1. Task 0で契約が確認できた場合、実際にWebSocket接続を確立し、少なくとも1種類のイベント(Audit Trailを推奨。設定変更を実際に行うことでイベントを発生させられるため)を実データで受信・表示できることを確認する
2. 有効/無効トグル、イベント種別選択、Retention設定がそれぞれ正しく動作し、コンテナ再作成後も設定が保持されることを確認する
3. 「調査する」ボタンの動作を確認する
4. 意図的に接続を切断し、再接続ロジックが機能することを確認する(可能な範囲でよい)
5. `docker compose up -d --build`で反映し、`/health`と実画面を確認する

## 完了報告

verified-report形式で報告すること。特に:

- Task 0の契約確認結果(Advance Tierの有無)
- 取得できたproto定義の一覧(取得できなかったものがあれば理由も)
- 実際にイベントを受信・表示できたか(Task 0の結果次第で全部は検証できない可能性がある旨も含めて)
- 有効/無効・イベント選択・Retention設定の動作確認結果
- 再接続ロジックの確認結果
- `docker compose up -d --build`後の反映確認結果

git操作は行わないこと。

---
**推奨モデル: Opus**(protobufデコード基盤の設計、WebSocket接続・再接続・トークン更新のライフサイクル管理、Retention設計など判断を伴う要素が多いタスクのため)
