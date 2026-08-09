// Coach(66)— 「このアプリ自身の UI 操作」を回答から締め出す層。
//
// 65 番の実測(data/coach/sessions.jsonl)で、Coach が
//   「ネットワーク調査タブを開いて」「Multi Network Dashboard を開いて見てる状態?」
// のように **このアプリ自身の画面操作** をヒントの中身にしていた。
//
// 原因は教材ではなく **system prompt 自身**だった(prompt.ts の絶対規則が
// 「今の状態を聞かれたらネットワーク調査タブで見てみようと促す」と書いていた)。
// 教材側(ナレッジ / 調査履歴 / ベストプラクティスの文言)は実データを走査した限り
// タブ名を含んでいない。詳細は 66_findings.md。
//
// このアプリは自作で画面が頻繁に変わるため、画面の操作手順をヒストリーとして
// 教えると、すぐに実態と合わなくなる。ヒントは**機器と現象に着目した一般的な
// チェック観点**に留め、画面の案内はアプリ側の導線(Coach 画面の「調査する」ボタン)に任せる。
//
// **禁止するのは Multi Network Dashboard 自身の UI だけ**で、
// Central / Mist(ベンダーの管理画面・設定項目・SLE 名・API/ツール名)への
// 具体的な言及はむしろ推奨する。検出器もその区別を持つ(ベンダー語が直前にあれば見逃す)。
//
// 二段構えにしてある:
//   1. 予防 … prompt.ts の【このアプリの画面には触れない】ブロック
//   2. 検出 … ここ。出てしまったら **1 回だけ**言い直させる(runGuarded)
// プロンプトだけに頼らないのは、30 番で「モデルが指示どおりのマーカーを無言で
// 省略する」実績があるため。ただし本文の機械的な書き換えはしない
// (文の途中を削ると日本語として壊れる)。言い直しはモデルにさせる。

import { runCoachAgent, type RunResult } from "./agent.js";
import type { CoachLang } from "./types.js";

/** このアプリ自身の名前。文中のどこに出ても NG。 */
const APP_NAME_RE = /Multi[ \-]?Network[ \-]?Dashboard|マルチ[ ・]?ネットワーク[ ・]?ダッシュボード/gi;

/**
 * 「このダッシュボード」「本アプリ」など、自己言及の指示語。
 *
 * 英語側は `this` に限定する(`the dashboard` は Mist / Central 側の
 * ダッシュボードを指す正当な用法があるため。実測で英語回答が
 * "inside this app" と書いてきたので日本語だけでは足りない)。
 */
const SELF_REF_RE =
  /(?:この|本|当|その)(?:ダッシュボード|アプリ|ツール|Web ?アプリ)|\bthis (?:app|application|dashboard|tool|web ?app)\b/gi;

/**
 * タブ名 + 面。**タブ名だけでは弾かない**
 * (「ベストプラクティス」「ナレッジ」は普通名詞としても使うため)。
 * 「〜タブ」「〜画面」のように面と結び付いて初めて UI 操作の指示になる。
 */
const TAB_NAMES = [
  "ネットワーク調査",
  "Network Investigation",
  "グローバル概要",
  "Global Overview",
  "Event ?/ ?Alert",
  "イベント ?/ ?アラート",
  "Webhook ?ログ",
  "Webhook ?feed",
  "Streaming ?\\(Central\\)",
  "タグ付き対象",
  "Tagged ?(?:Client|Device|Targets?)",
  "ベストプラクティス",
  "Best ?Practice",
  "ナレッジ",
  "Knowledge",
  "レポート",
  "Coach",
].join("|");

const SURFACES = "タブ|画面|ページ|パネル|ビュー|メニュー|tab|screen|page|panel|view";

const TAB_RE = new RegExp(`(?:${TAB_NAMES})\\s*(?:の)?\\s*(?:${SURFACES})`, "gi");

/**
 * ベンダー語。これが直前にあれば **見逃す**。
 * 「Central のレポート画面」「Mist の Insights ページ」は正当な具体的言及であり、
 * 66 番で禁止したいものではない(禁止しすぎを避ける)。
 */
const VENDOR_RE = /central|mist|aruba|juniper|hpe|marvis|clearpass/i;
const VENDOR_WINDOW = 24;

export interface UiGuardHit {
  /** 実際に一致した文字列(ログ・検証用)。 */
  text: string;
  /** どの規則で当たったか。 */
  rule: "appName" | "selfRef" | "tab";
}

/**
 * 本文に「このアプリ自身の UI 操作」への言及があるかを見る。
 *
 * **これはモデル出力の自然文パースではない**(CLAUDE.md 第 3 項)。
 * 意味を読み取って分岐しているのではなく、固有名詞の混入を機械的に検査しているだけで、
 * 判定結果は「もう一度書かせるか否か」にしか使わない。
 */
