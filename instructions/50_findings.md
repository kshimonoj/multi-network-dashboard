# 50: PMF(802.11w)出力形式の確定 + AOS8 の扱い

実施日: 2026-08-02 / 対象: PMF 解析方法の確定・パーサ実装・動作確認(git 操作なし)

49 番の §1-3 / §5-2 / §5-3 に残っていた「未検証」を解消した記録。
**49 番と同じく、実際の設定値そのもの(サイト名・SSID 名・シリアル)は記載しない。**

---

## 0. 要約

| | 結果 |
|---|---|
| PMF の出力形式 | **確定**。`mfp-capable` / `mfp-required` は ssid-profile 配下の**独立した 1 行**。`opmode` の引数ではない |
| 確定方法 | **公式ドキュメント 2 種 + 実機 3 台の running-config**。本番設定の変更は**一切行っていない** |
| 副産物(想定外の収穫) | `opmode-transition` / `opmode-transition-disable` が running-config から読めることが判明。**SEC-05 を `unknown` 固定から機械判定に格上げ**できた(49 §5-3 の解消) |
| 副産物 2 | `mbo-enable` が `mfp-capable` を**暗黙で有効化**する(公式 CLI リファレンス記載)。判定に織り込んだ |
| 実装 | `plugins/best-practice/` に `types.ts` / `running-config.ts` / `pmf.ts` を新規作成。`npm run typecheck` 通過 |
| 動作確認 | 合成 16 ケース + **実機 3 台 / 実 SSID 12 件**で期待どおり。異常入力 5 種で例外を出さないことも確認 |
| AOS8 | **PMF に関しては unknown にならず判定できる**(running-config は AOS8 でも同一構文)。unknown のままなのは `show radio config` / `show ids-*` に依存する項目のみ |

---

## 1. Task 1: PMF 出力形式の確定

### 1-1. 実機に該当 SSID があるかの確認(手順 1)

`central_get_wlans` で org 全体の WLAN を棚卸しした結果、**WPA2 系の SSID は実在した**(有効 2 件・無効 4 件)。
うち 1 件は AOS 10 機、1 件は AOS 8 クラスタで**有効**な状態で運用されている。

該当機の `show running-config` を取得した結果:

- **どの WPA2 SSID にも `mfp-capable` / `mfp-required` は設定されていなかった**
- `opmode` 行は `opmode wpa2-aes` / `opmode wpa2-psk-aes` の形で、**後続トークンは無い**

→ 「PMF **未設定**の WPA2 SSID が running-config でどう出るか」は実機で確定した(= 行そのものが出ない)。
一方で「PMF **設定済み**の場合にどう出るか」は、実環境に該当 SSID が無いため実機では確認できなかった。

### 1-2. 設定変更はしていない(手順 2 の選択)

指示のとおり本番 SSID の変更は行わず、**公式ドキュメントで確定させる**方を選んだ。
テスト用 SSID の作成も行っていない(実施していれば事前に報告・確認を取る運びだった)。

### 1-3. 公式ドキュメントによる確定(決め手)

**根拠 A — CLI リファレンス(パラメータの並び)**

[wlan ssid-profile(CLI-Bank / Instant)](https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/instant/wlan-ssid-prof.htm)
のシンタックス一覧で、`mfp-capable` と `mfp-required` は
`opmode <opmode>` と**同じ階層の独立したパラメータ**として列挙されている。
`opmode` の定義は `opmode <opmode>` で引数は 1 つ、`Range` は暗号方式の列挙のみで
mfp 系トークンを含まない。

> mfp-capable … When enabled, the SSID supports Management Frame Protection capable clients and non-MFP clients. Default: Disabled
> mfp-required … When enabled, the SSID supports only the clients that exhibt the MFP functionality. Default: Disabled

**根拠 B — 公式の設定例(実際の改行位置)**

[WPA3-Enterprise](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/wpa3-enterprise/)
の設定例ブロックを DOM から `innerText` として取り出した生の文字列:

```
wlan ssid-profile "ACME_1X_WPA3"
essid "ACME_1X_WPA3"
opmode wpa2-aes
mfp-capable
mfp-required
!
```

→ **改行で区切られた独立行**であることが確定した。

