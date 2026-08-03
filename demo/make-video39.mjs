// 39: 早送り編集 + 字幕の焼き込み + mp4 化(36 番の demo/make-video36.mjs がベース)。
//
// 36 番からの変更点:
//   - 早送り区間は Sonnet / Local の 4 ターン分の待ち時間(実行直後〜回答表示直前)。
//     倍率は全区間で同じ 3 倍にする(Local だけ強く縮めると速度差の印象が壊れるため)。
//   - 字幕には画面から読み取った実測の所要時間(秒)を差し込む。
//   - 37 番の判断どおり「▶▶ 3倍速」バッジのオーバーレイは付けない。
//     代わりに、早送りしている待ち区間ではそのことを字幕で 1 度だけ述べる。
//
// タイミングは demo/work39/marks.json(録画スクリプトが実際に書き出した時刻)から作る。
// このホストの ffmpeg には drawtext / subtitles / ass フィルタが無いので(34 番の調査どおり)、
// 字幕 1 枚ごとに透過 PNG を作って overlay で焼き込む。参照用に SRT も出す。
// 34〜38 番の成果物には一切触らない。
//
// 注: page.locator(...).screenshot は Playwright の API。JS の eval() は使っていない。
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WORK = "demo/work39";
const CAPDIR = `${WORK}/caps`;
const RAW = `${WORK}/demo-raw.webm`;
const OUT = "demo/demo_03_model_comparison.mp4";
const SRT = "demo/subtitles39.ja.srt";

const meta = JSON.parse(readFileSync(`${WORK}/marks.json`, "utf8"));
const M = Object.fromEntries(meta.marks.map((m) => [m.name, m.t / 1000]));
const DUR = meta.durationMs / 1000;

// ---- 実測の所要時間(画面のターン見出しから読み取った値)----
const dur = (side, i) => {
  const turns = meta[side]?.turns ?? [];
  return turns[i]?.durationText ?? meta[side]?.[`turn${i + 1}`]?.durationText ?? "—";
};
const S1 = dur("sonnet", 0);
const S2 = dur("sonnet", 1);
const L1 = dur("local", 0);
const L2 = dur("local", 1);
const sChipLabel = meta.sonnet?.chip?.label ?? "続けて調べる";
// 倍率も実測値から出す(字幕に数字を出すので、手で書かずに計算する)。
const sec = (side, i) => meta[side]?.turns?.[i]?.seconds ?? null;
const ratio = (a, b) => (a && b ? (a / b).toFixed(1) : null);
const R1 = ratio(sec("local", 0), sec("sonnet", 0));
const R2 = ratio(sec("local", 1), sec("sonnet", 1));
// 2 ターンの合計(タイムラインのカードは「最終ターン」の所要時間しか出さないので、
// 全体の差は合計で示す)。
const total = (side) => {
  const a = sec(side, 0);
  const b = sec(side, 1);
  return a != null && b != null ? (a + b).toFixed(1) : null;
};
const TS = total("sonnet");
const TL = total("local");
const RT = ratio(Number(TL), Number(TS));
// 継続チェックで実行した場合、クエリ文は Sonnet 側のチップ(title 属性)から取っているため
// 末尾に " (site=Home)" が付く。字幕では読みやすさのためこの補足を落とす。
const lFollowup =
  meta.local?.followupMode === "chip"
    ? `「${meta.local?.chip?.label ?? ""}」`
    : `「${(meta.local?.followupQuery ?? "").replace(/\s*\(site=[^)]*\)\s*$/, "")}」`;
console.log(`durations: sonnet ${S1} / ${S2}   local ${L1} / ${L2}`);

// ---- 早送り区間(ソース時間)----
// 実行/チップ押下の直後 8 秒(ルーティング判定・最初の呼び出し)と回答表示の直前 3 秒は
// 等倍で残し、間の待ち時間だけを 3 倍速にする。
const SPEED = 3;
const regions = [];
// 「どの待ち区間を実際に早送りしたか」を字幕側でも参照する(短くて早送りしなかった
// 区間に「3 倍速で再生しています」と書かないため)。
const sped = {};
for (const [key, a, b] of [
  ["s1", M.s_run1 + 8, M.s_answer1 - 3],
  ["s2", M.s_click2 + 8, M.s_answer2 - 3],
  ["l1", M.l_run1 + 8, M.l_answer1 - 3],
  ["l2", M.l_click2 + 8, M.l_answer2 - 3],
]) {
  if (a != null && b != null && b - a >= 6) {
    regions.push([a, b]);
    sped[key] = true;
  }
}
console.log(
  "speed regions (src):",
  regions.map(
    ([a, b]) =>
      `${a.toFixed(1)}-${b.toFixed(1)}s (${(b - a).toFixed(1)}s -> ${((b - a) / SPEED).toFixed(1)}s)`,
  ),
);

