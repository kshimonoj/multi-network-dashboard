// 36: デモ動画の再撮影(35 番の record-demo35.mjs がベース)。
//
// 35 番からの変更点:
//   - Event / Alert では authentication 系のアラートを選ぶ
//     (種別「アラート」+ 検索 "auth" → 802.1X Server Timed Out に絞り込む。recon36.mjs で確認済み)
//   - 2 ターン目は「このスレッドの続きとして実行する」チェックではなく、
//     回答の下に出る「続けて調べる」チップ(.ni-suggested .ni-chip)をワンクリックする
//
// 待ち時間(イベント取得・調査の実行)は実行ごとに変わるため、このスクリプトが
// 実際の時刻をマークとして書き出し、字幕・早送りはそのマークから生成する。
// 34 / 35 番の成果物(demo/work, demo/work35, 既存 mp4)には触らない(作業先は demo/work36)。
//
// 注: 以下の page.evaluate / $$eval / waitForFunction は Playwright の DOM 参照 API で、
// JS の eval() とは無関係(渡している関数はこのファイル内のリテラルのみ)。
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";

const URL = process.env.DEMO_URL ?? "http://localhost:8092/";
const WORK = "demo/work36";
const W = 1600;
const H = 900;

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

// スクロールは requestAnimationFrame で ease させる(34/35 番と同じ)。
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
t0 = Date.now();
mark("rec_start");

page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));

// 34/35 番と同じ表示設定(日本語・ライトテーマ)に固定。
await page.addInitScript(() => {
  localStorage.setItem("mnd-lang", "ja");
  localStorage.setItem("mnd-theme", "light");
});

await page.goto(URL, { waitUntil: "domcontentloaded" });

const GO = ".app-pane:not([hidden]) .go-root";
const NI = ".app-pane:not([hidden]) .ni-root";
const fgroup = (name) => page.locator(".app-pane:not([hidden]) .go-fgroup").filter({ hasText: name }).first();

// ============ ① Event / Alert ============
await page.waitForSelector(".go-card-value", { timeout: 60_000 });
await sleep(1200);
await page.getByRole("tab", { name: "Event / Alert" }).click();
await page.waitForSelector(".go-feed-table tbody tr", { timeout: 180_000 });
await sleep(1200);
mark("e1_list"); // イベント/アラート一覧が出た
await sleep(4200);

// authentication 系に絞り込む(種別 = アラート + 検索 "auth")。
mark("e1_filter");
await scrollToEl(page, GO, ".go-fbar", 900, 200);
await sleep(900);
await fgroup("種別").getByRole("button", { name: "アラート", exact: true }).click();
await sleep(1400);
const search = page.locator(".app-pane:not([hidden]) .go-fsearch");
await search.click();
await search.type("auth", { delay: 260 });
await sleep(1400);
mark("e1_filtered");
await scrollToEl(page, GO, ".go-feed-table", 900, 150);
await sleep(3800);

// 先頭(= 最新)の 802.1X アラートを対象にする。実際に何を選んだかは marks.json に残す。
const row = page.locator(".go-feed-table tbody tr").first();
const picked = await row.evaluate((tr) => ({
  time: tr.querySelector(".go-fc-time")?.textContent?.trim() ?? "",
  severity: tr.querySelector(".go-fsev")?.textContent?.trim() ?? "",
  kind: tr.querySelector(".go-fkind")?.textContent?.trim() ?? "",
  platform: tr.querySelector(".go-plat-tag")?.textContent?.trim() ?? "",
  site: tr.querySelector(".go-fc-site")?.textContent?.trim() ?? "",
  category: tr.querySelector(".go-fc-cat")?.textContent?.trim() ?? "",
  text: tr.querySelector(".go-ftext")?.textContent?.trim() ?? "",
}));
console.log("picked:", JSON.stringify(picked));

mark("e1_pick");
const invBtn = row.locator(".go-investigate-btn");
await invBtn.scrollIntoViewIfNeeded();
await invBtn.hover();
await sleep(3000);
mark("e1_click");
await invBtn.click();