**注意(紛らわしかった点)**: 検索エンジンの要約はこのブロックを
`... opmode wpa2-aes mfp-capable mfp-required` と**1 行に連結して**返してくる。
49 番が「opmode 行の後続トークンかもしれない」と迷った原因はこれで、
実際には**改行が要約時に潰れていただけ**だった。

### 1-4. それでもパーサは両対応にする(手順 3)

確定はしたが、指示どおり**両方の形式を受けるフォールバック設計**にした
(`plugins/best-practice/running-config.ts` の `detectMfpTokens()`)。

| 形式 | 例 | 実装 |
|---|---|---|
| (A) 正規形・確定済み | `opmode wpa2-aes` の次行に ` mfp-capable` / ` mfp-required` | 独立行として検出 |
| (B) フォールバック | `opmode wpa2-aes mfp-capable mfp-required` | `opmode` 行の**2 番目以降のトークン**を走査して検出 |

`opmode` の**本体は常に先頭 1 トークンのみ**として読む。これにより (B) の形が来ても
`opmode` の値が `wpa2-aes mfp-capable ...` のように壊れない。

あわせて次にも対応した。

- `no mfp-capable` / `no mfp-required` による打ち消し(後勝ち)
- ブロック名・値の引用符(`wlan ssid-profile "name with spaces"` / `essid "name with spaces"`)
- コントローラ形式のブロック終端 `!`

### 1-5. 想定外の収穫: transition mode が読める(49 §5-3 の解消)

同じ CLI リファレンスに、**`opmode-transition` / `opmode-transition-disable` が
ssid-profile の独立パラメータとして存在する**ことが記載されていた(`Default: Enabled`)。

つまり running-config から transition mode を判定できる:

| running-config | transition mode |
|---|---|
| `opmode-transition-disable` あり | **無効** |
| `opmode-transition` あり | 有効 |
| どちらも無い | **有効(既定値)** ← 既定値は出力されないため |

公式ドキュメントの記述とも整合する:

> WPA3-Enterprise CCM 128 in transition mode (default behavior) … Protected Management Frames are capable and automatically set as optional (MFPR=0 and MFPC=1).
> — [WPA3-Enterprise](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/wpa3-enterprise/)

> Due to the same BSS servicing both WPA2-Personal (PSK) and WPA3-Personal (SAE) clients, Protected Management Frames are optional (MFPR=0 and MFPC=1) for WPA3-Personal Transition networks.
> — [WPA3-Personal](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/wpa3-personal/)

→ **SEC-05 を `unknown` 固定から機械判定へ格上げした**(§2-2)。
ただし「明示行が無い = 既定値」という**推定**を含むため、
`observed.transitionAssumedDefault` にその旨を残し、画面側で区別できるようにしてある。

### 1-6. 想定外の収穫 2: `mbo-enable` は PMF を暗黙で有効化する

> mbo-enable … Enables the Agile Multiband Operations (MBO). **Enables the mfp-capable**, 802.11k and 802.11u-interworking implicitly on the AP.
> — 同 CLI リファレンス

→ `mfp-capable` 行が無くても `mbo-enable` があれば MFPC=1。
判定に織り込み、根拠を `basis: "implicit-mbo"` として区別できるようにした。

### 1-7. Enhanced Open の扱い(49 の表に無かった行)

[Enhanced Open](https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/enhanced-open/) より:

> PMF is required (MFPR=1 and MFPC=1) for the OWE BSS.

→ transition mode でも **OWE BSS 自体は常に PMF 必須**(併設される open BSS 側に PMF が無いだけ)。
Enhanced Open は帯域・transition mode によらず 1/1 とした。

---

## 2. Task 2: チェックルール設計への反映

### 2-1. 確定した decoder ring(49 §1-3 の差し替え版)

`plugins/best-practice/pmf.ts` の `resolvePmf()` がこの表を実装している。

