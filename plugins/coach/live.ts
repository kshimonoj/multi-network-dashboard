// Coach(68)— ライブ層。MCP 経由で Central / Mist に「今」を問い合わせる。
//
// 64 番では「Coach は MCP を繋がない」と決めていた(agent.ts の冒頭コメント)。
// 68 番でその判断を**部分的に**覆す。覆す理由は実測に基づく:
//
//   rogue AP の質問に対し、Coach は「電波の話か有線の話か」という技術的に成立しない
//   前提を提示した。一方、同じ問いを調査タブ(Insight Agent)に投げると、RSSI 実測値・
//   アラーム件数・正規 SSID との照合まで踏まえた回答が返る。
//
// ただし 64 番の懸念(役割の分離・速度・再現性)は消えていないので、**丸ごと調査タブに
// するのではなく、次の 3 点で性質を変えて取り込む**:
//
//   1. **段階的フォールバックの最後の層にする。** ナレッジ → 調査履歴 で足りているなら
//      ライブは引かない。薄い / 古い / 対象外のとき、または「今どうなってる?」と
//      聞かれたときにだけ引く(decideLive)。
//   2. **取ってくるのは「事実」だけで、「答え」ではない。** ライブの結果は
//      前提(premise)と具体値(detail)に分けて受け取り、hintLevel<3 では
//      前提しかプロンプトに載せない(prompt.ts の既存方針と同じ)。
//   3. **レート制限を設計に組み込む。** Central API は秒 10 回程度・アカウント全体で共有。
//      キャッシュ(同じ話題は使い回す)・最小間隔・同時実行 1 本・セッション上限の
//      4 つで「1 往復ごとに Central を叩く Coach」にならないようにする。
//
// 前提と具体値の切り分けは **言語非依存の機械可読マーカー**で受け取る(CLAUDE.md 第 3 項)。
// 自然文をパースしない。マーカーが出なかった場合は**安全側**に倒し、本文をすべて
// 具体値(= hintLevel 3 まで出さない)として扱い、前提はツール呼び出しの記録から
// コードで組み立てる(モデルの文章を読まずに作れる情報だけを使う)。

import { randomUUID } from "node:crypto";
import {
  ALL_PLATFORMS,
  parseMcpToolName,
  runClaudeWithMcp,
  type McpStreamEvent,
  type Platform,
} from "../network-investigation/mcp.js";
import { readSiteMap } from "../network-investigation/site-map.js";
import { normalizeText } from "../knowledge/similarity.js";
import type { CoachLang, CoachMaterial, CoachSettings, HintLevel } from "./types.js";

// ---- 読み取り専用の担保 ----
//
// --allowedTools はサーバー単位のワイルドカード(mcp__central-mcp__*)なので、
// 書き込み系まで通ってしまう。Coach は教育用途で、機器に触る理由が一切無いので
// 個別に締め出す。**Central / Mist の設定変更は一切行わない**(68 番の制約)。
const DISALLOWED_TOOLS = [
  "mcp__central-mcp__central_bounce_port", // ポートの up/down = 明確な書き込み
  "mcp__central-mcp__central_run_network_test", // 機器に負荷をかける能動テスト
  "mcp__central-mcp__central_run_show_commands", // 機器への直接 CLI。クラウド側の事実で足りる
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "Task",
];

// ---- 「今の状態を聞いている」発話の検出 ----
//
// **これは学習者の入力を見る処理**であり、モデル出力の自然文パースではない
// (materials.ts の JA_SYNONYMS / utterance.ts と同じ立場)。
// 判定結果は「ライブ問い合わせを 1 回起こすか否か」にしか使わない。
//
// **70 番で絞り込んだ。** 65〜68 番の版は「今」「状況」「発生して」を素通しで拾っていて、
// 「今回は」「今後」「この状況では」「〜が発生した場合」のような**仮定・一般論の質問**でも
// 発火していた。ライブ 1 回は実測 13〜63 秒(中央値 35 秒)かかるので、
// 空振りの 1 回がそのまま体感の遅さになる。
//   - 「今」は 今回 / 今後 / 今度 / 今のところ / 今まで を除外する
//   - 進行形の助動詞まで含める(「発生して**いる**」は今の話、「発生して**も**」は仮定)
//   - 「状況」単独は落とす(「今の状況」は先頭の「今」で拾える)
const LIVE_INTENT_RE =
  /今(?!回|後|度|のところ|まで)|いま|現在|現時点|直近|さっき|先ほど|昨日|今日|最近|出てる|出ている|起きて(る|いる|ます)|発生して(る|いる|ます)|鳴って(る|いる|ます)|上がって(る|いる|ます)|落ちて(る|いる|ます)|繋がらな|つながらな|何件|件数|どのくらい|どれくらい|ステータス|status|current|currently|right now|happening|now\b|today|yesterday|recent|still\b/i;

