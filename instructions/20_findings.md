# 20_findings — New Central Streaming API タブ(Streaming(Central))

対象タスク: `instructions/20_central_streaming_tab.md`
調査・実装日: 2026-07-27
実装先: `plugins/central-streaming/`(新規プラグイン)、`server/index.ts`、`src/main.tsx`

> 認証情報の値そのものは記載しない。実測は git 管理外の `.env` の資格情報で行った。
> 接続先ベース URL: `https://internal.api.central.arubanetworks.com`(→ `wss://` に置換して使う)

---

## Task 0: Advance Tier Central Subscription の有無 → **契約あり(5 エンドポイントすべて接続成立)**

実接続で確認した。5 エンドポイントすべてで WSS ハンドシェイクが成功している
(契約が無ければ 403 などで拒否されるはず)。

| エンドポイント | パス | 結果 |
|---|---|---|
| Audit Trail | `network-services/v1alpha1/audit-trail-events` | **OPEN**(10 秒間イベント無し。接続は維持) |
| AP Monitoring | `network-monitoring/v1alpha1/ap-events` | **OPEN**(同上) |
| Geofence | `network-services/v1alpha1/geofence` | **OPEN**(同上) |
| Location | `network-services/v1alpha1/location` | **OPEN + 受信**(715 バイトのバイナリフレーム) |
| Location Analytics | `network-services/v1alpha1/rssi-events` | **OPEN + 受信**(361 バイト) |

トークンは既存の client_credentials フローで取得でき(`expires_in=7199`)、
**追加の資格情報・WebSocket キーは不要**だった(Classic Central との違い)。

---

## Task 1: proto 定義 → **5 種すべて取得できた**

`plugins/central-streaming/proto/` に配置した。取得できなかったものは無い。

