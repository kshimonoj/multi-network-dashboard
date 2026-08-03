# 51: ベストプラクティス診断ルールの実装・接続(Central + Mist、全27項目、手動トリガー)

## 背景(49/50番からの引き継ぎ)

- 49番でセキュリティ13項目(機械判定11+LLM所見2)・RF14項目(機械判定12+LLM所見2)のチェックルール設計が完了している(`instructions/49_findings.md`)。うち8件はMistでも同一ロジックを再利用可能
- 50番でPMF(mfp-capable/mfp-required)の出力形式を確定し、`plugins/best-practice/types.ts` / `running-config.ts` / `pmf.ts` を純粋関数として実装済み。まだルーティング・画面・スケジュールには未接続
- 全ルールは `category` / `priority`(must/strong/recommended/advisory) / `method` / `references[]`(根拠URL必須) を持つTypeScript型として設計済み
- 封じ込め(containment)系は「無効=fail」にせず「有効化を検討する場合は法務確認を促す」方向(`requiresLegalReview`フラグ)で統一する方針
- AOS8は対象外の項目(`show radio config` / `show ids-detection config` / `show ids-protection config` に依存する項目)がある一方、PMF(SEC-04/SEC-05)はAOS8でも判定可能と判明済み

## 今回の実装範囲(確定事項)

- **Central + Mist の両方を最初から実装する**(共通ロジックを再利用可能な8項目を含む)
- **セキュリティ13項目・RF14項目の全27項目を一括実装する**(段階的な絞り込みはしない)
- **実行トリガーはユーザーが手動で「診断実行」を押した時のみ**(レポートタブのようなスケジュール実行は行わない)
- サイトごとに代表AP 1台をサンプリングする方式(49番の設計通り、デバイス単位でしか設定取得できないため)

## タスク

### Task 1: 実行エンジンの実装(plugins/best-practice/)

1. サイトを指定して「診断実行」した際に、そのサイトの代表AP(Central)または代表デバイス(Mist)を1台選び、ホワイトリスト固定のコマンド/APIで設定を取得する処理を実装する
   - Central: `central_run_show_commands`のホワイトリストコマンドのみ実行(49番で確認済みのコマンド群。未対応コマンドが1つ混ざると全カタログが失敗するため、動作確認済みコマンドのみに限定すること)
   - Mist: `get_mist_config`/`get_mist_stats`等で `wlans[].auth.pairwise[]`、`rftemplates[].band_*` 等の代替データ源から取得(49番で確認済みの構造)
2. 取得した生の設定データ(特に`show running-config`相当)は、機密情報(仮想コントローラキー・WPAパスフレーズ・RADIUS共有シークレット/IP等)を含むため、**生テキストは保存せず、LLMにも渡さない**。パース済みの構造化データのみを次の判定ステップに渡す設計にすること
3. 既存実装(`running-config.ts`/`pmf.ts`)を土台に、49番のfindingsに記載された全27項目分のパーサー・判定関数を実装する
   - 機械判定項目は決定的なロジックで判定(pass/fail/warn/unknown)
   - LLM所見項目(セキュリティ2件・RF2件)は軽量LLM呼び出しで所見を生成
   - 封じ込め系は`requiresLegalReview`フラグを持たせ、無効を即failにしない
   - AOS8で`show radio config`/`show ids-*`系に依存する項目は`unknown`として扱う(50番の確認通りPMF関連はunknown化しない)

### Task 2: APIとデータ保存

1. 「診断実行」を受け付けるエンドポイントを新設し、サイト単位で27項目の判定結果を返す/保存する(保存先は`data/best-practice/`配下などプロジェクトの既存の`data/`配置慣習に合わせること)
2. 結果には`category`/`priority`/`method`/`references[]`/`requiresLegalReview`を含め、49番の型定義をそのまま活用する
3. 既存の他プラグイン(reports/knowledge等)の実装パターンに倣い、無用な重複実装を避ける

### Task 3: 動作確認

1. 実際のサイト(Central・Mist双方)で「診断実行」相当の処理を動かし、27項目それぞれについて期待通りの判定結果(pass/fail/warn/unknown/requiresLegalReview)が得られることを確認する
2. AOS8サイトでは該当項目が`unknown`になり、PMF関連は判定可能であることを確認する
3. 機密情報(パスフレーズ・シークレット等)が結果データやログに一切含まれないことを確認する
4. 未対応コマンドの混入で全カタログが失敗しないよう、ホワイトリスト運用が機能していることを確認する

## 制約

- 今回はUI(タブ画面)の実装は範囲外。API/実行エンジン/データ保存までとする
- 本番のSSID・WLAN設定の変更は一切行わない
- git操作は行わない
- i18n辞書(ja.json/en.json)への追加はUI実装時に回してよい(キー名だけ確定させておく程度で可)

## 完了報告

verified-report形式で報告すること。特に:

- Central/Mist双方で実際にどの項目まで判定できたか(pass/fail/warn/unknown/requiresLegalReviewの内訳)
- 機密情報の非保存・非LLM渡しが実データで確認できたか
- ホワイトリスト運用の動作確認結果
- 未接続のまま残った部分(UIなど)の明記

---
**推奨モデル: Opus**(27項目の判定ロジック設計・Central/Mist双方の実行エンジン設計・機密情報の扱いなど、トレードオフ判断を伴う実装のため)
