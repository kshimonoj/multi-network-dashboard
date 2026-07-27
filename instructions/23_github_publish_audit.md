# 23: GitHub公開前のセキュリティ監査 + ローカルコミット準備(pushは行わない)

## 目的

`https://github.com/kshimonoj/multi-network-dashboard` にこのプロジェクトをpushする準備として、以下2点が絶対に含まれないことを徹底的に監査し、問題なければローカルでコミットまで行う。**このタスクではリモートへのpush(`git push`)は行わない。** 監査結果と、コミットされる予定の全ファイル一覧を完了報告にまとめ、そこで一旦停止する。

- API Key・トークン等のセキュリティ関連情報
- Central・Mist・GLP・Google Sheetsの生データ(実在のサイト名、MACアドレス、シリアル番号、org_id/site_idのUUID、顧客名等)

## タスク

### Task 1: リポジトリの現状確認

1. `git status`(または`git init`前であれば現状のディレクトリ構成)を確認し、現時点でgit管理下にあるかどうかを確認する
2. 既にgit管理下にあり、かつ過去のコミット履歴が存在する場合、**その履歴の中に機密情報が含まれていないか**も確認する(単に最新版から除外するだけでは、過去のコミットに残っていれば意味が無いため)。含まれていた場合は履歴の扱いについて完了報告で判断を仰ぐこと(履歴を書き換える操作はこのタスクでは行わない)

### Task 2: `.gitignore`の網羅性確認

1. 現在の`.gitignore`を確認し、以下が確実に除外されているか確認する。不足があれば追加する:
   - `secrets/`(サービスアカウントJSON等)
   - `.env`、`.env.*`(ただし`.env.example`は除外しない)
   - `data/`配下の実行時生成データ全般(`data/network-investigation/query-history.jsonl`、`data/global-overview/`、`data/webhook-feed/`、`data/central-streaming/`等、実データ・キャッシュ・state.json等を含むもの)
   - `node_modules/`、ビルド成果物(`dist/`等)、ログファイル
2. `.dockerignore`についても同様に、機密ファイルがDockerイメージに焼き込まれない設定になっているか確認する(既存の対応があるはずなので、崩れていないか確認する程度でよい)

### Task 3: コミット対象ファイルの内容精査(最重要)

1. `.gitignore`適用後に実際にコミット対象となる全ファイル(`git add -A`した場合に追加される想定のファイル一覧、または`git status`で見える未追跡ファイル一覧)を洗い出す
2. 特に`instructions/`配下の`*_findings.md`ファイル、および`docs/`やREADME等のドキュメント類について、以下のパターンに該当する実データが含まれていないか1ファイルずつ確認する:
   - MACアドレス形式の文字列(実機のもの。ダミー値`aabbccddeeff`や`11:22:33:44:55:66`のような明らかなテスト値は許容するが、実際の検証中に出力された実機のMACアドレスは除外・伏字にする)
   - デバイスのシリアル番号(実機のもの)
   - 実在のサイト名(例: 実際の拠点名。テスト用途で作った"Home"や"Test Site"のような一般的な名称は文脈で判断してよいが、固有の組織名・拠点名が推測できるものは伏字にする)
   - org_id/site_id等の実際のUUID・数値ID
   - トークン・APIキーの断片(たとえ一部がマスクされていても、残りの文字列から推測可能なもの)
   - Central/Mist/GLPの実際のテナント情報・アカウント名
3. 該当箇所が見つかった場合、それぞれのファイルで**該当箇所をプレースホルダー(例: `<REDACTED>`、`<SITE_NAME>`、`<DEVICE_SERIAL>`等)に置き換える**。ファイル全体を削除するのではなく、実データの部分だけを機械的に置換すること(調査記録としての価値は残す)
4. `plugins/*/proto/`配下や`Code.gs`相当のソースコード自体には、通常は実データが含まれないはずだが、テストデータ・コメント等に実データが紛れ込んでいないか念のため確認する
5. 修正した内容を`instructions/23_findings.md`に、どのファイルのどの部分をどう伏字にしたかの一覧として記録する

### Task 4: READMEの用意(無ければ簡単なもので良い)

1. `README.md`が無い、または内容が薄い場合、プロジェクトの概要(何のためのアプリか、Corstackからの外出しである経緯、主要機能: ネットワーク調査/Global Overview/Webhookログ/Streaming)を簡潔にまとめたものを新規作成・更新する。認証情報やセットアップに必要な`.env`の**variable名だけ**(値は書かない)を含めてよい
2. Webhookセットアップガイド(既にGitHub公開済みの別リポジトリ`central-mist-webhook-to-google-sheets`)へのリンクをREADMEに含める

### Task 5: ローカルコミット(pushはしない)

1. Task 1でgit管理下になければ`git init`する
2. リモートが未設定であれば`git remote add origin https://github.com/kshimonoj/multi-network-dashboard.git`を設定する(**pushは行わない**)
3. `git add -A`し、`git status`で最終的にステージされる全ファイルの一覧を確認する
4. 適切なコミットメッセージでローカルコミットする(例: `feat: initial commit of multi-network-dashboard`)
5. **`git push`は実行しない。** ここで作業を止める

## 完了報告

verified-report形式で報告すること。特に:

- Task 1: 既存のgit履歴の有無、あった場合の機密情報混入の有無
- Task 2: `.gitignore`/`.dockerignore`に追加・修正した内容
- Task 3: 実データが見つかったファイルの一覧と、それぞれどう伏字にしたか(伏字にした実際の値そのものは報告に書かないこと。「〇〇ファイルのMACアドレス3箇所を`<REDACTED>`に置換」のような記述に留める)
- Task 4: READMEの作成・更新内容
- Task 5: 最終的にコミットされたファイルの一覧(`git status`/`git show --stat HEAD`相当)
- **pushは行っていないことの明記**

サービスアカウントの中身やトークンの値そのものは、たとえ「これは除外しました」という報告であっても、報告内に絶対に含めないこと。
