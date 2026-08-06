# 59: タグ付き Client / Device タブの実装

実施日: 2026-08-04 / 対象: `plugins/tagged-targets/`(新規)+ Global Overview の直接 REST クライアントへの公開口追加

57・58 番と同じ方針で、**実データそのもの(サイト名・MAC・シリアル・org_id/site_id・IP・SSID 名)は記載しない。**

---

## 0. 要約

| | 結果 |
|---|---|
| Task 1 タグ機構 | ✓ 完了。`data/tagged-targets/tags.json` に永続化。付与/削除/改名/色変更/登録解除まで実データで確認 |
| Task 2 一覧ビュー | ✓ 完了。新規タブ「タグ付き対象」。Client ⇔ Device のサブビュー切替 |
| Task 3 Client 詳細 | ✓ 完了。Central 用 / Mist 用を判別可能ユニオンで完全分離 |
| Task 4 Device 詳細 | ✓ 完了。Central は AP / スイッチ / ゲートウェイで叩き分け、Mist は AP / スイッチ / ゲートウェイ |
| Task 5 i18n・動作確認 | ✓ 完了。240 キーを ja/en 両方に追加。日英・ダーク/ライトで確認 |
| 本番反映 | ✓ `docker compose up -d --build` 実行済み。ポート 8092 で動作確認済み |
| **57/58 の記載に対する訂正** | **2 件**(§4)。いずれも「取れない」としていたものが直接 REST では取れた |
| 実装中に見つけた実データの罠 | **4 件**(§3)。57/58 に無かったもの |

---

## 1. 作ったもの

### 1-1. ファイル構成

```
plugins/tagged-targets/
  types.ts          … 判別可能ユニオンの型定義(import ゼロの純粋な型)
  mac.ts            … MAC 正規化(12 桁 ⇔ コロン区切り)・ローカル管理ビット判定
  store.ts          … data/tagged-targets/{tags,settings}.json の読み書き(原子的書き込み)
  central-fetch.ts  … Central 直接 REST(一覧・Client 詳細・Device 詳細)
  mist-fetch.ts     … Mist 直接 REST(同上)
  resolve.ts        … タグ ⇔ 実データの突合・キャッシュ・lastSeen 書き戻し
  search.ts         … 対象検索(タグ付与の入口)。Central + Mist 統合
  api.ts            … Express router(/api/tagged-targets/*)
  view/
    types.ts        … ../types の再エクスポート + レスポンス型
    api.ts          … fetch ラッパ
    format.ts       … このタブ固有のロケール非依存な整形
    primitives.tsx  … SectionCard / FieldRow / NotSupported / SignalBadge / ChipList
    TaggedTargets.tsx … タブ本体(一覧 + サブビュー切替)
    ClientDetail.tsx  … CentralClientDetailView / MistClientDetailView
    DeviceDetail.tsx  … CentralDeviceDetailView / MistDeviceDetailView
    TagControls.tsx   … タグ管理・タグ付与・対象追加
    styles.css
```

既存への変更は **3 ファイルだけ**:

- `plugins/global-overview/central-client.ts` … 公開 `apiGet()` を追加(private `get()` の薄い口)
- `plugins/global-overview/mist-client.ts` … 公開 `apiGet()` / `getOrgId()` を追加
- `server/index.ts` / `src/main.tsx` / `src/i18n/*.json` … マウント・タブ登録・辞書

### 1-2. 直接 REST にした構成(58 §4 判断事項 #2 の (b) を採用)

MCP を経由せず、**Global Overview の `CentralClient` / `MistClient` をそのまま共有**する。
トークンのキャッシュもレート制御(`rate-limit.ts`)も既存のものを通るので、
本タブが増えても他タブを巻き込んで詰まらせない(57 §2-4 の要求どおり)。

新規に足したのは「任意の GET を 1 本叩く」公開メソッドだけで、**書き込みの口は作っていない**。

### 1-3. 一覧の突合コスト(57 §3-4 の二段構えは不要になった)

**タグ件数によらず固定本数**で済む:

| 一覧 | 出す HTTP |
|---|---|
| Client | Central 1 本 + Mist 2 本 + Mist 現況(対象が居るサイト数ぶん・既定上限 8) |
| Device | Central 1 本 + Mist 1 本 |

