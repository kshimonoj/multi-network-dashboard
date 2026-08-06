# 58: Central RSSI/SNR対応 + 未確定事項の決着(タグ付きClient/Device実装着手前の最終調整)

## 背景(57番からの引き継ぎ)

- 57番でタグ付きClient/Device専用ビューのデータ調査・設計を行った(instructions/57_findings.md)
- 残っていた2つの未確定事項について、今回ユーザーから方針決定があった:
  1. **Mistのスイッチ配下アプリ可視化は諦めてよい**(機能として存在しないと判断。追加調査は不要)
  2. **Central側のRSSI/SNRは実際には取得できるはず**。ユーザーが実際のCentral API(`GET /network-monitoring/v1/clients`、`GET /network-monitoring/v1/clients/{mac-address}`。ドキュメント: https://developer.arubanetworks.com/new-central/reference/listunifiedclients 、https://developer.arubanetworks.com/new-central/reference/getclientdetails )を直接呼んだ実データを提供しており、無線クライアントには`snr`フィールドが実際に含まれている(有線クライアントはnull)ことを確認済み。現在central-mcp経由(`central_get_clients`)ではこのフィールドが返ってこないため、central-mcp側の実装を確認し、必要ならアップデートする
- Client詳細の表示は、Central/Mistで共通スキーマにせず**最初から分けて設計する**方針が確定している(57番のRISKSで指摘された「共通部分だけ出すと情報を捨てることになる」という問題への対応)

## 確認事項(重要)

- ユーザーが提供した実データサンプルには`snr`フィールドは存在するが、`rssi`という名前のフィールド自体は見当たらない。CentralのAPIが本当にRSSIを提供しているのか、SNRのみが提供されているのかを、Task 1の調査で明確にすること(無い場合は「CentralはSNRのみ、RSSIはMistのみ」という結論で構わない。無理に代替値を作らない)

## タスク

### Task 1: central-mcpの実装確認とRSSI/SNR対応

1. central-mcpサーバー(元は https://github.com/KarthikSKumar98/central-mcp-server ベース、Python/pycentral依存。カスタマイズ・更新作業は`/Users/kshimono/claude/central-mcp-http`フォルダで行っている)の`central_get_clients`相当の実装を確認し、`GET /network-monitoring/v1/clients`(および`/clients/{mac-address}`)のどのフィールドを現在パススルーしているか、なぜsnr等が欠落しているのかを特定する
2. central-mcp側でこのAPIのレスポンスに含まれる全フィールド(ユーザー提供サンプルのフィールド一覧を参考にする: role/ipv4/ipv6/siteId/connectedDeviceSerial/connectedDeviceType/connectedTo/vlanName/clientFunction/clientVendor/clientOperatingSystem/clientTags/clientCategory/clientManufacturer/lastSeenAt/connectedAt/tunnelId/clientCapabilities/keyManagement/bssid/radioMacAddress/wirelessBand/wirelessSecurity/wirelessChannel/userName/hostName/mloOperMode/phyType/snr/wlanName/macAddress/status/vlanId/tunnelType/authenticationType/clientConnectionType/port等)を返すように改修が必要かどうかを判断する
3. central-mcpは`/Users/kshimono/claude/central-mcp-http`という別のローカルフォルダ(別言語:Python)で管理されている。改修が必要と判断した場合は、そのフォルダ内で実際にコード変更まで行ってよい(今回のタスクの範囲に含める)。multi-network-dashboard側で対応できる範囲(central-mcpのレスポンスを一部加工している場合など)があればそちらも確認する
4. central-mcp側を改修した場合は、変更後に該当サーバーを再起動し、`central_get_clients`(または該当エンドポイント)がsnr等の追加フィールドを実際に返すことを確認する。central-mcp-httpのgit操作(コミット等)は今回は行わない(multi-network-dashboard側と同様、明示的な指示があるまで実施しない)

### Task 2: Client詳細のCentral/Mist分離設計の確定

1. 57番の設計をベースに、Central用Clientビュー・Mist用Clientビューをそれぞれ独立したコンポーネント/型として設計する(共通の抽象型に無理に押し込めない)
2. Central用Clientビューに表示する項目を、ユーザー提供の実データフィールド一覧を踏まえて確定する(SNR、接続先AP/Switch、WLAN名、認証方式、VLAN等)
3. Mist用Clientビューは57番で確認済みの項目(RSSI/SNR/tx_bps/rx_bps/channel/proto/uptime/idle_time、アプリ別トラフィック)をベースに確定する
4. 有線Client(Central: `clientConnectionType: "Wired"`、Mist: バイト数・アプリ取得不可)の扱いを明記する(57番の結論通り、Mist有線はアプリ表示不可のまま進める)

### Task 3: findingsの更新

1. instructions/58_findings.mdに、Task1・Task2の結果を記載する
2. 57_findings.mdで「未確定」としていた2点(Mistスイッチアプリ可視化、Central RSSI/SNR)について、今回の結論(前者は対応しない、後者はcentral-mcp改修の要否と計画)を明記する

## 制約

- central-mcp-http・multi-network-dashboardいずれもgit操作(コミット等)は行わない(明示的な指示があるまで実施しない)
- Central/Mistの設定変更は一切行わない

## 完了報告

verified-report形式で報告すること。特に:

- central-mcpの現状実装(なぜsnr等が欠落しているか)と、改修が必要な場合の具体的な変更計画
- RSSI自体がCentral APIに存在するかどうかの調査結果
- Central用/Mist用それぞれのClientビュー項目の確定リスト
- 59番以降(実装着手)に進む前に残っている判断事項があれば明記

---
**推奨モデル: Opus**(別リポジトリのコード調査・改修計画の判断、Central/Mist分離設計の確定を伴うため)