| ファイル | package | 主なメッセージ | 出典 |
|---|---|---|---|
| `cloudevents.proto` | `cloudevents.v1` | `CloudEvent` / `CloudEventAttributeValue` | [streaming-api-cloudevents](https://developer.arubanetworks.com/new-central/docs/streaming-api-cloudevents) |
| `audit_trail.proto` | `network_services.audit_trail.v1alpha1` | `AuditTrail` / `ScopeInfo` / `LogDetails` / `ChangedField` / `ImpactRadius` / `ChangedJSON` | [event-audit-trail](https://developer.arubanetworks.com/new-central/docs/streaming-api-event-audit-trail) |
| `ap_monitoring.proto` | `network_monitoring.ap.v1alpha1` | `APInfo` / `RadioInfo` / `VapInfo` / `PortInfo` / `WlanInfo` / `TunnelInfo` / `APSystemStat` / `RadioStat` / `VapStat` / `PortStat` / `ModemStat` / `TunnelStat` / `IPProbeStat` / `RoleStat` / `SsidStat` / `VlanStat`(+ 列挙 24 個) | [event-ap-monitoring](https://developer.arubanetworks.com/new-central/docs/streaming-api-event-ap-monitoring) |
| `geofence.proto` | `network_services.geofence.v1alpha1` | `StreamGeofenceMessage` / `WifiClientGeofence` / `AssetTagGeofence` | [event-geofence](https://developer.arubanetworks.com/new-central/docs/streaming-api-event-geofence) |
| `location.proto` | `network_services.location.v1alpha1` | `StreamLocationMessage` / `WifiClientLocation` / `AssetTagLocation` / `ZoneEntry` | [event-location](https://developer.arubanetworks.com/new-central/docs/streaming-api-event-location) |
| `location_analytics.proto` | `network_services.location_analytics.v1alpha1` | `RssiEvent` / `ClientRssi`(+ `FirmwareVersion`) | [event-location-analytics](https://developer.arubanetworks.com/new-central/docs/streaming-api-event-location-analytics) |

### event-types の識別子(合計 42 種)

| ストリーム | 種別数 | 名前空間 |
|---|---|---|
| Audit Trail | **20** | `com.hpe.greenlake.network-services.v1alpha1.audit-trail.<sub-category>` |
| AP Monitoring | **16** | `com.hpe.greenlake.network-monitoring.v1alpha1.aps.{state,stats}.<obj>` |
| Geofence | 2 | `com.hpe.greenlake.network-services.v1alpha1.{wifi-client,asset-tag}-geofence-crossed` |
| Location | 2 | `…v1alpha1.wifi-client-locations.created` / `…v1alpha1.asset-tags.last-known-location.created` |
| Location Analytics | 2 | `…v1alpha1.rssi.{raw-rssi,proximity-rssi}` |

完全な一覧は `plugins/central-streaming/catalog.ts` にコードとして持たせた(画面の選択 UI もここから生成する)。

### ドキュメントに書かれていない、実測で分かった落とし穴 3 つ

1. **AP Monitoring だけベースパスが違う。**
   他 4 つは `network-services/v1alpha1/…` だが、AP Monitoring は
   **`network-monitoring/v1alpha1/ap-events`**。event-types の名前空間も
   `com.hpe.greenlake.network-monitoring.*` で、他と揃っていない。

2. **`proto_data.type_url` から 2 段目のメッセージを解決できない。**
   Any の type_url は公開されている `.proto` の package と一致しない:

   | 実測の type_url | ドキュメントの package |
   |---|---|
   | `type.googleapis.com/location.v1alpha1.StreamLocationMessage` | `network_services.location.v1alpha1` |
   | `type.googleapis.com/rssi.RssiEvent` | `network_services.location_analytics.v1alpha1` |

   → **必ず CloudEvent の `type` フィールドからカタログ経由で引く**。
   `decoder.ts` はそうしており、type_url は参考情報として payload に残すだけにしている。

3. **本体は `binary_data`(6)ではなく `proto_data`(8)に入る。**
   `datacontenttype` は `application/octet-stream`。念のため両方受けるようにしてある。
   加えて `attributes.subject` にテナント ID が入る。

4. **Location エンドポイントは非推奨予告を attributes に載せてくる**(実測):
   ```
   deprecated: true
   deprecationfrom:      2026-06-30T00:00:00Z
   deprecationsunset:    2026-09-30T00:00:00Z
   deprecationmigration: wss://internal.api.central.arubanetworks.com/network-services/v1/location-events
   ```
   **2026-09-30 で現行の `v1alpha1/location` は停止する**見込み。移行先は `v1/location-events`。
   デコード結果の `_cloudevent.attributes` に残しているので、画面で行を展開すれば見える。
   移行時期が来たら `catalog.ts` の path を差し替えること(proto が変わるかは未確認)。

### 二段デコードの実装

`protobufjs` を使用(`npm install ws protobufjs` / `-D @types/ws`)。
`google/protobuf/{any,timestamp,struct}.proto` は **protobufjs 内蔵の common 定義で解決される**ので、
ファイルを置く必要はない(`Root#resolvePath` で `google/protobuf/` 始まりに `null` を返す)。

```
バイナリフレーム
  → cloudevents.v1.CloudEvent としてデコード          (decoder.ts: decodeFrame)
  → ce.type で catalog.ts を引いてメッセージ名を決める
  → ce.proto_data.value を そのメッセージでデコード
  → ストリームごとの summarize() で 1 行要約 / サイト / デバイス / 実行者 を抽出
```

`keepCase: true` にしてフィールド名を snake_case のまま保っている(ドキュメントの `.proto` と
画面の生データ表示を突き合わせやすくするため)。

---

## Task 2: WebSocket 接続管理(`ws-client.ts`)

1 エンドポイント = 1 接続で、選択されたぶんだけ張る(最大 5 本)。押さえたライフサイクルは 4 つ。

| # | 事象 | 挙動 |
|---|---|---|
| 1 | トグル ON/OFF | `applySettings()` が「あるべき接続集合」に寄せる。設定は `data/central-streaming/settings.json` に永続化 |
| 2 | トークン更新 | 期限の **5 分前**(`token.ts` の `renewAt`)に、こちらから正常クローズ(1000)→ 新トークンで即再接続。全ストリームで 1 本のトークンを共有 |
| 3 | 予期しない切断 | 指数バックオフ 1s→2s→4s…最大 60s(±20% ジッタ)。Central は切断後 **15 分**キューするので、この範囲なら取りこぼさない |
| 4 | 400 / 403 / 404 | 再試行しても直らないので `state="error"` にし、15 分間隔でのみ再試行。**401 はトークンを捨てて通常バックオフ**で再試行 |

再送されたキュー分は **CloudEvent id による重複排除**(`store.addEvent`)で二重表示にならない。

### 実装中に踏んだバグ(修正済み。同じ設計をするなら注意)

`closeConn()` が「接続を捨てる」ためにジェネレーション番号を進めていたが、
**張り直し(トークン更新・イベント種別変更)でもそれをやってしまうと、`close` ハンドラが
自分を「古い世代」と判定して早期 return し、再接続が二度と走らない**。
`c.ws = null` を先にやると今度は `c.ws !== ws` の判定で同じことが起きる。

→ `disable`(以後つなぎ直さない)のときだけ世代を進めて `c.ws` を捨て、
`renew` / `reconfigure` のときは **どちらも触らずに `ws.close(1000)` するだけ**にした。
close ハンドラが `c.renewing` を見て自分で開き直す。

この不具合は「起動直後は正しい URL で繋がるが、画面から種別を変えると URL が古いまま」という
分かりにくい形で出る。実測で `event-types` がクエリに乗らないことに気づいて発見した。

---

## Task 3: 保存と Retention

### 保存形式の判断: **JSON Lines への追記**(SQLite は入れない)

| 案 | 判断 |
|---|---|
| Global Overview / Webhook ログと同じ「JSON 全体を毎回書き直す」 | **見送り**。Streaming は追記が主で高頻度(Location / RSSI は秒あたり数件)。1500 件を毎回書き直すのは無駄 |
| **JSON Lines への追記(採用)** | 1 行 1 イベント。2 秒ぶんをまとめてフラッシュする。Retention で捨てるときだけ全体を書き直す(compact) |
| SQLite 等の導入 | **見送り**。全文検索も集計もせず「新しい順に出す」だけなので、DB を増やす理由が無い |

- `data/central-streaming/events.jsonl` … イベント本体(古い順に追記)
- `data/central-streaming/settings.json` … トグル / 購読種別 / Retention(小さいので JSON のまま)

### Retention は「日数」と「件数」の 2 本立て

| 設定 | 選択肢 | 既定 |
|---|---|---|
| 保持期間 | 1 / 3 / 7 / 30 日 | **7 日** |
| 保持件数 | 1,000 / 5,000 / 20,000 / 50,000 件 | **20,000 件** |

どちらか厳しいほうが効く。**件数の上限は受信時に即座に**効かせ(メモリを守るため)、
日数の判定は 10 分ごとの定期ジョブ + 起動時に走らせる。

### 既定の購読は Audit Trail だけ・全体トグルは OFF

疎通確認で Location / RSSI が秒あたり数件流れ続けることを実測したため、
**起動しただけでは接続しない**(`enabled: false`)、**既定で選ばれているのは Audit Trail のみ**、
とした。全部 ON を既定にすると、画面を見ていない間にディスクとメモリを食う。

---

## Task 4: 画面

`src/main.tsx` に 4 枚目のタブ「Streaming(Central)」を追加(全 5 タブ構成)。
`plugins/central-streaming/view/CentralStreaming.tsx`。

- **接続状態カード**(5 枚): 未接続 / 接続中… / 接続済み / 再接続中 / エラー を色付きバッジで表示。
  受信件数・最終受信からの経過・想定流量・接続 URL(パス部)・次回再接続までの秒数・直近エラーを出す。
- **二段階の種別選択**: カードの「種別を選ぶ」→ 下にチェックボックス一覧が開く。
  Audit Trail は 20 サブカテゴリ、AP Monitoring は state/stats 16 種を個別に選べる。
  **何も選ばない = `event-types` を付けない = そのエンドポイントの全イベント**、という規則にした。
- **Retention 設定**: 保持期間 / 保持件数のプルダウン、「今すぐ整理」「すべて削除」。
- **一覧**: 受信時刻・ストリーム・種別・サイト/デバイス・要約・「調査する」。
  行をクリックするとデコード結果(生 JSON)と CloudEvent の id / type / 発生時刻が開く。
- **サイト名の解決**: Location イベントは `site_id` しか持たないので、
  Global Overview のポーリング済みスナップショットで名前に解決する(追加 HTTP は出さない)。
  実測で `<CENTRAL_SITE_ID>` → `Home` に解決できている。
- **「調査する」**: 15 番の `pendingInvestigationQuery` にそのまま乗せる(自動実行はしない)。

**自動調査は実装していない**(20 番の方針どおり)。各イベントに severity 相当のフィールドが無く、
自動実行の判断基準を持てないため。画面のフッタにもその旨を明記した。

---

## Task 5: 動作確認の結果

| 確認項目 | 結果 |
|---|---|
| WSS 接続確立 | **OK**。5 エンドポイントすべて。運用では Audit Trail / Location / RSSI の 3 本を同時接続して確認 |
| 実データの受信・デコード・表示 | **OK**(Location / Location Analytics)。1,500 件超をデコード失敗 0 件で受信・表示 |
| **Audit Trail の実イベント受信** | **未確認**。下記参照 |
| 全体トグル ON/OFF | **OK**。OFF で全接続クローズ、ON で再接続 |
| ストリーム個別トグル | **OK** |
| イベント種別選択 → URL への反映 | **OK**。`?event-types=…` が付いた状態で張り直る(上記バグ修正後) |
| Retention(件数) | **OK**。1,555 件 → maxEvents=1,000 に変更して purge → 555 件削除・jsonl も 1,000 行に |
| Retention(日数) | **OK**。10 日前の受信時刻を持つレコードを 3 件差し込んで再起動 → 3 件だけ削除された |
| 設定の永続化(コンテナ再作成後) | **OK**。`docker compose up -d --build` 後に settings.json / events.jsonl とも復元され、3 本とも自動再接続 |
| 「調査する」ボタン | **OK**。ネットワーク調査タブへ切り替わり、クエリ文が事前入力され、サイト "Home" が選択される(未実行) |
| 再接続ロジック | **OK**。`POST /disconnect` で強制切断 → `code=1006` を受けて 1 秒後に再接続(ログで確認) |
| ダーク / ライト両テーマ | **OK**(1512px)。コンソールエラーなし |
| `docker compose up -d --build` → `/health` | **OK**。`{"ok":true,...,"mcpConfig":{"source":"live",...}}` |

### Audit Trail のイベントを受信できていない件

接続自体は `state=open` で維持されており、`event-types` の指定・全解除も反映される。
ただし **実イベントは 1 件も流れてこなかった**(接続後 15 分以上待機)。

発火を試みた操作と結果:

| 試した操作 | 結果 |
|---|---|
| `show version`(Central の troubleshooting API 経由) | audit-trail に流れず |
| `ping 8.8.8.8`(同上・network test) | audit-trail に流れず |

→ **診断系(show / network test)は audit-trail ストリームには乗らない**と分かった。
このタブの Audit Trail が本当に動くかは、**Central UI で何か設定変更を 1 つ行えば**確認できる
(例: サイト名の編集、アラート設定の変更、WLAN のコメント変更など何でもよい)。
変更後 1 分ほどで画面の一覧に現れるはずで、現れなければ購読側の問題として切り分けられる。
実施していない理由は、本番テナントの設定を無断で変更しないため。

---

## 現在の稼働状態(引き継ぎ)

コンテナは **受信中**で、以下 3 本を購読している:

| ストリーム | 種別 | 備考 |
|---|---|---|
| Audit Trail | 全 20 種 | 流量小。実イベント未受信(上記) |
| Location | 全 2 種 | **流量大**。秒あたり数件 |
| Location Analytics | Proximity RSSI のみ | **流量大** |

Location / RSSI は動作確認のために有効にしたもの。
常用しないなら画面の接続状態カードでチェックを外すこと(保持件数 20,000 で頭打ちにはなるが、
それでも常時 20MB 前後の jsonl を保持し続ける)。全部止めるなら右上のトグルで「停止する」。

---

## 変更・追加ファイル一覧

```
plugins/central-streaming/proto/cloudevents.proto         新規。CloudEvents 封筒(1 段目)
plugins/central-streaming/proto/audit_trail.proto         新規
plugins/central-streaming/proto/ap_monitoring.proto       新規(列挙 24 + メッセージ 17)
plugins/central-streaming/proto/geofence.proto            新規
plugins/central-streaming/proto/location.proto            新規
plugins/central-streaming/proto/location_analytics.proto  新規
plugins/central-streaming/catalog.ts                      新規。エンドポイント / event-types / メッセージ名の対応表(唯一の正)
plugins/central-streaming/types.ts                        新規。StreamEvent / StreamStatus / StreamSettings / StreamEnvelope
plugins/central-streaming/decoder.ts                      新規。protobufjs 二段デコード + ストリーム別の要約抽出
plugins/central-streaming/token.ts                        新規。client_credentials + 残り寿命の管理(renewAt)
plugins/central-streaming/ws-client.ts                    新規。接続 / 再接続 / トークン更新 / 強制切断
plugins/central-streaming/store.ts                        新規。settings.json + events.jsonl + Retention
plugins/central-streaming/api.ts                          新規。/snapshot /catalog /settings /purge /clear /disconnect /status
plugins/central-streaming/view/types.ts                   新規。サーバ型のミラー
plugins/central-streaming/view/api.ts                     新規。fetch ラッパ
plugins/central-streaming/view/investigate.ts             新規。「調査する」のクエリ文組み立て
plugins/central-streaming/view/CentralStreaming.tsx       新規。タブ本体
plugins/central-streaming/view/styles.css                 新規。cs-* のみ(骨格は go-* を流用)
server/index.ts                                           /api/central-streaming をマウント + initCentralStreaming()
src/main.tsx                                              タブ "Streaming(Central)" を追加(5 枚構成)。isTabId を TABS 由来に
Dockerfile                                                data/central-streaming を mkdir 対象に追加
docker-compose.yml                                        CENTRAL_STREAMING_PURGE_MS / _API_MAX を追加(認証は既存 CENTRAL_* を流用)
package.json                                              ws / protobufjs / @types/ws を追加
```

`npx tsc --noEmit` / `npx vite build` 通過。`docker compose up -d --build` で反映し、
ブラウザ実機で確認した(ダーク・ライト両テーマ / 1512px)。コンソールエラーなし。
git 操作は行っていない。
