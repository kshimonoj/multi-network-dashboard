// 38: 34 番の字幕を「です・ます調」に変更(36 番の文体に合わせる)。
// 34 番の demo/make-video.mjs がベース。変更点は PLAN の texts の文言のみ ──
// タイミング計算・字幕の切り替わりポイント・raw 動画は一切変更しない。
// 34 番の成果物(demo/multi-network-dashboard-demo.mp4, demo/subtitles.ja.srt)は上書きしない。
//
// 字幕のタイミングは demo/work/marks.json(録画スクリプトが実際に書き出した時刻)から作る。
// 決め打ちの秒数は持たない ── 調査クエリの実行時間は毎回変わるため。
//
// ---- なぜ drawtext / subtitles フィルタを使わないか ----
// このホストの ffmpeg 8.1.1(Homebrew, --enable-libass も freetype も無いビルド)には
// drawtext / subtitles / ass のいずれのフィルタも含まれていない(`ffmpeg -h filter=drawtext`
// が Unknown filter を返す)。共有ツールである ffmpeg を作り直す代わりに、
// 字幕 1 枚ごとに透過 PNG を作り overlay フィルタで焼き込む(結果は同じ「焼き込み字幕」)。
// 参照用・将来 libass 付き ffmpeg に載せ替える場合用に SRT も同時に出力する。
//
// 注: 以下の page.locator(...).screenshot は Playwright の API。JS の eval() は使っていない。
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WORK = "demo/work";
const CAPDIR = "demo/work_v2/caps";
const RAW = `${WORK}/demo-raw.webm`;
const OUT = "demo/multi-network-dashboard-demo_v2.mp4";
const SRT = "demo/subtitles_v2.ja.srt";

const meta = JSON.parse(readFileSync(`${WORK}/marks.json`, "utf8"));
const M = Object.fromEntries(meta.marks.map((m) => [m.name, m.t / 1000]));

// ---- 字幕の台本(from マーク → to マークの区間に、texts を等分で割り当てる)----
// 区間が長い場面(MCP 呼び出しの待ち = 実行ごとに長さが変わる)は複数の文をローテーションさせ、
// 1 枚あたりの表示が 2〜7 秒に収まるようにする。
const PLAN = [
  { from: "s1_summary", to: "s1_donut", texts: ["① Global Overview — Central / Mist の状況をひと目で確認します"] },
  { from: "s1_donut", to: "s1_map", texts: ["サイト数・デバイス数・クライアント数・アラート数をプラットフォーム別に集計します"] },
  {
    from: "s1_map",
    to: "s1_table",
    texts: [
      "サイトマップ — 位置情報を持つサイトの状態を地図上に表示します",
      "マーカーをクリックすると そのサイトの内訳が読めます",
    ],
  },
  { from: "s1_table", to: "s2_open", texts: ["サイト別内訳では、デバイス / クライアント / アラート / 健全性を確認できます"] },
  { from: "s2_open", to: "s2_timeline", texts: ["② Event / Alert — 全サイトのイベント・アラートをオンデマンドで取得します"] },
  { from: "s2_timeline", to: "s2_sources", texts: ["取得したイベント・アラートを新しい順にタイムライン表示します"] },
  { from: "s2_sources", to: "s2_filter", texts: ["取得元ごとの件数と HTTP リクエスト数も可視化します"] },
  { from: "s2_filter", to: "s2_filtered", texts: ["重要度「重大」で絞り込みます"] },
  { from: "s2_filtered", to: "s3_open", texts: ["重大なアラートだけが残ります — サイト / カテゴリ / 本文でも絞り込めます"] },
  { from: "s3_open", to: "s3_typing", texts: ["③ ネットワーク調査 — 自然文の質問を AI が調査します"] },
  { from: "s3_typing", to: "s3_run", texts: [`「${meta.query}」と入力して実行します`] },
  {
    from: "s3_run",
    to: "s3_answer",
    texts: [
      "Central / Mist 両方の MCP サーバへ自動で問い合わせます",
      "MCP 呼び出しログがリアルタイムに流れます",
      "AI が必要なツールを自分で選んで実行していきます",
      "完了した呼び出しは件数付きで積み上がります",
    ],
  },
  {
    from: "s3_answer",
    to: "s3_outro",
    texts: ["Central / Mist を横断した回答が生成されます", "サイト単位の健全性・アラート・注意点まで要約されます"],
  },
  { from: "s3_outro", to: "rec_end", texts: ["呼び出したツールと回答は履歴として残ります"] },
];