// ---- ソース時間 → 出力時間の写像(regions の内側は 1/SPEED)----
const out = (t) => {
  let o = 0;
  let cur = 0;
  for (const [a, b] of regions) {
    if (t <= a) return o + (t - cur);
    o += a - cur;
    if (t <= b) return o + (t - a) / SPEED;
    o += (b - a) / SPEED;
    cur = b;
  }
  return o + (t - cur);
};

// ---- 字幕の台本(from マーク → to マークの区間に texts を等分で割り当てる)----
// すべて「です・ます調」。
const PLAN = [
  {
    from: "rec_start",
    to: "open_ni",
    offset: 1.4,
    texts: [
      "① 同じ質問を Sonnet と Local(gemma4:12b)で実行し、所要時間を見比べます",
      "ネットワーク調査タブを開きます",
    ],
  },
  {
    from: "open_ni",
    to: "s_typed",
    texts: [
      "② まずはサイトに Home、モデルに Sonnet を選びます",
      `質問文は「${meta.query}」です`,
    ],
  },
  { from: "s_typed", to: "s_run1", texts: ["この質問文を、あとで Local 側にもそのまま使います"] },
  {
    from: "s_run1",
    to: "s_answer1",
    texts: [
      "③ Sonnet で実行します — AI が MCP 経由でツールを選び、調査を進めます",
      "呼び出したツールと取得件数がリアルタイムに表示されます",
      "対象サイトの概要から順に、デバイスやアラートへ掘り下げていきます",
      ...(sped.s1 ? ["回答が出るまでの待ち時間は 3 倍速で再生しています"] : []),
    ],
  },
  {
    from: "s_answer1",
    to: "s_chip",
    texts: [
      `回答が表示されました — Sonnet の 1 ターン目は ${S1} です`,
      "回答の下には「続けて調べる」の候補が提示されます",
    ],
  },
  {
    from: "s_chip",
    to: "s_click2",
    texts: ["④ 回答の下の「続けて調べる」をワンクリックして深掘りします"],
  },
  {
    from: "s_click2",
    to: "s_answer2",
    texts: [
      `チップのクエリ「${sChipLabel}」が同じスレッドの 2 ターン目として実行されます`,
      "1 ターン目の回答を前提に、調査がさらに進みます",
      ...(sped.s2 ? ["待ち区間は Sonnet 側・Local 側ともに同じ 3 倍速で再生しています"] : []),
      "2 ターン目の呼び出しログも同じパネルに流れます",
      "AP 単位の詳細まで確認していきます",
      "深掘りの結論が出るまで待ちます",
    ],
  },
  {
    from: "s_answer2",
    to: "s_durations",
    texts: ["前のターンを踏まえた深掘りの回答が得られます"],
  },
  {
    from: "s_durations",
    to: "l_new",
    texts: [
      `⑤ 各ターンの見出しに model と所要時間が記録されます(Sonnet: ${S1} / ${S2})`,
      "この 2 ターンを、次はローカルモデルでそのまま繰り返します",
    ],
  },
  {
    from: "l_new",
    to: "l_run1",
    texts: [
      "⑥ 新しい調査を始め、モデルを Local(gemma4:12b)に切り替えます",
      "同じ質問を、今度は手元のローカル LLM で実行します",
    ],
  },
  {
    from: "l_run1",
    to: "l_answer1",
    texts: [
      "⑦ ローカル実行では、MCP 呼び出しのループをサーバー側で回します",
      "同じ質問でも、回答までの待ち時間は Sonnet より大幅に長くなります",
      ...(sped.l1 ? ["この待ち区間は 3 倍速で再生しています — 実時間ではまだ待っている状態です"] : []),
      "ツール呼び出しの結果を受けて、ローカルモデルが回答を組み立てます",
      "画面の見え方は Sonnet のときと同じで、違うのは待ち時間だけです",
      "MCP サーバーへの接続・ツール呼び出しの記録も同じように残ります",
      "ローカル完結なので、問い合わせ内容を外部に出さずに調査できます",
      "回答が返ってくるまで、もう少し待ちます",
    ],
  },
  {
    from: "l_answer1",
    to: "l_chip",
    texts: [
      `Local の 1 ターン目は ${L1} でした(Sonnet は ${S1})`,
      ...(R1 ? [`同じ質問・同じサイトで、約 ${R1} 倍の差が出ています`] : []),
    ],
  },
  {
    from: "l_chip",
    to: "l_click2",
    // Local(gemma4:12b)は suggested-actions を出さないことがある。実際の操作と
    // 食い違う字幕を出さないよう、録画時の分岐(followupMode)で文言を切り替える。
    texts:
      meta.local?.followupMode === "chip"
        ? ["⑧ Local でも「続けて調べる」のチップをワンクリックします"]
        : [
            "⑧ Local の回答には「続けて調べる」の候補が出なかったため、\n同じ追い質問を「このスレッドの続きとして実行する」で投げます",
          ],
  },
  {
    from: "l_click2",
    to: "l_answer2",
    texts: [
      `追い質問 ${lFollowup} を、同じスレッドの 2 ターン目として実行します`,
      sped.l2
        ? "2 ターン目も同じように待ち時間が発生します(3 倍速で再生しています)"
        : "2 ターン目も同じように待ち時間が発生します",
      "ローカル LLM では、ツール呼び出しのたびに手元のマシンで推論が走ります",
      "SSE ログには、ローカル実行でも同じように呼び出しが流れます",
    ],
  },
  {
    from: "l_answer2",
    to: "l_durations",
    texts: ["ローカルモデルでも、同じ流れで深掘りの回答が得られます"],
  },
  {
    from: "l_durations",
    to: "t_timeline",
    texts: [
      `⑨ Local の所要時間は ${L1} / ${L2} です`,
      ...(TS && TL ? [`2 ターン合計では Sonnet ${TS}秒 に対して Local ${TL}秒 です`] : []),
    ],
  },
  {
    from: "t_timeline",
    to: "t_cards",
    texts: ["⑩ 実行タイムラインには、実行ごとに model と最終ターンの所要時間が残ります"],
  },
  {
    from: "t_cards",
    to: "t_outro",
    // カードの数字は「最終ターン」のものなので、ターンごとの内訳も併せて出す
    //(最終ターンだけ見ると差が小さく見えることがあるため)。
    texts: [
      `上が Local(${L2})、下が Sonnet(${S2})— どちらも最終ターンの所要時間です`,
      `1 ターン目は Sonnet ${S1} に対し Local ${L1}${R1 ? `(約 ${R1} 倍)` : ""} でした`,
      ...(TS && TL && RT ? [`2 ターン合計は Sonnet ${TS}秒 / Local ${TL}秒 で、約 ${RT} 倍の差です`] : []),
    ],
  },
  {
    from: "t_outro",
    to: "rec_end",
    texts: ["クラウドモデルとローカルモデルの速度差を、同じ画面の数字で比較できます"],
  },
];