/** ライブ問い合わせを起こすか / 起こさないかの理由。**機械可読なコード**で返す(CLAUDE.md)。 */
export type LiveReasonCode =
  // 使う理由
  | "liveIntent" // 今の状態を聞いている
  | "noStatic" // 自社の記録(ナレッジ / 履歴)に当たりが無い
  | "thinStatic" // 当たったが関連度が低い(根拠が薄い)
  | "staleStatic" // 当たったが古い(鮮度が足りない)
  // 使わない理由
  | "disabled" // 設定で無効
  | "staticEnough" // 静的な素材で足りている
  | "earlyStage" // ヒント段階 0(問い返しだけ)。事実を語らない段階なので引かない(70 番)
  | "offTopic" // ネットワークの話と判別できない(MCP を叩く理由が無い)
  | "sessionCap" // このセッションのライブ上限に達した
  | "rateLimited" // 直前のライブから間隔が空いていない
  | "busy" // 別のライブ問い合わせが実行中
  | "cached" // キャッシュを使った(問い合わせは起こしていない)
  | "failed"; // 問い合わせたが失敗した

export interface LiveDecision {
  use: boolean;
  reasonCode: LiveReasonCode;
  /** 画面側の辞書が文にするための値(CLAUDE.md「サーバ生成の文言を画面に出すとき」)。 */
  reasonParams?: Record<string, string | number>;
}

export interface LiveGateInput {
  settings: CoachSettings;
  /** このターンのヒント段階(70 番)。0 = 問い返しだけ。 */
  hintLevel: HintLevel;
  /** 学習者の発話(継続ターンでは空でもよい)。 */
  question: string;
  /** 静的層(ナレッジ / 調査履歴 / ルール)で当たった素材。 */
  staticMaterials: CoachMaterial[];
  /** 発話から取れた話題キー(材料由来のものを混ぜない)。分野の判別に使う。 */
  topicKeys: string[];
  /** このセッションで既に実行したライブ問い合わせの回数。 */
  usedInSession: number;
}

/**
 * ライブ層を引くかどうかを決める。
 *
 * **順序が設計そのもの**(ユーザー決定): 自社の記録を優先し、
 * 「薄い / 古い / 対象外」または「今まさに起きている事象を聞かれた」ときにだけライブへ回す。
 */
