# 07 findings — 「サイト指定なし」クエリでの JSON パースエラー

## 結論(3行)

- 原因は **想定原因 1〜3 のいずれでもなかった**。claude CLI の stdout 読み取りは既に正しく行バッファリングされており、`maxBuffer` も使っていない(`spawn` はストリーム)。
- 真因は **`~/.claude.json` の「単一ファイル bind mount」がコンテナ作成時の inode に固定され、ホスト側でファイルが差し替えられた結果、コンテナからは書き込み途中で切れた古いスナップショットが見え続けていたこと**。
- したがって **「サイト指定なしのときだけ失敗する」という相関も成立していなかった**(サイト指定ありでも同じように失敗することを実測で確認)。

---

## 1. エラーが出ていた具体的な箇所

`JSON.parse` が失敗していたのは claude CLI の出力ではなく、**MCP サーバー定義の供給元ファイル**を読むところ。

```
plugins/network-investigation/mcp.ts
  readGlobalMcpServers()          ← JSON.parse(raw) がここで throw
    ← writeNarrowedMcpConfig()
      ← runClaudeWithMcp()        ← try/catch で握って { isError, reason } に変換
        ← runInsightAgent()
          ← api.ts runQuery()     ← reason をそのまま履歴/SSE に載せて UI に表示
```

`runClaudeWithMcp` は `writeNarrowedMcpConfig()` を try/catch で包み、例外メッセージを
そのまま `reason` にして返す。**claude CLI を起動する前に失敗している**ため、

- 呼び出したツールは **0 件**
- UI にはパーサの生メッセージ `Unterminated string in JSON at position 136653 (line 3689 column 19)` だけが出る
- サーバーログには何も残らない(catch が握りつぶしていたため)

という、報告どおりの症状になっていた。

### 履歴上の証拠

`data/network-investigation/query-history.jsonl` の該当 3 件:

```
2026-07-23T06:43:13.020Z | site=null | calls=0 | reason=Unterminated string in JSON at position 136653 (line 3689 column 19)
2026-07-23T06:43:42.324Z | site=null | calls=0 | reason=Unterminated string in JSON at position 136653 (line 3689 column 19)
2026-07-23T06:43:55.548Z | site=null | calls=0 | reason=Unterminated string in JSON at position 136653 (line 3689 column 19)
```

**42 秒にわたって 3 回とも完全に同じ position で失敗している**。これは
「出力の途中で偶然切れた」類の一過性の破損ではなく、**同じ壊れたバイト列を毎回読んでいる**ことを意味する。
この時点で「claude CLI の出力を読み損ねている」説は否定された。

---

## 2. 想定原因の検証結果(すべて否定)

| # | 想定原因 | 判定 | 根拠 |
|---|---------|------|------|
| 1 | stdout の chunk を行の途中で切って `JSON.parse` している | **否定** | `mcp.ts` の `child.stdout.on("data")` は既に `lineBuf` に蓄積し、`indexOf("\n")` で完全な行だけを `handleLine()` に渡している(末尾の改行なし行も `close` で処理済み)。さらに `handleLine` の `JSON.parse` は `catch { return }` で握るため、そもそもここから例外は外に出ない |
| 2 | `maxBuffer` によるサイズ上限で出力が打ち切られている | **否定** | 使っているのは `exec` ではなく `spawn`。`spawn` に `maxBuffer` の概念は無く、ストリームで受けている |
| 3 | サイト指定なしの大きい出力に閾値がある | **否定** | エラー位置(136,653)は claude の出力サイズとは無関係で、`~/.claude.json` のサイズと一致する(下記)。またサイト指定ありでも同じく失敗する(下記の実測) |

---

## 3. 真因の特定

### 3-1. エラー位置がホストの `~/.claude.json` と一致する

```
$ node -e 'const s=require("fs").readFileSync(process.env.HOME+"/.claude.json","utf-8");
           console.log(s.length, s.split("\n").length)'
137279 3712        # 文字数 / 行数
```

報告されたエラーは `position 136653 (line 3689 ...)`。**3,689 行 / 約 136k 文字という形は
`~/.claude.json`(3,712 行 / 137,279 文字)そのもの**。他に該当するサイズのファイルは無い
(`query-history.jsonl` は 38KB、`site-platform-map.json` は 3KB)。

### 3-2. コンテナから見えているファイルが実際に壊れている

```
$ docker compose exec -T app node -e '
    const s=require("fs").readFileSync("/host/claude.json","utf-8");
    console.log("chars:",s.length,"lines:",s.split("\n").length);
    try{JSON.parse(s)}catch(e){console.log("parse NG:",e.message)}'

chars: 136654 lines: 3689
parse NG: Expected property name or '}' in JSON at position 136654 (line 3689 column 3)
```

一方ホスト側は正常にパースできる(`parse OK`)。**同じファイルのはずが、ホストは正常・コンテナは破損**。

