# 58: Central RSSI/SNR 対応 + タグ付き Client/Device 設計の最終調整

実施日: 2026-08-04 / 対象: central-mcp-server のローカルパッチ(実施済み)+ Client 詳細の分離設計(設計のみ)

57 番と同じ方針で、**実データそのもの(サイト名・MAC・シリアル・org_id/site_id・IP・SSID 名)は記載しない。**
記録するのは「取得可否」「項目の構造」「設計判断」だけ。

---

## 0. 要約

| | 結果 |
|---|---|
| **Central の SNR** | ✓ **取れる。**API(`GET network-monitoring/v1/clients`)は無線クライアントに `snr`(int, dB)を返していた。欠落は **central-mcp-server 側のフィールド絞り込みが原因**(§1-2) |
| **Central の RSSI** | ✗ **存在しない。**API 応答 41 フィールドに `rssi` 相当が無い。AP CLI(`show clients` / `show ap association`)も dB 表記の Signal(=SNR)のみで、dBm の受信強度は出ない(§1-4)。**結論: Central は SNR のみ、RSSI は Mist のみ** |
| central-mcp 改修 | ✓ **実施済み。**`snr` / `phy_type` / `mlo_oper_mode` / `vlan_name` の 4 つを追加。サーバ + キャッシュプロキシ再起動後、MCP 経由で実値が返ることを確認(§1-3, §1-5) |
| multi-network-dashboard 側の改修 | **不要。**`central_get_clients` の応答を加工している箇所は無い。Global Overview は直接 REST で **既に `snr` を拾っていた**(§1-6) |
| 副産物 1 | Central にも**クライアント別の総トラフィック量がある**(`clients-topn-usage` の `usage` バイト)。57 番で「✗」としていた項目が覆る。ただし **MCP ツール未登録**(§1-7) |
| 副産物 2 | `last_seen_at` は接続中のクライアントで **文字列 `"0"`** が返る。日時としてレンダリングしてはいけない(§1-8) |
| Client 詳細の設計 | Central 用 / Mist 用を**判別可能ユニオンで完全に別型・別コンポーネント**にする。共有するのは表示プリミティブのみ(§2) |
| 57 番の未確定 #1(Mist スイッチ配下アプリ) | **対応しない**とユーザー判断で確定(§3) |

---

## 1. Task 1: central-mcp の実装確認と RSSI/SNR 対応

### 1-1. 調査対象の所在

`/Users/kshimono/claude/central-mcp-http` は **launchd の作業ディレクトリと `.env` とキャッシュプロキシの置き場**であって、
central-mcp-server 本体のソースはそこには無い。本体は uvx でインストールされた
`~/.local/share/uv/tools/central-mcp-server/lib/python3.10/site-packages/` 配下にある
(`PATCHES.md` の Patch 001 と同じ構図)。

| 層 | 実体 | クライアント項目に対する役割 |
|---|---|---|
| Central API | `GET network-monitoring/v1/clients` / `…/clients/{mac}` | **41 フィールドを返す**(§1-2) |
| pycentral | `pycentral/new_monitoring/clients.py` の `Clients.get_all_clients` / `get_client_details` | **無加工パススルー**。`resp["items"]` をそのまま返すだけで、絞り込みは一切していない |
| central-mcp-server | `utils/clients.py` の `clean_client_data()` + `models.py` の `class Client` | **ここで絞られていた**(原因) |
| cache-proxy(:8011) | `cache-proxy/src/index.mjs` | ペイロードは無加工。`central_get_clients` / `central_find_client` を **TTL 300 秒**でキャッシュするだけ |
| multi-network-dashboard | `plugins/network-investigation/` 他 | 応答の加工なし(§1-6) |

### 1-2. 欠落の原因 — 二重のホワイトリスト

`clean_client_data()` は camelCase → snake_case の**明示的な詰め替え**で、`snr` を拾っていなかった。
さらに `models.py` の `Client`(Pydantic)にも `snr` フィールドが無いため、**仮に詰め替えを直しても
extra フィールドとして捨てられる**。つまり 2 箇所を同時に直す必要があった。

`GET network-monitoring/v1/clients` の生応答を実測(1 サイト・11 クライアント)して
**全フィールド名を列挙**した結果、一覧エンドポイントと単体エンドポイント(`/clients/{mac}`)の
**フィールド集合は完全一致**(差分ゼロ)。その 41 フィールドのうち、パススルーされていなかったのは 6 つ:

| 生フィールド | 型 | 今回の扱い | 理由 |
|---|---|---|---|
| `snr` | int / null | **追加** (`snr`) | 本件の目的。無線のみ、有線は null |
| `phyType` | str / null | **追加** (`phy_type`) | 現行 PHY(`802.11a` / `802.11_6GHz` 等)。`capabilities` は端末の"能力"であって"今の PHY"ではないので別情報 |
| `mloOperMode` | str / null | **追加** (`mlo_oper_mode`) | Wi-Fi 7 の MLO 状態(`MLO Disabled` 等)。wifi7 サイトを持つ org なので将来必要 |
| `vlanName` | null | **追加** (`vlan_name`) | 実測 org では未設定(全件 null)だが API 上は正規のフィールド |
| `id` | str | 追加しない | API のリソース ID。MAC で引けるので冗長。LLM 文脈のノイズになる |
| `type` | str | 追加しない | 常に定数 `network-monitoring/client-monitoring`。情報量ゼロ |

### 1-3. 実施した変更(central-mcp-server)

`PATCHES.md` に **Patch 002** として記録済み。バックアップは
`models.py.orig-before-snr-patch` / `utils/clients.py.orig-before-snr-patch`。

1. `utils/clients.py` — `clean_client_data()` に 4 フィールドの詰め替えを追加。
   加えて**有線クライアント時に落とす無線専用フィールドの集合**に
   `snr` / `phy_type` / `mlo_oper_mode` を追加(既存の `wlan_name` 等と同じ扱いに揃えた)。
2. `models.py` — `class Client` に 4 フィールドを追加。
   無線専用の 3 つは `clean_client_data()` が有線時に `pop()` するため **`default=None` が必須**。
3. `tools/clients.py` — 2 つのツールの docstring の「無線専用フィールド」列挙に 3 つを追記し、
   **「Central は per-client の RSSI を出さない」**旨を明記した(LLM に RSSI を探させないため)。

> ⚠️ このパッチは `uv tool install --upgrade central-mcp-server` で消える。再適用手順は `PATCHES.md` 参照。

### 1-4. RSSI は Central に存在しない(3 経路で確認)

| 経路 | 確認内容 | 結果 |
|---|---|---|
| `GET network-monitoring/v1/clients`(一覧) | 全 41 フィールド名を機械的に列挙し、`rssi` / `signal` / `noise` を含む名前を検索 | **該当は `snr` のみ** |
| `GET network-monitoring/v1/clients/{mac}`(単体) | 同上 | 一覧と**完全同一のフィールド集合**。`rssi` 無し |
| AP CLI `show clients` | 57 番の未確定 #5 の宿題。引数なしで実行可 | `Signal(dB)` 列がある。**単位は dB = SNR** であって dBm ではない。値も API の `snr` と同オーダー |
| AP CLI `show ap association` | 追加確認 | PHY 能力・帯域幅・空間ストリーム数・フラグ(11k/r/v/w 等)は出るが、**受信強度の数値は一切無い** |

**結論: Central が提供する無線品質指標は SNR(dB)のみ。RSSI(dBm)は Mist のみ。**
代替値を計算で作らない(ノイズフロアは AP 単位の値しか無く、クライアント個体の RSSI は復元できない)。

補足 — `show clients` には API に無い情報が 2 つあった:
- **`Speed (Mbps)`**: 現在のネゴシエート PHY レート。API には無い。
- `Signal` / `Speed` ともに `54(good)` のように**品質ラベル付き**で返る。
両方とも AP 単位・show コマンド経由(遅い)なので、**初回リリースでは使わない**方針を提案(§4)。

### 1-5. 改修後の動作確認(実施済み)

1. `python -m py_compile models.py utils/clients.py tools/clients.py` — OK
2. `launchctl kickstart -k gui/$(id -u)/com.kshimono.central-mcp-http` — 再起動、`:8010` LISTEN 確認
3. `launchctl kickstart -k gui/$(id -u)/com.kshimono.central-mcp-cache-proxy` — 再起動、`:8011` LISTEN 確認
   ※ **プロキシも再起動しないと最大 5 分は旧レスポンスが返る**(`short_ttl` 300 秒)
4. `central_get_clients(site_id=…, connection_type="Wireless")` — 10 件すべてで
   `snr` が **整数**、`phy_type` / `mlo_oper_mode` が**文字列**で返ることを確認