export function decideLive(input: LiveGateInput): LiveDecision {
  const { settings, hintLevel, question, staticMaterials, topicKeys, usedInSession } = input;
  if (!settings.liveEnabled) return { use: false, reasonCode: "disabled" };
  if (usedInSession >= settings.liveMaxPerSession) {
    return { use: false, reasonCode: "sessionCap", reasonParams: { max: settings.liveMaxPerSession } };
  }

  // **分野の門。** 話題キーも取れず、素材も 1 件も当たらない発話は、
  // ネットワークの話だと判別できていない(実測で「有給休暇の申請方法」のような質問が
  // 素材 0 件になることを 65 番で確認済み)。ここを開けておくと、下の noStatic が
  // 無関係な質問のたびに MCP を叩き、Central のレート制限を無駄に消費する。
  if (topicKeys.length === 0 && staticMaterials.length === 0) {
    return { use: false, reasonCode: "offTopic" };
  }

  // 自社の事実の層だけを見る。ルール層(一般論)は「うちの記録」ではないので、
  // ルールしか当たっていない状態は noStatic と同じ扱いにする。
  const own = staticMaterials.filter((m) => m.kind === "knowledge" || m.kind === "history");

  const liveIntent = LIVE_INTENT_RE.test(question || "");

  // **ヒント段階 0 では引かない(70 番)。**
  // レベル 0 は「問い返しだけをする。ヒントは出さない」段階(prompt.ts の HINT_RULES)で、
  // そもそも事実を一切語らない。ここでライブを引いても、取ってきた前提は
  // 「今どこまで確かめた?」の 1 行に何も足さないまま捨てられる。
  // 実測ではライブ 1 回が 13〜63 秒(中央値 35 秒)で、壁打ちの**最初のターンが常に
  // これを払っていた**。セッションの第一印象がそのまま「遅いコーチ」になっていた。
  //
  // **ただし「今どうなってる?」と明示的に聞かれたときは引く。** そこを断ると
  // 68 番で直した回帰(現在の状態を聞かれて過去の記録だけで答える)に戻る。
  if (hintLevel === 0 && !liveIntent) {
    return { use: false, reasonCode: "earlyStage" };
  }

  if (liveIntent) {
    return { use: true, reasonCode: "liveIntent" };
  }
  if (own.length === 0) {
    return { use: true, reasonCode: "noStatic" };
  }
  const best = Math.max(...own.map((m) => m.score));
  if (best < settings.liveStaticFloor) {
    return { use: true, reasonCode: "thinStatic", reasonParams: { score: best, floor: settings.liveStaticFloor } };
  }
  // 鮮度。**当たった素材のうち最も新しいもの**で測る(1 件でも新しければ古くない)。
  const ages = own.map((m) => m.meta.ageDays).filter((d): d is number => typeof d === "number");
  if (ages.length > 0) {
    const freshest = Math.min(...ages);
    if (freshest > settings.liveStaleDays) {
      return {
        use: true,
        reasonCode: "staleStatic",
        reasonParams: { days: freshest, limit: settings.liveStaleDays },
      };
    }
  }
  return { use: false, reasonCode: "staticEnough", reasonParams: { score: best } };
}

// ---- プラットフォームの絞り込み ----
//
// 調査タブはサイト選択という手掛かりを持つが、Coach は質問文しか持っていない
// (junior は「どのサイトか」から分かっていない)。ここでは
//   1. サイト対応表のサイト名が発話に出ていればそのプラットフォーム
//   2. ベンダー名(Central / Mist)が出ていればそのプラットフォーム
//   3. どちらも無ければ両方
// の順で決める。両方になった場合の呼び出し回数の増加は、キャッシュと最小間隔で抑える。

const VENDOR_HINTS: Array<[RegExp, Platform]> = [
  [/central|aruba|hpe(?!n)/i, "central"],
  [/mist|juniper|marvis|sle\b/i, "mist"],
];

export async function narrowPlatforms(text: string): Promise<{ platforms: Platform[]; site: string | null }> {
  const raw = (text || "").trim();
  if (!raw) return { platforms: [...ALL_PLATFORMS], site: null };
  const norm = normalizeText(raw);

  try {
    const map = await readSiteMap();
    // 長いサイト名から先に見る(短い名前が別のサイト名の部分文字列であるケースを避ける)。
    const sorted = [...map].sort((a, b) => b.siteName.length - a.siteName.length);
    for (const e of sorted) {
      const n = normalizeText(e.siteName);
      if (n.length >= 3 && norm.includes(n)) return { platforms: [e.platform], site: e.siteName };
    }
  } catch {
    /* 対応表が読めなくてもライブ自体は動く(両方を候補にするだけ) */
  }

  const hit = new Set<Platform>();
  for (const [re, p] of VENDOR_HINTS) if (re.test(raw)) hit.add(p);
  if (hit.size === 1) return { platforms: [...hit], site: null };
  return { platforms: [...ALL_PLATFORMS], site: null };
}

