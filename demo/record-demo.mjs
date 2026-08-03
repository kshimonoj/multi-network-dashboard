// 34: デモ動画の録画スクリプト(Playwright)。
//
// Global Overview → Event / Alert → ネットワーク調査 の 3 タブを 1 本の .webm に収める。
// 字幕は後段(demo/make-subs.mjs)で焼き込むが、待ち時間(Event の取得・調査の実行)は
// 実行ごとに長さが変わるため、**このスクリプトが実際の時刻をマークとして書き出し**、
// 字幕はそのマークから生成する(固定の秒数を決め打ちしない)。
//
// 注: 以下の page.evaluate / $$eval は Playwright の DOM 参照 API で、JS の eval() とは無関係
// (渡している関数はこのファイル内のリテラルのみ。外部入力を実行する箇所は無い)。
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";

const URL = process.env.DEMO_URL ?? "http://localhost:8092/";
const WORK = "demo/work";
const W = 1600;
const H = 900;
const QUERY = "全体の健全性状況を教えて";

mkdirSync(WORK, { recursive: true });

// ---- マーク(録画開始からの経過 ms)----
let t0 = 0;
const marks = [];
const mark = (name) => {
  const t = Date.now() - t0;
  marks.push({ name, t });
  console.log(`mark ${name} @ ${(t / 1000).toFixed(2)}s`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// スクロールは requestAnimationFrame で ease させる(スクロールバーのジャンプを避け、
// 動画として見やすくするため)。
async function scrollToEl(page, scroller, target, ms, offset = 90) {
  await page.evaluate(
    ({ scroller, target, ms, offset }) =>
      new Promise((resolve) => {
        const s = document.querySelector(scroller);
        const el = document.querySelector(target);
        if (!s || !el) return resolve();
        const start = s.scrollTop;
        const to = Math.max(
          0,
          Math.min(
            s.scrollHeight - s.clientHeight,
            start + el.getBoundingClientRect().top - s.getBoundingClientRect().top - offset,
          ),
        );
        const dist = to - start;
        const begin = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - begin) / ms);
          const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
          s.scrollTop = start + dist * e;
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    { scroller, target, ms, offset },
  );
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  colorScheme: "light",
  recordVideo: { dir: WORK, size: { width: W, height: H } },
});
const page = await ctx.newPage();
t0 = Date.now(); // 動画の 0 秒 ≒ ページ生成時刻
mark("rec_start");

page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));

// 表示言語 / テーマを既定(日本語・ライト)に固定してから読み込む。
await page.addInitScript(() => {
  localStorage.setItem("mnd-lang", "ja");
  localStorage.setItem("mnd-theme", "light");
});

await page.goto(URL, { waitUntil: "domcontentloaded" });

const GO = ".app-pane:not([hidden]) .go-root";

// ============ ① Global Overview ============
await page.waitForSelector(".go-card-value", { timeout: 60_000 });
await page.waitForSelector(".leaflet-tile-loaded", { timeout: 60_000 });
await sleep(1500);
mark("s1_summary"); // サマリカード
await sleep(4500);

mark("s1_donut"); // プラットフォーム別ドーナツ
await scrollToEl(page, GO, ".go-donuts", 1600, 200);
await sleep(4000);

mark("s1_map"); // サイトマップ
await scrollToEl(page, GO, ".leaflet-container", 1600, 130);
await sleep(1200);
// 東京周辺のマーカーをひとつ開いて「地図から状態が読める」ことを見せる。
const marker = page.locator(".leaflet-marker-icon").first();
if (await marker.count()) {
  await marker.click({ timeout: 5000 }).catch(() => {});
  await sleep(3200);
  await page.keyboard.press("Escape").catch(() => {});
}
await sleep(800);

mark("s1_table"); // サイト別内訳テーブル
await scrollToEl(page, GO, ".go-table-panel", 1600, 90);
await sleep(4500);

// ============ ② Event / Alert ============
mark("s2_open");
await page.getByRole("tab", { name: "Event / Alert" }).click();
await page.waitForSelector(".go-feed-table tbody tr", { timeout: 120_000 });
await sleep(1200);
mark("s2_timeline"); // 一覧が出た
await sleep(4200);

mark("s2_sources"); // 取得元パネル
await scrollToEl(page, GO, ".go-src-list", 1200, 200);
await sleep(3800);

mark("s2_filter"); // 重要度で絞り込む
// 「重要度」グループの中の「重大」チップ(他グループの同名ラベルと衝突しないよう親で絞る)
const sevGroup = page
  .locator(".app-pane:not([hidden]) .go-fgroup")
  .filter({ hasText: "重要度" })
  .first();
await scrollToEl(page, GO, ".go-fbar", 900, 240);
await sleep(1000);
await sevGroup.getByRole("button", { name: "重大", exact: true }).click();
await sleep(1500);
mark("s2_filtered");
await scrollToEl(page, GO, ".go-feed-table", 900, 140);
await sleep(4500);

// ============ ③ ネットワーク調査 ============
mark("s3_open");
await page.getByRole("tab", { name: "ネットワーク調査" }).click();
await page.waitForSelector("textarea.ni-input", { timeout: 30_000 });
await sleep(2500);

mark("s3_typing");
const ta = page.locator("textarea.ni-input");
await ta.click();
await ta.type(QUERY, { delay: 110 });
await sleep(1800);

mark("s3_run");
const runBtn = page.locator("button.ni-btn.primary").first();
await runBtn.click();

// ルーティング決定 → MCP 呼び出しが流れ始めるまで
await page
  .waitForSelector(".ni-sse-log .ni-routing, .ni-sse-log .ni-call-row", { timeout: 120_000 })
  .catch(() => {});
mark("s3_streaming");
await page.waitForSelector(".ni-sse-log .ni-call-row", { timeout: 120_000 }).catch(() => {});

// 回答(このターンの ni-answer)が出るまで待つ。実行中はボタンが「実行中…」になる。
await page
  .locator(".ni-thread .ni-answer, .ni-console .ni-answer")
  .first()
  .waitFor({ state: "visible", timeout: 300_000 })
  .catch((e) => console.log("[warn] answer wait:", String(e).slice(0, 120)));
await sleep(1500);
mark("s3_answer");

// 回答本文が見える位置までスクロールして読ませる。
const NI = ".app-pane:not([hidden]) .ni-root";
await scrollToEl(page, NI, ".ni-answer", 1200, 260).catch(() => {});
await sleep(6000);

mark("s3_outro");
await scrollToEl(page, NI, ".ni-sse-panel", 1200, 200).catch(() => {});
await sleep(4000);

mark("rec_end");
const tEnd = Date.now() - t0;

await ctx.close();
await browser.close();

// 生成された .webm を demo/work/demo-raw.webm に固定名で置く。
const webm = readdirSync(WORK)
  .filter((f) => f.endsWith(".webm") && f !== "demo-raw.webm")
  .map((f) => `${WORK}/${f}`)
  .sort()
  .pop();
renameSync(webm, `${WORK}/demo-raw.webm`);

writeFileSync(
  `${WORK}/marks.json`,
  JSON.stringify({ query: QUERY, width: W, height: H, durationMs: tEnd, marks }, null, 2),
);
console.log(`\nrecorded ${(tEnd / 1000).toFixed(1)}s -> ${WORK}/demo-raw.webm`);