| opmode ファミリ | opmode | 2.4 / 5GHz | 6GHz | 判定根拠(`basis`) |
|---|---|---|---|---|
| `enhanced-open` | `enhanced-open` | MFPR=1 / MFPC=1 | 1 / 1 | `auto-by-opmode` |
| `wpa3-always-pmf` | `wpa3-cnsa` / `wpa3-aes-gcm-256` | 1 / 1 | 1 / 1 | `auto-by-opmode` |
| `wpa3-transitionable` | `wpa3-sae-aes` / `wpa3-aes-ccm-128` | transition 有効 → **0 / 1**<br>transition 無効 → 1 / 1 | 常に 1 / 1 | `auto-by-transition`<br>(6GHz は `auto-by-opmode`) |
| `wpa2` | `wpa2-aes` / `wpa2-psk-aes` / `mpsk-aes` | `mfp-required` → 1 / 1<br>`mfp-capable` → 0 / 1<br>`mbo-enable` → 0 / 1<br>いずれも無し → **0 / 0** | 規格上不可 → `not_applicable` | `explicit` / `implicit-mbo` / `default-disabled` |
| `legacy` | WEP / TKIP / `opensystem` および TKIP を含む混在 opmode | 0 / 0 | `not_applicable` | `default-disabled` |
| `unknown` | 上記以外(将来の opmode) | 判定不能 | 判定不能 | `unknown` |

**49 番からの変更点**: 49 の表は `wpa3-*` の 6GHz を一律 1/1 とする点は同じだが、
`enhanced-open` の行が無く、混在 opmode(`wpa-tkip,wpa2-aes` 等)と `mpsk-aes` の扱いが未定義だった。
今回それぞれ `legacy` / `wpa2` に分類して埋めた。

### 2-2. ルール定義の更新

| ID | 49 番での設計 | 50 番での確定 |
|---|---|---|
| **SEC-04**<br>WPA2 SSID の PMF 未設定 | 「`mfp-capable` / `mfp-required` 行の有無を見る。ただし出力形式が未確定」 | **確定**。独立行を第一に、opmode 行の後続トークンをフォールバックで検出。<br>`mfp-required` → `pass` / `mfp-capable` のみ → `warn` /<br>**`mbo-enable` による暗黙 capable → `warn`(新規)** / いずれも無し → `fail`。<br>WPA2 系以外は `not_applicable`、opmode 不明は `unknown` |
| **SEC-05**<br>WPA3 transition mode の常用回避 | 「取得方法が未確定なので当面 `unknown` を返す」 | **機械判定に格上げ**。`opmode-transition-disable` → `pass` /<br>それ以外(既定含む)→ `warn`。<br>6GHz 単独 SSID と非対象 opmode は `not_applicable`。<br>既定値からの推定であることは `observed.transitionAssumedDefault` で明示 |

`messageCode` は次を新設(いずれも `bestPractice.findings.<rule>.<case>`):

```
SEC-04.required / SEC-04.capableOnly / SEC-04.capableViaMbo /
SEC-04.disabled / SEC-04.notWpa2 / SEC-04.opmodeUnknown
SEC-05.enabled / SEC-05.disabled / SEC-05.oweTransition /
SEC-05.notApplicable / SEC-05.opmodeUnknown
```

**i18n について**: 49 §4-4 のとおり、これらの `messageCode` と `titleKey` /
`descriptionKey` は `src/i18n/ja.json` と `en.json` の**両方**に追加する必要がある。
50 番の時点では**タブ UI がまだ無く画面に出る文言が 1 つも無い**ため、辞書への追加は
**UI 実装時にまとめて行う**ことにして、今回は追加していない(キー名だけ先に確定させた)。

### 2-3. 機微情報の扱い(49 §1-5(a) の遵守)

`parseSsidProfiles()` は `wpa-passphrase` / `wep-key` / `key` / `hash-mgmt-user` の
**値を一切返さない**。`hasPassphrase` / `hasWepKey` の真偽値だけを構造体に残す。
動作確認スクリプトでも、構造体に passphrase 値が混入していないことを毎ケース検査した(全件 `none`)。

---

## 3. Task 3: 動作確認

`npm run typecheck` 通過。確認用スクリプトとデータは**リポジトリ外**(スクラッチパッド)に置き、
実機 running-config は鍵・パスフレーズを `REDACTED` に置換したうえで使用した。

### 3-1. 合成ケース(16 件)

テストデータは CLAUDE.md の方針どおり、明らかな偽物と分かる値(`test-*` / `aabbccddeeff`)で作成。