// ---- ライブ問い合わせの system prompt ----
//
// 調査タブの system prompt とは目的が違う。**回答を作らせない**。
// Coach 本体(勝手が違う 2 段構え)にとって、この呼び出しは「事実の取得」であって
// 「学習者への回答」ではない。ここで助言まで書かせると、Coach がそれを
// そのまま流用して答えを垂れ流す形になり、ソクラテス式が壊れる。

const LIVE_SYSTEM: Record<CoachLang, string> = {
  ja:
    "あなたは HPE Aruba Networking Central / Juniper Mist を対象とする**事実確認だけ**を行う調査係です。\n" +
    "接続された MCP ツールを実際に呼び出し、その結果(ライブ情報)だけを報告してください。\n" +
    "**読み取りのみ。設定変更・機器操作は絶対に行わない。**\n" +
    // 70 番で絞った。実測(15 回)では毎回 central_get_summary と get_mist_self の
    // **両方**が最初に呼ばれ、それだけで 2 回を消費していた。両方のベンダーが候補に
    // 上がるのは「学習者がどちらの話か言っていない」ときだけで、質問の中身からは
    // 大抵どちらかに寄る。上限も 8 → 4 に下げた(実測の中央値が 4 回・35 秒のため)。
    "- **質問に答えるのに必要な最小限のツールだけを呼ぶ。** 両方のベンダーが候補になっていても、" +
    "質問の内容から対象が一方に寄るなら、もう一方には問い合わせない(念のための確認で叩かない)。\n" +
    "- どこから見ればよいか判断できないときだけ、概況ツール" +
    "(Central なら central_get_summary、Mist なら get_mist_self)を起点にする。\n" +
    "- ツール呼び出しは**合計 4 回以内**に収める。網羅より速さを優先する(対話の途中で待たせているため)。\n" +
    "- 4 回で確かめきれなくても、そこまでに分かったことで報告を打ち切る。足りなかったことはそのまま書けばよい。\n" +
    "- ツールの結果に無いことは書かない。推測・一般論・助言・対処手順は一切書かない。\n" +
    "\n" +
    "【最重要: 出力マーカー】\n" +
    "回答は必ず次の 2 ブロックだけで構成する。どちらも省略できない。\n" +
    "[LIVE:premise]\n" +
    "(3 行以内。**事象がどの領域の話か**(無線 / 有線 / クラウド設定 など)、対象の広さ、件数だけを書く。\n" +
    " 固有名詞・実測値・原因の見立ては書かない。ここは「話の前提を間違えないため」の情報。)\n" +
    "[LIVE:detail]\n" +
    "(5 行以内。実測値・固有名詞をそのまま書く。サイト名・機器名・SSID・RSSI・時刻・件数など。)\n" +
    "マーカーは必ずこの半角の形のまま、行頭に単独で書く。**翻訳・全角化・言い換え・装飾を一切しない。**\n" +
    "該当するデータが 1 件も無かった場合も、両ブロックを出し、無かったことを書く。",
  en:
    "You are a **fact-finding only** investigator for HPE Aruba Networking Central and Juniper Mist.\n" +
    "Actually call the connected MCP tools and report only what their results (live data) say.\n" +
    "**Read-only. Never change any configuration or touch any device.**\n" +
    "- **Call only the minimum set of tools needed to answer.** Even when both vendors are in scope, " +
    "if the question clearly leans to one of them, do not query the other just to be sure.\n" +
    "- Fall back to the overview tools (central_get_summary for Central, get_mist_self for Mist) " +
    "only when you cannot tell where to start.\n" +
    "- Keep the total number of tool calls to **4 or fewer**. Speed beats completeness (someone is waiting mid-conversation).\n" +
    "- If four calls are not enough, stop and report what you have. Saying what you could not confirm is fine.\n" +
    "- Never write anything that is not in the tool results. No guesses, no general advice, no remediation steps.\n" +
    "\n" +
    "[MOST IMPORTANT: output markers]\n" +
    "Your reply must consist of exactly these two blocks. Neither is optional.\n" +
    "[LIVE:premise]\n" +
    "(At most 3 lines. State only **which domain the phenomenon belongs to** (wireless / wired / cloud config),\n" +
    " how wide the scope is, and the counts. No proper nouns, no measured values, no cause hypothesis.\n" +
    " This block exists so the premise of the conversation is not wrong.)\n" +
    "[LIVE:detail]\n" +
    "(At most 5 lines. Measured values and proper nouns as they are: site, device, SSID, RSSI, timestamps, counts.)\n" +
    "Write the markers exactly like that, in ASCII, alone at the start of the line. " +
    "**Do not translate, widen, reword or decorate them.**\n" +
    "If there was no matching data at all, still emit both blocks and say so.",
};

