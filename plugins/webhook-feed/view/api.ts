// Webhook ログ View — /api/webhook-feed/* への fetch ラッパ。
//
// GET はサーバのキャッシュを読むだけで Google Sheets を叩かない。
// Sheets を叩くのは POST /refresh(「更新」ボタン)とサーバ側の定期ポーリングだけ。

import type { WebhookFeedEnvelope, WebhookPollSettings } from "./types";

const BASE = "/api/webhook-feed";

async function json<T>(res: Response): Promise<T> {
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
  return parsed as T;
}

/** キャッシュ済みの統合フィードを取得する(Sheets は叩かれない)。 */
export async function fetchWebhookFeed(): Promise<WebhookFeedEnvelope> {
  return json<WebhookFeedEnvelope>(await fetch(`${BASE}/snapshot`));
}

/**
 * 手動更新。サーバ側が最短間隔(既定 30 秒)を守るので、間隔内なら Sheets を叩かず
 * キャッシュがそのまま返る(連打しても実害は無い)。
 */
export async function refreshWebhookFeed(): Promise<WebhookFeedEnvelope> {
  return json<WebhookFeedEnvelope>(await fetch(`${BASE}/refresh`, { method: "POST" }));
}

/** Webhook ログ専用のポーリング間隔設定(Global Overview の設定とは独立)。 */
export async function fetchWebhookSettings(): Promise<WebhookPollSettings> {
  return json<WebhookPollSettings>(await fetch(`${BASE}/settings`));
}

export async function updateWebhookPollInterval(pollIntervalMs: number): Promise<WebhookPollSettings> {
  return json<WebhookPollSettings>(
    await fetch(`${BASE}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollIntervalMs }),
    }),
  );
}

/**
 * 42: 日別アーカイブ(保存の正本)の保持日数。0 = 無期限。
 * 一覧の表示件数(viewMaxItems)とは別物で、短くすると古い日のファイルがその場で消える。
 */
export async function updateWebhookArchiveRetention(
  archiveRetentionDays: number,
): Promise<WebhookPollSettings> {
  return json<WebhookPollSettings>(
    await fetch(`${BASE}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archiveRetentionDays }),
    }),
  );
}