const MAX = 7.0; // 1 枚あたりの上限(秒)
const MIN = 1.2; // これより短くなる区間は捨てる
const GAP = 0.12; // 字幕の切り替わりに入れる無表示の間

// ---- タイミング計算 ----
const caps = [];
for (const seg of PLAN) {
  const a = M[seg.from];
  const b = M[seg.to];
  if (a == null || b == null || b - a < MIN) continue;
  // 上限に収まるまで texts を繰り返して枚数を増やす
  let n = seg.texts.length;
  while ((b - a) / n > MAX) n += seg.texts.length;
  const span = (b - a) / n;
  for (let i = 0; i < n; i++) {
    const start = a + i * span;
    const end = start + span - GAP;
    if (end - start < 0.5) continue;
    caps.push({ start, end, text: seg.texts[i % seg.texts.length] });
  }
}
console.log(`captions: ${caps.length}`);
for (const c of caps) console.log(`  ${c.start.toFixed(2)}-${c.end.toFixed(2)}  ${c.text}`);

// ---- SRT(参照用。libass 付き ffmpeg なら -vf subtitles=... でそのまま使える)----
const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, "0")}`;
};
writeFileSync(
  SRT,
  caps.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n"),
);

// ---- 字幕 PNG(透過)を Chromium で描く ----
rmSync(CAPDIR, { recursive: true, force: true });
mkdirSync(CAPDIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: meta.width, height: 300 }, deviceScaleFactor: 2 });
for (let i = 0; i < caps.length; i++) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent;}
    .wrap{display:flex;justify-content:center;padding:8px 0;}
    .cap{
      max-width:${meta.width - 160}px;
      box-sizing:border-box;
      padding:14px 30px;
      border-radius:12px;
      background:rgba(12,18,26,0.86);
      border:1px solid rgba(255,255,255,0.18);
      color:#fff;
      font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;
      font-size:30px;
      font-weight:600;
      line-height:1.45;
      letter-spacing:0.01em;
      text-align:center;
      white-space:pre-wrap;
    }</style>
    <div class="wrap"><div class="cap">${caps[i].text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div></div>`;
  await page.setContent(html);
  await page.locator(".cap").screenshot({ path: `${CAPDIR}/cap${String(i).padStart(2, "0")}.png`, omitBackground: true });
}
await browser.close();
console.log(`caption pngs -> ${CAPDIR}`);

// ---- ffmpeg: overlay で焼き込み、H.264 mp4 へ ----
const args = ["-y", "-i", RAW];
for (let i = 0; i < caps.length; i++) args.push("-i", `${CAPDIR}/cap${String(i).padStart(2, "0")}.png`);

// PNG は deviceScaleFactor=2 で描いたので 1/2 に縮めてから重ねる(等倍相当・高精細)。
const chain = [];
for (let i = 0; i < caps.length; i++) chain.push(`[${i + 1}:v]scale=iw/2:-1[c${i}]`);
let cur = "0:v";
for (let i = 0; i < caps.length; i++) {
  const next = `v${i}`;
  chain.push(
    `[${cur}][c${i}]overlay=x=(W-w)/2:y=H-h-48:enable='between(t,${caps[i].start.toFixed(3)},${caps[i].end.toFixed(3)})'[${next}]`,
  );
  cur = next;
}
args.push(
  "-filter_complex",
  chain.join(";"),
  "-map",
  `[${cur}]`,
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "22",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "25",
  "-movflags",
  "+faststart",
  OUT,
);

console.log("running ffmpeg…");
execFileSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
console.log(`\ndone -> ${OUT}`);