// ---- マーカーの分解 ----

const PREMISE_RE = /\[LIVE:premise\]([\s\S]*?)(?=\[LIVE:detail\]|$)/i;
const DETAIL_RE = /\[LIVE:detail\]([\s\S]*)$/i;
/** 除去用(緩い)。値の中身は問わない。markers.ts と同じ「検出は厳密・除去は広く」の方針。 */
const ANY_LIVE_MARKER_RE = /\[LIVE:[^\]\n]{0,40}\]/gi;

export interface LiveDigest {
  /** 前提(hintLevel に関係なく渡す)。 */
  premise: string;
  /** 具体値(hintLevel 3 でのみ渡す)。 */
  detail: string;
  /** マーカーが規定どおり出たか(出なければ安全側に倒したことの記録)。 */
  hadMarkers: boolean;
}

/**
 * ライブ回答をマーカーで前提 / 具体値に割る。
 *
 * **マーカーが無ければ本文はすべて具体値として扱う**(= hintLevel 3 まで出さない)。
 * 「前提のつもりで答えを載せてしまう」方向の事故を構造的に起こさないため、
 * 判定できないときは必ず伏せる側へ倒す。
 */
export function splitLiveDigest(text: string): LiveDigest {
  const src = (text || "").trim();
  if (!src) return { premise: "", detail: "", hadMarkers: false };
  const p = src.match(PREMISE_RE);
  const d = src.match(DETAIL_RE);
  if (!p && !d) return { premise: "", detail: src, hadMarkers: false };
  const clean = (s: string | undefined) => (s ?? "").replace(ANY_LIVE_MARKER_RE, "").trim();
  return { premise: clean(p?.[1]), detail: clean(d?.[1]), hadMarkers: true };
}

// ---- レート制限(Central API は秒 10 回程度・アカウント全体で共有)----
//
// 4 段構え。**一番効くのはキャッシュ**で、同じ話題の壁打ちを続けても問い合わせは 1 回で済む。
//   1. キャッシュ … 同じ話題キー + 同じプラットフォームなら TTL のあいだ使い回す
//   2. 同時実行 1 本 … 同じキーの実行中なら相乗り、違うキーなら見送る(待たせない)
//   3. 最小間隔 … 直前の実行から liveMinIntervalMs 空いていなければ見送る
//   4. セッション上限 … 1 セッション liveMaxPerSession 回まで(decideLive 側)

