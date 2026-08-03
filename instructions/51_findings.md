# 51: ベストプラクティス診断ルールの実装・接続(Central + Mist)

実施日: 2026-08-02 / 対象: 実行エンジン・判定エンジン・API・データ保存(UI は範囲外・git 操作なし)

49 / 50 番と同じく、**実際の設定値そのもの(サイト名・SSID 名・シリアル・org_id / site_id)は記載しない。**
記録するのは「取得可否」「判定ロジック」「件数」だけ。

---

## 0. 要約

| | 結果 |
|---|---|
| 実装したルール | **29 ID**(セキュリティ 13 = SEC-01〜13 / RF 16 = RF-01〜16)。機械判定 25 / LLM 所見 4 |
| 「全 27 項目」との関係 | 49 番の表に載っている ID をすべて実装したので **27 項目を欠けなく含む**。29 になる理由は §1-1 |
| Central の収集 | `central_run_show_commands` を**世代別の固定ホワイトリスト**で実行。AOS10 は 4 本 / AOS8 は 5 本 |
| Mist の収集 | `get_mist_config`(sites / rftemplates / wlantemplates / wlans)+ `get_mist_stats`(org_devices) |
| MCP の呼び方 | **claude CLI を経由せず MCP を直接呼ぶ**(`connectMcpTools`)。決定的な収集に LLM を挟まない |
| 動作確認 | 実サイト **5 件**(Central 3 / Mist 2)で診断を実行。全サイトで例外なく完走 |
| 機密情報 | 保存物・LLM 入力の**両方を機械的に検査して 0 件**。加えて送信直前ガードの負のテスト 3 件が発火 |
| ホワイトリスト | 正常系・カタログエラー・`% Parse error.` の 3 経路を**実機で確認**。カタログ 27,000 文字超 → 保存は 301 文字 |
| 未接続 | **タブ UI・i18n 辞書**(キー名は確定済み)。スケジュール実行は仕様どおり作っていない |

---

## 1. Task 1: 実行エンジン

### 1-1. ルール数の食い違い(49 番の記載に対する訂正)

指示は「セキュリティ 13 項目・RF 14 項目の全 27 項目」だったが、
**49 §3-4 の表には RF-01〜RF-16 の 16 行がある**。内訳は機械判定 14 行(RF-01〜RF-14)+
LLM 所見 2 行(RF-15 / RF-16)。49 の本文は「機械判定 12 + LLM 所見 2 = 14 件」と数えているが、
表の行数と合わない(機械判定は 12 ではなく 14 行ある)。

→ **表に載っている ID をすべて実装した**(合計 29 ID)。27 を下回る箇所は無い。
数え方だけが 49 番の本文と食い違っている、という位置付けで記録する。

| | 機械判定 | LLM 所見 | 計 |
|---|---:|---:|---:|
| セキュリティ(SEC-01〜13) | 11 | 2 | 13 |
| RF(RF-01〜16) | 14 | 2 | 16 |
| **計** | **25** | **4** | **29** |

### 1-2. ファイル構成

| ファイル | 役割 |
|---|---|
| `types.ts` | 49 §3-2 の型 + 収集スナップショット + 実行結果。**`FindingStatus` に `"info"` を追加**(§1-6) |
| `rules.ts` | 29 ルールのカタログ。`category` / `severity` / `method` / `references[]` / `requiresLegalReview` |
| `running-config.ts` | `wlan ssid-profile` / `ids` / `rf dot11*-radio-profile` の正規化。**鍵を返さない** |
| `show-parse.ts` | `show radio config` / `show ids-detection config` / `show ids-protection config` / `show arm config` |
| `pmf.ts` | 50 番の decoder ring(無変更で流用)。SEC-04 / SEC-05 |
| `evaluate.ts` | 機械判定 25 ルール(Central / Mist) |
| `llm.ts` | LLM 所見 4 ルール + **送信直前の機微情報ガード** |
| `collect-central.ts` | ホワイトリスト実行・代表 AP サンプリング・パース |
| `collect-mist.ts` | 設定の適用範囲解決(wlantemplate の applies / exceptions)・正規化 |
| `store.ts` | `data/best-practice/` への保存 |
| `api.ts` | ルーター + `initBestPractice()` |

`server/index.ts` に `/api/best-practice` としてマウント済み。

### 1-3. MCP は claude CLI ではなく直接呼ぶ(設計判断)

既存の調査タブは `claude` CLI に `--mcp-config` を渡し、MCP 呼び出しを CLI 側に任せている
(`runClaudeWithMcp`)。今回はこれを**使わない**。

