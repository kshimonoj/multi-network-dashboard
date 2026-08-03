# 49: ベストプラクティス診断の調査 + チェックルール設計(セキュリティ・RF)

## 目的

Central/Mistの設定が、公開されているベストプラクティスに沿っているかを診断する新機能の土台として、まずCentral側で実際に取得可能な設定項目を調査し、Mist Marvis Actionsの出力形式を確認した上で、セキュリティ・RF/無線チューニングのチェックルールを設計する。**このタスクではUI(タブ画面)は作らない。**

## 参考資料

- https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/ (WPA3/Enhanced Openへの移行、レガシー暗号化方式の非推奨)
- https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/features/ (802.11w/PMF)
- https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/wids-wips/protection/ (WIDS/WIPS、不正AP検知・封じ込め。封じ込めは法的な注意事項があるドキュメントの記載に留意すること)
- RF関連: AirMatch/ARM(自動チャネル・電力最適化)、2.4GHz帯の高密度環境での扱い、チャネル幅の一貫性に関する各種ページ(検索して該当ページを確認すること)

## 方針(確定事項)

- **Mist**: 既存のMarvis Actions(`get_mist_insights(insight_type=marvis_actions)`)を主として活用し、重複するルールを自作しない。Marvis Actionsがカバーしていない領域があれば、その範囲だけCentralと同様の自作ルールで補う
- **Central**: 標準の診断機能が無い前提で、機械的にチェックできる項目(客観的な合否判定ができるもの)を優先し、判断が難しい項目のみLLMに所見を出させる
- 今回はセキュリティとRF/無線チューニングの2領域に絞る。将来的に他領域(ファームウェア世代・冗長性・監視設定等)を追加できるよう、チェック項目をカテゴリ・ルール単位で管理できる設計にする

## タスク

### Task 1: Central側で取得可能な設定項目の調査

1. 既存のcentral-mcp(central_get_wlans等)・Global Overviewが使っている直接REST APIの両方を確認し、以下の設定値が実際に取得できるか確認する:
   - SSIDごとの暗号化方式/セキュリティモード(WPA2/WPA3/Enhanced Open/Open等)
   - 802.11w(PMF)の有効・無効・必須設定
   - WIDS/WIPSの不正AP検知・封じ込め設定の有効状態
   - ARM/AirMatchの有効・無効状態、手動での静的チャネル/電力設定の有無
   - 2.4GHz帯のクライアント利用可否設定
   - チャネル幅の設定
2. 取得できないもの・取得に別のAPIエンドポイントや権限が必要なものがあれば、その旨を記録する
3. 調査結果を`instructions/49_findings.md`に記録する(実際の設定値そのものではなく、取得可否と項目の構造を記録すること)

### Task 2: Mist Marvis Actionsの出力確認

1. `get_mist_insights(insight_type=marvis_actions)`の実際の出力を確認し、セキュリティ・RF関連のアクション種別にどのようなものがあるか一覧化する
2. Marvis Actionsがカバーしていない(参考資料に挙げたベストプラクティス項目のうち、Marvis Actionsの出力に出てこないもの)があれば特定する

### Task 3: チェックルールの設計

1. Task 1・2の結果を踏まえ、セキュリティ・RF領域それぞれについて、具体的なチェック項目とその判定方法(機械的な合否判定か、LLMによる所見か)を設計する
2. 各チェック項目に、重要度(推奨/強く推奨等)・参照した根拠ドキュメントのURL・対象(サイト単位かSSID単位かAP単位か)を持たせる設計にする
3. 将来カテゴリを追加しやすいデータ構造(例: `category: "security" | "rf" | ...`のような拡張可能な形)を設計する
4. 設計したチェックルールの一覧を`instructions/49_findings.md`にまとめる(この段階では実装しない。次の指示ファイルで実装する)

## 完了報告

verified-report形式で報告すること。特に:

- Central側で実際に取得できた設定項目・取得できなかった項目
- Mist Marvis Actionsの出力形式とカバー範囲
- 設計したチェックルールの一覧(セキュリティ・RFそれぞれ何項目か、判定方法の内訳)
- 次の実装(タブUI)に進む上で必要な追加調査があれば明記する

git操作は行わないこと。コード実装(タブUI等)はこのタスクでは行わない。

---
**推奨モデル: Opus**(取得可能な設定項目の調査・チェックルールの設計判断・将来拡張を見据えたデータ構造設計など判断要素が多いタスクのため)
