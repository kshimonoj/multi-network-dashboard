# 57: タグ付き Client / Device 専用ビュー — データ調査とタグ設計

実施日: 2026-08-04 / 対象: 調査・設計のみ(コード実装なし・git 操作なし・Central/Mist の設定変更なし)

このドキュメントは 58 番以降の実装(タブ UI・タグ永続化・突合処理)の前提になる。
49 番と同じ方針で、**実データそのもの(サイト名・MAC・シリアル・org_id/site_id・IP)は記載しない。**
記録するのは「取得可否」「項目の構造」「設計判断」だけ。実測値は形だけ残して伏字にしてある。

---

## 0. 要約

| | 結果 |
|---|---|
| Client 基本情報 | 両プラットフォームで取得可。ただし**持っている項目が大きく違う**(§1-7 の対比表) |
| **Client アプリトラフィック(Mist)** | ✓ **`insight_metrics` の `top-app-by-bytes` が `object_type="client"` を受け付ける。**MAC 指定で「アプリ名 × rx/tx/total bytes」が返る(実測 7 アプリ) |
| **Client アプリトラフィック(Central)** | △ **REST/MCP には無く、`show dpi-stats session`(AP 上の DPI セッションテーブル)でのみ取れる。**「送信元 IP × アプリ × Webカテゴリ × Web評価 × TX/RX bytes」(実測 61 エントリ)。**MAC ではなく IP キー**なので `central_get_clients` の `ipv4` で突き合わせが要る |
| Client の RSSI/SNR | Mist ✓(現在値 + 時系列)/ Central **✗**(クライアント API に RSSI・SNR・バイト数が無い。§1-3) |
| 有線 Client | Central: DPI 対象外(AP 配下の有線ポートを除く)。Mist: `wired_clients` に**バイト数もアプリも無い**。両者とも有線はアプリ可視化不可(§1-8) |
| Device 情報 | 両プラットフォームとも豊富。Mist の単体取得(`site_devices` + `object_id`)が最も情報量が多い(CPU/メモリ/帯域別 RF/ポート/PoE/RADIUS/環境センサ) |
| 既存タブとの重複 | Global Overview は監視系 REST の**サマリのみ**、ベストプラクティス診断(51)は**設定値のみ**。本タブが必要とする「個体の実測値」は**どちらとも重複しない**(§2-4) |
| タグの識別子 | Client = **正規化 MAC**(小文字・区切りなし 12 桁)。Device = **MAC を正準キー、シリアルを併記**(Central は serial 引き、Mist は MAC 引きのため両方要る)(§3-2) |
| 最大の設計リスク | **ランダム MAC**。Mist は `random_mac: true`、Central は `manufacturer: "Private"` で判別できる。MAC が変わるとタグが無効化する(§3-5) |
| 性能上の要注意点 | Central の DPI は `central_run_show_commands` 依存で**遅く・AP 単位・履歴なし**。一覧画面で回してはいけない(§3-6) |

---

## 1. Task 1: Client 向けデータの取得可能性

### 1-1. Central: クライアント一覧・単体(`central_get_clients` / `central_find_client`)

`central_get_clients(site_id=...)` を実クライアントのいるサイトで実行して確認した。1 クライアントあたり返る項目:

| 分類 | 項目 |
|---|---|
| 識別 | `mac` / `name` / `hostname` / `user_name` / `site_id` / `site_name` |
| ネットワーク | `ipv4` / `ipv6` / `vlan_id` / `role` / `tunnel_type` / `tunnel_id` / `port`(有線時) |
| 接続先 | `connected_device_type`(AP/…)/ `connected_device_serial` / `connected_to`(デバイス名)/ `bssid` / `radio_mac` / `connected_at` |
| 無線 | `wireless_band` / `wireless_channel`(`48E (80 MHz)` のように**帯域幅込みの文字列**)/ `wireless_security` / `key_management`(`WPA3-SAE` 等) / `wlan_name` |
| 端末プロファイル | `vendor` / `manufacturer` / `category` / `function` / `os` / `capabilities`(`802.11ax, 802.11k, 802.11r, 802.11v` の**カンマ区切り文字列**) |
| 認証 | `authentication`(`dot1x` 等)/ `status`(Connected/Failed) |
| その他 | `tags` — **Central 自身が付けたクライアントタグ**(ML 分類由来の値が入っていた)。今回作る独自タグとは**別物**なので、UI 上で名前が衝突しないようにすること |

- `central_find_client(mac_address)` で単体引きができる。**サイトを知らなくても MAC だけで引ける唯一の経路**で、タグ突合の主力になる(§3-6)。
- `status="Failed"` フィルタがあるので「認証失敗したクライアント」は一覧側で絞れる。

### 1-2. Central のアプリトラフィックは REST/MCP に無い — DPI show コマンドが唯一の経路(重要)

`central_get_clients` にも `central_get_ap_details` にもアプリ別のバイト数は**一切含まれない**。
そこで 49 番と同じく `central_run_show_commands` のコマンドカタログを当たった。AP のカタログには
`Security` カテゴリに **DPI 系が約 40 コマンド**存在する。実際に叩いて分類した結果:

| コマンド | 結果 | 返る形 |
|---|:--:|---|
| **`show dpi-stats session`** | **✓ 本命** | `Source IP` / `Destination IP` / `SSID ID` / `App(AppId)` / `Webcat` / `Webrep` / `Flag`(PERMIT/DENY) / `Hit Count` / `TX Bytes` / `Rx Bytes`。**クライアント単位 × アプリ単位のバイト数が取れるのはこれだけ**。末尾に `Num of Permitted / Denied / Total Entries` とスナップショット時刻 |
| `show dpi-stats app` | ✓ | `App / AppId / Total bytes` の降順表 + `Total bytes` と `Classication percentage`(原文ママの綴り)。**AP 全体の集計**でクライアント別ではない |
| `show dpi-stats appcategory` | ✓ | `App Category / App Category Id / Total bytes`。同じく AP 全体 |
| `show dpi-stats app user` / `... user full` | △ | `User(=IP) / Total bytes` のみ。**アプリ別の内訳が付かない**ので「誰が使ったか」しか分からず、本タブの用途には足りない |
| `show dpi-stats appcategory user full` | △ | 上と**同一の出力**(カテゴリ別内訳にならない) |
| `show dpi-stats app user ip {{ip}}` | **✗** | カタログにテンプレート引数付きで登録されており、具体値を入れると validator を通らない。`appcategory user ip` / `webcategory user ip` も同様。**49 番で `show ap monitor {{option}}` に見た制約と同じ** |
| `show dpi` | ✗ | `% Incomplete command.` |
| `show app-monitoring` | ✗ | `No output for this command` |