- 収集は決定的でよく、LLM に判断させる余地が無い
- LLM を挟むと出力が要約され、**どこまでが実データか分からなくなる**
- 何より、生 config が LLM の文脈に入ってしまい 49 §1-5(a) に反する

代わりに `network-investigation/ollama-mcp-client.ts` の `connectMcpTools(platforms)` を再利用した
(Ollama 版が `@modelcontextprotocol/sdk` で直接繋ぐために作ったもの)。
1 サイトの診断中は接続を張りっぱなしにして使い回し、終わったら `close()` する。

### 1-4. ホワイトリスト(49 §1-5(b) への対応)

```
aos10: show running-config / show radio config /
       show ids-detection config / show ids-protection config
aos8 : 上記 4 本 + show arm config
```

**動的に組み立てない。** 世代は `firmware_version` の先頭メジャー番号で判定する。

> **49 §5 の追加調査 #1 が解消した。**
> 49 番は「AOS8 で `show radio config` / `show ids-*` が動くか未検証」としていたが、
> 実機の AOS8 クラスタで**3 つとも実行できた**。AOS8 でこれらが unknown になるのは
> コマンドが無いからではなく、**出力に該当フィールドが含まれないから**(§1-5)。

失敗時の挙動は 3 経路すべて実機で確認した(§3-4)。

| 経路 | 応答 | 実装の扱い |
|---|---|---|
| 正常 | `{"status":"COMPLETED","output":{"results":[…]}}` | `ok` |
| カタログエラー | 先頭が `Error validating show commands:` の**プレーンテキスト**。`isError` は立たない。バッチ内の正常なコマンドの出力も返らない | バッチ全体を捨て、**1 コマンドずつ再実行**して生きているものを救う。理由は**先頭 301 文字に切って**保存 |
| その世代に無いコマンド | `results[].output` が `% Parse error.` | そのコマンドだけ `unsupported`。同じバッチの他のコマンドはそのまま使う |

### 1-5. 世代差で取れないもの(AOS8)

AOS8 の `show radio config` は AOS10 と**セクション構造は同じだが項目が少ない**。
実機で確認した欠落項目:

- `Max/Min channel bandwidth` … 出ない → RF-01 / RF-02 は `unknown`
- `Allowed channels` … 出ない → **RF-04 は `show arm config` のチャネル表に落とす**(実装済み・pass を確認)
- `Max/Min Tx Power` … 値は出るが **`127` = 未設定(ARM 任せ)の番兵** → `null` に落として RF-05 は `unknown`
- `Scanning-disable` / HE・EHT 系 … 出ない → RF-12 の無線側は `unknown`

一方 **SEC-07 / SEC-08 は AOS8 でも判定できた**。`show ids-detection config` が動くうえ、
50 §5 の補足どおり running-config の `ids` セクションにも
`infrastructure-detection-level` / `client-detection-level` が出るので、
**コマンドが失敗しても running-config 側にフォールバックする**実装にしてある。

### 1-6. 型への追加: `FindingStatus` に `"info"`

49 §3-2 の `FindingStatus` は `pass / warn / fail / not_applicable / unknown` の 5 値だったが、
**LLM 所見は合否を出さない**(49 §3-1 の 2)ため、どれにも寄せられない。
`unknown` に混ぜると「設定値を取得できなかった」件数が水増しされて意味が壊れる。

→ `"info"` を 1 値だけ追加した。`DiagnosisSummary` にも `info` を足してある。

### 1-7. 「存在しない無線」を診ないための帯域フィルタ

`show radio config` は **6GHz 無線を持たない機種でも `6.0 GHz` セクションを出力する**
(実機の Wi-Fi 5 機で確認)。これは無線プロファイルの一覧であって物理無線の一覧ではない。

そのまま診ると存在しない無線に対する所見が出るので、
`central_get_ap_details` の `radios[]` から**サイトに実在する帯域**を作り、それで絞っている。

実サイトで効果を確認できた例:
ある Central サイトの AP は `band_selection` が 5GHz / 6GHz の二者択一モードで
**2.4GHz 無線が 1 本も無い**。この AP のサイトでは 2.4GHz のルール(RF-01 / RF-04)が
**そもそも出力されない**(誤って fail / warn を出さない)。他の 4 サイトでは 25 ルールすべてが出る。

---

## 2. Task 2: API とデータ保存