const MAX = 7.0; // 1 枚あたりの上限(秒・出力時間)
const MIN = 1.0; // これより短くなる区間は捨てる
const GAP = 0.12; // 字幕の切り替わりに入れる無表示の間

const caps = [];
for (const seg of PLAN) {
  const sa = M[seg.from] == null ? null : M[seg.from] + (seg.offset ?? 0);
  const sb = M[seg.to];
  if (sa == null || sb == null) continue;
  const a = out(sa);
  const b = out(sb);
  if (b - a < MIN) continue;
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

// ---- SRT(参照用・出力タイムライン基準)----
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
const capHtml = (inner) => `<!doctype html><meta charset="utf-8"><style>
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
  }</style>${inner}`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
for (let i = 0; i < caps.length; i++) {
  await page.setContent(capHtml(`<div class="wrap"><div class="cap">${esc(caps[i].text)}</div></div>`));
  await page
    .locator(".cap")
    .screenshot({ path: `${CAPDIR}/cap${String(i).padStart(2, "0")}.png`, omitBackground: true });
}
await browser.close();
console.log(`caption pngs -> ${CAPDIR}`);

// ---- ffmpeg: trim + setpts + concat で早送り → overlay で字幕焼き込み → H.264 mp4 ----
const args = ["-y", "-i", RAW];
for (let i = 0; i < caps.length; i++) args.push("-i", `${CAPDIR}/cap${String(i).padStart(2, "0")}.png`);

const chain = [];

// 1) 早送り: 等倍 / 3 倍速のセグメントに切って連結する。
const bounds = [0];
for (const [a, b] of regions) bounds.push(a, b);
const segs = [];
for (let i = 0; i < bounds.length; i += 2) {
  const s = bounds[i];
  const e = i + 1 < bounds.length ? bounds[i + 1] : null;
  segs.push({ s, e, v: 1 });
  if (e != null) segs.push({ s: e, e: bounds[i + 2] ?? null, v: SPEED });
}
const parts = segs.filter((x) => x.e == null || x.e - x.s > 0.05);
parts.forEach((seg, i) => {
  const t = seg.e == null ? `trim=start=${seg.s.toFixed(3)}` : `trim=start=${seg.s.toFixed(3)}:end=${seg.e.toFixed(3)}`;
  const pts = seg.v === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${seg.v}`;
  chain.push(`[0:v]${t},${pts}[p${i}]`);
});
chain.push(`${parts.map((_, i) => `[p${i}]`).join("")}concat=n=${parts.length}:v=1:a=0[base]`);

// 2) 字幕 PNG は deviceScaleFactor=2 で描いたので 1/2 に縮めてから重ねる。
for (let i = 0; i < caps.length; i++) chain.push(`[${i + 1}:v]scale=iw/2:-1[c${i}]`);

let cur = "base";
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
console.log(`\ndone -> ${OUT}  (output ~${out(DUR).toFixed(1)}s from src ${DUR.toFixed(1)}s)`);