57 は「Central にクライアントの org 横断一覧が無いので対象ごとに個別引き、閾値 10 件で
サイト一括に切替」という二段構えを提案していたが、**§4-1 の訂正により Central も 1 本**で済む。
閾値の実装は不要になった。

詳細は開いた 1 件だけ叩く(60 秒キャッシュ + in-flight 共有 + 明示更新ボタン)。

### 1-4. 型の分離(58 §2-1 の設計をそのまま実装)

`CentralClientDetail` / `MistClientDetail` / `CentralDeviceDetail` / `MistDeviceDetail` は
**同名フィールドを持たない別型**。`platform` による判別可能ユニオンで、コンポーネントも
完全に分けた。共有しているのは `primitives.tsx` の見た目部品だけで、
`<FieldRow>` は `label: string, value: ReactNode` しか知らない。

「取得不可」は型に含めず、`<NotSupported reason>` の**固定注記**として書いた。
Central のクライアントに `rssi: null` というフィールドは存在しない。

### 1-5. ランダム MAC の判定

優先順位を付けて確定させ、判定元も一緒に保持する(ツールチップで根拠を出す):

1. Mist の `random_mac`(真偽値。最も確実)
2. Central の `clientManufacturer === "Private"`
3. MAC のローカル管理ビット(1・2 が取れないときだけ)

付与ダイアログで**その場でバッジ + 警告文**を出し、一覧の行にもバッジを残す。
実機で `random_mac: true` の端末・`Private` の端末とも警告が出ることを確認した。

---

## 2. 動作確認(実サイト・本番ポート 8092)

タグ 2 件 / 対象 9 件(Client 4 / Device 5)を登録して一連の流れを通した。

| 確認項目 | 結果 |
|---|---|
| タグの作成・改名・色変更・削除 | ✓ 削除時に「N 件の対象から外れます」の件数が出ることも確認 |
| タグの永続化 | ✓ `tags.json` に保存され、**コンテナ再作成後も読み込まれる**(`data/` は bind mount) |
| 対象の登録・登録解除 | ✓ |
| `lastSeen` の書き戻し | ✓ 9 件中 8 件(見つからない 1 件を除く全件)に書き戻された |
| Device の `serial` 埋め戻し | ✓ 5 件すべて。Central はシリアル引き・Mist は MAC/UUID 引きなので両値を保持(57 §3-2) |
| Client 一覧 | ✓ Central 有線 1 / Mist 無線 2 / 見つからない 1 |
| Device 一覧 | ✓ Central AP・スイッチ・ゲートウェイ / Mist AP・スイッチ の 5 種すべて |
| Central Client 詳細(有線) | ✓ 無線セクションが**セクションごと非表示**。`lastSeenAt === "0"` が「接続中」表示 |
| Mist Client 詳細(無線) | ✓ RSSI/SNR バッジ・スループット・累積バイト・リトライ・アプリ別・イベント |
| アプリ別トラフィック | ✓ 1 台で 3 アプリ取得。`Unknown` は「不明 / その他」として灰色で別扱い |
| Central Device 詳細 | ✓ AP(radios 2 / ports 5 / wlans 8)・スイッチ(ports 16 / hardware 3 項目 / PoE / 温度)・ゲートウェイ(ports 6) |
| Mist Device 詳細 | ✓ AP(radios 3 帯域 / ports 2 / LLDP 上流 / PoE / 証明書期限)・スイッチ(ports 30) |
| NotSupported 表示 | ✓ Central 無線=RSSI/スループット/時系列 の 3 件、Central 有線=+アプリ、Mist 有線=品質/アプリ |
| ランダム MAC 警告 | ✓ 一覧の行バッジ・詳細ヘッダのバッジ・追加ダイアログの警告文 |
| 見つからない対象 | ✓ 行を消さず灰色で残り、`lastSeen` を添えて「最後に確認できたのは〜」を出す |
| 日英切替 | ✓ 両言語で全画面を走査し、**辞書キーの露出ゼロ**(`taggedTargets.*` の生文字列が DOM に出ない) |
| ダーク / ライト | ✓ 両方で確認。崩れなし |
| 片方のプラットフォーム障害 | ✓ `sources[]` に理由が載り、もう片方の結果は出る設計(コード上。実障害の再現はしていない) |

**本番反映**: `docker compose up -d --build` を 2 回実行(修正の反映で 2 回目)。
起動ログに `[tagged-targets] タグ 2 件 / 対象 9 件を読み込みました(Client 4 / Device 5)`。
ポート 8092 で一覧・詳細ともに動作確認済み。

