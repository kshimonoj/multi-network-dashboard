# 02: network-investigation 本移植(multi-network-dashboard)

## PRECONDITIONS (from blindspot-pass / 01番の結果)

### 前提・制約(RESOLVED)
- サーバー側(`api.ts`/`mcp.ts`/`insight-agent.ts`/`site-map.ts`/`schedule.ts`)はCorstack本体に一切依存していない(express, Node標準のみ)。**原則そのままコピー**でよい
- Corstack本体への依存はview側の2行のみ: `view/NetworkInvestigation.tsx`が`../../../src/lib/types`の`Plug`型と`../../../src/lib/topbarModel`の`useSetTopbarModel`/`topbarModelLabel`を参照している
- 本アプリは単一プラグインの独立アプリであり、複数プラグインを横断するトップバーという前提が不要になる。よって本物のtopbarModelは持ち込まず、**ローカルにno-opスタブ**(空Context + 何もしない関数)を1ファイル作成して置き換える
- `DATA_DIR`定数(2箇所)は、Corstackの`data/`配下ではなく本アプリ独自の`data/`ディレクトリを指すよう書き換える
- `schedule.ts`のlaunchd連携は、**node-cronに置き換えて自己完結させる**方針(コンテナ内にlaunchd/launchctlが存在しないため)。トリガー部分のみ差し替え、実行対象(Insight Agentの共通関数)はそのまま流用する
- 認証: `.env`の`CLAUDE_CODE_OAUTH_TOKEN`はユーザーが`claude setup-token`で発行した長期トークンに手動で差し替え済みの前提で進める(このタスクでは値を書き換えない・生成しない)
- Dockerfile/docker-composeの必須改修3点(非root実行/CLAUDE_CODE_OAUTH_TOKEN環境変数/central-mcp urlのhost.docker.internal化)は01番で反映済み。今回は変更不要

### DEFERRED
- なし(01番で「大」項目はすべてRESOLVED)

### 今回新たに調査してから実施する項目
- styles.cssがCorstack本体の共通CSS変数(テーマシステム)にどこまで依存しているか(B-04b)
- schedule.tsが現在どういうスケジュール(実行時刻・頻度)で動いているか(node-cronで再現するため)

---

## タスク

### Task 1: styles.cssの依存調査 → 切り出し(B-04b)

1. `~/corstack/plugins/network-investigation/view/` 配下の`.css`/`.tsx`内で`var(--...)`形式のCSS変数参照を全件grepする
2. それぞれがCorstack本体のどのグローバルCSSファイルで定義されているか特定する
3. **実際に使われている変数の定義だけ**を抜き出し、`multi-network-dashboard`側にローカルの`theme.css`(または既存styles.cssの先頭)として複製する。Corstackのテーマシステム全体は持ち込まない
4. 見た目が大きく崩れる場合は一旦そのまま進めて構わない(細かい調整は次回以降でよい)

### Task 2: schedule.tsの現状調査

1. 現在の`schedule.ts`が定義している実行タイミング(何時に何を実行しているか、頻度)を確認する
2. `instructions/02_findings.md`に一覧化する

### Task 3: 独立Vite/Reactエントリの作成(B-04a)

1. `multi-network-dashboard/`側に、このプラグイン単体をマウントするための最小の`index.html`/`main.tsx`を新規作成する(Corstack本体のシェルはコピーしない)
2. `PluginEntry`型と`topbarModel`(`useSetTopbarModel`/`topbarModelLabel`)のローカルno-opスタブを1ファイルで作成する
3. `view/NetworkInvestigation.tsx`のimportを、Corstack本体参照からこのローカルスタブに差し替える(このファイル以外のview配下14ファイルは変更不要のはず)

### Task 4: サーバー側のコピーと最小修正

1. `mcp.ts`, `insight-agent.ts`, `site-map.ts`, `api.ts`, `tool-labels.json`等のデータファイルをそのままコピーする
2. `DATA_DIR`定数2箇所を本アプリの`data/`ディレクトリを指すよう書き換える
3. `schedule.ts`のトリガー部分をnode-cron(`npm install node-cron`)に置き換える。Task 2で確認した実行タイミングと同じ挙動になるようcron式を設定する。実行対象の関数(Insight Agent呼び出し)は変更しない
4. サイト→プラットフォーム対応表の事前生成・手動更新ボタンの仕組みはそのままコピーで動作するはず(Central/Mist双方のMCP呼び出し部分に変更なし)

### Task 5: 起動確認

1. `docker compose up`で起動し、`/health`だけでなく実際のnetwork-investigationの画面が表示されることを確認する
2. サイト一覧表示、Insight Agentの実行(central_get_summary等、実際にツールを1つ呼ぶレベルでよい)、SSEでのMCP呼び出し可視化が動作することを確認する
3. デモ映え要素(地図ピン、ロゴバッジ等)は表示崩れがあっても致命傷でなければ許容し、詳細な見た目調整は別タスクに回す

## 完了報告

verified-report形式で報告すること。特に以下は必ずVERIFIED/UNVERIFIED/RISKSのいずれかに対応づけること:

- styles.cssの依存調査結果と、実際にどの変数を切り出したか
- schedule.tsの旧スケジュール内容とnode-cron移行後のcron式の対応関係
- 起動確認(Task 5)の各項目の成否
- view/NetworkInvestigation.tsx以外のview配下ファイルに変更が必要だったかどうか(想定外の依存が見つかった場合は明記)

git操作は行わないこと。