| ケース | 期待 | 結果 |
|---|---|:--:|
| (A) 独立行 `mfp-capable` + `mfp-required` | 1/1・SEC-04 `pass` | ✓ |
| (A) 独立行 `mfp-capable` のみ | 0/1・SEC-04 `warn` | ✓ |
| (B) `opmode wpa2-aes mfp-capable mfp-required` | 1/1・SEC-04 `pass` | ✓ |
| (B) `opmode wpa2-psk-aes mfp-capable` | 0/1・SEC-04 `warn` | ✓ |
| `no mfp-required` による打ち消し | 0/1・SEC-04 `warn` | ✓ |
| `mbo-enable` による暗黙 capable | 0/1・`implicit-mbo`・SEC-04 `warn` | ✓ |
| WPA2 で mfp 行なし | 0/0・SEC-04 `fail` | ✓ |
| WPA3-SAE(transition 既定) | 2.4/5 は 0/1・6GHz は 1/1・SEC-05 `warn` | ✓ |
| WPA3-SAE + `opmode-transition-disable` | 1/1・SEC-05 `pass` | ✓ |
| 6GHz 単独(`rf-band none` + `rf-band-6ghz`) | 1/1・SEC-05 `not_applicable` | ✓ |
| Enhanced Open | 1/1 | ✓ |
| `wpa3-cnsa` | 1/1・SEC-05 `not_applicable` | ✓ |
| レガシー TKIP | 0/0・SEC-04 `not_applicable` | ✓ |
| WPA2 に 6GHz を付けた場合 | 6GHz だけ `not-applicable` | ✓ |
| 引用符付き名 + `!` 終端(コントローラ形式) | 正しく 1 件として解析 | ✓ |
| 未知の opmode | `unknown`(例外を投げない) | ✓ |

### 3-2. 実データ(実機 3 台・SSID 12 件)

| 機器 | 世代 | SSID 数 | 結果 |
|---|---|---:|---|
| AP-505H | AOS 10.8.1 | 5 | WPA3 系 4 件は自動判定、**WPA2-Enterprise 1 件が SEC-04 `fail`(MFPR=0/MFPC=0)** |
| AP-605H | AOS 10.8.1 | 8 | 全件 WPA3 系。`mfp-*` 行は 1 件も出力されない(ドキュメント記述と整合) |
| AP-225 クラスタ | AOS 8.6 | 7 | **WPA2 系 4 件がすべて SEC-04 `fail`**、WPA3 系 3 件は自動判定 |

指示にあった期待どおりの結果になった。

- **WPA3-SAE の SSID は PMF 必須と判定される** … 6GHz では MFPR=1/MFPC=1。
  ただし 2.4/5GHz では **transition mode が既定で有効なため MFPR=0/MFPC=1(任意)**になる。
  これは仕様どおりで、SEC-05 が `warn` を出してこの状態を可視化する
- **WPA2 系で PMF 設定があれば正しく検出される** … 実環境に該当 SSID が無いため合成ケースで確認(§3-1)
- **無ければ妥当な判定になる** … MFPR=0/MFPC=0 として SEC-04 `fail`

### 3-3. 異常入力(5 件)— 例外を投げないこと

| 入力 | 結果 |
|---|---|
| 空文字列 | 0 件・例外なし |
| `% Parse error.` | 0 件・例外なし |
| 未対応コマンド時のコマンドカタログ全文(49 §1-5(b)) | 0 件・例外なし |
| `opmode` の値が欠けた壊れたブロック | 1 件・SEC-04 / SEC-05 とも `unknown` |
| 帯域が 1 つも無い SSID | 1 件・例外なし |

→ 収集フェーズがエラー応答を渡しても、**例外ではなく `unknown` に落ちる**ことを確認した。

---

## 4. AOS8 の扱い

指示どおり AOS8 を対象外として扱う前提は維持する。ただし**実データを見た結果、
訂正すべき点が 1 つある**ので記録する。

### 4-1. 訂正: PMF に関しては AOS8 でも判定できる

49 番は AOS8 の該当項目を `unknown` にする設計だったが、これは
`show radio config` / `show ids-detection config` / `show ids-protection config` が
AOS8 で動くか未検証だったことに由来する。

