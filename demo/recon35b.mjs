// 35: 偵察その2。アラート / 重大・警告の行だけを抽出して、デモに使う 1 件を選ぶ。
// 注: $$eval は Playwright の DOM 参照 API(JS の eval() とは無関係)。
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

const dump = async (label) => {
  const rows = await page.$$eval(".go-feed-table tbody tr", (trs) =>
    trs.slice(0, 20).map((tr, i) => ({
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
  console.log(`\n=== ${label} (${await page.locator(".go-feed-table tbody tr").count()} rows) ===`);
  for (const r of rows) console.log(`${r.i}\t${r.time}\t${r.sev}\t${r.kind}\t${r.plat}\t${r.site}\t${r.cat}\t${r.text}`);
};

const group = (name) =>
  page.locator(".app-pane:not([hidden]) .go-fgroup").filter({ hasText: name }).first();

await group("種別").getByRole("button", { name: "アラート", exact: true }).click();
await page.waitForTimeout(800);
await dump("種別=アラート");

await group("種別").getByRole("button", { name: "すべて", exact: true }).click();
await group("重要度").getByRole("button", { name: "重大", exact: true }).click();
await page.waitForTimeout(800);
await dump("重要度=重大");

await group("重要度").getByRole("button", { name: "警告", exact: true }).click();
await page.waitForTimeout(800);
await dump("重要度=警告");

await browser.close();
