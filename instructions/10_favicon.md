# 10: favicon追加(multi-network-dashboard)

## タスク

1. `multi-network-dashboard`のフロントエンド(`index.html`)に、シンプルなネットワーク監視アプリらしいSVGファビコンを追加する。デザインの参考:
   - 中央に丸いノード、そこから数本の線で周辺の小さいノードに繋がる「ネットワーク図」を模したシンプルなアイコン
   - 色は既存の`theme.css`のアクセントカラー(`--accent`)を使い、ダーク/ライト両テーマの背景でも視認できる配色にする
   - 過度に複雑にせず、小さいサイズ(16x16〜32x32相当)でも潰れずに識別できるシンプルな形にする
2. SVGファイルとして`public/`または適切な静的配信ディレクトリに配置し、`index.html`の`<head>`に`<link rel="icon" type="image/svg+xml" href="...">`を追加する
3. ブラウザタブに実際にファビコンが表示されることを確認する
4. `docker compose up -d --build`で反映し、`/health`と実画面(ブラウザタブのファビコン表示)を確認する

## 完了報告

verified-report形式で簡潔に報告すること。ファビコンの見た目([SVG]の内容 or スクリーンショット)と、`docker compose up -d --build`後の反映確認結果を含めること。

git操作は行わないこと。
