// Coach(65)— クイズ出題モード。
//
// **素材の選定はコードで、問題文の生成だけ LLM に任せる**(64_findings.md §3-1(a))。
// 「面白い問題を作れ」と丸投げすると、素材から離れた作り話が混ざる。
// 素材 1 件を確定してから、その 1 件だけを渡して出題文を書かせる。
//
// 出題形式も**素材の性質で決まる**(モデルには選ばせない):
//   ナレッジ           → cause(症状 → 原因。rootCause を隠す)
//   調査履歴           → next (症状 → 次の一手。calls[] の 2 手目以降を隠す)★中核
//   ベストプラクティス  → rule (設定 → どのルールに触れるか)
//
// 形式 next がこの機能の中核。実際の熟練者の手順が正解データになっているので、
// **採点の根拠が主観にならない**(モデルの意見ではなく、そう調べて解決した記録)。
//
// 正誤は `[VERDICT:...]` マーカーだけで受け取る(CLAUDE.md 第 3 項)。
// 素材の重複回避は data/coach/material-usage.json に持つ。
// **ナレッジの refCount は絶対に回さない**(47 番の指標の定義が壊れるため)。

import { randomUUID } from "node:crypto";
import { listByStatus } from "../knowledge/store.js";
import { RULES } from "../best-practice/rules.js";
import { historyMaterial, knowledgeMaterial, ruleMaterial, teachableHistory } from "./materials.js";
import { detectSources, detectVerdict, materialKeySet, stripMarkers } from "./markers.js";
import {
  buildQuizGenSystemPrompt,
  buildQuizGenUserPrompt,
  buildQuizGradeSystemPrompt,
  buildQuizGradeUserPrompt,
} from "./prompt.js";
import { defaultModel } from "./agent.js";
import { runGuarded } from "./app-ui.js";
import { findUsage, getSettings, recordQuizUsage, recordQuizVerdict, recordQuizResult } from "./store.js";
import { weakTopicKeys } from "./weakness.js";
import type { CoachLang, CoachMaterial, QuizFormat, QuizState, QuizVerdict } from "./types.js";

/**
 * 出題形式は素材の性質で決まる(モデルには選ばせない。64 §3-1(c))。
 *
 * **ライブ素材(68 番)はクイズには使わない。** クイズは過去事例からの出題で、
 * 「今この瞬間の状態」を答えにすると翌日には正解が変わってしまう。
 * quizPool() が集める素材にライブは混ざらない(pool は knowledge / history / rule から作る)ので、
 * ここは型を満たすための対応表であり、実際に "live" が来る経路は無い。
 * 万一来た場合も cause 扱いにして落とさない(教材が 1 件も出せない方が害が大きい)。
 */
const FORMAT_OF: Record<CoachMaterial["kind"], QuizFormat> = {
  knowledge: "cause",
  history: "next",
  live: "cause",
  rule: "rule",
};

/** 難易度 1〜3。素材の性質から機械的に決める(モデルには決めさせない)。 */
function difficultyOf(m: CoachMaterial): number {
  if (m.kind === "rule") {
    const sev = m.meta.severity;
    // must が最も基本 = やさしい。advisory は環境依存の判断が要る = 難しい。
    return sev === "must" ? 1 : sev === "strong" ? 2 : 3;
  }
  if (m.kind === "knowledge") {
    // 一般的なパターンより、サイト / 機器に紐づく知見の方が前提が要る。
    return m.meta.tags.includes("site") ? 3 : 2;
  }
  // 履歴: 呼んだツールが多いほど切り分けが長い。
  return 2;
}

/**
 * 出題プール。**選択は「未出題 → lastQuizAt が古い順」**で、
 * wrong だった素材は reviewAfter を過ぎたら戻す(間隔反復。64 §3-3(d))。
 */
async function buildPool(lang: CoachLang): Promise<CoachMaterial[]> {
  const pool: CoachMaterial[] = [];

  for (const e of listByStatus("approved")) {
    // 答えにあたる部分が無いエントリは出題できない。
    if (!e.rootCause && !e.action) continue;
    pool.push(knowledgeMaterial(e, 0, []));
  }
  for (const rec of await teachableHistory()) {
    // 「次の一手」を問うので、2 手以上叩いている調査だけを使う。
    if (!rec.calls || rec.calls.length < 2) continue;
    pool.push(historyMaterial(rec, 0, []));
  }
  for (const rule of RULES) {
    pool.push(ruleMaterial(rule, 0, [], lang));
  }
  return pool;
}

