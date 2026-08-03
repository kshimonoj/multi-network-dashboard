// 35: 偵察用(本番録画ではない)。Event/Alert の行の並びと「調査する」ボタンの取り方、
// 生成されるクエリ文を確かめる。
// 注: page.evaluate / $$eval は Playwright の DOM 参照 API(JS の eval() とは無関係)。
import { chromium } from "playwright";

const URL = process.env.DEMO_URL ?? "http://localhost:8092/";
const OUT = "demo/shots";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  colorScheme: "light",
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.addInitScript(() => {
  localStorage.setItem("mnd-lang", "ja");
  localStorage.setItem("mnd-theme", "light");
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.getByRole("tab", { name: "Event / Alert" }).click();
await page.waitForSelector(".go-feed-table tbody tr", { timeout: 180_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/35-01-event.png` });

const rows = await page.$$eval(".go-feed-table tbody tr", (trs) =>
  trs.slice(0, 25).map((tr, i) => ({
    i,
    time: tr.querySelector(".go-fc-time")?.textContent?.trim(),
    sev: tr.querySelector(".go-fsev")?.textContent?.trim(),
    sevClass: tr.querySelector(".go-fsev")?.className,
    kind: tr.querySelector(".go-fkind")?.textContent?.trim(),
    plat: tr.querySelector(".go-plat-tag")?.textContent?.trim(),
    site: tr.querySelector(".go-fc-site")?.textContent?.trim(),
    cat: tr.querySelector(".go-fc-cat")?.textContent?.trim(),
    text: tr.querySelector(".go-ftext")?.textContent?.trim().slice(0, 120),
    hasBtn: !!tr.querySelector(".go-investigate-btn"),
  })),
);
console.log("ROWS:", JSON.stringify(rows, null, 1));
console.log("total rows:", await page.locator(".go-feed-table tbody tr").count());
console.log("summary:", await page.locator(".go-panel-note").first().textContent());

// 重要度チップの中身
const groups = await page.$$eval(".app-pane:not([hidden]) .go-fgroup", (els) =>
  els.map((e) => e.textContent?.replace(/\s+/g, " ").slice(0, 200)),
);
console.log("FILTER GROUPS:", JSON.stringify(groups, null, 1));

// 「調査する」を押して、遷移後の入力欄・サイト選択の状態を見る(実行はしない)
const target = page.locator(".go-feed-table tbody tr").first();
await target.locator(".go-investigate-btn").click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/35-02-prefilled.png` });
console.log("active tab:", await page.$$eval("button[role=tab][aria-selected=true]", (e) => e.map((x) => x.textContent)));
console.log("textarea:", JSON.stringify(await page.locator("textarea.ni-input").inputValue()));
console.log("site select:", JSON.stringify(await page.locator(".ni-select").first().inputValue()));
console.log("model select:", JSON.stringify(await page.locator(".ni-model-select").inputValue()));
console.log("continue checkbox count:", await page.locator(".ni-continue input").count());

await browser.close();
console.log("recon35 done");
