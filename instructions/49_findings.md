# 49: ベストプラクティス診断 — 調査結果とチェックルール設計

実施日: 2026-08-02 / 対象: 調査・設計のみ(コード実装なし・git 操作なし)

> **50 番による訂正あり。** §1-3(PMF の出力形式)・§3-3 の SEC-04 / SEC-05・§4-3(AOS8)・
> §5 の追加調査 #2 / #3 は `instructions/50_findings.md` で更新されている。
> PMF 関連を読むときは 50 番を優先すること。

このドキュメントは 50 番以降の実装(タブ UI・収集処理・判定エンジン)の前提になる。
**実際の設定値そのもの(サイト名・SSID 名・チャネル・鍵・シリアル)は記載しない。**
記録するのは「取得可否」「項目の構造」「判定ロジック」だけ。

---

## 0. 要約

| | 結果 |
|---|---|
| Central: 取得できた設定項目 | SSID 暗号方式 / PMF(opmode から確定的に導出) / WIDS 検知・保護(封じ込め含む) / 無線プロファイル(チャネル幅・Tx 電力・許可チャネル・スキャン) / ARM 設定(AOS 8) / SSID の帯域・レート・802.11k・OKC・ブロードキャストフィルタ |
| Central: 取得できなかった項目 | AirMatch のサービス設定(AOS 10 で該当 show コマンドを特定できず) / 静的チャネル・電力割当の明示フラグ / グループ・サイト単位の config(デバイス単位の show でしか取れない) |
| Central の取得手段 | **`central_run_show_commands`(MCP)が主**。既存の `central_get_wlans` / REST `network-monitoring/v1/*` は監視系のみで設定値を持たない |
| Mist Marvis Actions | 実出力を確認。この org には **switch / ap カテゴリのみ**存在し、**セキュリティ・RF 系のアクションは 0 件**。設定ベストプラクティス診断は Marvis Actions ではカバーされない |
| 設計したチェックルール | セキュリティ **13 件**(機械判定 11 / LLM 所見 2)、RF **14 件**(機械判定 12 / LLM 所見 2)。うち Mist 側で同一ロジックを適用できるものが 8 件 |

---

## 1. Task 1: Central 側で取得可能な設定項目

### 1-1. 既存の 2 経路は「設定」を持っていない

| 経路 | 実体 | 設定値を取れるか |
|---|---|---|
| `central_get_wlans`(MCP) | `network-monitoring` 系 | ✗ 返るのは `wlan_name` / `security_level` / `security`(表示用文字列)/ `band` / `status` / `vlan` のみ。PMF・レート・帯域制限などは無い |
| `central_get_ap_details`(MCP) | 同上 | △ `radios[]` に **実際の**チャネル・`bandwidth`・`power`・`channel_change_count` / `power_change_count` が入る。**設定値ではなく現在値** |
| Global Overview の直接 REST(`plugins/global-overview/central-client.ts`) | `network-monitoring/v1/sites-health` / `/devices` / `/clients` | ✗ 監視専用。設定 API は叩いていない |

→ **設定診断は `central_run_show_commands` に依存する。** これが今回の最大の発見。

### 1-2. `central_run_show_commands` で取得できた項目(実測)

AOS 10 の AP(AP-505H / 10.8.1.0)と AOS 8 の Instant クラスタ(AP-225 / 8.6.0.23)で実行して確認した。