5. `central_get_clients(site_id=…, connection_type="Wired")` — `snr` / `phy_type` / `mlo_oper_mode` が
   **null**(既存の無線専用フィールドと同じ挙動)であることを確認
6. `central_find_client(mac_address=…)` — 単体引きでも同じ 4 フィールドが返ることを確認

実測 SNR は 18〜45 dB の範囲に分布し、5 GHz より 6 GHz 接続端末のほうが高い値を示した
(値そのものは記載しない。品質バッジの閾値決めに使える分布だという記録のみ残す)。

### 1-6. multi-network-dashboard 側は改修不要

- `central_get_clients` / `central_find_client` を呼ぶコードは**アプリ側に無い**
  (ヒットするのは `plugins/network-investigation/tool-labels.json` の**ツール名ラベルだけ**)。
  ネットワーク調査タブは MCP の応答を LLM にそのまま渡すので、**今回の追加フィールドは自動的に届く**。
- Global Overview は MCP を経由せず直接 REST を叩いており、
  `plugins/global-overview/central-client.ts` の `fetchCentralClients()` は
  **既に `snr: toNum(c?.snr)` を拾っていた**。同ファイルは `rssi: null` を明示的に置き、
  `plugins/global-overview/detail-types.ts` には「**Central は返さないため null**」とコメントまである。
  → **本アプリのコードベースは 57 番の記述より先に正しい理解を持っていた**。
    57 番の「Central は RSSI/SNR とも ✗」は、**MCP 経由でしか見ていなかったことによる誤り**。§3 で訂正する。

### 1-7. 副産物: Central にもクライアント別トラフィック量がある(57 番の訂正)

pycentral の `Clients.get_top_n_clients` → `GET network-monitoring/v1/clients-topn-usage` を実測した:

```
{ "count": <n>, "items": [ { "id", "type", "clientName", "clientConnectionType",
                             "macAddress", "siteId", "siteName", "usage" } ] }
```

- **`usage` はバイト数**(実測で数百 MB〜数 GB のオーダー)。`duration` / `start-at` / `end-at` で期間指定可、`limit` は 1〜100。
- **site 単位の上位 N** という形。特定 MAC を直接引く形ではないが、
  タグ付き対象が属するサイトを 1 回叩いて MAC で突合すれば、**タグ付きクライアントの期間トラフィック量が出せる**。
- **tx/rx の内訳は無く合計のみ**。アプリ別内訳も無い(それは DPI show コマンド側の話で 57 番のまま)。
- **`clients-trend` は `group_by="mac"` で HTTP 400**。クライアント別の時系列は作れない
  (`group_by` 無しならサイト全体のクライアント数推移が `interval` / `keys` / `samples` 形式で返る)。

> **未登録**: `central_get_top_clients` 相当の MCP ツールは central-mcp-server に**存在しない**
> (`tools/clients.py` が登録するのは `central_get_clients` と `central_find_client` の 2 本だけ)。
> 使うなら**新規ツールの追加パッチが要る**。今回は目的外なのでスコープに入れていない。§4 の判断事項 #1。

### 1-8. 実データで見つかった注意点(実装前に必ず織り込む)

| # | 事象 | 実装への影響 |
|---|---|---|
| 1 | **`last_seen_at` が接続中のクライアントで文字列 `"0"`** | **日時としてレンダリングしてはいけない。**`"0"` / 空を「接続中(最終確認は N/A)」として扱う分岐が必須。`formatDateTime()` に素通しすると壊れる |
| 2 | `user_name` / `authentication` が PSK 端末で **空文字列**(null ではない) | 「未設定」判定は `== null` ではなく**空文字も含めて**行う。認証方式が空のときは `key_management`(WPA3-SAE 等)を代わりに見せる |
| 3 | `tags`(Central の ML 分類)も **空文字列**で返ることがある | 同上。かつ**本アプリのタグと別物**なので UI 上の名前を必ず分ける(例: 「Central 分類」) |
| 4 | `manufacturer` が `Private` = ランダム MAC | 57 番 §3-5 の警告表示の判定に使う。実測でも複数端末がこの値だった |
| 5 | `wireless_channel` が `48E (80 MHz)` のような**帯域幅込みの文字列** | **パースしない。**そのまま表示する。数値化すると `E`/`S`/`+` の意味が落ちる |
| 6 | `capabilities` は `802.11ax, 802.11k, 802.11r, 802.11v` の**カンマ区切り文字列**・有線は null | split してチップ表示にする。null と空文字の両方を「情報なし」に倒す |
| 7 | `vlan_name` は実測 org では**全件 null** | 「取得できない」ではなく「未設定」。空なら行ごと省くのが妥当 |
| 8 | `tunnel_id` も実測 org では全件 null、`tunnel_type` は文字列 `"None"` | `"None"` は**文字列**であって null ではない。トンネル行を出す条件に注意 |
| 9 | `mlo_oper_mode` は Wi-Fi 6 AP 配下でも `MLO Disabled` が入る | 常時表示すると情報量ゼロの行が増える。**Wi-Fi 7 AP 配下のときだけ出す**か、`MLO Disabled` を非表示にする |

