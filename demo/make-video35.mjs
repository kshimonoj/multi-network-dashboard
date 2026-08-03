// 35: 字幕の焼き込み + mp4 化(34 番の demo/make-video.mjs と同じ方式)。
//
// タイミングは demo/work35/marks.json(録画スクリプトが実際に書き出した時刻)から作る。
// 決め打ちの秒数は持たない ── 調査の実行時間は毎回変わるため。
//
// このホストの ffmpeg には drawtext / subtitles / ass フィルタが無いので(34 番の調査どおり)、
// 字幕 1 枚ごとに透過 PNG を作って overlay で焼き込む。参照用に SRT も出す。
//
// 出力先は 34 番と別名にしてあり、34 番の成果物(demo/multi-network-dashboard-demo.mp4,
// demo/subtitles.ja.srt, demo/work)には一切触らない。
//
// 注: page.locator(...).screenshot は Playwright の API。JS の eval() は使っていない。
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WORK = "demo/work35";
const CAPDIR = `${WORK}/caps`;
const RAW = `${WORK}/demo-raw.webm`;
const OUT = "demo/demo_02_event_to_investigation.mp4";
const SRT = "demo/subtitles35.ja.srt";

const meta = JSON.parse(readFileSync(`${WORK}/marks.json`, "utf8"));
const M = Object.fromEntries(meta.marks.map((m) => [m.name, m.t / 1000]));
const P = meta.picked;

// ---- 字幕の台本(from マーク → to マークの区間に、texts を等分で割り当てる)----
// 待ち時間が長い区間(MCP 呼び出し = 実行ごとに長さが変わる)は 1 枚あたり MAX 秒に収まるだけの
// 文を並べておき、同じ文の使い回しを避ける(texts が足りないときだけ先頭から繰り返す)。
// offset は from マークからさらに遅らせたい秒数(タブ切り替えの直後など)。
const PLAN = [
  {
    from: "rec_start",
    to: "e1_filter",
    offset: 1.6, // 0〜1.3 秒は Global Overview が映っているので、タブ切替後から出す
    texts: [
      "① Event / Alert — Central / Mist のイベント・アラートを横断で一覧",
      "気になった行から、その場で調査を始められる",
    ],
  },
  { from: "e1_filter", to: "e1_filtered", texts: ["種別「アラート」・重要度「重大」で絞り込む"] },
  {
    from: "e1_filtered",
    to: "e1_pick",
    texts: [`最新の${P.severity}${P.kind} — ${P.site}(${P.platform}) / ${P.category}`],
  },
  { from: "e1_pick", to: "e1_click", texts: ["この行の「調査する」を押す"] },
  {
    from: "n1_prefilled",
    to: "n1_run",
    texts: [
      "② ネットワーク調査タブへ自動で切り替わる",
      "事案の要約からクエリ文が事前入力され、サイトも自動選択される",
    ],
  },
  {
    from: "n1_run",
    to: "n1_answer",
    texts: [
      "③ そのまま「実行」— AI が MCP 経由で調査を始める",
      "Central / Mist のどちらに聞くかは AI が判断する",
      "呼び出したツールと取得件数がリアルタイムに流れる",
      "まずサイト概要を取得し、対象のスイッチを特定",
      "そのサイトのアラート・直近イベントへ掘り下げていく",
      "失敗した呼び出しも隠さずそのまま表示される",
      "回答に至るまでの過程がすべて追える",
    ],
  },
  {
    from: "n1_answer",
    to: "f_continue",
    texts: [
      "現状・根本原因の兆候・影響範囲・過去事例まで整理された回答",
      "回答の下には「続けて調べる」候補も提示される",
    ],
  },
  { from: "f_continue", to: "f_typing", texts: ["④「このスレッドの続きとして実行する」をオンにする"] },
  { from: "f_typing", to: "f_run", texts: ["同じスレッドへの追い質問を入力"] },
  {
    from: "f_run",
    to: "f_answer",
    texts: [
      "追い質問も同じ手順で MCP へ問い合わせる",
      "1 ターン目の回答を前提に調査が進む",
      "同じサイトの直近イベントを洗い直す",
      "再発しているかどうかをデータで確かめる",
      "サイト内に他のデバイスがあるかも点検",
      "イベント種別ごとの件数を突き合わせる",
      "2 ターン目の呼び出しログも同じパネルに流れる",
      "掘り下げた結論が出るまで待つ",
    ],
  },
  {
    from: "f_answer",
    to: "s_thread",
    texts: ["再発の有無と、切り分けの進め方まで踏み込んだ回答", "前のターンを踏まえた「続き」として答えている"],
  },
  { from: "s_thread", to: "s_outro", texts: ["⑤ 2 ターンの調査が 1 つのセッションとして残る"] },
  { from: "s_outro", to: "rec_end", texts: ["スレッド全体の共有・印刷 / PDF・メールもそのまま出せる"] },
];

const MAX = 7.0; // 1 枚あたりの上限(秒)
const MIN = 1.2; // これより短くなる区間は捨てる
const GAP = 0.12; // 字幕の切り替わりに入れる無表示の間

// ---- タイミング計算 ----
const caps = [];
for (const seg of PLAN) {
  const a = M[seg.from] == null ? null : M[seg.from] + (seg.offset ?? 0);
  const b = M[seg.to];
  if (a == null || b == null || b - a < MIN) continue;
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

// ---- SRT(参照用)----
const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, "0")}`;
};
writeFileSync(SRT, caps.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n"));

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
  await page
    .locator(".cap")
    .screenshot({ path: `${CAPDIR}/cap${String(i).padStart(2, "0")}.png`, omitBackground: true });
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
