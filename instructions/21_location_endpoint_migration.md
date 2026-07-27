# 21: Locationエンドポイントの新URLへの前倒し移行(multi-network-dashboard)

## 背景

20番の実装中、現行の`location`(位置情報、`wifi-client-locations.created`イベント)エンドポイントがCloudEvent属性内で2026-09-30に非推奨化される予告(移行先: `wss://.../network-services/v1/location-events`)を発見した。期限までまだ余裕はあるが、単純なURL差し替えで済むなら前倒しで対応しておきたい。

Location Analytics(RSSI、`rssi-events`エンドポイント)にも同様の廃止予告が出ているかは未確認。

## タスク

### Task 1: 現状の廃止予告の詳細確認

1. `location`エンドポイント接続時にCloudEventの`attributes`に含まれていた廃止予告の詳細(正確な文言、移行先URL、必須になる時期)を再確認する
2. `rssi-events`(Location Analytics)エンドポイントについても、同様の廃止予告がCloudEventのattributesに含まれていないか確認する。含まれていなければ「現時点では廃止予告なし」として記録する

### Task 2: 新エンドポイントの疎通確認

1. 新エンドポイント`wss://<host>/network-services/v1/location-events`に、現行と同じ認証(Bearer トークン)で接続を試みる
2. 接続できる場合、実際にイベントが届くか、届く場合のペイロード構造が現行の`location`エンドポイント(`wifi-client-locations.created`)と同じか、変更があるかを確認する
3. 接続できない場合(まだ新エンドポインが提供開始されていない等)、その旨を記録し、Task 3以降は見送る

### Task 3: 実装(Task 2で疎通確認できた場合のみ)

1. Locationの接続先URLを新エンドポイント(`v1/location-events`)に切り替える
2. ペイロード構造に変更があった場合は、デコード処理・保存スキーマを新構造に合わせて修正する(変更が無ければコード変更は最小限でよい)
3. 既存の保存済みイベントデータ(旧エンドポイント経由で受信したもの)との互換性(表示が壊れないこと)を確認する

### Task 4: 動作確認

1. 新エンドポイントで実際にイベントを受信・表示できることを確認する
2. 既存のLocation Analytics(RSSI)や他のイベント種別の動作に影響が無いことを確認する
3. `docker compose up -d --build`で反映し、実画面を確認する

## 完了報告

verified-report形式で簡潔に報告すること。特に:

- 廃止予告の詳細(正確な文言・移行先・時期)、Location Analytics側の予告有無
- 新エンドポインの疎通確認結果(接続可否、ペイロード構造の変更有無)
- 切り替えを実施したか見送ったか、その理由
- 実施した場合の動作確認結果

git操作は行わないこと。

---
**推奨モデル: Sonnet**(URLの差し替えが中心で、疎通確認さえできれば判断要素は少ないタスクのため。ただし新エンドポインの構造が大きく変わっていた場合は判断が必要になる可能性がある)
