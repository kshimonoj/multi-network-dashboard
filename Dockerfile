# multi-network-dashboard — network-investigation 本体イメージ
#
# 重要(01 スパイクで判明した制約):
#  - claude CLI は root で `--dangerously-skip-permissions` を拒否する
#    ("cannot be used with root/sudo privileges for security reasons")。
#    plugins/network-investigation/mcp.ts はこのフラグを使うため、非 root で動かす必要がある。
#    → node:22-slim に既存の `node` ユーザー(uid 1000)で実行する。
#  - macOS の claude 認証情報は Keychain にあり、~/.claude のマウントでは引き継がれない。
#    CLAUDE_CODE_OAUTH_TOKEN を環境変数で渡す(docker-compose 側)。
#  - ~/.claude.json の central-mcp url は 127.0.0.1 なので、コンテナ内では
#    host.docker.internal へ書き換える(mcp.ts の CENTRAL_MCP_HOST)。
FROM node:22-slim

# curl            : central-mcp(host.docker.internal:8011)への疎通確認
# ca-certificates : https(npm registry / mcp.ai.juniper.net)用
# git, ripgrep    : claude CLI が内部で使う一般的な依存
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       git \
       ripgrep \
  && rm -rf /var/lib/apt/lists/*

# claude CLI(subprocess 方式で MCP を叩くため、イメージ内に常設する)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# ---- 依存インストール(devDependencies を含む。vite build に必要)----
COPY package.json package-lock.json* ./
RUN npm install

# ---- アプリ本体 ----
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY server ./server
COPY plugins ./plugins

# フロントエンドをビルドして dist/ を作る(本番は NODE_ENV=production で dist/ を静的配信)。
RUN npm run build

# secrets/(Google サービスアカウント鍵)はイメージに焼かず、docker-compose が read-only で
# バインドマウントする(.dockerignore で除外済み)。
# data/ は docker-compose がホストの ./data をバインドマウントする。
# イメージ側にも作っておき、マウントしない場合でも書き込めるようにする。
RUN mkdir -p /app/data/network-investigation /app/data/global-overview /app/data/webhook-feed /app/data/central-streaming && chown -R node:node /app

USER node
ENV HOME=/home/node
ENV NODE_ENV=production
ENV PORT=8092
EXPOSE 8092

# server/index.ts は TypeScript のまま tsx で起動する(Corstack の start スクリプトと同じ方式)。
CMD ["npx", "tsx", "server/index.ts"]