interface CacheEntry {
  at: number;
  result: LiveResult;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<LiveResult>>();
let lastStartedAt = 0;

/**
 * キャッシュキー。話題キー(無ければ検索文の正規化)+ プラットフォーム + **言語**で決める。
 *
 * 言語を入れるのは実測で踏んだため: ja で取った digest を en のターンに配ると、
 * 日本語の事実要約を英語で読み解かせることになり、実際に**事実と逆の回答**が出た
 * (「rogue AP は見つからなかった」という premise から「rogue AP アラートが出ている」と書いた)。
 * 言語ごとに 1 本ずつ取るぶん呼び出しは増えるが、増えるのは TTL 内で最大 2 本まで。
 */
export function liveCacheKey(
  topicKeys: string[],
  searchText: string,
  platforms: Platform[],
  lang: CoachLang,
): string {
  const topic = topicKeys.length
    ? [...topicKeys].sort().join("+")
    : normalizeText(searchText).slice(0, 60) || "-";
  return `${lang}|${[...platforms].sort().join(",")}|${topic}`;
}

export interface LiveResult {
  id: string;
  digest: LiveDigest;
  platforms: Platform[];
  servers: string[];
  /** 実際に呼んだ MCP ツール(`server/tool`)。重複は畳む。 */
  tools: string[];
  site: string | null;
  isError: boolean;
  /** 失敗理由。**実行時の記録なので翻訳しない**(CLAUDE.md)。 */
  reason: string | null;
  at: string;
  durationMs: number;
  /** キャッシュから返したか。 */
  fromCache: boolean;
}

/** 問い合わせ文。学習者の言い回しをそのまま投げず、事実確認の依頼として組み立て直す。 */
function buildLiveQuery(opts: { lang: CoachLang; searchText: string; topicKeys: string[]; site: string | null }): string {
  const topics = opts.topicKeys.length ? opts.topicKeys.join(", ") : "";
  if (opts.lang === "ja") {
    return [
      `次の相談について、現在の事実だけを確認してください: ${opts.searchText}`,
      topics ? `関連する話題キー: ${topics}` : "",
      opts.site ? `対象サイト: ${opts.site}` : "対象サイトの指定はありません。組織全体の概況から見てください。",
      "助言・対処手順は不要です。事実だけを [LIVE:premise] / [LIVE:detail] の 2 ブロックで返してください。",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Check only the current facts relevant to this question: ${opts.searchText}`,
    topics ? `Related topic keys: ${topics}` : "",
    opts.site ? `Target site: ${opts.site}` : "No site was specified. Start from the org-wide overview.",
    "No advice or remediation is wanted. Return facts only, in the two blocks [LIVE:premise] / [LIVE:detail].",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * ライブ問い合わせを 1 回走らせる(キャッシュ・同時実行制御込み)。
 *
 * **失敗しても throw しない。** 壁打ちの本体はライブが無くても成立するので、
 * ここで倒れて回答そのものを失わせない(66 番の runGuarded と同じ立場)。
 */
export async function fetchLive(opts: {
  settings: CoachSettings;
  lang: CoachLang;
  /** 教材検索に使ったのと同じ文(継続ターンでは直近の質問が入っている)。 */
  searchText: string;
  topicKeys: string[];
  model?: string;
}): Promise<{ result: LiveResult | null; reasonCode: LiveReasonCode }> {
  const { settings, lang, searchText, topicKeys } = opts;
  const { platforms, site } = await narrowPlatforms(searchText);
  const key = liveCacheKey(topicKeys, searchText, platforms, lang);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < settings.liveCacheTtlMs) {
    return { result: { ...hit.result, fromCache: true }, reasonCode: "cached" };
  }

  // 同じキーが実行中なら相乗りする(同じ話題で連打されても呼び出しは 1 回)。
  const running = inFlight.get(key);
  if (running) {
    const result = await running;
    return { result: { ...result, fromCache: true }, reasonCode: "cached" };
  }
  // 違うキーが実行中なら見送る。ここで待たせると壁打ちの応答が 2 倍遅くなる。
  if (inFlight.size > 0) return { result: null, reasonCode: "busy" };

  const since = Date.now() - lastStartedAt;
  if (lastStartedAt > 0 && since < settings.liveMinIntervalMs) {
    return { result: null, reasonCode: "rateLimited" };
  }

  const startedAt = Date.now();
  lastStartedAt = startedAt;
  const id = `live-${randomUUID().slice(0, 8)}`;

  const task = (async (): Promise<LiveResult> => {
    const tools = new Set<string>();
    const onEvent = (e: McpStreamEvent) => {
      if (e.kind !== "tool_use") return;
      const parsed = parseMcpToolName(e.name);
      if (parsed) tools.add(`${parsed.server}/${parsed.tool}`);
    };
    const res = await runClaudeWithMcp({
      prompt: buildLiveQuery({ lang, searchText, topicKeys, site }),
      platforms,
      systemPrompt: LIVE_SYSTEM[lang],
      // 対話の途中なので、調査タブの既定(240 秒)より短くする(62 番の制約への配慮)。
      timeoutMs: settings.liveTimeoutMs,
      onEvent,
      model: opts.model,
      disallowedTools: DISALLOWED_TOOLS,
      // 接続健全性の probe は「1 度も呼ばれなかったサーバー」に追加の往復を発生させる。
      // ライブ層は失敗しても静的層で成立するので、ここでは probe まではしない。
      checkHealth: false,
    });
    return {
      id,
      digest: res.isError ? { premise: "", detail: "", hadMarkers: false } : splitLiveDigest(res.text),
      platforms,
      servers: res.mcpServers,
      tools: [...tools],
      site,
      isError: res.isError,
      reason: res.reason ?? null,
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      fromCache: false,
    };
  })();

  inFlight.set(key, task);
  let result: LiveResult;
  try {
    result = await task;
  } catch (err) {
    inFlight.delete(key);
    return {
      result: {
        id,
        digest: { premise: "", detail: "", hadMarkers: false },
        platforms,
        servers: [],
        tools: [],
        site,
        isError: true,
        reason: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        fromCache: false,
      },
      reasonCode: "failed",
    };
  }
  inFlight.delete(key);
  // 失敗はキャッシュしない(認証切れ等が TTL のあいだ固定化するのを避ける)。
  // ただし lastStartedAt は進めてあるので、連続失敗で叩き続けることにはならない。
  if (!result.isError) cache.set(key, { at: Date.now(), result });
  return { result, reasonCode: result.isError ? "failed" : "liveIntent" };
}

/**
 * ライブ結果を教材 1 件にする。
 *
 * body(前提)は常にプロンプトに載り、answerBody(具体値)は hintLevel 3 でのみ載る
 * (prompt.ts の buildMaterialBlock が既に持っている出し分けにそのまま乗る)。
 */
export function liveMaterial(result: LiveResult, lang: CoachLang): CoachMaterial {
  const platformLabel = result.platforms.join(" / ");
  const head =
    lang === "ja"
      ? [
          `いま ${platformLabel} に問い合わせて確認した事実(取得時刻 ${result.at})`,
          result.site ? `対象サイト: ${result.site}` : "",
          result.tools.length ? `呼んだツール: ${result.tools.join(", ")}` : "",
        ]
      : [
          `Facts just retrieved from ${platformLabel} (fetched at ${result.at})`,
          result.site ? `Target site: ${result.site}` : "",
          result.tools.length ? `Tools called: ${result.tools.join(", ")}` : "",
        ];
  // マーカーが出なかったときの前提は、**モデルの文章を読まずに**作れる情報だけで組む。
  const fallbackPremise =
    lang === "ja"
      ? `${platformLabel} のライブ情報を取得済み(${result.tools.length} 種類のツールで確認)。具体値はこの段階では伏せてある。`
      : `Live data was retrieved from ${platformLabel} (${result.tools.length} tool(s)). The concrete values are withheld at this stage.`;

  const premise = result.digest.premise || fallbackPremise;
  const body = [...head.filter(Boolean), premise].join("\n");

  return {
    kind: "live",
    id: result.id,
    // タイトルは画面の根拠リンクに出る。実行時の記録なので翻訳しない方針だが、
    // これは**サーバが機械的に組み立てた表示文**なので UI 言語で作る。
    title:
      lang === "ja"
        ? `${platformLabel} のライブ確認${result.site ? `(${result.site})` : ""}`
        : `Live check on ${platformLabel}${result.site ? ` (${result.site})` : ""}`,
    // ライブは「今の事実」なので関連度で測る対象ではない。並べ替えで沈まないよう 1 を入れる
    // (層の順位が先に効くので、これで静的層を追い越すことはない)。
    score: 1,
    boost: 0,
    hits: [`live=${result.tools.length}tools`, result.fromCache ? "cache=hit" : "cache=miss"],
    body,
    answerBody: result.digest.detail,
    meta: {
      tags: ["live", ...result.platforms],
      platform: result.platforms.length === 1 ? result.platforms[0] : null,
      at: result.at,
      ageDays: 0,
      tools: result.tools,
      servers: result.servers,
    },
  };
}

/** 動作確認用。キャッシュを空にする(設定変更後に古い結果を引きずらないため)。 */
export function clearLiveCache(): void {
  cache.clear();
}
