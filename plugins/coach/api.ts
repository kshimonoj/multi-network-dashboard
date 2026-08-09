// Coach(65)— API ルート。
//
// エンドポイント:
//   GET  /status                … 設定 / 素材の在庫 / 弱点の件数
//   POST /chat                  … 壁打ち 1 往復(body: sessionId, question, intent, incidentMode, lang)
//   GET  /sessions              … 記録済みセッション(新しい順)
//   GET  /weakness              … 弱点プロファイル(誰でも見られる)
//   POST /quiz                  … 出題(body: sessionId, lang)
//   POST /quiz/answer           … 解答の採点(body: sessionId, answer, reveal, lang)
//   GET  /materials?query=      … このクエリならどの教材が当たるか(しきい値の動作確認用)
//   GET/PUT /settings           … 設定
//
// **サーバ側で文章を組み立てない**(CLAUDE.md「サーバ生成の文言を画面に出すとき」)。
// エラーは機械可読な `code` を返し、画面側の辞書で文にする。
// 一方で **Coach の回答本文・出題文・失敗理由は「実行時の記録」なので翻訳しない**
// (履歴を後から別言語で開いても、その実行が何を教えたかは変わらないため)。

import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  collectMaterials,
  extractTopicKeys,
  loadRuleDictionaries,
  materialTopicKeys,
  teachableHistory,
  topicKeysOf,
} from "./materials.js";
import { buildRetrievalQuery, classifyUtterance, lastSubstantiveQuestion } from "./utterance.js";
import { decideLive, fetchLive, liveMaterial, type LiveReasonCode } from "./live.js";
import { detectLevel, detectSources, materialKeySet, stripMarkers } from "./markers.js";
import { buildChatSystemPrompt, buildChatUserPrompt } from "./prompt.js";
import { defaultModel } from "./agent.js";
import { runGuarded } from "./app-ui.js";
import { decideHintLevel, newSession } from "./hint.js";
import { generateQuiz, gradeQuiz, rebuildMaterial } from "./quiz.js";
import { weaknessViews, weakTopicKeys } from "./weakness.js";
import {
  appendSessionSnapshot,
  ensureDirs,
  getSession,
  getSettings,
  getUsage,
  loadSettings,
  loadUsage,
  loadWeakness,
  putSession,
  readRecordedSession,
  readRecordedSessions,
  readSessionSummaries,
  recordChatTurn,
  saveSettings,
} from "./store.js";
import { listByStatus } from "../knowledge/store.js";
import { RULES } from "../best-practice/rules.js";
import type { CoachLang, CoachMaterial, MaterialRef, TurnIntent } from "./types.js";

export const router = Router();

export async function initCoach(): Promise<void> {
  await ensureDirs();
  await loadSettings();
  await loadWeakness();
  await loadUsage();
  await loadRuleDictionaries();
  const s = getSettings();
  console.log(
    `[coach] 起動: 関連度しきい値 ${s.threshold}(実測で決めた既定は 0.15)/ ` +
      `${s.turnRule} ターン規則(弱点 ${s.weakTurnRule})/ クイズ ${s.quizRounds} 往復 / ` +
      `ライブ確認 ${s.liveEnabled ? "有効" : "無効"}` +
      (s.liveEnabled
        ? `(静的スコアの床 ${s.liveStaticFloor} / 鮮度 ${s.liveStaleDays} 日 / ` +
          `キャッシュ ${Math.round(s.liveCacheTtlMs / 1000)} 秒 / 最小間隔 ${Math.round(s.liveMinIntervalMs / 1000)} 秒 / ` +
          `セッション上限 ${s.liveMaxPerSession} 回)`
        : ""),
  );
}

/** クライアントが lang を送ってこなければ ja に倒す(既存プラグインと同じ)。 */
function normalizeLang(v: unknown): CoachLang {
  return v === "en" ? "en" : "ja";
}

function normalizeIntent(v: unknown): TurnIntent {
  return v === "hintMore" || v === "escalate" ? v : "ask";
}

function toRef(m: CoachMaterial): MaterialRef {
  return { kind: m.kind, id: m.id, title: m.title, score: m.score, meta: m.meta };
}

// ---- 現況 ----