// ============ ② ネットワーク調査へ自動遷移(事前入力を見せる)============
await page.waitForSelector("textarea.ni-input", { timeout: 30_000 });
await page.waitForFunction(
  () => (document.querySelector("textarea.ni-input")?.value ?? "").length > 0,
  undefined,
  { timeout: 30_000 },
);
await sleep(800);
mark("n1_prefilled");
const prefilled = await page.locator("textarea.ni-input").inputValue();
const site = await page.locator(".app-pane:not([hidden]) .ni-select").first().inputValue();
console.log("prefilled:", JSON.stringify(prefilled), "site:", JSON.stringify(site));
await sleep(8000); // 事前入力されたクエリ文とサイト選択をゆっくり見せる

// ============ ③ 1 ターン目の実行 ============
mark("n1_run");
await page.locator(".app-pane:not([hidden]) button.ni-btn.primary").first().click();

await page
  .waitForSelector(".ni-sse-log .ni-routing, .ni-sse-log .ni-call-row", { timeout: 120_000 })
  .catch(() => {});
mark("n1_streaming");
await page.waitForSelector(".ni-sse-log .ni-call-row", { timeout: 180_000 }).catch(() => {});

// 1 ターン目が完了してスレッドに積まれるまで待つ。
const waitTurns = (n, timeout) =>
  page.waitForFunction(
    (want) => document.querySelectorAll(".ni-console-session .ni-turn").length >= want,
    n,
    { timeout },
  );
await waitTurns(1, 600_000).catch((e) => console.log("[warn] turn1:", String(e).slice(0, 120)));
await sleep(1200);
mark("n1_answer");
await scrollToEl(page, NI, ".ni-console-session .ni-turn .ni-answer", 1200, 240).catch(() => {});
await sleep(8000);

// ============ ④ 続けて調べる(回答下のチップをワンクリック → 同じスレッドの 2 ターン目)============
mark("f_chip");
await scrollToEl(page, NI, ".ni-suggested", 1000, 320).catch(() => {});
await sleep(1200);
const chip = page.locator(".app-pane:not([hidden]) .ni-suggested .ni-chip").first();
await chip.waitFor({ timeout: 15_000 });
const chipInfo = await chip.evaluate((el) => ({
  label: el.childNodes[0]?.textContent?.trim() ?? el.textContent?.trim() ?? "",
  site: el.querySelector(".ni-chip-site")?.textContent?.trim() ?? null,
  query: el.getAttribute("title") ?? "",
}));
console.log("chip:", JSON.stringify(chipInfo));
await chip.hover();
await sleep(3200); // チップにフォーカスした状態を見せる
mark("f_click");
await chip.click(); // ワンクリックで即時実行(入力・チェック操作なし)

await page
  .waitForSelector(".ni-sse-log .ni-routing, .ni-sse-log .ni-call-row", { timeout: 120_000 })
  .catch(() => {});
mark("f_streaming");
await waitTurns(2, 600_000).catch((e) => console.log("[warn] turn2:", String(e).slice(0, 120)));
await sleep(1200);
mark("f_answer");
await scrollToEl(page, NI, ".ni-console-session .ni-turn:last-child .ni-answer", 1200, 240).catch(() => {});
await sleep(7000);

// ============ ⑤ 2 ターンが 1 セッションとして残っている ============
mark("s_thread");
await scrollToEl(page, NI, ".ni-console-session-head", 1200, 60).catch(() => {});
await sleep(5000);
const turnCount = await page.locator(".ni-console-session .ni-turn").count();
const threadHead = (await page.locator(".ni-console-session-head .ni-panel-title").textContent()) ?? "";
console.log("turns:", turnCount, "head:", threadHead);

mark("s_outro");
await sleep(4000);

mark("rec_end");
const tEnd = Date.now() - t0;

await ctx.close();
await browser.close();

const webm = readdirSync(WORK)
  .filter((f) => f.endsWith(".webm") && f !== "demo-raw.webm")
  .map((f) => `${WORK}/${f}`)
  .sort()
  .pop();
renameSync(webm, `${WORK}/demo-raw.webm`);

writeFileSync(
  `${WORK}/marks.json`,
  JSON.stringify(
    {
      picked,
      prefilled,
      site,
      chip: chipInfo,
      turnCount,
      threadHead,
      width: W,
      height: H,
      durationMs: tEnd,
      marks,
    },
    null,
    2,
  ),
);
console.log(`\nrecorded ${(tEnd / 1000).toFixed(1)}s -> ${WORK}/demo-raw.webm`);