---

## 2. Task 2: Client 詳細の Central / Mist 分離設計(確定)

### 2-1. 型設計 — 共通の抽象型を作らず、判別可能ユニオンにする

57 番の RISKS(「共通部分だけ出すと情報を捨てる」)への対応として、**データ型のレベルで分ける**。

```ts
// plugins/tagged-targets/types.ts(案)

/** タグ側が持つ情報。ここだけがプラットフォーム非依存 */
export interface TaggedClientRef {
  key: string;                    // 正規化 MAC 12 桁(57 番 §3-2)
  tagIds: string[];
  label: string | null;           // ユーザーの覚え書き
  note: string | null;
  lastSeen: { platform: "central" | "mist" | null; siteId: string | null;
              siteName: string | null; at: string | null };
}

/** ここから先は共通化しない。両者に同名フィールドを作らない */
export interface CentralClientDetail { platform: "central"; /* §2-2 の項目 */ }
export interface MistClientDetail    { platform: "mist";    /* §2-3 の項目 */ }

export type ClientDetail = CentralClientDetail | MistClientDetail;
```

**この形にする理由:**

1. `platform` による**判別可能ユニオン**なので、`switch (d.platform)` の各分岐で
   TypeScript が片方の型に絞ってくれる。Central 用の項目を Mist 側で `null` 埋めする必要が消える。
2. 片方にしか無い項目(Central の `capabilities` / `role`、Mist の `random_mac` / `is_guest`)を
   **追加してももう一方に影響しない**。57 番 §4-3 で Device について書いた
   「プラットフォームごとに項目が増減するのを許容する」を Client にも適用する。
3. 「取得不可」の表示が**型に含まれない**。Central に RSSI 欄そのものを作らないので、
   `rssi: null` を「未取得なのか非対応なのか」で悩む状態が発生しない。
   非対応は**コンポーネント側の固定の注記**として書く(§2-4)。

### 2-2. コンポーネント設計

```
view/ClientDetailPanel.tsx      … platform で分岐するだけの薄いディスパッチャ
view/CentralClientDetail.tsx    … Central 専用。§2-4 の項目のみを知る
view/MistClientDetail.tsx       … Mist 専用。§2-5 の項目のみを知る
view/primitives.tsx             … 両者が使う「見た目」だけの部品(データ形は知らない)
   ├ <SectionCard title>            セクション枠
   ├ <FieldRow label value>         1 行。value が null/空文字なら行ごと省く
   ├ <NotSupported reason />        「このプラットフォームでは取得できません」+ 理由
   ├ <SignalBadge kind="snr"|"rssi" value />  数値 + 良/可/不良の色
   └ <ChipList items />             capabilities / タグ用
```

**共有するのはプリミティブ(見た目)だけで、データスキーマは共有しない。**
`<FieldRow>` は `label: string, value: ReactNode` しか知らないので、
どちらのプラットフォームの型が変わっても壊れない。

### 2-3. 有線 / 無線の扱い

型の中でさらに分けるのではなく、**セクション単位の出し分け**にする(型は 1 つ)。

| | Central 有線 | Central 無線 | Mist 有線 | Mist 無線 |
|---|---|---|---|---|
| 判定 | `connection_type === "Wired"` | `"Wireless"` | `wired_clients` から取得 | `site_wireless_clients` から取得 |
| 無線セクション | **セクションごと非表示** | 表示 | **非表示** | 表示 |
| 接続品質セクション | 非表示 | SNR のみ表示(RSSI 欄を作らない) | **非表示**(データ源に品質値が無い) | RSSI + SNR + 時系列 |
| 接続先 | ポート名 (`port`) を表示 | AP 名 + BSSID | 収容スイッチ MAC + `port_id` | AP + BSSID |
| アプリ | `<NotSupported>`「AP の有線ポート配下を除き DPI 対象外」 | 明示ボタンで DPI 取得 | `<NotSupported>`「Mist は有線クライアントのバイト数を返さない」 | `top-app-by-bytes` |