> 動作確認で作ったタグ(2 件)と対象(9 件)はそのまま残してある。
> うち 1 件は「見つからない対象」の挙動を見るための **`aa:bb:cc:dd:ee:ff`(明らかな偽 MAC)**。
> 不要なら画面の「登録解除」で消せる。`data/` は `.gitignore` 済みなのでコミットには乗らない。

---

## 3. 実装中に見つけた実データの罠(57/58 に無かったもの)

いずれも実装に織り込み済み。**発見はすべて画面を実際に見たことによる**(API 応答の目視では気付けなかった)。

| # | 事象 | 対処 |
|---|---|---|
| **1** | **Central のポート速度は同じ「速度」でも単位が違う。**AP ポート(`aps/{serial}/ports`)は `"1000"` = **Mbps の文字列**、スイッチ `interfaces` は `1000000000` = **bps の数値** | `speedMbps()` で Mbps に正規化してから型に載せる(`CentralPortRow.speedMbps`)。表示は `formatLinkSpeed()` が 1000 Mbps 以上を Gbps に畳む。**放置すると画面に `1000000000` が出る** |
| **2** | **Mist の PoE 値はミリワット。**`lldp_stat.power_draw` が `25500` / `30300`(= 25.5W / 30.3W) | `mwToW()` で換算。単位の宣言がフィールドに無いので、実機の値域から判断した |
| **3** | **Mist の `last_trouble.timestamp` は機種によって秒とミリ秒が混在する。**EX スイッチはミリ秒、AP45 は秒 | `looseEpochToIso()` が桁で見分ける(1e11 超ならミリ秒)。**ミリ秒固定で実装すると AP 側が 1970 年になる** |
| **4** | **Mist の `env_stat` はセンサ非搭載の機種で 0 を返す。**AP45 の `ambient_temp` / `humidity` が 0 | `sensor()` が 0 を null に倒し、行ごと省く。**0 °C の室温・湿度 0% をそのまま出すと誤読を招く** |

補足(罠ではないが実装判断):

- Mist の `stats/clients` には **`hostname` / `username` / `random_mac` が無い**。それらは
  `clients/search` 側にしかないので、詳細は 2 本叩いて合成している。
- 逆に `stats/clients` には **`key_mgmt`(`WPA3-SAE-PSK/CCMP` 等)がある**(§4-2 の訂正)。
- Mist の AP は `cpu_util` / `mem_total_kb`、**スイッチ・ゲートウェイは `cpu_stat` / `memory_stat`**、
  ポートは AP が `port_stat` / スイッチ・ゲートウェイが `if_stat` と、**キーが別**。
- Central の `aps/{serial}` は CPU / メモリ / クライアント数を **`apStats[]` の中**に持つ(トップレベルに無い)。
- Central の `meshRole` は未設定時に `"-"` が入る。`tunnelType` の `"None"` と同じ扱いで落とす。
- Central の `switchTrends` は温度・PoE を `29.120000839233` のような長い浮動小数で返すので丸めた。

---

## 4. 57 / 58 番の記載に対する訂正

| # | これまでの記載 | 59 番での実測 |
|---|---|---|
| **1** | 57 §3-4「Central にはクライアントの org 横断一覧が無く、`central_get_clients` は `site_id` 単位。サイト数ぶんループが要る」 | **訂正。`GET network-monitoring/v1/clients` は `site-id` を省くと org 全体を返す**(実測で全サイトぶんが 1 応答)。57 が置いた「閾値 10 件で個別引き ⇔ サイト一括を切り替える二段構え」は**不要**。一覧は常に 1 本で済む。誤りの原因は **MCP ツール(`site_id` 必須)の口だけを見て REST の口を見なかったこと**で、58 §1-6 で RSSI/SNR に起きたのと同じ構図 |
| **2** | 57 §1-7 / 58 §2-5「Mist の暗号方式 / 鍵管理は `wlan_id` から WLAN 設定を別途引く必要がある。初回リリースでは出さない」 | **訂正。`sites/{sid}/stats/clients` に `key_mgmt` がそのまま入っている**(実測値の形は `WPA3-SAE-PSK/CCMP`)。追加の呼び出しは不要なので**初回から表示している**。58 §4 判断事項 #7 はこれで解消 |