router.get("/status", async (_req, res) => {
  try {
    const approved = listByStatus("approved");
    const history = await teachableHistory();
    const weak = weaknessViews();
    res.json({
      settings: getSettings(),
      pool: {
        knowledge: approved.length,
        history: history.length,
        rules: RULES.length,
      },
      weakness: { total: weak.length, weak: weak.filter((w) => w.isWeak).length },
      usage: getUsage().materials.length,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "statusFailed" });
  }
});

router.get("/settings", (_req, res) => res.json(getSettings()));

router.put("/settings", async (req, res) => {
  try {
    res.json(await saveSettings(req.body));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err), code: "saveFailed" });
  }
});

// ---- 壁打ち ----

router.post("/chat", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const lang = normalizeLang(body.lang);
  const intent = normalizeIntent(body.intent);
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 4000) : "";
  const incidentMode = body.incidentMode === true;
  // sessionId は View が採番してサーバが受け取る(調査タブと同じ設計)。
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : randomUUID();

  if (!question && intent === "ask") {
    res.status(400).json({ error: "question is required", code: "emptyQuestion" });
    return;
  }

  try {
    const settings = getSettings();
    let session = getSession(sessionId);
    if (!session) session = newSession(sessionId, "chat", incidentMode);
    // 障害対応中モードは会話の途中でも切り替えられる(実際に鳴ったら即座に切り替わるべき)。
    session.incidentMode = incidentMode;

    // 1. 発話を分類する(67 番。**ユーザーの入力**を機械的に見るだけで、
    //    モデル出力の自然文パースではない)。
    //    相槌・ボタンだけのターンを「新しい問い」として扱わないための入口。
    const spokenKeys = [...topicKeysOf(question)].slice(0, 4);
    const kind = classifyUtterance(question, spokenKeys);
    const isSubstantive = (q: string) => classifyUtterance(q, [...topicKeysOf(q)]) === "substantive";

    // 2. 素材を集める(層の選択はコードで行い、LLM に選ばせない)。
    //    弱点タグの素材を少しだけ前に出す。
    //    継続のターンは発話自体に検索価値が無いので、直近の質問と今の論点を足して引く
    //    (これが無いと「もう答えを教えて」で教材 0 件になる。66_findings §5-(a))。
    const weakTopics = weakTopicKeys();
    const searchText = buildRetrievalQuery({
      kind,
      question,
      lastSubstantive: lastSubstantiveQuestion(session.turns, isSubstantive),
      topicKeys: session.topicKeys,
    });
    const retrieval = await collectMaterials({
      query: searchText,
      threshold: settings.threshold,
      historyThreshold: settings.historyThreshold,
      max: settings.maxMaterials,
      lang,
      weakTopics,
    });

    // 3. 話題キー。**判定用と記録用を分ける**(67 番)。
    //    - 判定用(decideHintLevel へ渡す): 発話由来のキーだけ。
    //      素材のタグを借りると、相槌のたびに別の論点に見えて往復数がリセットされる。
    //    - 記録用(弱点プロファイルの軸・画面表示): 発話 → 今の論点 → 素材のタグ の順に埋める。
    //      素材からの穴埋めは「まだ論点が決まっていない実質的な発話」にだけ許す。
    const derivedKeys =
      kind === "substantive" && spokenKeys.length === 0 && session.topicKeys.length === 0
        ? materialTopicKeys(retrieval.materials)
        : [];
    const recordKeys = spokenKeys.length ? spokenKeys : session.topicKeys.length ? session.topicKeys : derivedKeys;

    // 4. hintLevel を決める(サーバの状態機械。モデルには決めさせない)。
    //    **70 番でライブ層より前に移した。** ライブを引くかどうかの判断に hintLevel が要るため
    //    (レベル 0 は問い返しだけの段階なので、実測 35 秒のライブ問い合わせに見合わない)。
    //    decideHintLevel は素材を見ないので、ここに移しても判定内容は変わらない。
    const decision = decideHintLevel(session, intent, spokenKeys, weakTopics, settings);

    // 5. ライブ層(68 番)。**静的な層で足りているなら引かない。**
    //    順序が設計そのもの: ナレッジ・調査履歴を先に引き、その結果が
    //    「薄い / 古い / 対象外」のとき、または「今どうなってる?」と聞かれたときだけ MCP を叩く。
    //    失敗しても壁打ち本体は静的層だけで成立するので、ここで例外を投げない。
    const liveGate = decideLive({
      settings,
      hintLevel: decision.hintLevel,
      // 判定に使うのは**検索と同じ文**。継続ターン(相槌・ボタン)でも直近の質問が入っているので、
      // 「もう答えを教えて」の直後にライブが空振りすることが無い(67 番の buildRetrievalQuery)。
      question: searchText,
      staticMaterials: retrieval.materials,
      // 分野の門に使うキー。継続ターン(相槌・ボタン)では発話から取れないので、
      // セッションが持っている今の論点に落とす(そこは既に判別済みの話題)。
      topicKeys: spokenKeys.length ? spokenKeys : session.topicKeys,
      usedInSession: session.liveCount ?? 0,
    });
    let materials = retrieval.materials;
    let liveInfo: {
      used: boolean;
      reasonCode: LiveReasonCode;
      reasonParams?: Record<string, string | number>;
      fromCache?: boolean;
      platforms?: string[];
      tools?: string[];
      durationMs?: number;
      isError?: boolean;
      reason?: string | null;
    } = { used: false, reasonCode: liveGate.reasonCode, reasonParams: liveGate.reasonParams };

    if (liveGate.use) {
      const { result, reasonCode } = await fetchLive({
        settings,
        lang,
        searchText,
        topicKeys: recordKeys,
        model: settings.model || defaultModel(),
      });
      if (result && !result.isError) {
        // ライブは**静的層の後ろ**に足す(ユーザー決定の優先順位をそのまま順序にする)。
        // 上限(maxMaterials)で切らない: 1 件だけで、しかも前提の正しさを担保する層なので、
        // ここが落ちると 68 番の目的そのものが消える。
        materials = [...retrieval.materials, liveMaterial(result, lang)];
        if (!result.fromCache) session.liveCount = (session.liveCount ?? 0) + 1;
        liveInfo = {
          used: true,
          reasonCode: liveGate.reasonCode,
          reasonParams: liveGate.reasonParams,
          fromCache: result.fromCache,
          platforms: result.platforms,
          tools: result.tools,
          durationMs: result.durationMs,
          isError: false,
          reason: null,
        };
      } else {
        liveInfo = {
          used: false,
          reasonCode: result ? "failed" : reasonCode,
          reasonParams: liveGate.reasonParams,
          durationMs: result?.durationMs,
          isError: result?.isError ?? false,
          reason: result?.reason ?? null,
        };
        if (result?.isError) {
          console.warn(`[coach] ライブ確認に失敗しました(静的な教材だけで続行します): ${result.reason}`);
        }
      }
    }
    const hasLive = materials.some((m) => m.kind === "live");

    // 6. hintLevel < 3 なら答えにあたる部分はプロンプトに載せない(prompt.ts 側で制御)。
    //    ライブ素材も同じ扱いで、前提(premise)だけが常に載り、具体値は 3 でのみ載る。
    const system = buildChatSystemPrompt({
      lang,
      hintLevel: decision.hintLevel,
      level: session.level,
      incidentMode: session.incidentMode,
      forcedDisclosure: decision.forcedDisclosure,
      // 「🔓 もう答えを教えて」経由の開示では、最後に問いを返さずに閉じる(70 番)。
      escalated: decision.escalated,
      intent,
      generalOnly: retrieval.generalOnly,
      noMaterials: materials.length === 0,
      hasLive,
    });
    const prompt = buildChatUserPrompt({
      lang,
      question,
      materials,
      hintLevel: decision.hintLevel,
      history: session.turns.slice(-4).map((t) => ({ q: t.question, a: t.answer })),
      // ボタンだけのターンを「発言なし」という偽の発話にしない(70 番)。
      intent,
    });

    const model = settings.model || defaultModel();
    // 自アプリの UI 操作に触れていたら 1 回だけ言い直させる(66 番。app-ui.ts)。
    const run = await runGuarded({ prompt, system, model, lang, label: "壁打ち" });

    // 7. マーカーを検出 → 本文から除去。
    //    **渡した素材の id 集合に含まれるものだけ採用**(存在しない id の捏造対策)。
    const allowed = materialKeySet(materials);
    const cited = detectSources(run.text, allowed).map((s) => `${s.kind}:${s.id}`);
    const level = detectLevel(run.text);
    const answer = stripMarkers(run.text);

    if (!run.isError && !level) {
      console.warn(`[coach] [LEVEL:...] マーカーが出ませんでした。sessionId=${sessionId}`);
    }

    const at = new Date().toISOString();
    session.turns.push({
      question,
      answer,
      intent,
      hintLevel: decision.hintLevel,
      level,
      topicKeys: recordKeys,
      materials: materials.map(toRef),
      citedIds: cited,
      forcedDisclosure: decision.forcedDisclosure,
      live: liveInfo,
      at,
      durationMs: run.durationMs,
      model: run.model,
      isError: run.isError,
      reason: run.reason,
    });
    // 失敗したターンでは状態を進めない。学習者は何も受け取っていないのに
    // hintLevel と往復数だけが進むと、再送しただけで答えに飛んでしまう
    // (3 ターン規則が「失敗 3 回」で発火してしまう)。記録としては turns に残す。
    if (!run.isError) {
      session.hintLevel = decision.hintLevel;
      session.turnsOnTopic = decision.turnsOnTopic;
      if (recordKeys.length) session.topicKeys = recordKeys;
      if (level) session.level = level;
      if (decision.escalated) session.escalated = true;
    }
    session.updatedAt = at;
    putSession(session);
    void appendSessionSnapshot(session);

    // 8. 弱点シグナルの記録。エスカレーションは責めないが、必ず記録する
    //    (何度も同じ話題で押されるなら、それは教材か教え方の問題)。
    if (!run.isError) {
      await recordChatTurn({
        topicKeys: session.topicKeys,
        hintLevel: decision.hintLevel,
        escalated: decision.escalated,
        forcedDisclosure: decision.forcedDisclosure,
        newTopic: decision.newTopic,
        at,
      });
    }

    console.log(
      `[coach] 壁打ち: intent=${intent} 発話=${kind} hintLevel=${decision.hintLevel} ` +
        `(${decision.turnsOnTopic}/${decision.turnRule} 往復${decision.forcedDisclosure ? " → 強制開示" : ""}` +
        `${decision.weakTopic ? " / 弱点タグ" : ""}) 素材 ${materials.length} 件 ` +
        `live=${liveInfo.used ? `使用(${liveInfo.reasonCode}${liveInfo.fromCache ? "/cache" : ""})` : `なし(${liveInfo.reasonCode})`} ` +
        `topic=[${session.topicKeys.join(",")}] ${run.durationMs}ms`,
    );

    res.json({
      sessionId,
      answer,
      isError: run.isError,
      reason: run.reason,
      hintLevel: decision.hintLevel,
      maxHintLevel: 3,
      turnsOnTopic: decision.turnsOnTopic,
      turnRule: decision.turnRule,
      forcedDisclosure: decision.forcedDisclosure,
      escalated: decision.escalated,
      weakTopic: decision.weakTopic,
      incidentMode: session.incidentMode,
      level,
      topicKeys: session.topicKeys,
      // 根拠は 2 経路の併用: モデルの宣言(citedIds)と、サーバが渡した素材一覧(materials)。
      // 1 だけだと取りこぼし、2 だけだと「実際に使ったのはどれか」が分からない。
      materials: materials.map(toRef),
      citedIds: cited,
      primaryLayer: retrieval.primaryLayer,
      generalOnly: retrieval.generalOnly,
      // ライブ層の動作(68 番)。**機械可読なコードのまま**返す(文にするのは画面の辞書の仕事)。
      live: liveInfo,
      // 自アプリ UI ガードの動作(66 番)。学習者には見せず、検証・監視のために返す。
      uiGuard: run.uiGuard,
      // 発話の分類(67 番)。**機械可読なコードのまま**返す(画面には出さない。
      // 出すとしても文にするのは画面側の辞書の仕事。CLAUDE.md)。
      utterance: kind,
      newTopic: decision.newTopic,
      model: run.model,
      durationMs: run.durationMs,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "chatFailed" });
  }
});