**この経路の 4 つの制約**(実装前に必ず織り込むこと):

1. **IP キーであって MAC キーではない。** タグは MAC で持つので、`central_get_clients` の `ipv4` を使った
   IP→MAC の突き合わせが必須。DHCP でアドレスが変わると過去分は追えない。
2. **AP ローカル・スナップショット。** その AP のデータパスが今持っているセッションだけで、
   **履歴も時系列も無い**。「直近 24h のアプリ内訳」は作れない。作りたければ本アプリ側で
   定期取得して自前で貯める必要がある(Webhook ログ・レポートと同じ方式)。
3. **AP 単位で実行が要る。** タグ付きクライアントが 3 台の AP に散っていれば 3 回叩く。
   `central_get_clients` の `connected_device_serial` で**AP ごとにまとめてから 1 回ずつ**呼ぶこと。
4. **遅い。** `central_run_show_commands` はデバイスに投げてポーリングする非同期実行。
   一覧描画の同期パスに入れてはいけない(§3-6)。

補足: 実測データの `App` 列には `https` のような「アプリ名が付かなかった分」が最大値で入っていた。
これは DPI が分類しきれなかった暗号化トラフィックで、**Mist 側の `Unknown` に相当する**。
UI で上位アプリを出すときは、この行を「不明/その他」として明示的に別扱いするのが誠実。

### 1-3. Central で取得できなかった Client 項目

| 項目 | 状況 | 影響 |
|---|---|---|
| **RSSI / SNR** | クライアント API に**フィールドが無い**。AP 側の `central_get_ap_details` にあるのは無線単位の `noise_floor` などで、クライアント個体の受信強度ではない | Client ビューの「接続品質」は **Central だけ空欄**になる。`show ap debug client-stats {{mac}}` はテンプレート引数のため使えない |
| **クライアント別の総トラフィック量(bytes)** | 同上。無い | 「よく使う端末」の並べ替えが Central では DPI 由来の値でしか作れない |
| **接続品質の時系列** | 無い | Mist の `client-rf-metrics` に相当するものが無い |
| **ローミング履歴 / 認証失敗の詳細** | `central_get_events(context_type="WIRELESS_CLIENT", context_identifier=<mac>)` で**イベントとしては取れる**(要 `site_id`)。数値指標ではない | 「品質」ではなく「出来事」として出す設計にする(§4-2) |

### 1-4. Mist: クライアント一覧・現況(`search_mist_data` / `get_mist_stats`)

2 系統あり、**返る項目が違うので両方要る**。

**(a) `search_mist_data(search_type="wireless_clients")` — 履歴寄りの検索**

`mac` / `hostname[]` / `ip[]` / `last_ip` / `ap[]`(接続した AP の MAC 一覧)/ `last_ap` /
`ssid[]` / `last_ssid` / `vlan[]` / `last_vlan` / `wlan_id[]` / `os[]` / `last_os` / `os_version` /
`model[]` / `last_model` / `last_family`(`Phone/Tablet/Wearable` 等)/ `mfg` / `protocol`(`ax`/`ac`/`n`)/
`band` / `psk_name[]` / `username[]` / **`random_mac`(真偽値)** / `site_id` / `timestamp`

- 配列項目は「期間中に観測された値の集合」、`last_*` は最新値。**表示には `last_*` を使う。**
- MAC は**区切りなし小文字 12 桁**(Central のコロン区切りと違う。§3-2)。

**(b) `get_mist_stats(stats_type="site_wireless_clients")` — 現在値のスナップショット**

`mac` / `hostname` / `ip` / `ap_mac` / `ap_id` / `bssid` / `ssid` / `wlan_id` / `band` / `channel` /
`proto` / **`rssi`** / **`snr`** / **`tx_bps`** / **`rx_bps`** / `uptime` / `idle_time` / `is_guest` /
`vlan_id` / `manufacture` / `model` / `os` / `family` / `last_seen`

- `object_id` に **MAC**(UUID ではない)を渡すと単体引きできる。
- **Central に無い RSSI / SNR / 現在スループットがここにある。**

### 1-5. Mist のアプリトラフィックはクライアント単位で直接取れる(重要)

`get_mist_insights(insight_type="insight_metrics")` の `top-app-by-bytes` は、
`get_mist_constants("insight_metrics")` 上で **`scopes: ["org","site","ap","device","client"]`** と定義されている。
`object_type="client"` + `mac` + `duration` で実行し、動作を確認した。

返り値(1 アプリ 1 要素):

```
{ "app": "<アプリ名>", "num_clients": 1,
  "rx_bytes": <n>, "tx_bytes": <n>, "total_bytes": <n> }
```

- 実測: 1 クライアント・24 時間で **7 アプリ**が降順で返った。AP スコープ(`object_type="ap"` + AP の MAC)でも
  同じ形で **13 アプリ**返り、こちらは `num_clients` が実数になる。
- **アプリ名の粒度は Mist 独自の分類**で、`Microsoft` / `Office` / `Video Conference` / `OfficeApp` のような
  **粗いくくり**。Central の DPI が返す `ms-teams` / `outlook` / `office365` のような細かい名前とは**別の体系**。
  → **両プラットフォームのアプリ名を突き合わせて 1 つのランキングにしてはいけない。**
    プラットフォームごとに別の表として見せる(§4-2)。
- `Unknown` が上位に来ることがある(分類できなかった分)。Central の `https` と同じ扱いにする。

**クライアント単位で取れなかった隣接メトリクス:**