export function detectAppUiMentions(text: string): UiGuardHit[] {
  if (!text) return [];
  const hits: UiGuardHit[] = [];
  const seen = new Set<string>();
  const scan = (re: RegExp, rule: UiGuardHit["rule"], vendorAware: boolean) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (vendorAware) {
        const before = text.slice(Math.max(0, m.index - VENDOR_WINDOW), m.index);
        if (VENDOR_RE.test(before)) continue;
      }
      const key = `${rule}:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ text: m[0], rule });
    }
  };
  // アプリ名は「Central の Multi Network Dashboard」という言い方が成立しないので、
  // ベンダー語による見逃しをしない。
  scan(APP_NAME_RE, "appName", false);
  scan(SELF_REF_RE, "selfRef", true);
  scan(TAB_RE, "tab", true);
  return hits;
}

/** 言い直しの指示。日英どちらでも同じ制約を与える。 */
function correction(lang: CoachLang, hits: UiGuardHit[]): string {
  const list = hits.map((h) => `「${h.text}」`).join(" ");
  if (lang === "ja") {
    return [
      "",
      "【書き直しの指示(最優先)】",
      `直前のあなたの下書きに、この学習アプリ自身の画面への言及 ${list} が含まれていました。これは禁止です。`,
      "同じ内容を、**画面の話を一切せずに**書き直してください。",
      "「どの画面/タブを開くか」ではなく、「どの機器の、どの状態・事実を確かめるか」で書くこと。",
      "例:「ネットワーク調査タブで見て」→「そのスイッチ自体のステータスと、上流の機器が生きているかを確かめて」。",
      "相手がこのアプリの名前や画面名を口にしていた場合も、**その語をそのまま引用し返さない**。話を機器・症状に戻すこと。",
      "画面の案内そのものを求められたら、それには応じられないと一言だけ伝えて、確かめるべき事実の話に移ってよい。",
      "**書き直したという経緯には一切触れない。**「書き直すね」「さっきの回答を修正すると」のような前置きを書かない。",
      "相手には、最初からこの内容だったように読める文にすること(相手は下書きを見ていない)。",
      "Central / Mist(ベンダー側)の設定項目名・画面名・ツール名は今までどおり具体的に書いてよい。",
      "マーカー([SRC:...] / [LEVEL:...] / [VERDICT:...])は前回と同じ規則で必ず付け直すこと。",
    ].join("\n");
  }
  return [
    "",
    "[Rewrite instruction (highest priority)]",
    `Your previous draft mentioned this learning app's own UI: ${list}. That is forbidden.`,
    "Rewrite the same content **without referring to any screen of this app**.",
    "Write in terms of which device and which fact/state to check, never in terms of which tab or screen to open.",
    "e.g. 'open the Network Investigation tab' -> 'check the switch's own status, and whether its upstream device is alive'.",
    "Even if the learner used this app's name or a screen name, **do not quote it back**. Steer to the device and the symptom.",
    "If they explicitly ask to be walked through a screen, say in one line that you cannot do that, then move to what needs checking.",
    "**Never mention that you rewrote anything.** No 'let me rephrase', no 'correcting my previous answer'.",
    "It must read as if this had been your reply all along (the learner never saw the draft).",
    "Vendor-side specifics (Central / Mist setting names, screens, tool names) are still allowed and encouraged.",
    "Re-emit the markers ([SRC:...] / [LEVEL:...] / [VERDICT:...]) under exactly the same rules as before.",
  ].join("\n");
}

export interface GuardInfo {
  /** 1 回目の下書きで見つかった言及。 */
  detected: string[];
  /** 言い直しを走らせたか。 */
  retried: boolean;
  /** 採用した本文に残っている言及(空なら綺麗)。 */
  remaining: string[];
}

export interface GuardedRunResult extends RunResult {
  uiGuard: GuardInfo;
}

/**
 * Coach の生成を 1 回だけ検査して、必要なら言い直させる。
 *
 * - 言い直しは **1 回まで**。落ちなかった場合は言い直し版を採用してログに残す
 *   (学習者にとっては、多少画面名が残っていても回答が返らないより良い)。
 * - 言い直しが実行エラーになった場合は 1 回目を採用する。
 *   体裁の問題で回答そのものを失わせない。
 * - durationMs は 2 回ぶんの合算にする(遅くなった理由が見えるように)。
 */
export async function runGuarded(opts: {
  prompt: string;
  system: string;
  model: string;
  lang: CoachLang;
  /** ログの頭に出す文脈(chat / quiz.gen / quiz.grade)。 */
  label: string;
}): Promise<GuardedRunResult> {
  const first = await runCoachAgent(opts.prompt, opts.system, opts.model);
  const hits = first.isError ? [] : detectAppUiMentions(first.text);
  if (hits.length === 0) {
    return { ...first, uiGuard: { detected: [], retried: false, remaining: [] } };
  }

  const detected = hits.map((h) => h.text);
  console.warn(`[coach] ${opts.label}: 自アプリ UI への言及 [${detected.join(", ")}] を検出。言い直させます`);

  const second = await runCoachAgent(opts.prompt, opts.system + "\n" + correction(opts.lang, hits), opts.model);
  if (second.isError) {
    console.warn(`[coach] ${opts.label}: 言い直しが失敗したため 1 回目を採用します(${second.reason})`);
    return {
      ...first,
      durationMs: first.durationMs + second.durationMs,
      uiGuard: { detected, retried: true, remaining: detected },
    };
  }
  const remaining = detectAppUiMentions(second.text).map((h) => h.text);
  if (remaining.length > 0) {
    console.warn(`[coach] ${opts.label}: 言い直し後も [${remaining.join(", ")}] が残りました`);
  }
  return {
    ...second,
    durationMs: first.durationMs + second.durationMs,
    uiGuard: { detected, retried: true, remaining },
  };
}