また、58 §1-8-7「`vlan_name` は実測 org では全件 null」は**サイトによる**。
別サイトの有線クライアントでは値が入っていた(値そのものは記載しない)。
「空なら行ごと省く」の実装方針自体は変えていない。

---

## 5. 採用した設計判断(59 の指示で確定していたもの)

| 事項 | 採用 |
|---|---|
| 取得経路 | **直接 REST**(MCP の 300 秒キャッシュを挟まない)。`clients-topn-usage` 用の MCP ツール追加は第 2 段階に見送り |
| SNR 品質バッジ | **>= 25 良 / 15–24 可 / < 15 不良**(58 の提案どおり)。RSSI は**別の閾値表**(>= -65 / -75〜-66 / < -75)。単位が違うので共用しない |
| `last_seen_at === "0"` | **status と統合して「接続中」**。日時としてレンダリングしない |
| `mlo_oper_mode` | `MLO Disabled` は**非表示** |
| Central の RSSI | **欄そのものを作らない**。代わりに `<NotSupported>` で「Central は SNR のみ」と理由を書く |
| 両プラットフォームから返った場合 | **カードを縦に 2 枚**並べる(マージしない) |

---

## 6. 未確認・次回に持ち越した事項

| # | 事項 | 状況 |
|---|---|---|
| 1 | **Central のアプリ別トラフィック(DPI)** | 未実装。`<NotSupported>` で「AP の DPI show 経由・IP キー・AP 単位・履歴なしのため取得していない」と明記している。実装するなら MCP 経由が必須(`central_run_show_commands`)で、一覧の同期パスには絶対に入れられない |
| 2 | **`clients-topn-usage`(Central のクライアント別トラフィック量)** | 未実装。58 §4 判断事項 #1 の (b)(MCP ツール追加)を第 2 段階に見送るという 59 の指示どおり |
| 3 | **Mist の RF 時系列(`client-rf-metrics`)** | エンドポイントの動作は 59 の事前調査で確認済み(`min_/avg_/max_` × 各指標 + `rt` タイムスタンプ配列)だが、**画面には出していない**。折れ線を入れるなら未接続時間帯の `null` を繋げない実装が要る |
| 4 | **片方のプラットフォームが実際に落ちたときの表示** | コード上は `sources[]` に理由を載せて他方を出す設計だが、**実際に落として確認はしていない**(資格情報未設定のパスのみ設計確認) |
| 5 | **タグ対象が大量(数百件)のときの挙動** | 一覧は固定本数の HTTP なので API 負荷は増えないが、**描画側の件数は実測していない**。9 件でしか確認していない |
| 6 | **Mist の現況取得サイト数上限(既定 8)に当たったときの表示** | `truncated` に記録して画面に警告を出す実装は入れたが、**8 サイトを超える配置を作れなかったので発火は未確認** |
| 7 | 57 の未確定 #2(Mist アプリ可視化のライセンス要件) | **未解決のまま。**別ライセンス構成の org が手元に無い。なお実測では 4 クライアント中 1 台だけ `top-app-by-bytes` が返り、残り 3 台は空配列だった。ライセンスではなくトラフィック量由来の可能性が高いが確証はない |
| 8 | 57 の未確定 #3(Central DPI 無効時の挙動) | **未確認のまま**(#1 が未実装のため) |

---

## 7. 実施内容の記録

**新規追加**: `plugins/tagged-targets/`(サーバ 8 ファイル + view 9 ファイル)

**変更**:
- `plugins/global-overview/central-client.ts` — 公開 `apiGet()` を追加
- `plugins/global-overview/mist-client.ts` — 公開 `apiGet()` / `getOrgId()` を追加
- `server/index.ts` — `/api/tagged-targets` をマウント
- `src/main.tsx` — タブ `tagged-targets` を登録
- `src/i18n/ja.json` / `src/i18n/en.json` — **240 キーを両方に追加**(片方だけの追加はゼロ。機械的に照合済み)

**変更していないもの**:
- git 操作(commit / push なし。指示どおり)
- Central / Mist の設定(一切変更なし。**タグはローカル DB のみ**)
- central-mcp-server(58 の Patch 002 のまま。今回は触っていない)

**実行したのは読み取り専用の GET のみ。**設定変更 API は 1 本も叩いていない。
本ファイルに実データ(サイト名・MAC・シリアル・org_id / site_id・IP・SSID 名)は記載していない。