| # | 診断したい項目 | 取得可否 | コマンド | 取れる形 |
|---|---|:--:|---|---|
| 1 | SSID の暗号化方式 / セキュリティモード | ✓ | `show running-config` | `wlan ssid-profile <name>` 配下の **`opmode <mode>`**。値は `wpa3-sae-aes` / `wpa3-aes-ccm-128` / `wpa2-aes` / `enhanced-open` / `wpa3-cnsa` 等 |
| 1' | 同上(一覧形式・軽量) | ✓ | `show network` | 表形式で `Profile Name / ESSID / Type / Band / Authentication Method / Key Management / IP Assignment / Status`。Key Management に `WPA3-SAE` / `WPA3-AES-CCM-128` / `WPA2-AES` が入る |
| 2 | 802.11w(PMF)の有効・無効・必須 | ✓(導出) | `show running-config` | **単独のフィールドは存在しない。** `opmode` + 帯域 + transition mode から公式ドキュメントの decoder ring で MFPR/MFPC が一意に決まる(§1-3)。WPA2 系のみ `mfp-capable` / `mfp-required` が ssid-profile 配下に**任意行として**現れる |
| 3 | WIDS/WIPS 不正 AP **検知**設定 | ✓ | `show ids-detection config` | `infrastructure detection level` / `client detection level`(`off` / `low` / `medium` / `high`)+ 個別ポリシー約 45 種の `Status`(enable/disable)とレベル別の既定値表 |
| 4 | WIDS/WIPS **封じ込め**設定 | ✓ | `show ids-protection config` | `Wireless Containment` / `Wired Containment` / `Wired Containment AP Adjacent MAC` / `Wired Containment Suspect Layer3 Rogue` / `infrastructure protection level` / `client protection level` + 個別ポリシー(`protect-ssid` / `rogue-containment` / `protect-ap-impersonation` / `protect-adhoc-network` / `protect-wifi-direct-p2p-groups` / `protect-valid-sta` / `protect-windows-bridge`) |
| 4' | 同上(要約) | ✓ | `show running-config` | `ids` セクションに `wireless-containment <mode>` |
| 5 | ARM の有効・無効状態(**AOS 8 のみ**) | ✓ | `show arm config` | `Scanning` / `Client Aware` / `Client Match` / `Band Steering Mode` / `Wide Channel Bands` / `80Mhz Support` / `160Mhz Support` / `Air Time Fairness Mode` / `Minimum(Maximum) Transmit Power` / `Aggressive Scan` / `Custom Channels` / 帯域別の許可チャネル表 |
| 5' | AirMatch の有効・無効状態(**AOS 10**) | **✗** | — | `show arm config` は **`% Parse error.`**。`show ap debug airmatch {{option}}` はコマンドカタログ上テンプレート引数付きで登録されており、`config` 等を入れても validator を通らなかった。§1-5 参照 |
| 6 | 静的チャネル/電力の手動設定の有無 | △ | `show running-config` | AP 単位の静的割当がある場合のみ設定行が現れる。**「設定が無い = 動的」を絶対値として断定できるかは未検証**(静的割当済みの機器で確認が必要)。代替として `central_get_ap_details` の `channel_change_count` / `power_change_count` が 0 のまま推移するかで補強できる |
| 7 | 2.4GHz 帯のクライアント利用可否 | ✓ | `show running-config` / `show network` | SSID 単位で `rf-band all` / `rf-band-6ghz` の有無、`show network` の `Band` 列(`all` / `2.4ghz,5ghz` 等)。無線単位の稼働状態は `central_get_ap_details` の `radios[].status`(UP/DOWN) |
| 8 | チャネル幅の設定 | ✓ | `show radio config` | 帯域ごと(2.4 / 5.0 / Secondary 5.0 / 6.0 / Secondary 6.0)に `Max channel bandwidth` / `Min channel bandwidth` |
| 8' | 同上(config 側) | ✓ | `show running-config` | `rf dot11a-radio-profile` の `ch-bw-range 20MHz 160MHz` 等。**2.4GHz は既定 20MHz のとき行自体が出ない** |
| 9 | Tx 電力の上下限 | ✓ | `show radio config` / `show running-config` | `Max Tx Power` / `Min Tx Power`(帯域別)、`rf dot11X-radio-profile` の `max-tx-power` / `min-tx-power` |
| 10 | 許可チャネルリスト | ✓ | `show radio config` / `show arm-channels` | `Allowed channels`(帯域別)/ チャネルごとの enable-disable 表(HT40 の `+`、80MHz の `E`、160MHz の `S` も含む) |
| 11 | 基本レート / 送信レート | ✓ | `show running-config` | SSID 単位の `a-basic-rates` / `a-tx-rates` / `g-basic-rates` / `g-tx-rates` |
| 12 | 802.11k / OKC / ブロードキャストフィルタ | ✓ | `show running-config` | SSID 単位の `dot11k` / `okc` / `broadcast-filter <arp\|none>` / `broadcast-filter-ipv6 unicast-router-advertisements` |
| 13 | Wi-Fi 6/7 機能の明示無効 | ✓ | `show running-config` / `show radio config` | SSID 単位の `extremely-high-throughput-disable`、無線単位の `HE/EHT MU-OFDMA` / `MU-MIMO` / `TxBF` |
| 14 | スキャン設定 | ✓ | `show radio config` | `Scanning-disable` / `Scan-interval` / `Aggressive-scan` / `Background Spectrum Monitor` / `Rogue AP Aware` |
| 15 | AP モデル・ファーム・サイト所属 | ✓ | `central_get_aps`(MCP) | `model` / `firmware_version` / `site_id` / `deployment` / `status`。show コマンド不要 |

### 1-3. PMF は「別項目」ではなく opmode から確定的に決まる(重要)

公式ドキュメントの記述を確認した。

> PMF is not user configurable for WPA3 or Enhanced Open security modes. MFPR (Required) and MFPC (Capable) configuration is automatic.
> — [Protected management frames](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/features/pmf/)

同ページの 3 状態の定義:

| 設定 | パラメータ | PMF 対応クライアント | 非対応クライアント |
|---|---|---|---|
| Disabled | MFPR=0 / MFPC=0 | 効果なし | 効果なし |
| Capable(任意) | MFPR=0 / MFPC=1 | 保護される | 効果なし |
| Mandatory(必須) | MFPR=1 / MFPC=1 | 保護される | **接続不可** |

[Security modes](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/) の decoder ring から、`opmode` → PMF の対応は以下のとおり確定できる。

| opmode | transition mode | 2.4/5GHz の PMF | 6GHz の PMF |
|---|---|---|---|
| `wpa3-sae-aes` | 有効 | MFPR=0 / MFPC=1 | MFPR=1 / MFPC=1 |
| `wpa3-sae-aes` | 無効 | MFPR=1 / MFPC=1 | MFPR=1 / MFPC=1 |
| `wpa3-aes-ccm-128` | 有効 | MFPR=0 / MFPC=1 | MFPR=1 / MFPC=1 |
| `wpa3-aes-ccm-128` | 無効 | MFPR=1 / MFPC=1 | MFPR=1 / MFPC=1 |
| `wpa3-aes-gcm-256` / `wpa3-cnsa` | — | MFPR=1 / MFPC=1 | MFPR=1 / MFPC=1 |
| `wpa2-aes`(`mfp-*` 行なし) | — | **MFPR=0 / MFPC=0** | 6GHz 不可 |
| `wpa2-aes` + `mfp-capable` | — | MFPR=0 / MFPC=1 | 6GHz 不可 |
| `wpa2-aes` + `mfp-capable mfp-required` | — | MFPR=1 / MFPC=1(実質 WPA3-Enterprise 相当) | 6GHz 不可 |