export interface PickedQuiz {
  material: CoachMaterial;
  format: QuizFormat;
  difficulty: number;
  /** 弱点タグを狙って選んだか(画面には出さないが、ログで挙動を追えるようにする)。 */
  weakBiased: boolean;
  poolSize: number;
}

/**
 * 出題する素材を 1 件選ぶ。
 *   1. 弱点タグの素材を weakBias(既定 1/3)の確率で優先する。
 *      **常にではない** — 弱点ばかり出すと続かない(64 §5-2(d))。
 *   2. 未出題 → reviewAfter を過ぎたもの → lastQuizAt が古い順。
 */
export async function pickQuizMaterial(lang: CoachLang, seed?: number): Promise<PickedQuiz | null> {
  const settings = getSettings();
  const pool = await buildPool(lang);
  if (pool.length === 0) return null;

  const now = Date.now();
  const weak = new Set(weakTopicKeys());
  const wantWeak = weak.size > 0 && (seed ?? Math.random()) < settings.weakBias;

  const scored = pool.map((m) => {
    const u = findUsage(m.kind, m.id);
    // 未出題が最優先。次に「戻す予定日時を過ぎた素材」。最後に古い順。
    const never = !u || u.quizCount === 0;
    const due = !!u?.reviewAfter && Date.parse(u.reviewAfter) <= now;
    const lastAt = u?.lastQuizAt ? Date.parse(u.lastQuizAt) : 0;
    const isWeak = m.meta.tags.some((t) => weak.has(t));
    return { m, never, due, lastAt, isWeak };
  });

  const candidates = wantWeak && scored.some((s) => s.isWeak) ? scored.filter((s) => s.isWeak) : scored;

  candidates.sort((a, b) => {
    if (a.never !== b.never) return a.never ? -1 : 1;
    if (a.due !== b.due) return a.due ? -1 : 1;
    return a.lastAt - b.lastAt;
  });

  // 未出題が複数あるときに毎回同じものを引かないよう、先頭 5 件から選ぶ。
  const head = candidates.slice(0, 5);
  const chosen = head[Math.floor((seed ?? Math.random()) * head.length) % head.length];
  return {
    material: chosen.m,
    format: FORMAT_OF[chosen.m.kind],
    difficulty: difficultyOf(chosen.m),
    weakBiased: wantWeak,
    poolSize: pool.length,
  };
}

export interface GeneratedQuiz {
  quiz: QuizState;
  material: CoachMaterial;
  isError: boolean;
  reason: string | null;
  durationMs: number;
  model: string;
}

/** 素材 1 件から出題文を作る。 */
export async function generateQuiz(lang: CoachLang, seed?: number): Promise<GeneratedQuiz | null> {
  const picked = await pickQuizMaterial(lang, seed);
  if (!picked) return null;

  const settings = getSettings();
  const model = settings.model || defaultModel();
  const res = await runGuarded({
    prompt: buildQuizGenUserPrompt(picked.material, lang),
    system: buildQuizGenSystemPrompt(lang, picked.format),
    model,
    lang,
    label: "出題",
  });

  const now = new Date().toISOString();
  // 出題した時点で +1(記録の失敗で出題そのものを壊さない = store 側で握り潰す)。
  await recordQuizUsage(picked.material.kind, picked.material.id, now);

  const quiz: QuizState = {
    quizId: randomUUID(),
    format: picked.format,
    material: {
      kind: picked.material.kind,
      id: picked.material.id,
      title: picked.material.title,
      score: picked.material.score,
      meta: picked.material.meta,
    },
    // 出題文は「実行時の記録」なので翻訳しない。
    question: stripMarkers(res.text),
    rounds: 0,
    verdict: null,
    revealed: false,
    askedAt: now,
    difficulty: picked.difficulty,
  };

  console.log(
    `[coach] 出題: ${picked.format} / ${picked.material.kind}:${picked.material.id} ` +
      `(プール ${picked.poolSize} 件${picked.weakBiased ? " / 弱点優先" : ""})`,
  );

  return {
    quiz,
    material: picked.material,
    isError: res.isError,
    reason: res.reason,
    durationMs: res.durationMs,
    model: res.model,
  };
}