// ---- クイズ ----

router.post("/quiz", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const lang = normalizeLang(body.lang);
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : randomUUID();
  try {
    const generated = await generateQuiz(lang);
    if (!generated) {
      res.status(409).json({ error: "no material available", code: "emptyPool" });
      return;
    }
    let session = getSession(sessionId);
    if (!session) session = newSession(sessionId, "quiz", false);
    session.mode = "quiz";
    session.quiz = generated.quiz;
    session.updatedAt = new Date().toISOString();
    putSession(session);
    void appendSessionSnapshot(session);

    res.json({
      sessionId,
      quiz: generated.quiz,
      isError: generated.isError,
      reason: generated.reason,
      model: generated.model,
      durationMs: generated.durationMs,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "quizFailed" });
  }
});

router.post("/quiz/answer", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const lang = normalizeLang(body.lang);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 4000) : "";
  const reveal = body.reveal === true;

  const session = sessionId ? getSession(sessionId) : null;
  if (!session || !session.quiz) {
    res.status(404).json({ error: "no active quiz", code: "noActiveQuiz" });
    return;
  }
  if (!answer && !reveal) {
    res.status(400).json({ error: "answer is required", code: "emptyAnswer" });
    return;
  }

  try {
    const material = await rebuildMaterial(session.quiz.material.kind, session.quiz.material.id, lang);
    if (!material) {
      res.status(410).json({ error: "material is gone", code: "materialGone" });
      return;
    }
    const graded = await gradeQuiz({ lang, quiz: session.quiz, material, answer, reveal });

    session.quiz = {
      ...session.quiz,
      rounds: graded.rounds,
      verdict: graded.verdict,
      revealed: graded.revealed,
    };
    session.updatedAt = new Date().toISOString();
    putSession(session);
    void appendSessionSnapshot(session);

    console.log(
      `[coach] 採点: ${graded.verdict ?? "(未回答・開示のみ)"} (${graded.rounds}/${getSettings().quizRounds} 往復` +
        `${graded.revealed ? " → 解説" : ""}) ${graded.durationMs}ms`,
    );

    res.json({
      sessionId,
      verdict: graded.verdict,
      feedback: graded.feedback,
      revealed: graded.revealed,
      rounds: graded.rounds,
      maxRounds: getSettings().quizRounds,
      // 根拠リンク。**解説に到達するまでは畳んだまま見せる**のが画面側の役目(64 §5-3(c))。
      materials: [toRef(material)],
      citedIds: graded.citedIds,
      isError: graded.isError,
      reason: graded.reason,
      model: graded.model,
      durationMs: graded.durationMs,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "gradeFailed" });
  }
});

