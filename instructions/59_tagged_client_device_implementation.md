# 59: タグ付きClient/Deviceタブの実装(タグ永続化 → 一覧 → 詳細)

## 背景(57・58番からの引き継ぎ)

- 57番でデータ取得可能性調査、58番でCentralのRSSI/SNR対応(central-mcpにPatch 002適用済み、稼働確認済み)とClient/Device取得可否の最終確認が完了している
- タグはこのダッシュボード固有の独自機能(ローカルDB管理、Central/Mistの設定には一切手を加えない)。対応プラットフォームはCentral+Mist両方。位置付けは新規独立タブ
- Clientの詳細表示はCentral/Mistで抽象化せず、platformによる判別可能ユニオン型として設計する。共有するのは表示プリミティブ(FieldRow/NotSupported/SignalBadge等)のみ
- タグの識別子: Client=正規化MAC、Device=MAC正準+シリアル(両値を保持し、Centralはシリアル引き・Mistはmac/UUID引きを使い分ける)
- ランダムMAC端末はMistのrandom_mac/Centralのmanufacturer:"Private"で検出し、タグ付与時に警告を出す

## 今回決定した進め方(判断事項への回答)

- **データ取得はMCP経由ではなく直接REST(central-client.ts等の既存の直接REST経路に相当する方式)を優先する**。理由: タグ付きビューは利用者が「今気にしている特定の対象」を見る画面なので、MCPの300秒キャッシュより即時性を優先する
- `clients-topn-usage`用の新規MCPツール追加は今回は行わず、第2段階(次回以降)に回す
- SNR品質バッジの閾値は58番の提案(>=25 / 15–24 / <15 dB)をそのまま採用してよい(実証値ではない前提だが、まず動くものを作ってから調整する)
- `last_seen_at === "0"`はstatusと統合して「接続中」と表示する
- central-mcpのパッチ運用(Patch 001, 002...)についてはユーザーは特に気にしていない。ローカルでの追加改修は自由に行ってよく、必要なら別途GitHubでの独自管理を検討する程度で良い(今回のタスクでは対応不要)

## タスク

### Task 1: タグ機構の実装

1. タグの永続化(ローカルDB、既存プロジェクトのdata/配置慣習に合わせる)を実装する
2. タグの対象識別子(Client=正規化MAC、Device=MAC正準+シリアル)を実装する
3. タグの付与・削除・編集ができるUI(一覧画面からの操作を想定)を実装する
4. ランダムMAC検出時の警告表示を実装する

### Task 2: Client/Device一覧ビュー

1. タグが付いた対象だけに絞った一覧を表示する新規タブを追加する(既存タブのデザイン言語に合わせる)
2. Client一覧とDevice一覧を分けて表示する(タブ内サブビュー等、既存のベストプラクティス診断タブの「診断」⇔「ルール一覧」切替パターンを参考にしてよい)
3. 一覧からタグの付与・削除ができるようにする(Task 1のUIと連携)
4. データ取得は直接REST経由(Central: `network-monitoring/v1/clients`相当、Mist: 既存のGlobal Overviewが使っている直接REST経路があればそれに合わせる)を優先する

### Task 3: Client詳細ビュー(Central/Mist別)

1. Central用Clientビューを実装する。表示項目は58番で確認済みの実データフィールド(role/connectedDeviceSerial/connectedDeviceType/connectedTo/vlanName/clientFunction/clientVendor/clientOperatingSystem/clientCategory/snr/wlanName/keyManagement/bssid/wirelessBand/wirelessChannel/status等)を基本とする。SNRは品質バッジ(>=25/15–24/<15)で表示。RSSIは無いため表示しない(NotSupportedにしない、そもそも項目自体を出さない)
2. Mist用Clientビューを実装する。57番で確認済みの項目(RSSI/SNR/tx_bps/rx_bps/channel/proto/uptime/idle_time)に加え、アプリ別トラフィック(`get_mist_insights`, object_type="client", metric="top-app-by-bytes")を必ず表示する
3. 有線Client(Central: `clientConnectionType: "Wired"`、Mist: バイト数・アプリ取得不可)は、取得できない項目をNotSupported表示にする
4. 58番で発見した実データの罠(last_seen_atが文字列"0"、tunnel_typeが文字列"None"、user_name/tagsが空文字列など)を考慮したパース処理を実装する

### Task 4: Device詳細ビュー(Central/Mist別)

1. Central用Deviceビューを実装する(cpu_utilization/memory_utilization/uptime/negotiated_power/radios[]/ports[]/wlans[]等、57番で確認済みの項目)
2. Mist用Deviceビューを実装する(cpu_util/mem/radio_stat/port_stat/lldp_stat/cert_expiry等、57番で確認済みの項目)
3. 既存のベストプラクティス診断タブ・Global Overviewで取得しているデータと重複する部分があれば、可能な範囲でコードを再利用する

### Task 5: i18n対応・動作確認

1. 新規文言をja.json/en.json両方に追加する
2. Central/Mist双方の実サイトで、タグ付与→一覧表示→詳細表示までの一連の流れを確認する
3. 有線/無線それぞれでNotSupported表示が意図通りであることを確認する
4. ランダムMAC端末での警告表示を確認する
5. 日英切替・ダークモードでの表示崩れが無いことを確認する
6. 実装完了後、本番Dockerコンテナのrebuild(`docker compose up -d --build`)まで行い、本番ポート(8092)での動作確認まで実施する(標準運用ルール通り)

## 制約

- Central/Mistの設定変更は一切行わない(タグはこのダッシュボード固有のローカル機能)
- git操作は行わない(コミット等は別途指示があるまで実施しない)
- 既存タブのデザイン言語に合わせる

## 完了報告

verified-report形式で報告すること。特に:

- タグの永続化・付与/削除の実データ確認結果
- Client/Device一覧・詳細それぞれの実サイトでの動作確認結果(Central/Mist双方)
- NotSupported表示・ランダムMAC警告の確認結果
- 本番反映(rebuild)の実行結果と本番ポートでの確認結果
- 未確認・次回に持ち越した事項

---
**推奨モデル: Opus**(タグ機構の識別子設計・Central/Mist別ビューの実装判断・既存コードとの重複整理を伴う実装のため)