export interface GradeResult {
  /** 解答が無い開示専用ターン(74 番)は採点していないので null。 */
  verdict: QuizVerdict | null;
  feedback: string;
  revealed: boolean;
  rounds: number;
  citedIds: string[];
  isError: boolean;
  reason: string | null;
  durationMs: number;
  model: string;
}

/**
 * 解答を採点する。
 *
 * **クイズは壁打ちより早く答えに寄せる(上限 quizRounds 往復、既定 2)。**
 * 壁打ちは「自分の課題を持ち込んでいる」ので粘る価値があるが、
 * クイズは既に「解こうとしている」状態なので、テンポが学習量を決める。
 */
export async function gradeQuiz(opts: {
  lang: CoachLang;
  quiz: QuizState;
  material: CoachMaterial;
  answer: string;
  /** 「もう答えを教えて」= 即座に解説へ。 */
  reveal: boolean;
}): Promise<GradeResult> {
  const settings = getSettings();
  const model = settings.model || defaultModel();
  const rounds = opts.quiz.rounds + 1;
  // 上限往復に達したら必ず解説する。エスカレーションでも即解説。
  const reveal = opts.reveal || rounds >= settings.quizRounds;
  // 「答えを教えて」ボタンだけで解答欄が空のターンか(74 番)。
  // これは「解答の提出」ではなく「開示の要求」なので、採点(verdict)の対象にしない。
  const answered = opts.answer.length > 0;

  const res = await runGuarded({
    prompt: buildQuizGradeUserPrompt({
      lang: opts.lang,
      question: opts.quiz.question,
      answer: opts.answer,
      material: opts.material,
      reveal,
    }),
    system: buildQuizGradeSystemPrompt({
      lang: opts.lang,
      round: rounds,
      maxRounds: settings.quizRounds,
      reveal,
      // 「🔓 もう答えを教えて」で来た解説だけ、最後に問いを返さずに閉じる(70 番)。
      // 上限往復に達しての解説(opts.reveal は false)はこれまでどおり 1 問残す。
      escalated: opts.reveal,
      answered,
    }),
    model,
    lang: opts.lang,
    label: "採点",
  });

  // 正誤はマーカーだけで読む。出なかった場合は partial に倒す
  // (correct に倒すと誤答を正解扱いしてしまい、wrong に倒すと正答を否定してしまう)。
  // **解答が無いターンはそもそも採点していないので verdict は null のまま**
  // (74 番。wrong に倒すと「答えを聞いただけ」を誤答実績として弱点集計・間隔反復に混ぜてしまう)。
  const verdict = answered ? (detectVerdict(res.text) ?? "partial") : null;
  const allowed = materialKeySet([opts.material]);
  const citedIds = detectSources(res.text, allowed).map((s) => `${s.kind}:${s.id}`);
  const feedback = stripMarkers(res.text);

  const now = new Date().toISOString();
  if (verdict) {
    await recordQuizVerdict(opts.material.kind, opts.material.id, verdict, now);
    await recordQuizResult({ topicKeys: opts.material.meta.tags.slice(0, 4), verdict, at: now });
  }

  if (answered && !detectVerdict(res.text)) {
    console.warn(`[coach] [VERDICT:...] マーカーが出ませんでした(partial に倒しました)。quizId=${opts.quiz.quizId}`);
  }

  return {
    verdict,
    feedback,
    revealed: reveal,
    rounds,
    citedIds,
    isError: res.isError,
    reason: res.reason,
    durationMs: res.durationMs,
    model: res.model,
  };
}

/** 出題済みの素材を再構成する(採点時に本文が必要になる)。 */
export async function rebuildMaterial(
  kind: CoachMaterial["kind"],
  id: string,
  lang: CoachLang,
): Promise<CoachMaterial | null> {
  if (kind === "knowledge") {
    const e = listByStatus("approved").find((x) => x.id === id);
    return e ? knowledgeMaterial(e, 0, []) : null;
  }
  if (kind === "history") {
    const rec = (await teachableHistory()).find((r) => r.id === id);
    return rec ? historyMaterial(rec, 0, []) : null;
  }
  const rule = RULES.find((r) => r.id === id);
  return rule ? ruleMaterial(rule, 0, [], lang) : null;
}