**PMF(SEC-04 / SEC-05)は `show running-config` だけで判定でき、
AOS8(Instant 8.6)の running-config は AOS10 と同一の `wlan ssid-profile` 構文**だった。
実機の AOS8 クラスタから取得した 7 件の ssid-profile を、同じパーサが**そのまま解析できた**
(§3-2)。世代分岐は不要。

→ **SEC-04 / SEC-05 は AOS8 でも `unknown` にならない。** unknown 扱いのままなのは
49 §4-3 のうち `show radio config` / `show ids-*` に依存する項目(RF-01/02/04/05〜07、SEC-07〜SEC-11)だけ。

### 4-2. エラーにならないことの確認

AOS8 機に対して未対応コマンドを投げると 49 §1-5(b) のとおり巨大なカタログが返るため、
**今回は該当コマンドを実行していない**(指示どおり深追いしない)。
代わりに、そのカタログ文字列や `% Parse error.` を収集結果としてパーサに渡した場合に
**例外ではなく `unknown` になる**ことをコード側で確認した(§3-3)。

---

## 5. 49_findings.md に対する訂正

| 箇所 | 49 番の記載 | 50 番での確定 |
|---|---|---|
| §1-3 | 「`mfp-capable` / `mfp-required` が独立行か opmode 行の後続トークンかは未検証」 | **独立行で確定**(§1-3)。パーサは両対応済み |
| §1-3 / §3-3 SEC-05 | 「WPA3 transition mode を running-config から読む方法が未検証。当面 `unknown` を返す」 | **`opmode-transition` / `opmode-transition-disable` で読める。機械判定に格上げ**(§1-5) |
| §1-3 の decoder ring | `enhanced-open` / 混在 opmode / `mpsk-aes` の行が無い | §2-1 の表で補完 |
| §3-3 SEC-04 | `mbo-enable` を考慮していない | `mbo-enable` は `mfp-capable` を暗黙で有効化するため `warn` 扱いを追加(§1-6) |
| §5 の追加調査 #2 / #3 | 未解決として列挙 | **どちらも解決済み**(#2 = §1-3、#3 = §1-5) |
| §4-3 の世代分岐 | AOS8 の該当項目は `unknown` | PMF については AOS8 でも判定可能(§4-1) |

**補足(今回の副産物・未深追い)**: AOS8 機の running-config には
`ids` セクションに `infrastructure-detection-level` / `client-detection-level` が
**そのまま出力されていた**。AOS10 側の同セクションには含まれない(`wireless-containment` のみ)。
SEC-07 / SEC-08 を AOS8 でも判定できる可能性があるが、
今回の指示範囲外のため**深追いしていない**。次に AOS8 を扱うときの入口として記録しておく。

---

## 6. 追加した実装

| ファイル | 内容 |
|---|---|
| `plugins/best-practice/types.ts` | 49 §3-2 の型定義(`BestPracticeRule` / `Finding` 等)+ `SsidProfileConfig` |
| `plugins/best-practice/running-config.ts` | `parseSsidProfiles()`。ssid-profile ブロックの切り出しと正規化。**鍵・パスフレーズを返さない** |
| `plugins/best-practice/pmf.ts` | `classifyOpmode()` / `resolvePmf()`(decoder ring)/ `evaluateSec04()` / `evaluateSec05()` |

いずれもサーバ側の純粋関数のみで、ルーティング・画面・スケジュールには未接続。
`npm run typecheck` 通過。

---

## 7. 参照した根拠ドキュメント

| 用途 | タイトル | URL |
|---|---|---|
| mfp-capable / mfp-required / opmode-transition / mbo-enable のパラメータ定義 | wlan ssid-profile(CLI-Bank / Instant) | https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/instant/wlan-ssid-prof.htm |
| 独立行であることを示す設定例・transition mode の既定と MFPR/MFPC | WPA3-Enterprise | https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/wpa3-enterprise/ |
| SAE の transition / only mode の MFPR/MFPC | WPA3-Personal | https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/wpa3-personal/ |
| OWE BSS の PMF 必須 | Enhanced Open | https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/enhanced-open/ |
| PMF の 3 状態(Disabled / Capable / Mandatory) | Protected management frames | https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/features/pmf/ |
