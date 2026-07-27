// Global Overview — 送出レート制御(トークンバケット)と 429 リトライ
//
// なぜ必要か:
//  - Central の新 API(internal.api.central.arubanetworks.com)は 1 リクエストごとに
//    `X-RateLimit-Limit: 10` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`(秒)を返す。
//    実測で Limit=10 / Reset=1 → 「10 req/sec」。この枠は **アカウント全体で共有**されるため、
//    同じ資格情報を使う central-mcp-http(:8010) 側の呼び出しとも取り合いになる。
//    → 本ダッシュボードは枠の一部しか使わない前提で、既定 4 req/sec に自主規制する。
//  - Mist(api.ac2.mist.com)はレート制限ヘッダを返さない(実測: X-RateLimit-* 無し)。
//    公開ドキュメント上の上限はトークンあたり 5000 req/hour とされるが、レスポンスからは
//    確認できないため、こちらも保守的に 2 req/sec で送出する。
//
// 実装方針:
//  - トークンバケット(容量 = burst、補充 = ratePerSec)で送出間隔を平滑化する。
//  - レスポンスヘッダに残枠が載っていれば取り込み、残りが少なければ reset まで待つ。
//  - 429 / 503 は Retry-After(または指数バックオフ)で最大 maxRetries 回まで再試行する。

export interface LimiterOptions {
  /** 1 秒あたりの平均送出数 */
  ratePerSec: number;
  /** バースト許容数(バケット容量) */
  burst: number;
  /** 429/5xx の最大リトライ回数 */
  maxRetries: number;
  /** ログ用のラベル(central / mist) */
  label: string;
}

export interface LimiterStats {
  label: string;
  ratePerSec: number;
  burst: number;
  /** プロセス起動以降に実際に送出した HTTP リクエスト数(リトライを含む) */
  requests: number;
  /** 429 を受けた回数 */
  throttled: number;
  /** バケット待ちで停止した合計ミリ秒 */
  waitedMs: number;
  /** 直近レスポンスの残枠(取得できた場合のみ) */
  lastRemaining: number | null;
  lastLimit: number | null;
  lastRequestAt: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue: Promise<void> = Promise.resolve();
  private readonly opts: LimiterOptions;
  private readonly stats: LimiterStats;

  constructor(opts: LimiterOptions) {
    this.opts = opts;
    this.tokens = opts.burst;
    this.lastRefill = Date.now();
    this.stats = {
      label: opts.label,
      ratePerSec: opts.ratePerSec,
      burst: opts.burst,
      requests: 0,
      throttled: 0,
      waitedMs: 0,
      lastRemaining: null,
      lastLimit: null,
      lastRequestAt: null,
    };
  }

  getStats(): LimiterStats {
    return { ...this.stats };
  }

  /** バケットからトークンを 1 つ取る(足りなければ待つ)。呼び出しは直列化する。 */
  private acquire(): Promise<void> {
    const run = this.queue.then(async () => {
      for (;;) {
        const now = Date.now();
        this.tokens = Math.min(
          this.opts.burst,
          this.tokens + ((now - this.lastRefill) / 1000) * this.opts.ratePerSec,
        );
        this.lastRefill = now;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.ceil(((1 - this.tokens) / this.opts.ratePerSec) * 1000);
        this.stats.waitedMs += waitMs;
        await sleep(waitMs);
      }
    });
    // queue はエラーで止まらないようにする(acquire 自体は throw しない)。
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** レスポンスヘッダから残枠を取り込み、枯渇が近ければ reset 秒ぶんバケットを空にする。 */
  private absorbHeaders(res: Response): void {
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(limit) && limit > 0) this.stats.lastLimit = limit;
    if (!Number.isFinite(remaining)) return;
    this.stats.lastRemaining = remaining;
    // 残枠が 2 未満なら、reset(秒)ぶん送出を止めるためトークンを落とす。
    if (remaining < 2) {
      this.tokens = 0;
      this.lastRefill = Date.now() + Math.max(0, (Number.isFinite(reset) ? reset : 1) * 1000);
    }
  }

  /**
   * レート制御つき fetch。429 / 502 / 503 / 504 は Retry-After または指数バックオフで再試行する。
   * 4xx(429 以外)は再試行しない(資格情報・クエリの誤りは待っても直らないため)。
   */
  async fetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs = 30_000, ...rest } = init;
    let attempt = 0;
    for (;;) {
      await this.acquire();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        this.stats.requests += 1;
        this.stats.lastRequestAt = new Date().toISOString();
        res = await fetch(url, { ...rest, signal: ac.signal });
      } catch (err) {
        clearTimeout(timer);
        if (attempt >= this.opts.maxRetries) throw err;
        attempt += 1;
        await sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      clearTimeout(timer);
      this.absorbHeaders(res);

      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (!retryable || attempt >= this.opts.maxRetries) return res;

      if (res.status === 429) this.stats.throttled += 1;
      const retryAfter = Number(res.headers.get("retry-after"));
      const resetSec = Number(res.headers.get("x-ratelimit-reset"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Number.isFinite(resetSec)
          ? resetSec * 1000
          : Math.min(8000, 500 * 2 ** (attempt + 1));
      console.warn(
        `[global-overview/${this.opts.label}] HTTP ${res.status} — ${backoffMs}ms 待って再試行 (${attempt + 1}/${this.opts.maxRetries})`,
      );
      // レスポンスボディを読み捨てて接続を解放する。
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
      attempt += 1;
      await sleep(backoffMs);
    }
  }
}