| メトリクス | scopes | 判定 |
|---|---|---|
| `top-categories-by-bytes` | `site`, `device` | **client 不可**。クライアント別のカテゴリ内訳は取れない |
| `top-services-by-bytes` | `site`, `device` | **client 不可** |
| `top-grouped-apps`(カテゴリ配下にアプリを束ねた形) | `device` のみ | **client 不可** |
| `app-bytes`(アプリ別の時系列) | `site`, `device` | **client 不可**。「このクライアントの Teams 使用量の推移」は作れない |

→ **Mist 側のクライアントアプリ可視化は「期間合計のアプリ別ランキング」までで、時系列にもカテゴリ別にもできない。**

### 1-6. Mist: 接続品質・SLE 系

| 項目 | 手段 | 確認結果 |
|---|---|---|
| **RSSI/SNR/レート/リトライの時系列** | `insight_metrics` `client-rf-metrics`(`scopes: ["client"]`) | ✓ 動作確認済み。`min_/avg_/max_` × `rssi` `snr` `tx_rates` `rx_rates` `tx_bps` `rx_bps` `tx_retries` `rx_retries` `tx_retried` `tx_failed` の**キー付き時系列**。`interval` は `10m`(保持 24h)/ `1h`(保持 14 日)。未接続の時間帯は `null` で埋まる。定義に **"SUB-VNA required"** と書かれているが、この org では返った |
| 認証遅延 / DHCP 遅延 | `client-auth-latency` / `client-dhcp-latency`(定義上 `scopes` に `client` を含む) | **未実測**。定義から可能と読めるだけ |
| ローミング成否 | `client-roam-band5` / `client-roam-band24` | **scopes は `site` / `ap` のみ**。クライアント単位のローミング成否は**取れない**。代わりに `search_mist_data(wireless_client_events, filters:{mac})` のイベントで見る |
| Marvis 個別診断 | `get_mist_insights(insight_type="troubleshoot", params:{mac})` | **未実測**。ツール定義に **Marvis サブスクリプション必須**・**最大 7 日**と明記されている |
| クライアントイベント | `search_mist_data(search_type="wireless_client_events", filters:{mac})` | 未実測だがフィルタに `mac` があり利用可能。イベント種別は `get_mist_constants("client_events")` で引ける |

### 1-7. Client データ対比表(Central / Mist)

| 見せたい情報 | Central | Mist |
|---|:--:|:--:|
| MAC / ホスト名 / IP / VLAN | ✓ | ✓ |
| 接続先 AP | ✓(名前 + **シリアル**) | ✓(**MAC** + AP UUID) |
| SSID / バンド / チャネル | ✓(チャネルは帯域幅込みの文字列) | ✓(チャネルは数値、帯域は別項目) |
| 暗号方式 / 鍵管理 | ✓ (`wireless_security` / `key_management`) | △(`wlan_id` から WLAN 設定を引く必要あり) |
| 端末 OS / 種別 / ベンダ | ✓(`os` / `category` / `function` / `vendor`) | ✓(`last_os` / `last_family` / `mfg` / `last_model`) |
| 802.11k/r/v 対応 | ✓ (`capabilities`) | ✗(`protocol` で世代のみ) |
| ユーザ名 / 認証方式 | ✓ | ✓(`username` / NAC 検索側) |
| **RSSI / SNR(現在値)** | **✗** | ✓ |
| **RSSI/SNR/レートの時系列** | **✗** | ✓ (`client-rf-metrics`) |
| **現在スループット(bps)** | **✗** | ✓ (`tx_bps` / `rx_bps`) |
| **アプリ別トラフィック** | △ **DPI show 経由・IP キー・履歴なし・AP 単位** | ✓ **API 1 本・MAC キー・期間合計** |
| アプリのカテゴリ別内訳 | ✓(AP 全体としてのみ。クライアント別は不可) | ✗(client スコープ非対応) |
| Web カテゴリ / レピュテーション | ✓ (`show dpi-stats session` の `Webcat` / `Webrep`) | ✗ |
| ランダム MAC の判別 | △(`manufacturer: "Private"` から推測) | ✓(`random_mac` 真偽値) |
| ゲスト判定 | △(`role` から推測) | ✓ (`is_guest`) |

### 1-8. 有線クライアントは両プラットフォームともアプリ可視化ができない

- **Central**: `central_get_clients(connection_type="Wired")` は返るが、DPI は AP のデータパス上の話。
  スイッチ配下の有線クライアントは `show dpi-stats session` に現れない(AP の有線ポート配下は別)。
- **Mist**: `search_mist_data(search_type="wired_clients")` の実レコードを確認したところ、
  `mac` / `hostname[]` / `device_mac[]`(収容スイッチ)/ `port_id[]` / `vlan[]` / `manufacture` /
  `device_mac_port[]`(LLDP 由来の収容ポート履歴)は取れるが、
  **バイト数・IP・アプリのいずれも入っていない**(観測レコードでは `ip: []` が空だった)。