**空欄で黙らせず、必ず `<NotSupported reason>` で理由を出す**(28/33 番で確立した方針の踏襲)。

### 2-4. Central 用 Client ビュー — 表示項目の確定リスト

すべて `central_get_clients` / `central_find_client`(Patch 002 適用後)の 1 回の呼び出しで揃う。

| セクション | 表示項目(MCP のフィールド名) | 備考 |
|---|---|---|
| **基本** | `name` / `hostname` / `mac` / `ipv4` / `ipv6` | 実測では `name` = `hostname` = MAC 文字列の端末が多数。3 つとも同値なら 1 行に畳む |
| | `category` / `function` / `os` | 端末プロファイル。Central の ML 分類由来で粒度が細かい |
| | `vendor` / `manufacturer` | `manufacturer === "Private"` で**ランダム MAC バッジ**(§1-8-4) |
| | `connection_type` / `status` | Wired/Wireless、Connected/Failed |
| | `tags` | **「Central 分類」等の別名で出す**。本アプリのタグと衝突させない(§1-8-3) |
| **接続** | `connected_to` / `connected_device_type` / `connected_device_serial` | シリアルは DPI 取得(`central_run_show_commands`)のキーになるので必ず保持 |
| | `port` | **有線のみ** |
| | `bssid` / `radio_mac` | **無線のみ** |
| | `connected_at` | `formatDateTime()` |
| | `last_seen_at` | **`"0"` 分岐が必須**(§1-8-1)。接続中は「接続中」と出す |
| | (導出)接続継続時間 | `connected_at` からアプリ側で算出。Mist の `uptime` に相当する情報を Central でも出せる |
| **無線**(無線のみ) | **`snr`** ← 今回追加 | `<SignalBadge kind="snr">`。**RSSI 欄は作らない** |
| | `wireless_band` / `wireless_channel` | チャネルは帯域幅込み文字列をそのまま(§1-8-5) |
| | **`phy_type`** ← 今回追加 | 現行 PHY。`capabilities`(端末の能力)とは別物として並べる |
| | **`mlo_oper_mode`** ← 今回追加 | `MLO Disabled` のときは出さない(§1-8-9) |
| | `wlan_name` / `wireless_security` / `key_management` | |
| | `capabilities` | `<ChipList>`。11k/r/v の対応可否は **Mist に無い Central の強み** |
| **ネットワーク / 認証** | `vlan_id` / **`vlan_name`** ← 今回追加 | `vlan_name` は空なら行ごと省く(§1-8-7) |
| | `role` | Central のポリシーロール |
| | `tunnel_type` / `tunnel_id` | `"None"` は文字列(§1-8-8)。トンネル未使用時は非表示 |
| | `user_name` / `authentication` | 空文字あり(§1-8-2)。空なら `key_management` で補う |
| | `site_name` / `site_id` | |
| **アプリ**(無線のみ・明示ボタン) | `show dpi-stats session` | 57 番 §1-2 のまま。IP キー・AP 単位・履歴なし。**一覧では絶対に取らない** |
| **イベント** | `central_get_events(context_type="WIRELESS_CLIENT", context_identifier=mac)` | 数値指標でなく「出来事」として出す |

**Central で出せないもの(コンポーネントに固定の注記として書く):**

