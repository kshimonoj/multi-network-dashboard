// Streaming(Central)(20 Task 2-3 / 2-4)— アクセストークンの取得と寿命管理。
//
// 05 番で実装済みの client_credentials フローと同じもの(sso.common.cloud.hpe.com に
// HTTP Basic で POST)。global-overview/central-client.ts の getToken() をそのまま使い回せない
// 理由は 1 つだけで、**WebSocket 側は「トークンの残り寿命」を知る必要がある**ため
// (期限が近づいたら能動的に張り直す。Central 側は期限切れで接続を切ってくる)。
//
// トークン自体は Central のアカウント単位なので、ここで取ったものと Global Overview 側が
// 取ったものが別インスタンスになっても問題は起きない(発行数の制限は実測で確認していない
// ため、少なくとも「1 接続ごとに取り直す」ことはせず、全ストリームで 1 本を共有する)。

const DEFAULT_TOKEN_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2";

/** 期限のどれくらい手前で取り直すか。往復時間と時計ずれの余裕。 */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface StreamToken {
  value: string;
  /** 実際の期限(expires_in をそのまま反映したもの) */
  expiresAt: number;
  /** これを過ぎたら張り直すべき時刻(expiresAt - 5 分) */
  renewAt: number;
}

let cached: StreamToken | null = null;
let inFlight: Promise<StreamToken> | null = null;

export class CentralConfigError extends Error {}

export function isConfigured(): boolean {
  return Boolean(
    (process.env.CENTRAL_BASE_URL ?? "").trim() &&
      (process.env.CENTRAL_CLIENT_ID ?? "").trim() &&
      (process.env.CENTRAL_CLIENT_SECRET ?? "").trim(),
  );
}

export function configError(): string | null {
  const missing = ["CENTRAL_BASE_URL", "CENTRAL_CLIENT_ID", "CENTRAL_CLIENT_SECRET"].filter(
    (k) => !(process.env[k] ?? "").trim(),
  );
  return missing.length ? `${missing.join(" / ")} が未設定です(.env に設定してください)` : null;
}

/** wss:// のベース。CENTRAL_BASE_URL の https を wss に置き換えるだけ。 */
export function wssBase(): string {
  const base = (process.env.CENTRAL_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new CentralConfigError("CENTRAL_BASE_URL が未設定です");
  return base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

export function currentToken(): StreamToken | null {
  return cached;
}

/**
 * 有効なトークンを返す。renewAt を過ぎていれば取り直す。
 * 同時に複数ストリームから呼ばれても HTTP は 1 本にまとめる。
 */
export async function getToken(opts: { force?: boolean } = {}): Promise<StreamToken> {
  if (!opts.force && cached && Date.now() < cached.renewAt) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const err = configError();
    if (err) throw new CentralConfigError(err);

    const id = (process.env.CENTRAL_CLIENT_ID ?? "").trim();
    const secret = (process.env.CENTRAL_CLIENT_SECRET ?? "").trim();
    const url = (process.env.CENTRAL_TOKEN_URL ?? DEFAULT_TOKEN_URL).trim();
    const basic = Buffer.from(`${id}:${secret}`).toString("base64");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new Error(`Central トークン取得に失敗: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Central トークン応答に access_token がありません");

    const ttlMs = (body.expires_in ?? 7200) * 1000;
    const expiresAt = Date.now() + ttlMs;
    cached = {
      value: body.access_token,
      expiresAt,
      // 寿命が極端に短い場合でも「今すぐ renew」にならないよう半分は使う。
      renewAt: expiresAt - Math.min(REFRESH_SKEW_MS, ttlMs / 2),
    };
    return cached;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** 401 / 期限切れ検知時に、次回の getToken() で必ず取り直させる。 */
export function invalidateToken(): void {
  cached = null;
}