### 3-3. 決定的な証拠 — コンテナ側の inode は link count 0

```
$ docker compose exec -T app stat -c "%s %Y %i %h" /host/claude.json
137700 1784784801 139762 0        # size mtime inode nlink=0  ← ホストでは既に unlink 済み

$ stat -f "%z %m %i %l" ~/.claude.json     # ホスト
138326 1784789305 134614047 1             # size mtime inode nlink=1
```

- コンテナが掴んでいる inode の **link count が 0** = そのファイルはホスト側で既に削除されている。
- ホストの `~/.claude.json` は **別の inode**(134614047)に差し替わっている。

**メカニズム:**
docker-compose は `${HOME}/.claude.json:/host/claude.json:ro` と **単一ファイル**で bind mount している。
単一ファイルのマウントは(ディレクトリマウントと違って)**コンテナ作成時点の inode に固定される**ため、
パス経由の追従をしない。ホスト側の claude CLI が `~/.claude.json` を書き換えて差し替えると:

1. コンテナは古い inode を掴んだまま取り残される(nlink=0)。
2. しかもその固定されたスナップショットが **書き込み途中(truncate 直後)の状態**だったため、JSON として閉じていない。
3. 結果、**コンテナを作り直すまで永続的に** `JSON.parse` が同じ位置で失敗し続ける。

コンテナ内 `/host/claude.json` の mtime は `Jul 23 14:33`(= コンテナ作成時刻)で固定されていた一方、
ホストの `~/.claude.json` は `15:47` に更新されていた。時系列も一致する。

### 3-4. 「サイト指定なしのときだけ」は成立しない

`writeNarrowedMcpConfig()` は narrowing の対象が Central 1 つでも両方でも、
**必ず `readGlobalMcpServers()` を通る**(コードパスが同一)。実際に修正前の状態で
サイト指定ありのクエリを投げると、同じ場所で失敗した:

```
$ curl -X POST .../query -d '{"query":"Tokyo サイトの健全性を1行で教えて","site":"Tokyo",...}'
2026-07-23T06:49:40.839Z | site=Tokyo | err=true | calls=0
  | reason= Expected ':' after property name in JSON at position 136653 (line 3689 column 28)
```

履歴を時系列で見ると、最後の成功は 04:30(UTC)= コンテナ再作成前。
コンテナが 14:33(JST)に作り直されて以降のクエリは、たまたますべてサイト指定なしだっただけだった。

---

## 4. 修正内容

方針は 2 段構え。**「壊れたマウントでも走り続けられるようにする」+「壊れたことが分かるようにする」**。

### 4-1. `plugins/network-investigation/mcp.ts` — last-known-good フォールバック

`readGlobalMcpServers()` を書き換えた。

- **軽いリトライ**(2 回 / 150ms 間隔)。ホスト直実行時の「書き込み途中を掴んだだけ」の一過性破損を吸収する。
- **必要な 2 サーバーだけ抽出**(`pickOurServers`)。`central-mcp` / `mist-cloud` 以外の定義(= 無関係なトークン)をキャッシュに持ち込まない。
- **last-known-good キャッシュ**。読めた定義をメモリに保持し、Docker 実行時(`NETINV_CLAUDE_JSON` が設定されているとき)だけディスクにも保存する。
  - 保存先 `~/.cache/multi-network-dashboard-mcp/mcp-servers-last-known-good.json`(dir 0700 / file 0600)。既存の一時 mcp-config と同じ置き場・同じパーミッション方針。
  - コンテナ内では `HOME=/home/node` = 名前付きボリューム `claude-home` なので、**イメージを作り直しても残る**。ホストのディスクにも repo にもトークンは出ない。
  - ホスト直実行時(`NETINV_CLAUDE_JSON` 未設定)は供給元が常に新鮮なので **ディスクには一切書かない**(CLAUDE.md「情報漏洩には気を付ける」)。
- 供給元が壊れていたらフォールバックで継続し、**原因と復旧手順(`docker compose up -d --force-recreate`)を含む警告をログに出す**。
- フォールバックも無いときだけ throw。メッセージはパーサの生文言ではなく、原因と対処が分かる日本語にした。

さらに:

- `primeMcpServerCache()` を追加。**マウントがまだ新鮮な起動直後に 1 回読んで** last-known-good を確保する。
- `mcpServerSourceStatus()` を追加。現在の供給状態(`live` / `fallback` / `unavailable`)を返す。
- `runClaudeWithMcp()` の catch に `console.error` を追加。**今回ログに何も残らなかった原因**なので、ここは必ず出す。

### 4-2. `server/index.ts` — 起動時 prime と `/health` への露出

- 起動時に `primeMcpServerCache()` を呼び、結果をログに出す。
- `/health` に `mcpConfig: { source, servers }` を追加(既存フィールドはそのまま。追加のみ)。
  `source` が `fallback` なら、マウントが腐っていて last-known-good で走っていると一目で分かる。