**この設計上の意味**: PMF チェックは「PMF フィールドを読む」のではなく「`opmode` を読んで上表を引く」。
`wpa2-aes` の SSID にだけ `mfp-capable` / `mfp-required` 行の有無を追加で見ればよい。

- 検証済み: WPA3 系 SSID の running-config には `mfp-*` 行が**出ない**(ドキュメントの記述と整合)
- ~~**未検証**: `mfp-capable` / `mfp-required` の出力形式~~
  → **50 番で確定。独立した 1 行**であり `opmode` の引数ではない。`instructions/50_findings.md` §1-3 参照
  (パーサは指示どおり「opmode 行の後続トークン」形式にもフォールバック対応済み)
- ~~**未検証**: WPA3 の transition mode 設定を running-config から読む方法~~
  → **50 番で解決。`opmode-transition` / `opmode-transition-disable` で読める**(既定は有効・
  既定値は出力されない)。SEC-05 は `unknown` 固定をやめ機械判定に格上げした。50 番 §1-5 参照

### 1-4. 取得できなかった項目・別手段が要るもの

| 項目 | 状況 | 影響と回避策 |
|---|---|---|
| **AirMatch のサービス設定**(coverage tuning / 展開スケジュール / 品質しきい値) | AOS 10 で該当 show コマンドを特定できず。`show arm config` は parse error | AirMatch は「無設定で動くのが既定」という公式方針([AirMatch](https://arubanetworking.hpe.com/techdocs/aos/aos10/services/airmatch/): "developed to operate with no user input")なので、**AirMatch そのものの設定は診断対象から外し、無線プロファイル側の制約(チャネル幅レンジ・Tx 電力レンジ・許可チャネル)を診る**方針にする |
| **グループ / サイト単位の config** | show コマンドはデバイス単位でしか実行できない | サイトごとに代表 AP を 1 台選んでサンプリングする(§4-2)。同一グループ内で設定が食い違うケースは検出できない旨を UI に明示する |
| **Rogue AP の分類結果**(valid / rogue / suspected の一覧) | 未確認。`show ap monitor {{option}}` / `show ids {{option}}` がカタログにあるがテンプレート引数の解決に失敗する | 設定診断のスコープ外とし、検知**結果**は既存の Event/Alert タブに委ねる |
| **AOS 8 と AOS 10 のコマンド差** | `show arm config` は AOS 8 のみ有効 | ファーム世代で分岐する(§4-3) |

### 1-5. 実装上の重大な注意点(3 つ)

#### (a) `show running-config` には機微情報が含まれる

実測した出力に以下が含まれていた。

- `virtual-controller-key <hex>`
- `hash-mgmt-user admin password hash <hash>`
- `wpa-passphrase <hex>`(SSID ごと)
- `wlan auth-server <name>` 配下の `key <hex>`(RADIUS 共有シークレット)
- `wlan gw-auth-server default` の `key <hex>`
- RADIUS サーバの IP アドレス・`nas-id`(UUID)

→ **CLAUDE.md の「実データ・機密情報のリポジトリ混入防止」に直結する。**
実装時は次を必須要件とする。

1. running-config の生テキストを**そのまま保存しない**。パース直後に破棄する
2. 保存するのは正規化済みの構造体(§3-2 の `observed`)のみ。鍵・パスフレーズ・ハッシュは
   構造体に**入れない**(`hasPassphrase: true` のような真偽値に落とす)
3. LLM に所見を出させる場合も、生 config ではなく正規化済み構造体だけを渡す
4. 診断結果の共有テキスト・印刷レイアウトにも同じ規約を適用する

#### (b) 未対応コマンドを 1 つでも混ぜると巨大なカタログが返る

`central_run_show_commands` に未対応コマンドを含めると、**そのデバイスの全 show コマンドカタログ(約 600 コマンド / 40KB 超)** がエラーメッセージとして返る。バッチ内の他のコマンドも実行されない。

→ 実装では、デバイスファミリごとに**使用するコマンドを固定のホワイトリストで持ち**、
動的に組み立てない。エラー応答は先頭 N 文字で切って保存する。

#### (c) 実行コストが高い

`central_run_show_commands` はデバイスへのコマンド投入 + ポーリング(既定 `max_attempts=10` / `poll_interval=15s`)。
1 コマンドあたり数秒〜数十秒。1 回のコールで最大 5 コマンド。
→ サイト全 AP に流すのは非現実的。**サイトごとに代表 1 台 + 日次バッチ**が前提(§4-2)。

---

## 2. Task 2: Mist Marvis Actions の出力確認

### 2-1. 呼び出しと応答の形

`get_mist_insights(insight_type="marvis_actions", org_id=...)` を実行。

- 応答は `{ count, insight_type, data: [...] }`。この org では **`count` = 50**
- `params.category="wireless"` を指定すると **0 件**(エラーではなく空配列)
- **時間範囲パラメータは受け付けない**(`start_time` / `end_time` / `duration` は非対応)

### 2-2. 1 アクションのフィールド構造(実測)

50 件すべてに存在するキー:

```
batch_count, category, details, duration, end_time, entity_id, entity_type,
impact_scope, org_id, prefix, row_key, self_drivable, severity, site_id,
snooze_expire_time, start_time, status, suggestion, suggestion_time,
symptom, unique_key, uuid
```

一部にのみ存在するキー:

```
display_entity_id / display_entity_type / is_discovered (45件)
suggestion_id / suggestion_number (46件)
resolve_time / validation_time (30件)
display_data / evidence (2件)
```

- `details` は症状ごとに形が変わる自由構造。共通するのは **`details.impacted_tuple[]`**(影響を受けた実体の配列)と `details.details_msg_in_ui`(UI 表示用の短文)
- `evidence[]` / `display_data.view_more[]` は `{ type: "table", title, columns: [{key,label}], rows: [...] }` という**表描画用の構造**。そのまま表に落とせる
- `status` は `open` / `validated`(= 修正済みとして検証された)
- `severity` は数値(実測はすべて 60)

### 2-3. 実際に出現したアクション種別

| category | symptom | 件数 | 内容 |
|---|---|---:|---|
| switch | `sw_offline` | 43 | スイッチのオフライン |
| switch | `misconfig_port` | 2 | ポート設定不一致(`mis_config_reason: ["mode"]`、trunk ↔ access の食い違い等) |
| ap | `ap_disconnect` | 5 | AP の切断(`disconnect_reason`、接続先スイッチ・ポートまで特定) |

### 2-4. カバー範囲の結論

**この org の Marvis Actions には、セキュリティ・RF/無線チューニングの「設定ベストプラクティス」に該当するアクションが 1 件も出現しなかった。**
`category="wireless"` でも 0 件。

出現した 3 種はいずれも**運用上の障害・不整合の検出**(オフライン・切断・ポート設定不一致)であり、
本タスクが対象とする「公開されたベストプラクティスへの適合性」とは**性質が異なる**。

したがって、参考資料に挙げたベストプラクティス項目のうち Marvis Actions がカバーしているものは**無い**:

| ベストプラクティス項目 | Marvis Actions のカバー |
|---|:--:|
| WPA3 / Enhanced Open への移行 | ✗ |
| レガシー暗号方式(WEP / TKIP / WPA1 / Open)の排除 | ✗ |
| 802.11w(PMF)の設定 | ✗ |
| WIDS/WIPS 検知レベル | ✗ |
| 不正 AP 封じ込めの妥当性 | ✗ |
| AirMatch/ARM に任せる(静的割当の回避) | ✗ |
| 2.4GHz の高密度環境での扱い | ✗ |
| チャネル幅の一貫性 | ✗ |

**制約(正直に記録する)**: 上表は「この org の実出力に出現しなかった」ことの記録であり、
**Marvis Actions のアクション種別の全数を列挙したものではない**。Mist 側に種別カタログを返す API は
今回見つからなかった。他の org(特にセキュリティ機能を有効にした org)で追加調査する価値はある。

### 2-5. Mist 側で「自作ルール」に使える設定 API(実測)

Marvis Actions が空白のため、Mist 側も Central と同じ自作ルールで補う。データ源は `get_mist_config`。

| リソース | 取得できた構造 | 用途 |
|---|---|---|
| `wlans` | `auth.type`(`psk` / `eap`)、**`auth.pairwise[]`**(`wpa2-ccmp` / `wpa3` の配列)、`auth.enable_mac_auth` / `eap_reauth` / `multi_psk_only`、**`bands[]`**(`["24","5","6"]`)、`enabled`、`vlan_id`、`template_id` | 暗号方式 / 6GHz 適合 / 帯域構成の診断 |
| `rftemplates` | 帯域別オブジェクト **`band_24` / `band_5` / `band_6`** = `{ bandwidth, channels, power, power_min, power_max, disabled, allow_rrm_disable, ant_gain, preamble }`、**`band_24_usage`**(`auto` 等)、`country_code`、`model_specific` | チャネル幅 / Tx 電力レンジ / 2.4GHz 利用方針 / 静的チャネル(`channels` が `null` = 自動)の診断 |
| `wlantemplates` / `sitetemplates` / `deviceprofiles` | この org では `sitetemplates` は 0 件 | 適用範囲の解決 |

**Central より Mist のほうが診断しやすい**: Mist は構造化 JSON で設定が返り、show コマンドのパースも
ファーム世代の分岐も不要。しかも `channels: null` / `power: null` が「自動(RRM 任せ)」を明示的に表す。

**Mist 側で取得できなかったもの**: WIDS/rogue の検知設定(site settings 配下の `rogue` オブジェクト)は
`get_mist_config` の `resource_type` 列挙に無く、今回は到達できなかった。
検知**結果**は `search_mist_data(search_type="rogue_events")` で取れるが、**site_id 必須**(org 一括不可)。

---

## 3. Task 3: チェックルールの設計

### 3-1. 設計方針

1. **ルールはカテゴリ単位で追加できる**。`category` は文字列ユニオンで、将来 `"firmware"` / `"redundancy"` / `"monitoring"` を足すときにルール定義を 1 件追加するだけで済む形にする
2. **判定は機械判定を第一とし、LLM は「環境依存で機械的に決められないもの」に限る**。LLM 所見は合否を出さず、所見テキストのみを返す
3. **サーバは文章を作らない**。CLAUDE.md の規約どおり、判定結果は `messageCode` + `messageParams` で返し、画面側の辞書で文にする
4. **封じ込め系は「有効化を勧めない」**。公式ドキュメントが法規制上のリスクを明記しているため、
   有効になっている場合に「法務・セキュリティ部門の承認確認」を促す向きのルールにする(§3-5)

### 3-2. データ構造

```ts
// ── 拡張ポイント: カテゴリはここに足す ──────────────────────
export type CheckCategory = "security" | "rf";
// 将来: | "firmware" | "redundancy" | "monitoring" | "wired"

export type CheckPlatform = "central" | "mist" | "both";

/** 判定の粒度。UI のグルーピングにも使う */
export type CheckTarget = "org" | "site" | "group" | "ssid" | "ap" | "radio";

/** 重要度。公式ドキュメントの語調に対応させる */
export type CheckSeverity =
  | "must"        // 規格・規制上そうでなければならない(6GHz の WPA3 必須 等)
  | "strong"      // 強く推奨(WPA3 移行・PMF・WIDS 検知の有効化 等)
  | "recommended" // 推奨(Tx 電力レンジ・基本レート 等)
  | "advisory";   // 注意喚起(誤検知リスク・法務確認要・環境依存)

export type CheckMethod = "mechanical" | "llm";

export interface RuleReference {
  /** 表示用タイトル(i18n 辞書のキーではなく原文タイトル。出典は翻訳しない) */
  title: string;
  url: string;
}

/** どの生データから判定材料を取るか。収集フェーズがこれを見てコマンドを決める */
export type RuleSource =
  | { kind: "central-show"; command: string }            // ホワイトリスト固定
  | { kind: "central-mcp"; tool: string }                // central_get_aps 等
  | { kind: "mist-config"; resourceType: string }        // wlans / rftemplates
  | { kind: "derived" };                                 // 他ルールの収集結果から導出

export interface BestPracticeRule {
  id: string;                    // "SEC-01" / "RF-05"
  category: CheckCategory;
  platform: CheckPlatform;
  target: CheckTarget;
  severity: CheckSeverity;
  method: CheckMethod;
  /** i18n キー。ja.json / en.json の両方に必ず追加する */
  titleKey: string;              // "bestPractice.rules.SEC-01.title"
  descriptionKey: string;        // "bestPractice.rules.SEC-01.desc"
  references: RuleReference[];   // 根拠 URL(必須・1 件以上)
  sources: RuleSource[];
  /** 法務・規制上の確認を促すルール(封じ込め系) */
  requiresLegalReview?: boolean;
  /** 既定で有効か。ノイズの多いルールは false で出荷し、UI で有効化させる */
  enabledByDefault: boolean;
}

export type FindingStatus =
  | "pass"
  | "warn"
  | "fail"
  | "not_applicable"  // 例: AOS 10 に ARM ルールを当てた
  | "unknown";        // 例: 設定値を取得できなかった

export interface Finding {
  ruleId: string;
  status: FindingStatus;
  platform: "central" | "mist";
  targetType: CheckTarget;
  targetId: string;
  targetLabel: string;
  siteId?: string;
  /** 素材(値)だけ。文章にしない。機微情報は入れない */
  observed: Record<string, string | number | boolean | null>;
  /** 画面側の辞書で文にするためのコードと値 */
  messageCode: string;
  messageParams: Record<string, string | number>;
  collectedAt: string;  // ISO8601
}
```

**カテゴリ追加の手順**(将来の自分向け):
`CheckCategory` に文字列を足す → ルール定義配列に `BestPracticeRule` を追加 →
`ja.json` / `en.json` に `titleKey` / `descriptionKey` / `messageCode` の 3 種を追加 →
収集フェーズが `sources` を見て自動でデータを集める。判定関数はルール ID で引くマップに登録する。

### 3-3. セキュリティ領域のチェックルール(13 件)

機械判定 11 / LLM 所見 2。

| ID | 内容 | 判定 | 重要度 | 対象 | 判定ロジック | 根拠 |
|---|---|:--:|---|---|---|---|
| SEC-01 | レガシー暗号方式の排除 | 機械 | must | SSID | `opmode` が WEP / TKIP / WPA1 系、または `security_level` が `Open` かつ `enhanced-open` でない → fail | [Security modes](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/) |
| SEC-02 | Open SSID は Enhanced Open(OWE)へ | 機械 | strong | SSID | `opmode` が実質 open(暗号なし)→ warn。`enhanced-open` なら pass | 同上 |
| SEC-03 | WPA2 → WPA3 への移行 | 機械 | strong | SSID | `opmode` が `wpa2-aes` / WPA2-Personal → warn。`wpa3-*` なら pass | 同上 |
| SEC-04 | WPA2 SSID の PMF 未設定 | 機械 | strong | SSID | `opmode` が WPA2 系かつ `mfp-capable` / `mfp-required` いずれも無い → fail(MFPR=0/MFPC=0)。`mfp-capable` のみ → warn。両方 → pass。**50 番で `mbo-enable` による暗黙 capable → warn を追加** | [PMF](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/features/pmf/) |
| SEC-05 | WPA3 transition mode の常用回避 | 機械 | advisory | SSID | transition mode 有効 → warn(2.4/5GHz で MFPR=0 になり AKM:1/AKM:2 が残るため)。~~取得方法が未確定なので当面 `unknown`~~ → **50 番で機械判定に格上げ済み**(50 番 §2-2) | [Security modes](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/) |
| SEC-06 | 6GHz を有効にした SSID のセキュリティ適合 | 機械 | must | SSID | 帯域に 6GHz を含み `opmode` が WPA3/Enhanced Open でない → fail(6GHz では WPA2/Open/WPA1/TKIP/WEP は規格上不可) | 同上("The Wi-Fi Alliance (WFA) made the decision to require WPA3 or Enhanced Open as the minimum security modes allowed in the 6 GHz band.") |
| SEC-07 | 基盤側 WIDS 検知が無効 | 機械 | strong | AP/サイト | `infrastructure detection level` = `off` → fail。`low` → pass | [Detection](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/wids-wips/detection/) |
| SEC-08 | クライアント側 WIDS 検知が無効 | 機械 | strong | AP/サイト | `client detection level` = `off` → fail。`low` → pass | 同上 |
| SEC-09 | 検知レベルが Medium / High | 機械 | advisory | AP/サイト | `medium` / `high` → warn(誤検知・アラート過多の注意喚起)。公式の一般推奨は `Low` | 同上("The general recommendation is to set the detection settings as Low.") |
| SEC-10 | 無線封じ込めが有効(法務確認) | 機械 | advisory | AP/サイト | `Wireless Containment` ≠ `none` → warn + `requiresLegalReview` | [Protection](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/wids-wips/protection/) |
| SEC-11 | 高リスクな保護ポリシーが有効(法務確認) | 機械 | advisory | AP/サイト | `rogue-containment` / `protect-ssid` / `protect-ap-impersonation` / `protect-valid-sta` / `protect-windows-bridge` / `protect-wifi-direct-p2p-groups` / `protect-adhoc-network` のいずれかが `enable` → warn + `requiresLegalReview`。**該当ポリシー名を `messageParams` で返し、画面側の辞書で文にする** | 同上 |
| SEC-12 | 認証・鍵配布構成の総合所見 | LLM | — | サイト | 認証サーバの冗長性、SSID 用途と認証方式の整合(ゲスト/IoT/従業員)、MPSK の使い所などを所見として出す。合否は付けない | — |
| SEC-13 | SSID 構成全体のセキュリティ姿勢 | LLM | — | サイト | 機械判定の結果一式を渡し、「どれから直すべきか」の優先順位と、機械判定に出ない構成上の懸念を所見として出す | — |

**SEC-11 の注意**: 公式ドキュメントは `protect-ssid` / `protect-ap-impersonation` / `rogue-containment` /
`protect-valid-sta` / 40MHz HT 保護 / 誤設定 AP 保護 / 疑わしい rogue 封じ込め のいずれについても
**「有効にすべきでない」または「法務・セキュリティ部門の承認が前提」**と明記している。
唯一「Recommend enable」とされているのは **有線封じ込め(wired containment)** だが、これも
"Both Security and Legal should be consulted and approval given before it is enabled" が付く。

→ **有線封じ込めを「推奨だから有効にせよ」と機械判定で fail 扱いにするのは適切でない。**
SEC-11 は封じ込めが**有効になっている**ことを検知して法務確認を促す向きに統一し、
無効であることを問題として扱わない。

### 3-4. RF / 無線チューニング領域のチェックルール(14 件)

機械判定 12 / LLM 所見 2。

| ID | 内容 | 判定 | 重要度 | 対象 | 判定ロジック | 根拠 |
|---|---|:--:|---|---|---|---|
| RF-01 | 2.4GHz のチャネル幅が 20MHz 超 | 機械 | strong | 無線 | `Max channel bandwidth`(2.4GHz)> 20MHz → fail | [RF Design](https://arubanetworking.hpe.com/techdocs/VSG/docs/010-campus-design/esp-campus-design-047-rf-design/)(推奨表: 2.4GHz = 20MHz) |
| RF-02 | 5GHz のチャネル幅レンジが推奨外 | 機械 | recommended | 無線 | 5GHz の `Max channel bandwidth` > 80MHz → warn(推奨は 20–80MHz) | 同上 |
| RF-03 | ESS 内でチャネル幅が AP 間で不一致 | 機械 | strong | サイト | 同一サイト内の AP で同一帯域の実効チャネル幅(`central_get_ap_details.radios[].bandwidth`)が 2 種類以上 → warn | [RF planning](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/design-guides/lpv/rf-planning/)("the network design must maintain consistent channel widths across the ESS") |
| RF-04 | 2.4GHz の許可チャネルが 1/6/11 以外を含む | 機械 | recommended | 無線 | `Allowed channels`(2.4GHz)が `{1,6,11}` の部分集合でない → warn(非重複チャネル数の制約) | 同上 |
| RF-05 | 同一無線の Tx 電力の上下限差が 6dBm 超 | 機械 | recommended | 無線 | `Max Tx Power` − `Min Tx Power` > 6 → warn | [RF Design](https://arubanetworking.hpe.com/techdocs/VSG/docs/010-campus-design/esp-campus-design-047-rf-design/)("The difference between minimum and maximum Tx power within the same radio should be no more than 6 dBm.") |
| RF-06 | 5GHz の Tx 電力が 2.4GHz より 6dBm 以上高くない | 機械 | recommended | 無線 | (5GHz min) − (2.4GHz min) < 6 → warn | 同上 |
| RF-07 | 6GHz の Tx 電力が 5GHz 比で範囲外 | 機械 | recommended | 無線 | (6GHz) − (5GHz) が 0〜+3dBm の範囲外 → warn | 同上 |
| RF-08 | 基本レートが 12Mbps 未満を含む | 機械 | recommended | SSID | `a-basic-rates` / `g-basic-rates` に 12 未満(1/2/5.5/6/9/11)を含む → warn。中密度で最低 12Mbps、高密度で 24Mbps 以上 | 同上("HPE Aruba Networking recommends a minimum basic rate of 12 Mbps") |
| RF-09 | 802.11k が無効 | 機械 | recommended | SSID | ssid-profile に `dot11k` が無い → warn(Balanced プロファイルでは有効) | 同上(ローミングプロファイル表) |
| RF-10 | OKC / PMK キャッシュが無効 | 機械 | recommended | SSID | ssid-profile に `okc` が無い → warn(Balanced プロファイルでは有効) | 同上 |
| RF-11 | ブロードキャストフィルタ / IPv6 RA 最適化が未設定 | 機械 | recommended | SSID | `broadcast-filter` が `none` または未設定 → warn。`broadcast-filter-ipv6 unicast-router-advertisements` が無い → warn(推奨は「ARP only」+「Convert to Unicast」) | 同上 |
| RF-12 | Wi-Fi 6/7 機能の明示的な無効化 | 機械 | advisory | SSID/無線 | ssid-profile に `extremely-high-throughput-disable` がある、または無線側で `HE MU-OFDMA` / `MU-MIMO` / `TxBF` が `disable` → warn | 同上("High efficiency is enabled by default, and HPE Aruba Networking recommends keeping it enabled.") |
| RF-13 | ARM のスキャン / ClientMatch が無効(**AOS 8 のみ**) | 機械 | recommended | AP | `show arm config` の `Scanning` = `disable` または `Client Match` = `disable` → warn。AOS 10 では `not_applicable` を返す | 同上("HPE Aruba Networking recommends keeping ClientMatch enabled.") |
| RF-14 | 同一サイトでの AP モデル混在 | 機械 | advisory | サイト | 同一サイトに AP-5xx 系と AP-6xx 系が混在 → warn(同一 RF ブロック内では同一モデルを推奨) | 同上("HPE Aruba Networking advises using identical AP models within a contiguous RF service area") |
| RF-15 | 高密度環境における 2.4GHz の扱い | LLM | — | サイト | 2.4GHz を使っている SSID・AP 台数・クライアント数を渡し、その環境で 2.4GHz をクライアント用途に開けておくべきかの所見を出す。**環境依存(LPV/高密度なら無効化推奨、一般オフィスなら一部 AP のみ無効化)なので機械判定にしない** | [RF planning](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/design-guides/lpv/rf-planning/) / [RF Design](https://arubanetworking.hpe.com/techdocs/VSG/docs/010-campus-design/esp-campus-design-047-rf-design/) |
| RF-16 | 静的チャネル / 電力割当と RRM 運用の妥当性 | LLM | — | サイト | 実効チャネル・電力・`channel_change_count` / `power_change_count` の推移を渡し、AirMatch/ARM に任せられているかの所見を出す。**AOS 10 で AirMatch の設定を直接取れない**(§1-4)ため機械判定にしない | [AirMatch](https://arubanetworking.hpe.com/techdocs/aos/aos10/services/airmatch/) |

> 表は 16 行あるが RF-15 / RF-16 が LLM 所見のため、
> **機械判定 12 + LLM 所見 2 = 14 件**として数える(RF-01〜RF-14 のうち RF-13 は AOS 8 限定)。

### 3-5. Mist 側への適用(8 件は同一ロジックを再利用できる)

Marvis Actions が空白のため、Central と同じルール ID を `platform: "both"` として持ち、
データ源だけ差し替える。

| ルール | Mist のデータ源 | マッピング |
|---|---|---|
| SEC-01 / SEC-02 / SEC-03 | `wlans[].auth` | `auth.type` + `auth.pairwise[]`。`pairwise` に `wpa3` を含まず `wpa2-ccmp` のみ → SEC-03 warn |
| SEC-06 | `wlans[].bands[]` + `auth.pairwise[]` | `bands` に `"6"` を含み `pairwise` に `wpa3` が無い → fail |
| RF-01 | `rftemplates[].band_24.bandwidth` | > 20 → fail |
| RF-02 | `rftemplates[].band_5.bandwidth` | > 80 → warn |
| RF-05 / RF-06 / RF-07 | `rftemplates[].band_*.power_min` / `power_max` | Central と同じ算術 |
| RF-16(LLM) | `rftemplates[].band_*.channels`(`null` = 自動)/ `power`(`null` = 自動) | Mist では静的割当を明示的に判定できるので、**Mist に限っては機械判定に格上げ可能** |

Mist 側で**適用できない**もの: SEC-04 / SEC-05(PMF は Mist の WLAN オブジェクトに独立フィールドが無い)、
SEC-07〜SEC-11(WIDS/rogue 設定に `get_mist_config` から到達できない、§2-5)、
RF-08〜RF-13(該当フィールドを今回確認できていない)。

Marvis Actions は**別枠**として、設定診断とは分けて「Marvis が検出した運用上の問題」として並べて表示する
(重複するルールを自作しない、という方針どおり)。

---

## 4. 実装(50 番以降)に向けた前提

### 4-1. 収集フェーズの構成

```
サイト一覧(central_get_summary / get_mist_config(sites))
  ↓ サイトごとに代表 AP を 1 台選ぶ(§4-2)
Central: central_run_show_commands で固定 4 コマンドを 1 バッチ実行
   ["show running-config", "show radio config",
    "show ids-detection config", "show ids-protection config"]
   + AOS 8 のみ ["show arm config"] を追加バッチ
  ↓ パース → 正規化構造体(鍵・パスフレーズは落とす)
Mist: get_mist_config(wlans / rftemplates / wlantemplates)
  ↓ そのまま正規化構造体へ
判定エンジン: ルール配列を回して Finding[] を生成
  ↓
保存(data/ 配下、.gitignore 済み)+ 画面へ
```

### 4-2. 代表 AP のサンプリング

- サイトごとに `central_get_aps(site_id, status="ONLINE")` から 1 台選ぶ(ファーム世代が混在するサイトでは世代ごとに 1 台)
- ESS 内のチャネル幅一致(RF-03)と AP モデル混在(RF-14)だけは**全 AP のメタ情報**が必要だが、
  これは `central_get_aps` / `central_get_ap_details` で取れるので show コマンド不要
- 「サイト内で設定が食い違っている可能性」は診断できない旨を UI に明示する

### 4-3. ファーム世代の分岐

| | AOS 8(Instant) | AOS 10 |
|---|---|---|
| `show arm config` | ✓ | ✗(parse error) |
| `show radio config` | 未検証 | ✓ |
| `show ids-detection config` / `show ids-protection config` | 未検証 | ✓ |
| `show running-config` の `rf dot11X-radio-profile` | 未検証 | ✓ |

→ **AOS 8 機での `show radio config` / `show ids-*` の動作確認が実装前に必要**(§5)。

### 4-4. i18n

- ルールの `titleKey` / `descriptionKey` / 判定結果の `messageCode` を `src/i18n/ja.json` と `en.json` の
  **両方に**追加する。片方だけ追加しない
- **根拠 URL とドキュメントタイトルは翻訳しない**(実行時の記録として残る文言に相当)
- 重要度ラベル(must / strong / recommended / advisory)は辞書化する
- 日時は `src/i18n/format.ts` の `formatDateTime()` を使う。`toLocaleString("ja-JP")` を直接書かない

### 4-5. 機微情報の扱い(再掲・必須)

§1-5(a) のとおり。running-config の生テキストを保存しない。正規化構造体に鍵・パスフレーズ・
ハッシュ・RADIUS シークレットを入れない。LLM にも生 config を渡さない。

---

## 5. 次の実装に進む上で必要な追加調査

| # | 内容 | なぜ必要か | 難易度 |
|---|---|---|---|
| 1 | **AOS 8 機での `show radio config` / `show ids-detection config` / `show ids-protection config` の動作確認** | ラボの AOS 8 機では `show arm config` しか叩いていない。AOS 8 で動かない場合、RF-01/02/04/05〜07 と SEC-07〜SEC-11 が AOS 8 サイトで `unknown` になる | 低(ラボで実行するだけ) |
| 2 | ~~`mfp-capable` / `mfp-required` の running-config 出力形式~~ **→ 50 番で解決済み(独立行)** | — | — |
| 3 | ~~WPA3 transition mode を running-config から読む方法~~ **→ 50 番で解決済み(`opmode-transition-disable`)** | — | — |
| 4 | **AOS 10 で AirMatch の設定を読む手段**(`show ap debug airmatch {{option}}` のテンプレート引数解決、または Central の設定 API) | RF-16 を LLM 所見から機械判定に格上げできるかが決まる。優先度は低い(AirMatch は無設定運用が公式方針) | 中〜高 |
| 5 | **Mist の site settings(`rogue` オブジェクト)への到達手段** | Mist 側で SEC-07〜SEC-11 相当を診断できるかが決まる。`get_mist_config` の `resource_type` には無かった | 中 |
| 6 | **他 org での Marvis Actions のアクション種別の確認** | §2-4 の「セキュリティ・RF 系は 0 件」がこの org 固有か普遍かを確定させる。結論が変わればルール重複を避ける必要が出る | 低(別 org のトークンがあれば) |
| 7 | **`central_run_show_commands` の所要時間の実測**(サイト数 × コマンド数) | 日次バッチのスケジュール設計に必要。既存の `plugins/reports/schedule.ts` に相乗りするかを決める | 低 |

---

## 6. 参照した根拠ドキュメント

| ID で参照 | タイトル | URL |
|---|---|---|
| SEC-01/02/03/05/06 | Security modes | https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/ |
| SEC-04 | Protected management frames | https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/features/pmf/ |
| SEC-07/08/09 | WIDS/WIPS — Detection | https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/wids-wips/detection/ |
| SEC-10/11 | WIDS/WIPS — Protection | https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/wids-wips/protection/ |
| RF-01/02/05〜14 | RF Design(Validated Solution Guide) | https://arubanetworking.hpe.com/techdocs/VSG/docs/010-campus-design/esp-campus-design-047-rf-design/ |
| RF-03/04/15 | Radio frequency planning and channel optimization(LPV) | https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/design-guides/lpv/rf-planning/ |
| RF-16 | AirMatch(AOS 10) | https://arubanetworking.hpe.com/techdocs/aos/aos10/services/airmatch/ |
