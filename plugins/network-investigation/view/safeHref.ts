// Markdown 回答中のリンク url は claude(エージェント)が生成した値。href に直接載せると
// `javascript:` 等のスキームで XSS になりうるため、レンダリング境界で http/https のみ許可する
// (Newsletter の同名ヘルパと同じ方針)。
export function safeHref(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.toString() : undefined;
  } catch {
    return undefined;
  }
}