| 項目 | 注記に書く理由 |
|---|---|
| RSSI(dBm) | 「Central は SNR のみ提供。API・AP CLI とも RSSI を返さない」(§1-4) |
| 現在スループット(bps) | API に無い |
| SNR / 品質の時系列 | **スナップショットのみ**。`clients-trend` はクライアント別に割れない(§1-7) |
| idle_time | 無い |
| ゲスト判定 | `role` からの推測にとどまる。断定表示しない |
| 期間トラフィック量 | **`clients-topn-usage` で取れるが MCP ツール未登録**(§1-7 / §4 判断事項 #1) |

### 2-5. Mist 用 Client ビュー — 表示項目の確定リスト

57 番 §1-4(b) / §1-5 / §1-6 で実測済みの内容を確定させたもの。

| セクション | 表示項目 | 取得手段 |
|---|---|---|
| **基本** | `hostname` / `mac` / `ip` / `manufacture` / `model` / `os` / `family` | `get_mist_stats("site_wireless_clients", site_id, object_id=<mac>)` |
| | **`random_mac`** / **`is_guest`** | Central に無い。ランダム MAC 警告(57 番 §3-5)は Mist 側のほうが確実 |
| | (補助表示)`username` / `psk_name` | `search_mist_data("wireless_clients")` 側。**キーにはしない**(57 番 §3-5) |
| **接続** | `ap_mac` / `ap_id` → デバイス名に解決 / `bssid` / `ssid` / `wlan_id` / `vlan_id` | 同上 |
| | `band` / `channel` / `proto` | チャネルは**数値**、帯域は別項目(Central と形が違う) |
| | **`uptime`** / **`idle_time`** / `last_seen` | Central に無い |
| **接続品質** | **`rssi`(dBm)** + **`snr`(dB)** 現在値 | `<SignalBadge>` 2 つ。**Central と違い RSSI がある** |
| | **`tx_bps` / `rx_bps`** 現在スループット | Central に無い |
| | **RSSI/SNR/レート/リトライの時系列** | `get_mist_insights("insight_metrics", …, metric:"client-rf-metrics")`。`interval` は `10m`(24h 保持)/ `1h`(14 日保持)。**未接続の時間帯は null で埋まる**ので折れ線を繋げない |
| **アプリ**(無線のみ) | アプリ名 × `rx_bytes` / `tx_bytes` / `total_bytes` | `insight_metrics` の `top-app-by-bytes` + `object_type:"client"`。**期間合計のみ・時系列/カテゴリ別は不可**(57 番 §1-5) |
| **イベント** | `search_mist_data("wireless_client_events", filters:{mac})` | 種別は `get_mist_constants("client_events")` |

**Mist で出せないもの(注記として書く):**

| 項目 | 理由 |
|---|---|
| 802.11k/r/v の対応可否 | `proto` で世代しか分からない。**Central の `capabilities` に相当するものが無い** |
| 暗号方式 / 鍵管理 | `wlan_id` から WLAN 設定を別途引く必要がある。**初回リリースでは出さない**(呼び出しが 1 本増えるだけの価値が薄い) |
| 端末カテゴリ / 機能分類 | Central の `category` / `function` に相当する粒度が無い(`family` 止まり) |
| Web カテゴリ / レピュテーション | Central DPI のみ |
| 有線クライアントのバイト数・アプリ | `wired_clients` に該当フィールドが無い(57 番 §1-8) |

### 2-6. 2 つのビューを並べない

同じ MAC が Central と Mist の両方で見つかることは実運用では想定しないが、
**万一両方から返った場合も 2 つのカードを縦に並べる**(1 枚にマージしない)。
アプリ名の体系もチャネル表記も品質指標の単位も違うため、混ぜると誤読を招く(57 番 §1-5 の結論の延長)。

---

## 3. Task 3: 57 番の未確定事項に対する結論

| # | 57 番での記載 | 58 番での結論 |
|---|---|---|
| **1** | Mist のスイッチ配下アプリ可視化(`top-flow-by-app` が `metric not found`) | **対応しない。**ユーザー判断により機能として存在しないものとして扱う。追加調査もしない。**有線クライアントのアプリ可視化は Central / Mist とも「不可」で確定**(§2-3 の表に反映済み) |
| **5** | Central のクライアント品質の代替(`show clients` に RSSI/SNR が含まれるか未確認) | **解決。**`show clients` の `Signal(dB)` は SNR。RSSI は無い。そもそも **API が `snr` を返しており show コマンドは不要**(§1-4) |
| — | §0 / §1-3 / §1-7 の「Client の RSSI/SNR: Central ✗」 | **訂正。**正しくは「**Central は SNR ✓ / RSSI ✗**」。57 番の誤りは **MCP 経由の応答だけを見て API 応答を見なかったこと**による(§1-2)。同じ理由で §1-3 の表の「RSSI / SNR」行と §1-7 の対比表の該当 2 行を差し替える |
| — | §1-3「クライアント別の総トラフィック量: 同上。無い」 | **訂正。**`clients-topn-usage` の `usage`(バイト・期間指定可)で**取得可能**。ただし MCP ツール未登録(§1-7) |
| 2 | Mist アプリ可視化のライセンス要件(SUB-VNA / Marvis) | **未解決のまま。**別ライセンス構成の org が手元に無く、権限不足時の挙動(エラーか空配列か)は確認できていない |
| 3 | Central DPI 無効時の `show dpi-stats session` の挙動 | **未確認のまま。**今回の実測 AP では DPI が有効だった |
| 4 | MCP 経由か直接 REST か | **未決定。**§4 判断事項 #2 に持ち越し |
| 6 | アプリトラフィックの履歴保持 | **初回リリースには入れない**方針を維持 |
| 7 | 突合の閾値 10 件 | 実測前。実装後に計測する |
| 8 | `formatBytes` の追加 | 未着手。`clients-topn-usage` を使う場合も同じ関数で足りる |

---

## 4. 59 番(実装着手)に進む前に残っている判断事項

| # | 事項 | 選択肢 | 推奨 |
|---|---|---|---|
| **1** | **`clients-topn-usage` を使うか**(Central のクライアント別トラフィック量) | (a) 使わない (b) central-mcp に `central_get_top_clients` ツールを追加する(Patch 003 相当) (c) 直接 REST で叩く | **(b) を第 2 段階で。**初回は無しで出す。Central 側だけ「総トラフィック量」欄が空くのは §2-4 の注記で説明できる。追加するならパッチが 1 本増える(アップグレードで消える負債も 1 本増える)ことを織り込む |
| **2** | **MCP 経由か直接 REST か**(57 番 #4 の持ち越し) | (a) 全面 MCP (b) Central は REST + DPI だけ MCP (c) 全面 REST + DPI だけ MCP | **(b)。**Global Overview の `central-client.ts` が既に `snr` まで拾えており、レート制限(`rate-limit.ts`)も REST 側にある。**MCP はキャッシュプロキシの 300 秒 TTL が挟まる**ので、明示更新ボタンの即時性を出しにくい。ただし **DPI(`central_run_show_commands`)だけは MCP 一択** |
| **3** | **SNR の品質バッジ閾値** | 実測分布は 18〜45 dB | **>= 25 良 / 15–24 可 / < 15 不良** を初期値として提案。Mist の RSSI(dBm)とは**別の閾値表**を持つ(単位が違うので共用不可) |
| **4** | **`mlo_oper_mode` の表示条件** | 常時 / Wi-Fi 7 AP のみ / `MLO Disabled` は非表示 | **`MLO Disabled` は非表示。**実測では Wi-Fi 6 AP 配下でも文字列が入り、常時表示だと無意味な行になる |
| **5** | **`last_seen_at === "0"` の表示文言** | 「接続中」/「—」/ `status` に統合 | **`status` と統合して「接続中」**と出す。日英両方の辞書キーが要る |
| **6** | **central-mcp のパッチ運用** | 現状の手動再適用のまま / 再適用スクリプト化 | 今回で **Patch 001 / 002 の 2 本**になった。3 本目(判断事項 #1)を作る前に、`PATCHES.md` から機械的に再適用できる形にしておくか決めたい |
| **7** | Mist の暗号方式 / 鍵管理を出すか | `wlan_id` から WLAN 設定を追加取得 | **初回は出さない**(§2-5)。Central 側にだけ暗号方式が出る非対称は注記で説明する |

---

## 5. 実施内容の記録

**変更したファイル(central-mcp-server / uvx インストール先)**
- `~/.local/share/uv/tools/central-mcp-server/lib/python3.10/site-packages/models.py`
- `~/.local/share/uv/tools/central-mcp-server/lib/python3.10/site-packages/utils/clients.py`
- `~/.local/share/uv/tools/central-mcp-server/lib/python3.10/site-packages/tools/clients.py`
- バックアップ 2 本を同ディレクトリに作成(`*.orig-before-snr-patch`)

**変更したファイル(central-mcp-http)**
- `/Users/kshimono/claude/central-mcp-http/PATCHES.md` — Patch 002 を追記

**変更していないもの**
- multi-network-dashboard のコード(改修不要と判断。§1-6)
- git 操作(両リポジトリとも commit / push なし。指示どおり)
- Central / Mist の設定(一切変更なし)

**実行したのは読み取り専用の API / show コマンドのみ。**
`central_run_show_commands` は `show clients` / `show ap association` の 2 本だけで、設定変更コマンドは実行していない。
本ファイルに実データ(サイト名・MAC・シリアル・org_id / site_id・IP・SSID 名)は記載していない。
