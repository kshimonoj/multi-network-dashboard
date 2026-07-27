import type { Platform } from "./types";

// 正規化済みロゴバッジ(scripts/generate-logo-badges.ts が生成した public/logos/*.png)。
// 丸型で表示し、スキップした側はグレースケール + 減光で視覚的に区別する。
// server 名("central-mcp"|"mist-cloud")か platform のどちらからでも出せる。

const SERVER_TO_PLATFORM: Record<string, Platform> = {
  "central-mcp": "central",
  "mist-cloud": "mist",
};

const BADGE_SRC: Record<Platform, string> = {
  central: "/logos/central-badge.png",
  mist: "/logos/mist-badge.png",
};

export function platformOf(serverOrPlatform: string): Platform | null {
  if (serverOrPlatform === "central" || serverOrPlatform === "mist") return serverOrPlatform;
  return SERVER_TO_PLATFORM[serverOrPlatform] ?? null;
}

export function LogoBadge({
  target,
  size = 22,
  skipped = false,
  title,
}: {
  target: string; // server 名 or platform
  size?: number;
  skipped?: boolean;
  title?: string;
}) {
  const platform = platformOf(target);
  const cls = `ni-badge${skipped ? " skipped" : ""}`;
  if (!platform) {
    // MCP 以外(理論上出ない)は文字プレースホルダ。
    return (
      <span className={cls} style={{ width: size, height: size, fontSize: size * 0.5 }} title={title}>
        ?
      </span>
    );
  }
  return (
    <img
      className={cls}
      src={BADGE_SRC[platform]}
      alt={platform}
      title={title ?? platform}
      width={size}
      height={size}
      style={{ width: size, height: size }}
    />
  );
}
