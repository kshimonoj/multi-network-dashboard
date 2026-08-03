# 52: 「ベストプラクティス」タブのUI実装

## 背景(49〜51番からの引き継ぎ)

- 49番でチェックルール(29 ID、機械判定25+LLM所見4)を設計、50番でPMF出力形式を確定、51番で`plugins/best-practice/`に実行エンジン・API(`/api/best-practice`)・データ保存まで実装済み
- 実行はユーザーが手動で「診断実行」を押した時のみ(サイトごとに代表AP1台をサンプリング)。スケジュール実行は無い
- 結果は`category`/`priority`(must/strong/recommended/advisory)/`method`/`references[]`/`requiresLegalReview`を持つ形式で返る。判定値はpass/fail/warn/unknown
- i18nキー名は`bestPractice.rules.<ID>.title`/`.desc`等で確定済み(ja.json/en.json本体への追加は今回のタスクに含む)
- 封じ込め系(SEC-10/11)は無効でもfailにせず、有効化を検討する場合のみ法務確認を促す(`requiresLegalReview`)表示にする
- Mist側はSEC-07〜11・RF-08〜12が構造的にunknownになる(到達できないデータのため)。AirMatch(RF-16)はLLM所見のみ

## タスク

### Task 1: タブの新設

1. 既存タブ(Global Overview / Event・Alert / Webhookログ / Streaming / レポート / ナレッジ)と並ぶ形で「ベストプラクティス」タブを追加する
2. サイト選択(既存のGlobal Overviewのサイト一覧・SiteFocusRequestの仕組みを流用できるか確認し、可能なら再利用する)
3. 選択したサイトに対して「診断実行」ボタンを配置。実行中はローディング表示(所要時間は51番実測で8〜10秒程度)

### Task 2: 結果表示

1. 実行結果を一覧表示する。最低限以下を満たすこと:
   - カテゴリ(セキュリティ/RF)ごとにグルーピング
   - 各ルールについて判定値(pass/fail/warn/unknown)を色分けやバッジ等で視覚的に区別
   - priority(must/strong/recommended/advisory)も併記し、fail/warnの中でも優先度が分かるようにする
   - requiresLegalReviewが立っている項目は「有効化を検討する場合は法務確認を」という趣旨の表示にする(無効=failのような否定的な表現にしない)
   - references[](根拠URL)へのリンクを各ルールに表示
   - unknownの項目は「取得不可」であることが分かる表示にし、fail/warnと混同されないようにする(51番の実データではMist側でSEC-07〜11/RF-08〜12がunknownになる)
2. LLM所見系の4項目(SEC-12/13, RF-15/16)は、機械判定項目と見分けがつくように表示する(所見はスナップショットの値のみを根拠にした参考情報である旨を示す)

### Task 3: i18n対応

1. `bestPractice.rules.<ID>.title`/`.desc`等、確定済みのキー名に沿ってja.json/en.jsonへ実際の文言を追加する(日英両方)
2. タブ名・「診断実行」ボタン・判定値ラベル(pass/fail/warn/unknown)・「法務確認」表示等、画面上の全ての新規文言をja.json/en.json両方に追加する
3. i18nの運用ルール(CLAUDE.md記載済み)に従う: 動的生成文もテンプレート両方用意、モデル出力の自然言語パース禁止でマーカー方式

### Task 4: 動作確認

1. Central/Mist双方のサイトで実際にタブから「診断実行」→結果表示までの一連の流れが動くことを確認する
2. unknown項目・requiresLegalReview項目・fail項目それぞれの表示が意図通りであることを確認する
3. 日英切替・ダークモードでの表示崩れが無いことを確認する
4. 他タブへの影響が無いことを確認する

## 制約

- 本番のSSID・WLAN設定の変更は一切行わない
- git操作は行わない
- 既存タブのデザイン言語(色使い・レイアウト・コンポーネント)に合わせる。新しいUIパターンを増やさない

## 完了報告

verified-report形式で報告すること。特に:

- 実際にサイトを選んで診断実行→結果表示まで動いたことの実データ確認
- unknown/requiresLegalReview/fail表示が意図通りかどうか
- i18n・ダークモードでの確認結果
- 未確認・今回スコープ外とした事項の明記

---
**推奨モデル: Sonnet**(51番までで仕様・データ形式が確定しており、既存タブのUIパターンに沿った機械的な実装タスクのため)