### 2-1. エンドポイント

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/best-practice/status` | 設定 / ルール件数 / 実行中 / 直近 20 件 |
| GET | `/api/best-practice/rules` | ルールカタログ(根拠 URL 込み) |
| GET | `/api/best-practice/sites` | 診断できるサイト一覧(`?platform=central\|mist\|both`、60 秒キャッシュ) |
| POST | `/api/best-practice/run` | **診断実行**。`{ platform, siteId, siteName?, llm?, lang? }` |
| GET | `/api/best-practice/runs` | 実行一覧 |
| GET | `/api/best-practice/runs/:id` | 1 回分の詳細 |
| DELETE | `/api/best-practice/runs/:id` | 削除 |
| GET / PUT | `/api/best-practice/settings` | 設定 |

**実行は手動トリガーのみ。** スケジューラへの登録口はこのプラグインに存在しない(51 の確定事項)。

1 サイト 8〜10 秒かかるので `POST /run` は `runId` を即返し、実行はバックグラウンドで走らせる。
完了前に `GET /runs/:id` を叩くと **202 + `status:"running"`**、完了後は 200 で本体が返る。
同じサイトの二重実行は **409** で弾く(実機で確認済み・§3-5)。

### 2-2. 保存先

```
data/best-practice/settings.json     … LLM 所見の有効/無効・モデル・保存件数・無効ルール
data/best-practice/index.json        … 実行一覧(メタのみ)
data/best-practice/runs/<uuid>.json  … 1 回分の Finding[] 一式
```

`data/` は既に `.gitignore` 済み(`git check-ignore` で確認)。
書き込みは他プラグインと同じ「一時ファイル → rename」。`maxRuns`(既定 50)を超えた古い実行は自動で消す。

`Finding` は 49 §3-2 の型のまま。`references[]` はルールカタログ側に持ち、
Finding には `ruleId` だけを持たせて重複を避けている(`GET /rules` と突き合わせる)。
`requiresLegalReview` はルール定義から Finding へ転記される。

### 2-3. 既存プラグインとの重複回避

- 保存の作法(`atomicWrite` / index + 本体分割 / 上限で古いものを消す)は `reports/store.ts` と同型
- LLM 呼び出しは `knowledge/extract.ts` の `runClaudePlain`(MCP 無しの軽い claude CLI)と同型
- MCP 接続は `network-investigation/ollama-mcp-client.ts` を**そのまま再利用**(新規実装なし)

---

## 3. Task 3: 動作確認

### 3-1. 実サイトでの診断(5 サイト)

Central 3 サイト(AOS 10.8 / AOS 10.7 / AOS 8.6)+ Mist 2 サイト。全件 `error: none` で完走した。

| # | プラットフォーム | 世代・規模 | 所要 | Finding | 出たルール ID | pass | warn | fail | n/a | unknown |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A | Central | AOS 10.8 / AP 1 台 | 9.7s | 76 | 25/25 | 45 | 14 | 3 | 14 | **0** |
| B | Central | AOS 10.7 / AP 2 台(2.4GHz 無線なし) | 10.0s | 107 | 23/25 | 44 | 34 | 2 | 19 | 8 |
| C | Central | AOS 8.6 / AP 2 台(クラスタ) | 9.8s | 98 | 25/25 | 26 | 30 | 4 | 22 | 16 |
| D | Mist | AP 4 台 / RF テンプレートあり | 8.2s | 82 | 25/25 | 8 | 6 | 1 | 12 | 55 |
| E | Mist | AP 2 台 / RF テンプレートあり | 8.6s | 49 | 25/25 | 15 | 4 | 0 | 4 | 26 |

- **B の 23/25** は §1-7 のとおり「2.4GHz 無線が実在しないので 2.4GHz ルールを出さない」正しい挙動
- **A の unknown = 0**: AOS10 では 25 ルールすべてが機械的に決着した
- LLM 所見を有効にした実行(別途 1 件)では **SEC-12 / SEC-13 / RF-15 / RF-16 が `info` で 4 件**返り、
  いずれもスナップショットの値だけを根拠にした所見だった(存在しない値を作っていない)

### 3-2. AOS8 サイトで期待どおりになったこと

| 確認したいこと | 結果 |
|---|---|
| PMF 関連(SEC-04 / SEC-05)が unknown にならない | **なっていない。** WPA2 系 SSID 4 件が SEC-04 `fail`(MFPR=0/MFPC=0)、WPA3 系 3 件が SEC-05 `warn`(transition 既定有効)。50 §3-2 の実測と一致 |
| `show radio config` に依存する項目が unknown になる | **なる。** RF-01 = unknown 1 / RF-02 = unknown 2 / RF-05 = unknown 2 |
| RF-04 が ARM に落ちる | **落ちた。** `show arm config` のチャネル表から 2.4GHz の許可チャネルを読み `pass`。`1+` / `7+` のような 40MHz 結合表記は除外し、素の 20MHz チャネルだけで判定している |
| RF-13(ARM)が AOS8 で機能する | **した。** `Scanning` / `Client Match` とも enable → `pass`。AOS10 サイトでは全件 `not_applicable` |
| SEC-07 / SEC-08 が AOS8 で判定できる | **できた**(49 の想定より広い。§1-5)。検知レベル high → `pass`、SEC-09 が `warn`(Medium/High の注意喚起)|

### 3-3. 機密情報の非保存・非 LLM 渡し(実データで確認)

実機の running-config には `virtual-controller-key` / `hash-mgmt-user` / `wpa-passphrase` /
RADIUS 共有シークレット(`key`)/ `nas-id` が実在する(49 §1-5(a) のとおり)。
その状態で収集を通し、**保存物と LLM 入力の両方を機械的に検査した**。

| 検査 | 対象 | 結果 |
|---|---|---|
| 32 文字以上の連続 hex(鍵・ハッシュの形) | 保存済み run すべて | **0 件** |
| 鍵らしきキー名 + 値(`"psk":"…"` 等) | 保存済み run すべて | **0 件** |
| running-config の生テキストの痕跡(`wpa-passphrase ` / `virtual-controller-key ` / `COMMAND=show running-config`) | 保存済み run すべて | **0 件** |
| 実 SSID 5 件を含む LLM コンテキスト | `buildContext()` の出力 | hex ブロブ 0 / passphrase 値 0 |
| 失敗理由(`step.detail`)の長さ | 保存済み run すべて | 最大 **301 文字**(上限どおり) |

構造上の担保:

1. `collectCentralSite()` の中で生テキストをパースし、**返り値にも `steps.detail` にも載せない**。
   `outputs` はループのスコープを出ず、明示的に `clear()` してから次へ進む
2. `parseSsidProfiles()` は鍵の**値を返す経路が無い**(`hasPassphrase` / `hasWepKey` の真偽値のみ)
3. LLM へは `buildContext()` が組み立てた正規化構造体だけを渡す。
   さらに送信直前に `assertNoSecrets()` で検査し、**引っかかったら LLM を起こさずに失敗させる**

3 の負のテスト(わざと混ぜたら止まるか)も実施:

| 混ぜたもの | 結果 |
|---|---|
| `"psk":"…"` というキー | **送信前に例外**(SEC-12 等は `unknown` + 理由付きで保存)|
| `"wpa-passphrase":"…"` というキー | **送信前に例外** |
| 32 文字以上の hex ブロブ | **送信前に例外** |

### 3-4. ホワイトリスト運用(実機で 3 経路とも確認)

AOS10 の実機に対して意図的に壊したコマンド列を投げ、挙動を確かめた。

| ケース | 投げたもの | 結果 |
|---|---|---|
| A. 正常系 | ホワイトリスト 4 本 | 4 本とも `ok`。出力 4 本を取得 |
| B. カタログに無いコマンドを混入 | 正常 1 本 + 存在しないコマンド 1 本 | バッチが `catalog_error` で全滅 → **1 本ずつ再実行して正常なほうを救出**。壊れたほうだけ `catalog_error`。**detail は 301 文字**(生のカタログ応答は 27,000 文字超) |
| C. その世代に無いコマンド | `show arm config`(AOS10)+ 正常 1 本 | `% Parse error.` を検出して `unsupported`。**同じバッチの正常なコマンドはそのまま使える** |

5 サイトの本番実行では **`catalog_error` は 1 件も発生していない**(ホワイトリストが効いている)。

### 3-5. API の疎通

サーバを起動して HTTP で確認した。

- `GET /status` → ルール 29 件(機械 25 / LLM 4 / セキュリティ 13 / RF 16)
- `GET /rules` → 29 件。各ルールに `references[]`(タイトル + URL)が入っている
- `GET /sites` → Central 5 + Mist 9 = **14 サイト**(AP 台数付き)
- `POST /run` → `runId` を即返す
- 同じサイトへ二重に `POST /run` → **409**「同じサイトの診断が実行中です」
- 実行中の `GET /runs/:id` → **202** `status:"running"` / 完了後 → **200** で Finding 49 件
- `trigger` は `"manual"` 固定

### 3-6. パーサの異常入力耐性

収集の失敗がそのままパーサへ落ちても例外を投げないことを確認した(50 §3-3 の再確認 + 新規パーサ分)。

| 入力 | 全 7 パーサの結果 |
|---|---|
| 空文字列 | 0 件 / null。例外なし |
| `% Parse error.` | 0 件 / null。例外なし |
| コマンドカタログ全文 | 0 件 / null。例外なし |

---

## 4. 49 / 50 番の記載に対する訂正・追記

| 箇所 | これまでの記載 | 51 番での確定 |
|---|---|---|
| 49 §3-4 の件数 | 「RF は機械判定 12 + LLM 2 = 14 件」 | **表の行は RF-01〜16 の 16 行**。機械判定は 14。合計 29 ID(§1-1) |
| 49 §4-3 / §5 追加調査 #1 | 「AOS8 で `show radio config` / `show ids-*` が動くか未検証」 | **3 つとも動く。** AOS8 で unknown になるのは出力に該当フィールドが無いから(§1-5) |
| 49 §3-3 SEC-07 / SEC-08 | 「AOS8 では unknown になりうる」 | **AOS8 でも判定できる。** `show ids-detection config` + running-config の `ids` セクションの二段構え |
| 49 §3-4 RF-04 | 「`show radio config` の Allowed channels」 | AOS8 には無いので **`show arm config` のチャネル表にフォールバック**(実機で pass を確認) |
| 49 §1-2 の 9(Tx 電力) | 「`Max Tx Power` / `Min Tx Power`」 | **`127` は未設定(ARM 任せ)の番兵。** 数値として扱うと差分 0 の誤判定になるため null に落とす |
| 49 §3-2 `FindingStatus` | 5 値 | **`"info"` を追加**(LLM 所見用。§1-6) |
| 49 §3-5(Mist の SEC-01〜03) | 「`auth.pairwise[]` で判定」 | **`auth.pairwise` を持たない WLAN が実在する**(サイトスコープに多い)。既定値を勝手に埋めず `pairwiseUnset` として `unknown` に落とす |
| — (新規) | — | `show radio config` は**物理無線を持たない帯域のセクションも出す**。`ap_details.radios[]` で絞らないと存在しない無線に所見が出る(§1-7) |

---

## 5. 未接続のまま残っている部分

| # | 内容 | 状況 |
|---|---|---|
| 1 | **タブ UI** | 未実装(51 で範囲外と明示)。API はすべて揃っている |
| 2 | **i18n 辞書(`ja.json` / `en.json`)** | 未追加。**キー名は確定済み**: `bestPractice.rules.<ID>.title` / `.desc`、`bestPractice.findings.<ID>.<case>`、重要度ラベル。画面に出る文言がまだ 1 つも無いので、UI 実装時にまとめて入れる(50 番と同じ方針) |
| 3 | **Marvis Actions の併記** | 49 §3-5 の「設定診断とは別枠で並べる」は UI 側の話なので未着手 |
| 4 | **Mist の rogue / WIDS 設定** | `get_mist_config` の `resource_type` から到達できないまま(49 §2-5)。SEC-07〜11 は Mist で `unknown` を返す。到達手段が見つかれば `collect-mist.ts` に足すだけで判定側は変更不要 |
| 5 | **Mist の RF-08〜RF-12** | 該当フィールドを確認できていないので `unknown`(49 §3-5 のとおり) |
| 6 | **AirMatch の設定取得(49 §5 #4)** | 未着手。RF-16 は LLM 所見のまま |
| 7 | **サイト内の設定差異** | 代表 AP 1 台のサンプリングなので原理的に診られない(49 §4-2)。`sampledDeviceIds` に対象を残してあるので、UI で「この AP を見た結果です」と明示できる |

---

## 6. 参照した根拠ドキュメント

ルール定義(`rules.ts`)の `references[]` に URL ごと埋め込んである。出典は 49 §6 と同じ 8 件で、
**タイトルと URL は翻訳しない**(49 §4-4)。

| ID で参照 | タイトル |
|---|---|
| SEC-01/02/03/06、SEC-12/13 | Security modes |
| SEC-04 | Protected management frames |
| SEC-04/05 | wlan ssid-profile(CLI-Bank / Instant) |
| SEC-07/08/09 | WIDS/WIPS — Detection |
| SEC-10/11 | WIDS/WIPS — Protection |
| RF-01/02/05〜14 | RF Design(Validated Solution Guide) |
| RF-03/04/15 | Radio frequency planning and channel optimization(LPV) |
| RF-16 | AirMatch(AOS 10) |