- スイッチ単位のアプリ内訳(`top-flow-by-app`)は定数定義上 `scopes: ["device"]` / `device_type: ["switch"]` だが、
  `object_type="switch"` でも `object_type` の他の値でも **MCP 側が "metric not found" を返して実行できなかった**(§5 の未確定 #1)。

→ **Client ビューのアプリトラフィックは「無線クライアント限定機能」として設計し、有線は該当欄を
「このプラットフォームでは取得不可」と明示する。** 空欄で黙らせない。

### 1-9. 取得手段のまとめ(新規ツールの要否)

**新規 MCP ツールは不要。既存ツールだけで実装できる。**

| 用途 | 使うもの |
|---|---|
| Central クライアント一覧 | `central_get_clients(site_id)` |
| Central クライアント単体(サイト不明でも可) | `central_find_client(mac_address)` |
| Central アプリトラフィック | `central_run_show_commands(serial, ["show dpi-stats session"])` |
| Central クライアントイベント | `central_get_events(site_id, context_type="WIRELESS_CLIENT", context_identifier=mac)` |
| Mist クライアント現況 | `get_mist_stats("site_wireless_clients", site_id, object_id=<mac>)` |
| Mist クライアント検索 | `search_mist_data("wireless_clients", filters:{mac})` / 横断は `find_mist_entity` |
| Mist アプリトラフィック | `get_mist_insights("insight_metrics", site_id, params:{object_type:"client", metric:"top-app-by-bytes", mac})` |
| Mist RF 時系列 | 同上 `metric:"client-rf-metrics"` + `interval` |
| Mist クライアントイベント | `search_mist_data("wireless_client_events", filters:{mac})` |

なお Global Overview は MCP ではなく**直接 REST**(`plugins/global-overview/central-client.ts` /
`mist-client.ts`)を叩いている。本タブをどちらに寄せるかは §5 の未確定 #4。

---

## 2. Task 2: Device 向けデータの取得可能性

### 2-1. Central: AP / スイッチ / ゲートウェイ

| 見せたい情報 | 手段 | 取れる形 |
|---|---|---|
| インベントリ(一覧) | `central_get_devices` / `central_get_aps` / `central_get_switches` / `central_get_gateways` | `serial_number` / `mac_address` / `device_type` / `model` / `part_number` / `name` / `status` / `is_provisioned` / `deployment` / `tier` / `firmware_version` / `site_id` / `site_name` / `device_group_name` / `ipv4` / `stack_id`。**ステータス値の大文字小文字がデバイス種別で違う**(AP は `ONLINE`/`OFFLINE`、スイッチ・ゲートウェイは `Online`/`Offline`)ので、フィルタ時に注意 |
| AP の稼働状況 | `central_get_ap_details(serial)` | `cpu_utilization` / `memory_utilization` / `client_count` / `uptime_in_millis` / `last_reboot_reason` / `firmware_version` / `ipv4` / `public_ipv4` / `default_gateway` / `country_code` / `negotiated_power`(`802.3at` 等)/ `current_uplink_in_use` / `band_selection` / `mode` / `mesh_role` |
| AP の無線(現在値) | 同上 `radios[]`(`include:["radios"]` で詳細化) | `band` / `bandwidth` / `channel` / `channel_quality` / **`channel_utilization`** / `rx_utilization` / `tx_utilization` / `noise_floor` / **`non_wifi_interference`** / `client_count` / `power` / `retries` / `drops` / `channel_change_count` / `power_change_count` / `status` |
| AP の有線ポート | 同上 `ports[]` | `name` / `status` / `speed` / `duplex` / `connector` / `vlan_mode` / `access_vlan` / `allowed_vlan` / `native_vlan` |
| AP の時系列 | `central_get_ap_trends(serial, metric, scope)` | `scope="ap"`: throughput / cpu-utilization / memory-utilization / power-consumption。`scope="radio"`: throughput / channel-utilization / channel-quality / noise-floor / frames。`scope="port"`: throughput / frames / crc / collisions。**長い窓では値の無いサンプルが混ざる**とツール定義に明記あり |
| スイッチ | `central_get_switches`(`switchTrends` を 1 件埋め込み)/ `central_get_switch_details(serial, include:[...])` | include で `interfaces`(ポート状態・速度・PoE・LLDP 隣接)/ `vlans` / `poe`(割当)/ `lag` / `vsx` / `stack_members` / `hardware`(CPU・メモリ・温度・ファン・電源)。時系列は `central_get_switch_trends`(`hardware` は CPU/メモリ/温度/PoE 供給・消費/総消費電力、`interface` は rx/tx bytes と各種エラーカウンタ) |
| ゲートウェイ | `central_get_gateway_details(serial, include:[...])` / `central_get_gateway_trends` | ports / tunnels / uplinks / vlans。トレンドは cpu / memory / hardware-temperature ほか。**WAN/VPN プローブ未設定だと `-1` が返る**とツール定義に明記あり |

### 2-2. Mist: AP / スイッチ / ゲートウェイ

**一覧(`get_mist_stats("org_devices")` / `search_mist_data("devices")`)は薄い。**
`id` / `mac` / `model` / `name` / `serial` / `site_id` / `status` / `type` / `uptime` / `version` / `ip` / `last_seen` 程度。

**単体(`get_mist_stats("site_devices", site_id, object_id=<device UUID>)`)が本命で、情報量は Central を上回る。**
実測で確認できた主なもの:

| 分類 | 項目 |
|---|---|
| 稼働 | `cpu_util` / `cpu_system` / `cpu_user` / `mem_total_kb` / `mem_used_kb` / `uptime` / `version` / `status` / `last_seen` / `num_clients` / `num_wlans` |
| **帯域別 RF**(`radio_stat.band_24` / `band_5` / `band_6`) | `channel` / `bandwidth` / `power` / `noise_floor` / `num_clients` / `num_wlans` / **`util_all`** / **`util_non_wifi`** / `util_rx_in_bss` / `util_rx_other_bss` / `util_tx` / `util_unknown_wifi` / `util_undecodable_wifi` / `tx_bytes` / `rx_bytes` / `tx_pkts` / `rx_pkts` |
| 有線ポート(`port_stat.<if>`) | `up` / `speed` / `full_duplex` / `rx_bytes` / `tx_bytes` / `rx_pkts` / `tx_pkts` / `rx_errors` / `rx_peak_bps` / `tx_peak_bps` |
| **PoE / 上流**(`lldp_stat`) | `power_draw` / `power_allocated` / `power_requested` / `power_request_count` / 上流スイッチの `system_name` / `chassis_id` / `port_id` / `system_desc`。加えて `power_src`(`LLDP` 等)/ `power_budget` / `power_constrained` |
| **環境センサ**(`env_stat`) | `ambient_temp` / `cpu_temp` / `humidity` / `pressure` / 加速度・地磁気 |
| RADIUS(`radius_stat[]`, BSSID 別) | `accessAccepts` / `accessRejects` / `accessChallenges` / `requests` / `timeouts` / `roundTripTimeMs` / `badAuthenticators` / `packetsDropped` |
| 保守 | `auto_upgrade_stat`(予定バージョン・実施時刻)/ `fwupdate`(進捗・結果)/ **`cert_expiry`** / `expiring_certs` / `config_reverted` / `last_config_status` |
| 設置 | `map_id` / `x` / `y` / `x_m` / `y_m` / `orientation` / `mount` / `notes` / 画像 URL 3 種 |
| その他 | `ip_stat`(IP/GW/DNS/DHCP サーバ)/ `ble_stat` / `lacp_stat` / `ext_ip` |

- スイッチ個体は `search_mist_data("devices", filters:{device_type:"switch"})` で
  `model` / `version` / `uptime` / `num_members` / `clustered` / `last_config_status` /
  **`last_trouble_code`** / `time_drifted` / `radius_stats`(サーバ別 up/down)/ `evpn_missing_links` が取れる。
- **ポートは org 横断で一気に取れる**: `get_mist_stats("org_ports")` が
  `mac`(スイッチ)/ `port_id` / `up` / `active` / `speed` / `full_duplex` / **`poe_on`** /
  `rx_bytes` / `tx_bytes` / `rx_bps` / `tx_bps` をカーソルページングで返す(実測 org 全体で 324 ポート)。
  Device ビューのポート一覧はこれ 1 本でまかなえる。

### 2-3. Device データ対比表

| 見せたい情報 | Central | Mist |
|---|:--:|:--:|
| CPU / メモリ | ✓ (`cpu_utilization` / `memory_utilization` = %) | ✓ (`cpu_util` = % / `mem_total_kb`・`mem_used_kb` = **実量**。%は自前計算) |
| 稼働時間 | ✓(ミリ秒) | ✓(秒) |
| ファーム世代 | ✓ (`firmware_version`) | ✓ (`version`) |
| チャネル利用率 | ✓(無線単位・合計 + rx/tx 別) | ✓(帯域別・**Wi-Fi / 非 Wi-Fi / 自 BSS / 他 BSS に分解**。Mist の方が細かい) |
| 送信電力 | ✓ | ✓ |
| 接続クライアント数 | ✓(AP 全体・無線別とも) | ✓(AP 全体・帯域別とも) |
| ノイズフロア / 干渉 | ✓ (`noise_floor` / `non_wifi_interference`) | ✓ (`noise_floor` / `util_non_wifi`) |
| ポート状態 | ✓(AP・スイッチとも) | ✓(AP は `port_stat`、スイッチは `org_ports`) |
| **PoE 使用量** | ✓(スイッチ `switchTrends` の PoE 供給/消費、AP は `negotiated_power`) | ✓(AP 側で **実消費 `power_draw` と割当 `power_allocated` の両方**) |
| 上流スイッチ(LLDP 隣接) | △(スイッチの `interfaces` に隣接情報) | ✓(AP から上流スイッチ名・ポートまで直接) |
| 温度 | ✓(スイッチ `hardware` / ゲートウェイ `hardware-temperature`) | ✓(AP の `env_stat.ambient_temp`) |
| 証明書期限 | ✗ | ✓ (`cert_expiry`) |
| RADIUS 統計 | △(`show ap debug radius-statistics` 経由) | ✓(API で BSSID 別) |
| 時系列トレンド | ✓(AP / スイッチ / ゲートウェイ専用の trends API) | ✓ (`insight_metrics` の `cpu` / `memory` / `bytes` / `ap-rf-metrics` 等) |

### 2-4. 既存タブとの重複と再利用可否

| 既存 | 取っているもの | 本タブとの関係 |
|---|---|---|
| **Global Overview**(`plugins/global-overview/`) | 直接 REST で `sites-health` / `devices` / `clients` の**サイト単位サマリ**。デバイスは種別と台数・オンライン数中心 | **重複しない。**個体の CPU/RF/ポートは持っていない。ただし**サイト一覧と site_id の解決**は再利用価値があり、`data/global-overview/snapshot.json` のスナップショットからサイト名↔ID を引ける |
| **ベストプラクティス診断**(51、`plugins/best-practice/`) | `show running-config` 等の**設定値**(SSID 暗号方式・RF プロファイル・WIDS)。`collect-central.ts` / `collect-mist.ts` | **重複しない。**あちらは「設定がどうなっているか」、本タブは「今どう動いているか」。ただし `collect-central.ts` の **show コマンド実行の組み立て・失敗時の扱い**は DPI 収集でそのまま参考にできる |
| **レポート**(41〜45) | 日次/週次/月次の集計と保存(`data/reports/`) | 重複しない。**日次収集の枠組み**(`plugins/reports/collect.ts` / `store.ts`)は、Central DPI に履歴が無い問題(§1-2 の制約 2)を自前で埋める場合の下敷きになる |
| **ネットワーク調査**(`plugins/network-investigation/`) | MCP 経由の LLM 調査 | 重複しない。タグ付き対象から「この端末を調査する」で**既存の調査キュー**(`src/shell.tsx` の `InvestigationRequest`)に投げる導線が作れる |
| レート制限 | `plugins/global-overview/rate-limit.ts`(Central はアカウント全体 10 req/s、自主規制 4 req/s) | **必ず再利用する。**本タブは個体単位の呼び出しが増えるので、ここを通さないと他タブを巻き込んで詰まる |

---

## 3. Task 3: タグ機構の設計

### 3-1. 永続化方式

既存プラグインの慣習(`data/<plugin>/*.json`、一時ファイル → `rename` の原子的書き込み)にそのまま合わせる。

```
data/tagged-targets/
  tags.json         … タグ定義 + 付与状態(1 ファイル)
  settings.json     … 表示件数・キャッシュ TTL 等
```

**1 ファイルにまとめる根拠**: ナレッジタブ(46)と同じ判断。想定件数が数十〜数百で、
かつ**常に全件を横断して絞り込む**使い方しかしないため、日付や対象種別で割る利が無い。

```jsonc
{
  "version": 1,
  "updatedAt": "<ISO8601>",
  "tags": [
    { "id": "<uuid>", "name": "<表示名>", "color": "<パレット名>",
      "description": "<任意>", "createdAt": "<ISO8601>" }
  ],
  "assignments": [
    {
      "kind": "client",              // "client" | "device"
      "key": "<正規化 MAC 12 桁>",    // 正準キー(§3-2)
      "serial": null,                // device のみ。Central 引きに使う
      "tagIds": ["<uuid>", "..."],   // 複数タグ可
      "label": "<ユーザーが付けた覚え書き名。任意>",
      "note": "<自由記述。任意>",
      "lastSeen": {                  // 突合の手がかり(キーではない)
        "platform": "central",       // "central" | "mist" | null
        "siteId": "<id>", "siteName": "<name>",
        "at": "<ISO8601>"
      },
      "addedAt": "<ISO8601>"
    }
  ]
}
```

- **`lastSeen` は非正準**。デバイスがサイト移設されたりクライアントが別プラットフォーム配下に
  移っても、キー(MAC)が同じならタグは追従する。`lastSeen` は「次に探しに行く先のヒント」と
  「見つからないときの最後に見た場所の表示」にだけ使う。
- タグ削除時は `tags` から消し、全 `assignments` の `tagIds` から掃除する(参照の孤児を残さない)。

### 3-2. 対象識別子 — Central / Mist をまたいで同じ対象に同じタグを付ける

**Client = 正規化 MAC を正準キーにする。**

| プラットフォーム | 実際の表記 | 正規化 |
|---|---|---|
| Central | `xx:xx:xx:xx:xx:xx`(コロン区切り・小文字) | `toLowerCase()` して `[^0-9a-f]` を除去 → 12 桁 |
| Mist | `xxxxxxxxxxxx`(区切りなし・小文字) | 同上(実質そのまま) |

表示は既存 UI の見やすさに合わせてコロン区切りに戻す。**保存は常に 12 桁**。

**Device = MAC を正準キーにし、シリアルを併記して持つ。**

理由は**引き方が逆だから**:

- Central のデバイス系ツールは**すべてシリアル引き**(`central_get_ap_details(serial_number)` /
  `central_get_switch_details(serial_number)` / `central_run_show_commands(serial_number)`)。
- Mist のデバイス系は**MAC / デバイス UUID 引き**(`object_id`、`filters:{mac}`)。

幸い**どちらのプラットフォームも両方の値を返す**(Central の `central_get_devices` に `mac_address`、
Mist の `search_mist_data("inventory")` / `org_devices` に `serial`)。
そこで `key` に正規化 MAC、`serial` に Central 用シリアルを保存し、**呼ぶ API に応じて使い分ける**。
`serial` が空のまま Central 側で必要になったら、`central_get_devices` で MAC から解決して埋め戻す。

**プラットフォームをキーに含めない**のが要点。同じ MAC のデバイスが両方に見えることは実運用では無いが、
「Central 管理 → Mist 管理へ移行」のようなケースでタグを引き継げる。

### 3-3. タグの付け方(UI 操作)

1. **付与の入口を 3 つ用意する**(タグを付けるためだけに専用画面へ行かせない):
   - 本タブの一覧から「対象を追加」→ MAC / ホスト名 / シリアルで検索して選ぶ
     (検索は Central `central_find_client` + Mist `find_mist_entity` の**両方に投げて結果を統合**。
     `find_mist_entity` は MAC・IP・ホスト名プレフィックスを横断検索できるのでこの用途に合う)
   - 既存の Global Overview のサイト詳細・クライアント一覧の行から「タグを付ける」
   - ネットワーク調査の結果に出てきた対象から「タグを付ける」
2. **複数タグ**: 1 対象に N タグ。付与 UI はチップの複数選択 + その場で新規タグ作成。
3. **削除・編集**:
   - タグ定義の改名・色変更は `tags[]` を書き換えるだけで、付与済みへ即反映(`tagIds` は uuid 参照)。
   - タグ定義の削除は**確認ダイアログで「N 件の対象から外れます」と件数を出す**。
   - 対象そのものの登録解除は行のメニューから。
4. **文言はすべて `src/i18n/ja.json` / `en.json` の両方に追加する**(CLAUDE.md の規約)。
   タグ名・覚え書き・ノートは**ユーザーが入力した実行時データなので翻訳しない**
   (CLAUDE.md「実行時の記録として残る文言は翻訳しない」に該当)。

### 3-4. タグと実データの突合方式(性能)

**結論: 「タグ付き対象だけを個別に問い合わせる」を基本とし、件数が増えたらサイト一括に切り替える二段構え。**

理由 — 全件取得の一括突合は Central では**そもそも成立しない**。
Central にはクライアントの org 横断一覧が無く、`central_get_clients` は `site_id` 単位。
サイト数ぶんループすれば「タグ 3 件のために全サイトを舐める」ことになる。

| 局面 | 方式 | 呼び出し回数 |
|---|---|---|
| タグ付き **Client** の一覧(基本情報のみ) | N ≤ 閾値: `central_find_client(mac)` / Mist `find_mist_entity` を**対象ごとに 1 回** | N |
| 同上・N > 閾値 | `lastSeen.siteId` でグルーピングし、**サイトごとに 1 回** `central_get_clients(site_id)` / `get_mist_stats("site_wireless_clients", site_id)` してメモリ上で MAC 突合 | サイト数 |
| タグ付き **Device** の一覧 | Central は `central_get_devices()` **1 回**で org 全体が返るのでこれを使う。Mist は `get_mist_stats("org_devices")` **1 回** | 2 |
| Device の詳細 | 開いた 1 台だけ `central_get_ap_details` / `get_mist_stats("site_devices", object_id)` | 1 |
| **Client のアプリトラフィック(Mist)** | 開いた 1 台だけ `insight_metrics` | 1 |
| **Client のアプリトラフィック(Central)** | **一覧では絶対に取らない。**詳細を開いたときだけ、その client の `connected_device_serial` に対して `show dpi-stats session` を 1 回 | 1(遅い) |

**閾値の初期値は 10 件**を提案する(N=10 なら個別引きのほうがサイト全舐めより確実に軽い)。
`settings.json` で変えられるようにしておき、実測してから調整する。

**キャッシュ**: 種類ごとに TTL を変える。
- 現況(RSSI・接続先・オンライン状態): **60 秒**
- Device 詳細: **60 秒**
- アプリトラフィック: **5 分**(Mist は期間集計なので頻繁に変わらない。Central は show 実行が高コスト)
- 明示的な「更新」ボタンを必ず置き、キャッシュを無視して取り直せるようにする。

**レート制限**: `plugins/global-overview/rate-limit.ts` を必ず経由する(§2-4)。

### 3-5. 設計上の最大リスク: ランダム MAC

iOS / Android / Windows のプライベートアドレスは**SSID ごと・定期的に変わる**。
MAC をキーにする以上、**タグは黙って無効になる**。

- 検出は可能: Mist は `random_mac: true`、Central は `manufacturer: "Private"`
  (実データでも Apple / Google 端末がこの値になっていた)。
- **設計方針**: タグ付与時にランダム MAC と判定できたら、**その場で警告を出す**
  (「この端末はランダム MAC を使用しています。MAC が変わるとタグが外れます」)。
  黙って登録して後から行方不明にするより、登録時に伝えるほうが親切。
- 補助キーとして `username`(802.1X)や Mist の `psk_name` を**表示用に併記**しておくと、
  タグが外れたときにユーザーが同じ端末を見つけ直しやすい。
  **これらをキーにはしない**(未認証・PSK 共有で一意にならないため)。
- 「見つからない対象」は一覧から消さず、**`lastSeen` を添えて灰色で残す**。
  勝手に消すと、ユーザーはタグを付けたこと自体を忘れる。

---

## 4. Task 4: 画面構成の設計方針(実装はしない)

### 4-1. Client ビューと Device ビューの分け方

**新規独立タブ 1 枚 + タブ内サブビュー切替**を採る。

- `src/main.tsx` の `TABS` に 1 件追加(例: `{ id: "tagged-targets", key: "tabs.taggedTargets" }`)。
  既存 8 タブに対して**2 枚追加すると横幅が厳しい**ので 1 枚に収める。
- タブ内の最上部に **Client / Device のセグメント切替**。選択は `localStorage`(既存の `mnd-tab` と
  同じ流儀で `mnd-tagged-view` 等)に保存し、タブを離れても戻ってくる。
- タグフィルタ(チップの複数選択)は Client / Device で**共有**する。
  同じタグ(例: 重要拠点)が両方に付いている運用を想定するため。

```
┌───────────────────────────────────────────────────────────────┐
│ [概要][イベント][Webhook][Streaming][レポート][ナレッジ][調査][診断][タグ] │
├───────────────────────────────────────────────────────────────┤
│  ( ● クライアント )( ○ デバイス )          [+ 対象を追加] [更新] │
│  タグ: (すべて)(役員端末 3)(検証用 5)(重要 AP 2)   [タグを管理]  │
├───────────────────────────────────────────────────────────────┤
│ 名前          MAC        タグ      接続先      状態    最終確認  │
│ ─────────────────────────────────────────────────────────── │
│ ▸ <端末A>    xx:..:xx   [役員端末] <AP名>  ● 接続中  2 分前   │
│ ▸ <端末B>    xx:..:xx   [検証用]   <AP名>  ● 接続中  1 分前   │
│ ▸ <端末C>    xx:..:xx   [役員端末] —       ○ 未検出  3 日前   │
└───────────────────────────────────────────────────────────────┘
```

行を展開(▸)すると詳細。**別ページに飛ばさない**(タグ横断の一覧に戻る操作が主になるため)。

### 4-2. Client 詳細 — アプリケーショントラフィックの見せ方

```
┌─ <端末A>  xx:xx:xx:xx:xx:xx  [役員端末] [検証用]  (Mist / <サイト>) ─┐
│                                                                     │
│ ┌─ 基本情報 ────────┐ ┌─ 接続品質 ─────────────────────┐ │
│ │ ホスト名  <name>    │ │  RSSI  -52 dBm   SNR  38 dB       │ │
│ │ OS/種別   <os>      │ │  ┌───────────────────────────┐  │ │
│ │ IP/VLAN   <ip>/<n>  │ │  │  RSSI 推移(24h・折れ線)   │  │ │
│ │ 接続先AP  <ap>      │ │  └───────────────────────────┘  │ │
│ │ SSID/帯域 <ssid>/6G │ │  ※ Central の対象は「取得不可」と表示 │ │
│ │ 認証      dot1x     │ └───────────────────────────────────┘ │
│ └─────────────────┘                                          │
│                                                                     │
│ ┌─ アプリケーション別トラフィック(直近 24 時間 / Mist) ─────────┐ │
│ │  OfficeApp        ████████████████████████  261 MB           │ │
│ │  不明(Unknown)   █████████████             133 MB           │ │
│ │  ビデオ会議        ████████                  85 MB           │ │
│ │  Microsoft        ███                        26 MB           │ │
│ │                                    [上位 10 件を表示 ▾]       │ │
│ │  取得元: Mist insight_metrics / 期間合計(時系列は非対応)    │ │
│ └───────────────────────────────────────────────────────────┘ │
│                                                                     │
│ [このクライアントを調査する]  [タグを編集]  [登録を解除]            │
└─────────────────────────────────────────────────────────────────┘
```

**Central の対象を開いた場合はこのブロックの中身が変わる**(データの出自が違うことを隠さない):

```
┌─ アプリケーション別トラフィック(現在のセッション / Central DPI) ──┐
│  ms-teams        ████████████  … TX/RX 別に表示                  │
│  ─────────────────────────────────────────────────────────  │
│  Web カテゴリ / レピュテーションの内訳(Central のみ取得可)       │
│  取得元: <AP名> の DPI セッションテーブル(スナップショット)      │
│  ※ 履歴は保持されません。表示は取得時点の値です。      [取得する] │
└───────────────────────────────────────────────────────────────┘
```

設計上の判断:

- **Central のブロックは「取得する」ボタンで明示的に発火させる。** show コマンド実行が遅く、
  詳細を開いただけで毎回走らせるのは体験が悪い。
- **2 プラットフォームのアプリ名を混ぜない**(§1-5)。ヘッダに取得元と期間を必ず書く。
- **有線クライアント / Central のクライアント品質**など取れない箇所は、
  空欄ではなく**「このプラットフォームでは取得できません」と理由込みで表示**する
  (28/33 番で確立した「取得不可を明示する」方針の踏襲)。

**コンポーネント再利用の可否**:

| 使いたいもの | 再利用可否 |
|---|---|
| `recharts`(依存に既存: `^3.10.0`) | ✓ そのまま使える。横棒は `BarChart` + `layout="vertical"` |
| `plugins/network-investigation/view/Chart.tsx` | **△ そのままは使わない。**これは LLM 回答内の ```chart ブロックを描く専用で、`{label, value}` の単純形しか受けない。アプリ別 rx/tx の 2 系列や単位整形に合わない。**ただし「全系列でアニメーションを無効化する」規約(04b、印刷・共有クローン対策)は必ず踏襲する** |
| `plugins/reports/view/Trends.tsx` | ✓ **時系列折れ線の書き方の下敷きとして良い。**RSSI 推移はこの構造をなぞる |
| `src/i18n/format.ts` の `formatDateTime` / `formatNumber` / `formatRelative` | ✓ **必ず使う。**「2 分前」「最終確認」はここ。`toLocaleString("ja-JP")` を書かない(CLAUDE.md) |
| バイト数の整形(`261 MB` 等) | **新規。**`format.ts` に `formatBytes(n, lang?)` を足すのが筋。単位記号は日英共通で、桁区切りだけロケール依存 |

### 4-3. Device 詳細

```
┌─ <AP名>  (Central / <サイト>)  [重要AP]   ONLINE  稼働 237 日 ─────┐
│ ┌─ 稼働 ──────────┐ ┌─ 無線 ─────────────────────────┐ │
│ │ CPU     19 %      │ │ 帯域  ch   幅    出力  利用率  クライアント │ │
│ │ メモリ  55 %      │ │ 5GHz  48E  80MHz  16   7 %     6 台      │ │
│ │ ファーム <ver>    │ │ 6GHz  85S  160MHz 16   2 %     1 台      │ │
│ │ 電源    802.3at   │ │ ノイズ -89/-84 dBm  非Wi-Fi干渉 2/1      │ │
│ └───────────────┘ └───────────────────────────────┘ │
│ ┌─ 有線ポート ───────────────────────────────────────┐ │
│ │ eth0  UP    1000 Full  Trunk   / eth1  DOWN  …               │ │
│ │ (スイッチの場合) ポート状態・PoE 供給量・VLAN・LLDP 隣接      │ │
│ └───────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

- **AP / スイッチ / ゲートウェイで出す枠を変える**(無線の枠はスイッチには出さない)。
- Mist の AP は Central に無い項目(証明書期限・PoE 実消費 vs 割当・上流スイッチ名・筐体温度・
  RADIUS 統計)を持つので、**プラットフォームごとに項目が増減するのを許容する設計にする**。
  「両者の共通部分だけ出す」と Mist の情報量を捨てることになる。
- 時系列(CPU / チャネル利用率)は**第 2 段階**に回してよい。初回は現在値で足りる。

### 4-4. 今回作らないもの(実装は 58 番以降)

- コード変更は一切していない。上記はすべて設計方針とワイヤーフレームのみ。

---

## 5. 未確定事項(58 番以降で解く)

| # | 事項 | 現状 | 次にやること |
|---|---|---|---|
| 1 | **Mist のスイッチ配下アプリ可視化** | `top-flow-by-app` は定数定義上 `scopes:["device"]` / `device_type:["switch"]` だが、`object_type="switch"` でも `"gateway"` でも MCP が `metric not found` を返した。`top-app-by-bytes` も `object_type="switch"` は不可 | MCP の `object_type` → scope マッピングを読むか、REST を直接叩いて確認する。**有線のアプリ可視化を諦めるかどうかがここで決まる** |
| 2 | **Mist のアプリ可視化のライセンス要件** | 今回の org では `top-app-by-bytes`(client / ap)も `client-rf-metrics` も**実際に値が返った**。ただし `client-rf-metrics` の定義には **"SUB-VNA required"** と明記されている。`troubleshoot` は **Marvis 必須**と定義に明記 | 別ライセンス構成の org で、権限不足時に**エラーになるのか空配列が返るのか**を確認する。UI の「取得不可」表示の出し分けに直結する |
| 3 | **Central DPI の有効化前提** | 実測 AP では DPI が動いていた(`Classication percentage: 100`)。DPI 無効の AP で `show dpi-stats session` が何を返すかは**未確認** | DPI 無効な AP で叩き、空表かエラーかを確認して分岐を決める。`show dpi debug status` がカタログにあるので、事前チェックに使えるか併せて見る |
| 4 | **MCP 経由か直接 REST か** | Global Overview は直接 REST、ベストプラクティス診断は MCP と分かれている。本タブは Mist 側が `insight_metrics` 頼みで、MCP のほうが記述量は少ない | 実装着手時に決める。**Central の DPI だけは `central_run_show_commands`(MCP)一択**なので、少なくとも Central 側は MCP 依存になる |
| 5 | **Central のクライアント品質の代替** | RSSI/SNR が API に無い。`show ap debug client-stats {{mac}}` はテンプレート引数で叩けない | `show clients` / `show clients debug advanced`(引数なし・カタログにあり)の出力に RSSI/SNR が含まれるか確認する。含まれれば AP 単位 1 回で全クライアント分が取れて効率も良い |
| 6 | **アプリトラフィックの履歴保持** | Central はスナップショットのみ、Mist は期間合計のみ(client スコープでは時系列不可) | 「タグ付き対象だけを定期取得して `data/tagged-targets/` に貯める」を作るかどうか。作るならレポート(41)の日次収集の枠組みを流用する。**初回リリースには入れない**方針を提案 |
| 7 | **タグ付与の閾値 10 件** | 根拠は推定。実測していない | 実装後に N を変えて計測し、`settings.json` の既定値を決め直す |
| 8 | **`formatBytes` の追加** | `src/i18n/format.ts` に無い | 33 番の方針(整形は format.ts に集約)に沿って追加する。日英で単位記号は共通、桁区切りのみロケール依存 |

---

## 6. 実施内容の記録

- コード変更なし・git 操作なし・Central / Mist の設定変更なし(いずれも指示どおり)。
- 実行したのは**読み取り専用の API / show コマンドのみ**。`central_run_show_commands` は
  `show dpi*` 系と存在しないコマンド 1 件(カタログ取得目的)だけで、設定変更コマンドは実行していない。
- 本ファイルに実データ(サイト名・MAC・シリアル・org_id / site_id・IP・SSID 名)は記載していない。