### 4-3. `docker-compose.yml` — 制約のドキュメント化

単一ファイル bind mount が inode に固定される件と、ホストの `~/.claude.json` の MCP 定義を
変更したときは `docker compose up -d --force-recreate` でマウントを張り直す必要がある旨をコメントで明記した。

> **設計判断:** マウント自体を直す(= ディレクトリマウントにする)には `${HOME}` 丸ごとを
> read-only で渡す必要がある。このコンテナは `claude --dangerously-skip-permissions` を動かすため、
> ホームディレクトリ全体の露出は割に合わないと判断し、**アプリ側の耐性 + 復旧手順の明示**を採った。

---

## 5. 検証結果

### 5-1. 起動確認

```
$ docker compose up -d --build     # → Container Recreated / Started
$ curl -s localhost:8092/health
{"ok":true,"service":"multi-network-dashboard","port":8092,
 "mcpConfig":{"source":"live","servers":["central-mcp","mist-cloud"]},"ts":"..."}

# 起動ログ
[network-investigation] MCP サーバー定義: source=live servers=[central-mcp, mist-cloud]
```

last-known-good も保存されている(中身はトークンを含むためキー名のみ確認):

```
$ docker compose exec -T app ls -la /home/node/.cache/multi-network-dashboard-mcp/
-rw------- 1 node node 463 Jul 23 15:54 mcp-servers-last-known-good.json
cached servers: [ 'central-mcp', 'mist-cloud' ]
```

### 5-2. クエリ実行(すべて成功・エラー 0 件)

| ケース | site | 結果 | ツール呼び出し | 使用 MCP |
|--------|------|------|--------------|---------|
| 元の失敗クエリ「ローミングに問題がある端末があれば教えて」 | なし | OK | 9 件 | central-mcp / mist-cloud |
| 同一セッションの追い質問(2 ターン目) | なし | OK | 11 件 | central-mcp / mist-cloud |
| 退行確認「Tokyo サイトの健全性とアラートを確認して」 | Tokyo | OK | 3 件 | central-mcp のみ(narrowing 維持) |
| 大量応答「全サイトを一覧し問題サイトは AP/スイッチまで掘り下げ。Central と Mist 両方を横断」 | なし | OK | 9 件 | central-mcp / mist-cloud |
| 実画面から実行「アラートが発生しているサイトを教えて」 | なし | OK | 6 件 | central-mcp / mist-cloud |

セッションスレッドも正常:

```
$ curl -s .../history/session/017f5800-... | ...
session turns: 2
 1. err=false calls=9  q=ローミングに問題がある端末があれば教えて
 2. err=false calls=11 q=その中で最も影響が大きいサイトを詳しく調べて
```

### 5-3. フォールバック経路の実証

今回の破損を**バイト単位で再現**して、フォールバックが効くことを確認した。

```
# コンテナ内で /host/claude.json を 136,653 文字で切った壊れたコピーを作り、
# それを供給元にして新しいプロセスを起動する(= コンテナ再起動時に既にマウントが腐っている状況)
$ NETINV_CLAUDE_JSON=/tmp/broken-claude.json npx tsx scratch/fallback-test.ts

[network-investigation] /tmp/broken-claude.json を読めませんでした
  (Expected ':' after property name in JSON at position 136653 (line 3689 column 28))。
  直近に読めた MCP サーバー定義(central-mcp, mist-cloud)で継続します。
  Docker では単一ファイル bind mount が古い inode に固定されるため、
  ホストの ~/.claude.json を更新したら `docker compose up -d --force-recreate` で
  マウントを張り直してください。

prime: {"source":"fallback","servers":["central-mcp","mist-cloud"]}
narrowed config servers: central-mcp,mist-cloud
status: {"source":"fallback","servers":["central-mcp","mist-cloud"]}
```

**修正前とまったく同じエラー(position 136653)が出る入力に対して、narrowing 済み mcp-config の生成まで到達している。**
これが根本原因の直接的な裏付けでもある。

### 5-4. 実画面

`http://localhost:8092/` →「ネットワーク調査」タブからサイト指定なしでクエリを実行し、

- MCP 呼び出しログが Central / Mist 両方のバッジ付きでリアルタイムに流れること
- 6 件のツール呼び出しがすべて「完了」になること
- 回答本文とグラフ(サイト別アラート件数)が描画されること
- 実行タイムラインに緑(成功)で積まれること

を確認した。修正後のサーバーログにエラー・警告は 1 件も出ていない。

---

## 6. 残る運用上の注意

- ホストの `~/.claude.json` の **MCP サーバー定義を変更した場合**、コンテナは last-known-good を
  使い続けるため即座には反映されない。`docker compose up -d --force-recreate` でマウントを張り直すこと。
- `/health` の `mcpConfig.source` が `fallback` になっていたら、マウントが腐っているサイン。
  動作は継続しているが、上記の再作成を実施するのが望ましい。
