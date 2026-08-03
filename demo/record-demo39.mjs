// 39: モデル比較デモの録画(36 番の record-demo36.mjs がベース)。
//
// 同じ調査フロー(初回クエリ + 「続けて調べる」)を Sonnet と Local(gemma4:12b)で
// それぞれ実行し、26 番で実装した所要時間表示(ターン見出し / 実行タイムライン)で
// 速度差が見えるようにする。
//
//   ① ネットワーク調査タブ → サイト Home / モデル Sonnet でクエリ実行
//   ② 回答下の「続けて調べる」チップをワンクリック(同一スレッドの 2 ターン目)
//   ③ Sonnet の 2 ターン分の所要時間を見せる
//   ④ 新しい調査を始める → モデル Local(gemma4:12b)で同じクエリを実行
//   ⑤ Local でも「続けて調べる」(チップが無ければ継続チェック + 同じ追い質問)
//   ⑥ 実行タイムラインで Sonnet / Local のカードを並べて見せる
//
// 待ち時間(特に Local)は実行ごとに大きく変わるため、実際の時刻と画面から読み取った
// 所要時間を marks.json に書き出し、字幕・早送りはそこから生成する(make-video39.mjs)。
// 34〜38 番の成果物(demo/work*, 既存 mp4)には触らない(作業先は demo/work39)。
//
// 注: 以下の page.evaluate / waitForFunction は Playwright の DOM 参照 API で、
// JS の eval() とは無関係(渡している関数はこのファイル内のリテラルのみ)。
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";

const URL = process.env.DEMO_URL ?? "http://localhost:8092/";
const WORK = "demo/work39";
const W = 1600;
const H = 900;

// 両モデルで同じ質問を使う(速度差が公平に伝わるように)。
const QUERY = "Homeサイトの状態を教えて";
const SITE = "Home";

// Local 側はターンあたり数分かかる(25 番の実測で 224 秒)。
const TURN_TIMEOUT_SONNET = 600_000;
const TURN_TIMEOUT_LOCAL = 1_500_000;

mkdirSync(WORK, { recursive: true });