// ---- 弱点・記録 ----

router.get("/weakness", (_req, res) => {
  res.json({ settings: getSettings(), topics: weaknessViews(), weakTopics: weakTopicKeys() });
});

/**
 * 履歴の一覧(70 番)。**要約だけを返す。**
 *
 * 65 番では `CoachSession` をそのまま返していたが、1 セッションぶんの `materials`
 * (根拠リンク全件)まで載って一覧が肥大するので、要約 + 詳細の 2 本に分けた。
 * 全文が要るときは `?full=1`(旧来の形。動作確認用に残す)か `/sessions/:id` を使う。
 */
router.get("/sessions", async (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const n = Number.isFinite(limit) ? limit : 50;
  try {
    if (req.query.full === "1") {
      res.json({ sessions: await readRecordedSessions(n) });
      return;
    }
    res.json({ sessions: await readSessionSummaries(n) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "sessionsFailed" });
  }
});

/** 履歴の詳細(70 番)。やり取りの全文と、そのターンで渡した素材を返す。 */
router.get("/sessions/:sessionId", async (req, res) => {
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required", code: "emptySessionId" });
    return;
  }
  try {
    const session = await readRecordedSession(sessionId);
    if (!session) {
      res.status(404).json({ error: "session not found", code: "sessionNotFound" });
      return;
    }
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "sessionsFailed" });
  }
});

// ---- 動作確認用: このクエリならどの教材が当たるか ----
//
// しきい値(既定 0.15)を実データで検証するための口。LLM は起こさない。

router.get("/materials", async (req, res) => {
  const query = String(req.query.query ?? "").trim();
  const lang = normalizeLang(req.query.lang);
  const threshold = req.query.threshold ? Number(req.query.threshold) : getSettings().threshold;
  if (!query) {
    res.status(400).json({ error: "query is required", code: "emptyQuery" });
    return;
  }
  try {
    const r = await collectMaterials({
      query,
      threshold: Number.isFinite(threshold) ? threshold : getSettings().threshold,
      historyThreshold: getSettings().historyThreshold,
      max: getSettings().maxMaterials,
      lang,
      weakTopics: weakTopicKeys(),
    });
    res.json({
      threshold: r.threshold,
      primaryLayer: r.primaryLayer,
      generalOnly: r.generalOnly,
      topicKeys: extractTopicKeys(query, r.materials),
      materials: r.materials.map((m) => ({
        kind: m.kind,
        id: m.id,
        title: m.title,
        score: m.score,
        boost: m.boost,
        hits: m.hits,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "materialsFailed" });
  }
});
