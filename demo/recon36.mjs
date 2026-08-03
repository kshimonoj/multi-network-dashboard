// 36: 偵察。authentication 系アラート(802.1X)への絞り込みと、
// 回答後の「続けて調べる」チップ(.ni-suggested .ni-chip)が実際に出るかを確認する。
// 注: $$eval / evaluate は Playwright の DOM 参照 API(JS の eval() とは無関係)。
import { chromium } from "playwright";

const URL = process.env.DEMO_URL ?? "http://localhost:8092/";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  colorScheme: "light",
});
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem("mnd-lang", "ja");
  localStorage.setItem("mnd-theme", "light");
});
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.getByRole("tab", { name: "Event / Alert" }).click();
await page.waitForSelector(".go-feed-table tbody tr", { timeout: 180_000 });
await page.waitForTimeout(1000);

const group = (name) =>
  page.locator(".app-pane:not([hidden]) .go-fgroup").filter({ hasText: name }).first();

// ① 種別=アラート + 検索 "auth"
await group("種別").getByRole("button", { name: "アラート", exact: true }).click();
await page.locator(".go-fsearch").fill("auth");
await page.waitForTimeout(800);

const rows = await page.$$eval(".go-feed-table tbody tr", (trs) =>
  trs.map((tr, i) => ({
    i,
    time: tr.querySelector(".go-fc-time")?.textContent?.trim(),
    sev: tr.querySelector(".go-fsev")?.textContent?.trim(),
    kind: tr.querySelector(".go-fkind")?.textContent?.trim(),
    plat: tr.querySelector(".go-plat-tag")?.textContent?.trim(),
    site: tr.querySelector(".go-fc-site")?.textContent?.trim(),
    cat: tr.querySelector(".go-fc-cat")?.textContent?.trim(),
    text: tr.querySelector(".go-ftext")?.textContent?.trim().slice(0, 140),
  })),
);
console.log(`=== 種別=アラート + 検索"auth" (${rows.length} rows) ===`);
for (const r of rows) console.log(`${r.i}\t${r.time}\t${r.sev}\t${r.kind}\t${r.plat}\t${r.site}\t${r.cat}\t${r.text}`);

if (rows.length === 0) {
  console.log("NO ROWS — abort");
  await browser.close();
  process.exit(1);
}

// ② 先頭行の「調査する」→ ネットワーク調査の事前入力を確認
await page.locator(".go-feed-table tbody tr").first().locator(".go-investigate-btn").click();
await page.waitForSelector("textarea.ni-input", { timeout: 30_000 });
await page.waitForFunction(
  () => (document.querySelector("textarea.ni-input")?.value ?? "").length > 0,
  undefined,
  { timeout: 30_000 },
);
const prefilled = await page.locator("textarea.ni-input").inputValue();
const site = await page.locator(".app-pane:not([hidden]) .ni-select").first().inputValue();
console.log("\nprefilled:", JSON.stringify(prefilled));
console.log("site:", JSON.stringify(site));

// ③ 実行 → 回答 → チップの有無
await page.locator(".app-pane:not([hidden]) button.ni-btn.primary").first().click();
await page.waitForFunction(
  () => document.querySelectorAll(".ni-console-session .ni-turn").length >= 1,
  undefined,
  { timeout: 600_000 },
);
await page.waitForTimeout(1500);
const chips = await page.$$eval(".ni-suggested .ni-chip", (els) =>
  els.map((el) => ({
    label: el.childNodes[0]?.textContent?.trim() ?? el.textContent?.trim(),
    site: el.querySelector(".ni-chip-site")?.textContent?.trim() ?? null,
    title: el.getAttribute("title"),
  })),
);
const suggestedLabel = await page
  .locator(".ni-suggested .ni-suggested-label")
  .textContent()
  .catch(() => null);
console.log("\nsuggested label:", JSON.stringify(suggestedLabel));
console.log("chips:", JSON.stringify(chips, null, 2));
const answer = await page
  .locator(".ni-console-session .ni-turn .ni-answer")
  .first()
  .textContent()
  .catch(() => null);
console.log("\nanswer head:", JSON.stringify((answer ?? "").slice(0, 200)));

await browser.close();