let t0 = 0;
const marks = [];
const mark = (name) => {
  const t = Date.now() - t0;
  marks.push({ name, t });
  console.log(`mark ${name} @ ${(t / 1000).toFixed(2)}s`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 34〜38 番と同じ表示設定(日本語・ライトテーマ)に固定。
await page.addInitScript(() => {
  localStorage.setItem("mnd-lang", "ja");
  localStorage.setItem("mnd-theme", "light");
});

await page.goto(URL, { waitUntil: "domcontentloaded" });

const NI = ".app-pane:not([hidden]) .ni-root";
const pane = (sel) => page.locator(`.app-pane:not([hidden]) ${sel}`);

// 画面のターン見出しから model / 所要時間を読み取る(26 番の表示をそのまま使う)。
const readTurnMeta = () =>
  page.$$eval(".app-pane:not([hidden]) .ni-console-session .ni-turn", (els) =>
    els.map((el) => {
      const head = el.querySelector(".ni-turn-head")?.textContent ?? "";
      const m = head.match(/model=(\S+)\s*・\s*([0-9.]+)\s*(秒|ms)/);
      return {
        head: head.replace(/\s+/g, " ").trim(),
        model: m ? m[1] : null,
        durationText: m ? `${m[2]}${m[3]}` : null,
        seconds: m ? (m[3] === "ms" ? Number(m[2]) / 1000 : Number(m[2])) : null,
        error: el.classList.contains("error"),
      };
    }),
  );

const waitTurns = (n, timeout) =>
  page.waitForFunction(
    (want) => document.querySelectorAll(".app-pane:not([hidden]) .ni-console-session .ni-turn").length >= want,
    n,
    { timeout, polling: 1000 },
  );

// チップ情報(無ければ null)。
async function chipInfo() {
  const chip = pane(".ni-suggested .ni-chip").first();
  if ((await chip.count()) === 0) return null;
  // title 属性は `<クエリ> (site=<サイト>)` の形。実際に投げられるクエリ文は前半だけなので、
  // 追い質問を Local 側で再利用するときは補足を落とした query を使う。
  return chip.evaluate((el) => {
    const title = el.getAttribute("title") ?? "";
    return {
      label: el.childNodes[0]?.textContent?.trim() ?? el.textContent?.trim() ?? "",
      site: el.querySelector(".ni-chip-site")?.textContent?.trim() ?? null,
      title,
      query: title.replace(/\s*\(site=[^)]*\)\s*$/, ""),
    };
  });
}

const result = { query: QUERY, site: SITE, sonnet: {}, local: {} };

// ============ 準備: ネットワーク調査タブへ ============
await page.waitForSelector(".go-card-value", { timeout: 60_000 });
await sleep(1500);
await page.getByRole("tab", { name: "ネットワーク調査" }).click();
await page.waitForSelector("textarea.ni-input", { timeout: 60_000 });
await page.waitForFunction(
  () => document.querySelectorAll(".app-pane:not([hidden]) .ni-select option").length > 3,
  undefined,
  { timeout: 60_000 },
);
await sleep(2000);
mark("open_ni");
await sleep(3000);

// ============ ① Sonnet ============
mark("s_setup");
await pane(".ni-select").first().selectOption(SITE);
await sleep(1400);
await pane(".ni-model-select").selectOption("sonnet");
await sleep(1800);
const ta = pane("textarea.ni-input");
await ta.click();
// 入力欄に残っている文字列に追記してしまわないよう、必ず空にしてから打つ
//(チップ実行や前のターンの内容が残っていると、両モデルで別の質問になってしまう)。
await ta.fill("");
await ta.type(QUERY, { delay: 90 });
await sleep(2200);
mark("s_typed");
await sleep(1500);

mark("s_run1");
await pane("button.ni-btn.primary").first().click();
await page
  .waitForSelector(".ni-sse-log .ni-routing, .ni-sse-log .ni-call-row", { timeout: 180_000 })
  .catch(() => {});
mark("s_stream1");
await waitTurns(1, TURN_TIMEOUT_SONNET).catch((e) => console.log("[warn] sonnet turn1:", String(e).slice(0, 120)));
await sleep(1500);
mark("s_answer1");
await scrollToEl(page, NI, ".ni-console-session .ni-turn .ni-answer", 1200, 240).catch(() => {});
await sleep(6000);
result.sonnet.turn1 = (await readTurnMeta())[0] ?? null;
console.log("sonnet turn1:", JSON.stringify(result.sonnet.turn1));

// 「続けて調べる」チップをワンクリック(36 番と同じ操作)。
mark("s_chip");
await scrollToEl(page, NI, ".ni-suggested", 1000, 320).catch(() => {});
await sleep(1200);
const sChip = await chipInfo();
result.sonnet.chip = sChip;
console.log("sonnet chip:", JSON.stringify(sChip));
if (sChip) {
  const chip = pane(".ni-suggested .ni-chip").first();
  await chip.hover();
  await sleep(3000);
  mark("s_click2");
  await chip.click();
} else {
  // 提案が無い場合の保険: 継続チェック + 追い質問を手入力。
  mark("s_click2");
  await pane(".ni-continue input").check();
  await ta.click();
  await ta.fill("Homeサイトのアラートの内訳を詳しく教えて");
  await sleep(1200);
  await pane("button.ni-btn.primary").first().click();
}
await page
  .waitForSelector(".ni-sse-log .ni-routing, .ni-sse-log .ni-call-row", { timeout: 180_000 })
  .catch(() => {});
mark("s_stream2");
await waitTurns(2, TURN_TIMEOUT_SONNET).catch((e) => console.log("[warn] sonnet turn2:", String(e).slice(0, 120)));
await sleep(1500);
mark("s_answer2");
await scrollToEl(page, NI, ".ni-console-session .ni-turn:last-child .ni-answer", 1200, 240).catch(() => {});
await sleep(5000);

// ============ ③ Sonnet の所要時間(2 ターン分)を見せる ============
mark("s_durations");
await scrollToEl(page, NI, ".ni-console-session-head", 1200, 60).catch(() => {});
await sleep(1000);
result.sonnet.turns = await readTurnMeta();
console.log("sonnet turns:", JSON.stringify(result.sonnet.turns));
await sleep(6000);

// ============ ④ Local(gemma4:12b)で同じクエリ ============
mark("l_new");
await pane(".ni-console-session-head button.ni-btn.sm").last().click(); // 新しい調査を始める
await sleep(2500);
await pane(".ni-select").first().selectOption(SITE);
await sleep(1000);
await pane(".ni-model-select").selectOption("local");
await sleep(2400); // モデル選択が Local(gemma4:12b) に変わったことを見せる
mark("l_setup");
await ta.click();
await ta.fill(""); // Sonnet 側のチップ実行で残った文字列を消してから、同じ質問を打つ
await ta.type(QUERY, { delay: 90 });
await sleep(2000);

mark("l_run1");
await pane("button.ni-btn.primary").first().click();
await page
  .waitForSelector(".ni-sse-log .ni-routing, .ni-sse-log .ni-call-row", { timeout: 300_000 })
  .catch(() => {});
mark("l_stream1");
await waitTurns(1, TURN_TIMEOUT_LOCAL).catch((e) => console.log("[warn] local turn1:", String(e).slice(0, 120)));
await sleep(1500);
mark("l_answer1");
await scrollToEl(page, NI, ".ni-console-session .ni-turn .ni-answer", 1200, 240).catch(() => {});
await sleep(6000);
result.local.turn1 = (await readTurnMeta())[0] ?? null;
console.log("local turn1:", JSON.stringify(result.local.turn1));

// ============ ⑤ Local でも続けて調べる ============
mark("l_chip");
const lChip = await chipInfo();
result.local.chip = lChip;
result.local.followupMode = lChip ? "chip" : "continue-checkbox";
console.log("local chip:", JSON.stringify(lChip));
if (lChip) {
  await scrollToEl(page, NI, ".ni-suggested", 1000, 320).catch(() => {});
  await sleep(1200);
  const chip = pane(".ni-suggested .ni-chip").first();
  await chip.hover();
  await sleep(3000);
  mark("l_click2");
  await chip.click();
} else {
  // Local モデルが suggested-actions を出さなかった場合は、Sonnet 側と同じ追い質問を
  // 継続チェック付きで実行する(比較の条件を揃える)。
  const followup = result.sonnet.chip?.query || "Homeサイトのアラートの内訳を詳しく教えて";
  result.local.followupQuery = followup;
  await scrollToEl(page, NI, ".ni-form", 1000, 60).catch(() => {});
  await sleep(1000);
  await pane(".ni-continue input").check();
  await sleep(1200);
  await ta.click();
  await ta.fill(followup);
  await sleep(2000);
  mark("l_click2");
  await pane("button.ni-btn.primary").first().click();
}
await page
  .waitForSelector(".ni-sse-log .ni-routing, .ni-sse-log .ni-call-row", { timeout: 300_000 })
  .catch(() => {});
mark("l_stream2");
await waitTurns(2, TURN_TIMEOUT_LOCAL).catch((e) => console.log("[warn] local turn2:", String(e).slice(0, 120)));
await sleep(1500);
mark("l_answer2");
await scrollToEl(page, NI, ".ni-console-session .ni-turn:last-child .ni-answer", 1200, 240).catch(() => {});
await sleep(5000);

mark("l_durations");
await scrollToEl(page, NI, ".ni-console-session-head", 1200, 60).catch(() => {});
await sleep(1000);
result.local.turns = await readTurnMeta();
console.log("local turns:", JSON.stringify(result.local.turns));
await sleep(6000);

// ============ ⑥ 実行タイムラインで両方を並べて見せる ============
mark("t_timeline");
await scrollToEl(page, NI, ".ni-timeline", 1400, 40).catch(() => {});
await sleep(2000);
// 先頭 2 枚(Local / Sonnet)が入るようにカード列へ寄せる。
await scrollToEl(page, NI, ".ni-timeline-list", 1000, 120).catch(() => {});
await sleep(1500);
mark("t_cards");
const cards = await page.$$eval(".app-pane:not([hidden]) .ni-tl-card", (els) =>
  els.slice(0, 4).map((el) => {
    const top = el.querySelector(".ni-tl-top")?.textContent ?? "";
    const m = top.match(/model=(\S+)\s*・\s*([0-9.]+)\s*(秒|ms)/);
    return {
      top: top.replace(/\s+/g, " ").trim(),
      model: m ? m[1] : null,
      durationText: m ? `${m[2]}${m[3]}` : null,
      query: el.querySelector(".ni-tl-query")?.textContent?.trim() ?? "",
      threadTag: el.querySelector(".ni-tag.thread")?.textContent?.trim() ?? null,
    };
  }),
);
result.timelineCards = cards;
console.log("timeline cards:", JSON.stringify(cards, null, 1));
await sleep(8000);

mark("t_outro");
await sleep(4500);

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
  JSON.stringify({ ...result, width: W, height: H, durationMs: tEnd, marks }, null, 2),
);
console.log(`\nrecorded ${(tEnd / 1000).toFixed(1)}s -> ${WORK}/demo-raw.webm`);
