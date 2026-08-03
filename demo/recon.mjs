// 偵察用スクリプト(本番録画ではない)。
// 各タブが headless Chromium でどう描画されるか、どのセレクタが取れるかを確かめる。
// 注: 以下の page.evaluate / $$eval は Playwright の DOM 参照 API で、JS の eval() とは無関係
// (渡している関数はこのファイル内のリテラルのみ。外部入力を実行する箇所は無い)。
import { chromium } from "playwright";

const URL = process.env.DEMO_URL ?? "http://localhost:8092/";
const OUT = "demo/shots";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 2,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
});
const page = await ctx.newPage();
page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/01-initial.png` });

const tabs = await page.$$eval("button[role=tab]", (els) =>
  els.map((e) => ({ text: e.textContent, selected: e.getAttribute("aria-selected") })),
);
console.log("TABS:", JSON.stringify(tabs, null, 1));

// Global Overview の主要ブロックの有無
for (const sel of [".go-root", ".go-panel", ".go-table", "canvas", ".leaflet-container", "svg"]) {
  console.log("GO", sel, await page.locator(sel).count());
}
// ページ全体の高さ / スクロール対象
const metrics = await page.evaluate(() => {
  const pane = document.querySelector(".app-pane:not([hidden])");
  const root = pane?.querySelector(".go-root");
  return {
    bodyScrollH: document.body.scrollHeight,
    innerH: window.innerHeight,
    paneScrollH: pane?.scrollHeight,
    paneClientH: pane?.clientHeight,
    rootScrollH: root?.scrollHeight,
    rootClientH: root?.clientHeight,
    paneClass: pane?.className,
  };
});
console.log("METRICS:", JSON.stringify(metrics, null, 1));

// Event / Alert
await page.getByRole("tab", { name: "Event / Alert" }).click();
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/02-event.png` });
const chips = await page.$$eval(".go-fgroup", (els) =>
  els.map((e) => e.textContent?.replace(/\s+/g, " ").slice(0, 160)),
);
console.log("EVENT FILTER GROUPS:", JSON.stringify(chips, null, 1));
console.log("EVENT rows:", await page.locator(".go-feed-table tbody tr").count());

// ネットワーク調査
await page.getByRole("tab", { name: "ネットワーク調査" }).click();
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/03-netinv.png` });
console.log("textarea:", await page.locator("textarea.ni-input").count());
const models = await page.$$eval(".ni-model-select option", (els) => els.map((e) => e.textContent));
console.log("MODELS:", JSON.stringify(models, null, 1));
const runBtn = page.locator("button.ni-btn.primary").first();
console.log("runBtn text:", await runBtn.textContent());

await browser.close();
console.log("recon done");
