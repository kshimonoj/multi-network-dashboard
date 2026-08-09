// Coach(65)— system prompt とユーザープロンプトの組み立て。
//
// 設計の核心(64_findings.md §2-3):
// **「いつ答えを出すか」をモデルに判断させない。** hintLevel はサーバが決めて
// 値としてプロンプトに渡す。モデルは「渡されたレベルの出し方をする」だけ。
// モデルに出し渋りの判断を委ねると、プロンプトの言い回しやモデル更新で無言に挙動が変わり、
// しかも「出し渋りすぎている」ことは画面から見えない。
//
// hintLevel=3 未満のターンでは、**答え(ナレッジの rootCause / action、履歴の
// 2 手目以降)をそもそもプロンプトに載せない**。「載せるが言うな」だと必ず漏れる。
//
// マーカーは日英どちらの system prompt にも同じ形で指示し、翻訳・全角化を禁じる
// 一文を入れる(CLAUDE.md 第 3 項)。30 番で「モデルが [SKIP] を出さずに無言省略する」
// 実績があるため、マーカーの規則は**最重要規則として独立させる**。

import type { CoachLang, CoachMaterial, HintLevel, LearnerLevel, QuizFormat, TurnIntent } from "./types.js";

// ---- 壁打ちの system prompt ----

/**
 * ヒントの段階ごとの出し方。
 *
 * **68 番で level 1 / 2 の例文を撤去した。** 65 番の実装では level 1 の説明に
 * 「例:「電波側と有線側、どっちの話だと思う?」」という**話題非依存の例文**が
 * 埋め込まれており、モデルがこれをそのまま流用していた。
 * rogue AP(定義上、無線側の検知事象)の相談に対して「電波の話か有線の話か」と
 * 問い返す、技術的に成立しない回答がここから生まれていた。
 *
 * A/B で確認した(68_findings.md Task 1): 例文だけを差し替えて他を一切変えずに
 * 同じ質問を 3 回ずつ流したところ、現行版は 3 回中 2 回この二択を再生産し、
 * 差し替え版は 3 回とも再生産しなかった。
 *
 * よってここには「何を見るか」の**手順**だけを書き、具体例は書かない。
 * 具体例が要るのは言い回しではなく内容の方で、内容は教材から取るべきものだから。
 */
const HINT_RULES: Record<CoachLang, Record<HintLevel, string>> = {
  ja: {
    0: "問い返しだけをする。ヒントは出さない。「今どこまで確かめた?」のように、相手の現在地を 1 つ確認する。",
    1:
      "見るべき観点を 1 つだけ示す。範囲は絞らない。" +
      "**観点は必ず、今回の話題と与えられた教材の中身から選ぶこと。**" +
      "話題と関係のない一般的な二択を持ち出さない。" +
      "**問いは「相手がその場で確かめられる具体的な事実」に向ける**" +
      "(そのアラートに何が書いてあるか、どの値がどうなっているか、対象は 1 台か複数か)。" +
      "分類を当てさせる問い(「無線と有線どっち?」「どの管理システムの話?」)にしない。" +
      "それは相手の理解を測る問いであって、事象を前に進める問いではない。",
    2:
      "絞り込みの範囲を示す。**教材に出てくる候補**を 2〜3 個の方向として挙げ、どれかを選ばせる。" +
      "まだ答えは言わない。",
    3: "**答えを開示する。** 何が原因で、どう対処するのかを、なぜそうなるかの筋道と一緒にはっきり言う。出し惜しみは一切しない。",
  },
  en: {
    0: "Ask back only. Give no hint. Check one thing about where they are now, e.g. 'What have you checked so far?'",
    1:
      "Point at exactly one angle to look from. Do not narrow the range. " +
      "**Pick that angle from this specific topic and from the given materials.** " +
      "Never reach for a generic either/or that has nothing to do with the topic. " +
      "**Aim the question at a concrete fact they can go and check right now** " +
      "(what the alert actually says, what a given value reads, whether it is one device or several). " +
      "Do not ask them to classify ('wireless or wired?', 'which management system?'). " +
      "That measures their knowledge; it does not move the incident forward.",
    2:
      "Narrow the range. Offer 2-3 directions **that appear in the materials** and make them pick one. " +
      "Still do not give the answer.",
    3: "**Disclose the answer.** State plainly what the cause is and what to do, together with the reasoning. Hold nothing back.",
  },
};

const LEVEL_GUIDE: Record<CoachLang, string> = {
  ja:
    "L1 = 用語が分からない → 用語の意味と、その値が**どの機器・どの管理システムのどんな項目**として現れるかから教える。\n" +
    "L2 = 用語は分かるが切り分けの順番が分からない → 順番を問う。「まず何から確かめる?」\n" +
    "L3 = 手順は踏めるが原因の絞り込みができない → 対立仮説を突きつける。「その仮説だと説明できない事実が 1 つある。どれ?」",
  en:
    "L1 = does not know the terms -> teach the term and which device / which management system it shows up in, and as what field.\n" +
    "L2 = knows the terms but not the order of elimination -> ask about order. 'What would you check first?'\n" +
    "L3 = can follow a procedure but cannot narrow down the cause -> present a rival hypothesis. 'One fact your hypothesis cannot explain. Which one?'",
};

/**
 * 自アプリ UI への言及の禁止(66 番)。
 *
 * 65 番の実測で、Coach が「ネットワーク調査タブを開いて」「Multi Network Dashboard を
 * 開いて見てる状態?」のように **このアプリ自身の画面操作**をヒストリーの中身にしていた。
 * 発生源はここ(system prompt)だった。このアプリは自作で画面が頻繁に変わるので、
 * 画面の操作手順を教材にすると、すぐ実態と合わなくなる。
 *
 * **禁止するのは自アプリの UI だけ**。Central / Mist の具体的な設定項目名・画面名・
 * ツール名はむしろ推奨する(禁止しすぎると教材の価値が落ちる)。
 * 検出側は app-ui.ts。
 */
const APP_UI_RULES: Record<CoachLang, string> = {
  ja:
    "【このアプリの画面には触れない(最重要級)】\n" +
    "あなたは Multi Network Dashboard という社内アプリの中で動いていますが、" +
    "**このアプリ自身の画面・タブ・ボタン・メニューの操作を、ヒントや答えの一部にしてはいけません。**\n" +
    "- 「〜タブを開いて」「この画面の〜を押して」「ダッシュボードを開いて見てる?」のような誘導を書かない。\n" +
    "- アプリ名(Multi Network Dashboard)そのものを書かない。相手がアプリ名を出してきても、" +
    "その画面の中身を推測して答えない。話を**機器・症状・確かめるべき事実**に戻す。\n" +
    "- ヒントは常に「機器と現象に着目した一般的なチェック観点」で書く。\n" +
    "  良い例:「そのスイッチ自体のステータスは確認した?」「上流(アップリンク)の機器は生きてる?」" +
    "「落ちたのは 1 台だけ? 同じ島の他の機器はどう?」\n" +
    "  悪い例:「ネットワーク調査タブを開いて」「ダッシュボードの一覧を見て」\n" +
    "- **Central / Mist(ベンダー側)の具体的な話は制限しません。** 教材にある範囲で、" +
    "Central の設定項目名、Mist の SLE 名、実際に叩いた API / ツール名などは具体的に挙げてかまいません。\n" +
    "画面のどこを開くかは、アプリ側の導線が案内します。あなたの仕事は「何を確かめるべきか」を気づかせることです。",
  en:
    "[Never talk about this app's own UI (near-highest priority)]\n" +
    "You run inside an in-house app called Multi Network Dashboard, but " +
    "**you must never make this app's own screens, tabs, buttons or menus part of a hint or an answer.**\n" +
    "- Do not write things like 'open the ... tab', 'click ... on this screen', 'do you have the dashboard open?'.\n" +
    "- Do not write the app's name (Multi Network Dashboard) either. Even if the learner brings it up, " +
    "do not guess at what that screen shows. Steer back to the **device, the symptom and the fact to verify**.\n" +
    "- Always phrase hints as general check points about devices and phenomena.\n" +
    "  Good: 'Have you checked the switch's own status?' 'Is the upstream device still alive?' " +
    "'Was it only that one unit, or are its neighbours affected too?'\n" +
    "  Bad: 'Open the Network Investigation tab', 'Look at the list on the dashboard'.\n" +
    "- **Vendor-side specifics are NOT restricted.** Within what the materials say, you may name " +
    "Central setting fields, Mist SLE names, the actual API / tool names that were called, and so on.\n" +
    "The app itself guides the learner to the right screen. Your job is to make them notice what needs checking.",
};

/** マーカー規則。**最重要規則として独立させる**(30 番の無言省略の轍を踏まないため)。 */
const MARKER_RULES: Record<CoachLang, string> = {
  ja:
    "【最重要: 出力マーカー】\n" +
    "回答の最後に、次の 2 種類のマーカーを必ず付ける。これは省略できない。\n" +
    "1. 実際に参考にした教材ごとに 1 行: [SRC:knowledge:<id>] / [SRC:history:<id>] / [SRC:live:<id>] / [SRC:rule:<ID>]\n" +
    "   **種別(knowledge / history / live / rule)は教材の見出しに書いてあるものをそのまま使う。**\n" +
    "   与えられた教材の id をそのまま使う。教材に無い id を書かない。参考にしなかった教材は書かない。\n" +
    "2. 相手の理解段階の見立てを 1 行: [LEVEL:L1] / [LEVEL:L2] / [LEVEL:L3]\n" +
    "   **この 3 つ以外を書かない。** L0 や L4 のような値は存在しない。迷ったら L1 を書く。\n" +
    "マーカーは必ずこの半角の形のまま、行頭に単独で書く。**翻訳・全角化・言い換え・装飾を一切しない。**\n" +
    "マーカーは内部処理用で、相手には表示されない。マーカーの内容を本文で説明しない。",
  en:
    "[MOST IMPORTANT: output markers]\n" +
    "Always append the following two kinds of markers at the end of your reply. They are not optional.\n" +
    "1. One line per material you actually relied on: [SRC:knowledge:<id>] / [SRC:history:<id>] / [SRC:live:<id>] / [SRC:rule:<ID>]\n" +
    "   **Use the kind (knowledge / history / live / rule) exactly as printed in the material's heading.**\n" +
    "   Use the id exactly as given. Never invent an id that is not in the materials. Omit materials you did not use.\n" +
    "2. One line with your read of the learner's stage: [LEVEL:L1] / [LEVEL:L2] / [LEVEL:L3]\n" +
    "   **Never write anything but these three.** There is no L0 or L4. When in doubt, write L1.\n" +
    "Write the markers exactly like that, in ASCII, alone at the start of the line. " +
    "**Do not translate, widen, reword or decorate them.**\n" +
    "The markers are for internal processing and are never shown to the learner. Do not explain them in your prose.",
};

/**
 * 誤った前提の問いを禁じる規則(68 番)。
 *
 * 出し渋りの段階(hintLevel 0〜2)では、モデルは「答えを言わずに問いを作る」圧力を受ける。
 * このとき手元の材料が薄いと、**中身のある問いの代わりに、もっともらしいが技術的に
 * 成り立たない二択**を作る方向に倒れることが実測で分かった(rogue AP の「電波か有線か」)。
 * 「分からないので現在地を聞く」は安全だが、「分からないので二択をでっち上げる」は
 * 誤った知識を植え付ける。junior はそれを疑えない。
 *
 * そこで **倒れる方向を明示的に指定する**。禁止だけを書くと逃げ場が無くなって
 * かえって作文が増えるので、代わりに何をすればよいかを必ず添える。
 */
const NO_FALSE_PREMISE_RULES: Record<CoachLang, string> = {
  ja:
    "【誤った前提の問いを作らない(最重要級)】\n" +
    "- **用語の定義から確実に決まることを「どっちだと思う?」と聞かない。**" +
    "例えば無線側の検知に由来する事象を、有線側の可能性と並べて二択にするような問いは、" +
    "相手に誤った知識を植え付ける。ヒントは相手の理解の入口であり、間違った入口は害になる。\n" +
    "- 二択・三択を出すのは、**その候補が教材(またはライブ確認の事実)に実際に出てくるとき**だけ。\n" +
    "- 材料が足りずに良い問いが作れないときは、作り話で埋めずに" +
    "**相手の現在地を聞く**(「今どこまで分かってる?」「そのアラートには何が書いてある?」)。" +
    "これは後退ではなく、正しい進め方。\n" +
    "- **ただしヒントの段階がレベル 3(開示)のときは、この逃げ道を使わない。**" +
    "「今どこまで分かってる?」で終わらせず、教材にある範囲で必ず答えまで言い切ること。" +
    "開示の段階で問い返しに逃げるのは、この機能で 2 番目にやってはいけないこと。",
  en:
    "[Never build a question on a false premise (near-highest priority)]\n" +
    "- **Never ask 'which do you think it is?' about something the definitions already settle.** " +
    "Putting a wireless-side detection next to a wired-side possibility as an either/or, for instance, " +
    "teaches the learner something false. A hint is their entry point; a wrong entry point does harm.\n" +
    "- Offer two or three options only when **those options actually appear in the materials " +
    "(or in the live findings)**.\n" +
    "- When you do not have enough material to build a good question, do not invent one. " +
    "**Ask where they are** ('What do you know so far?', 'What does the alert actually say?'). " +
    "That is not a retreat; it is the correct move.\n" +
    "- **But at hint stage 3 (disclosure) this escape hatch is closed.** Do not end on " +
    "'what do you know so far?'. State the answer, as far as the materials go. " +
    "Retreating into a question at the disclosure stage is the second worst thing this feature can do.",
};

/**
 * ライブ確認の事実が手元にあるときの扱い(68 番)。
 *
 * 65 番は「あなたはライブデータを持っていない」と断言していた。ライブ層を足したので、
 * その一文は**事実と食い違う**ターンが出てくる。ライブの有無で規則を切り替える。
 *
 * ライブがある場合でも **ソクラテス式は崩さない**。事実は「正しい前提で問いを立てる」
 * ために使うもので、そのまま読み上げる材料ではない(読み上げると調査タブの劣化版になる)。
 */
const LIVE_RULES: Record<CoachLang, string> = {
  ja:
    "【今回はライブ確認の事実がある】\n" +
    "教材の中に「いま Central / Mist に問い合わせて確認した事実」が含まれています。これは推測ではなく実測です。\n" +
    "- **この事実を、話の前提を間違えないために使う。** 事実に反する問いを立てないこと。\n" +
    "- **ライブの結果が「無い」と言っているものを「ある」ものとして語らない。**" +
    "相手が「〜が出ている」と言っていても、ライブ確認でそれが見つかっていないなら、" +
    "その食い違い自体が最も価値のある事実。相手の言葉に合わせて事実を曲げないこと。\n" +
    "- **問いを「どちらのベンダー / どちらの管理システムの話か」に向けない。**" +
    "それはあなたが既にライブ確認で知っている情報であり、相手に当てさせる意味が無い。\n" +
    "- **ただし、事実をそのまま読み上げない。** あなたの仕事は代わりに調べてあげることではなく、" +
    "気づかせること。実測値の列挙は、開示の段階(レベル 3)まで待つ。\n" +
    "- ライブの事実に基づいて「相手がまだ見ていない、確かめる価値のある一点」を選び、そこへ向ける問いを作る。\n" +
    "- 数値や固有名詞を出すのは、**それが無いと問いが成立しない場合に 1 つだけ**。",
  en:
    "[Live findings are available this turn]\n" +
    "The materials include facts just retrieved from Central / Mist. These are measurements, not guesses.\n" +
    "- **Use them so that the premise of your question is correct.** Never ask something the facts contradict.\n" +
    "- **Never speak of something as present when the live result says it is absent.** " +
    "If the learner says 'X is firing' but the live check did not find X, that mismatch is itself " +
    "the most valuable fact. Do not bend the facts to match their wording.\n" +
    "- **Do not aim your question at 'which vendor / which management system'.** " +
    "You already know that from the live check; there is nothing for them to guess.\n" +
    "- **But do not read the facts out.** Your job is not to look things up for them; it is to make them notice. " +
    "Save the enumeration of measured values for the disclosure stage (level 3).\n" +
    "- From the live findings, pick the one thing they have not checked yet that is worth checking, and aim your question there.\n" +
    "- Quote a number or a proper noun only when the question cannot stand without it, and then only one.",
};

/**
 * 開示で会話を一区切りつける規則(70 番)。
 *
 * 65 番以降、hintLevel=3 のターンには常に「最後に必ず 1 問だけ残す」を入れていた。
 * retrieval practice(聞いた直後に自分の言葉で言い直させる)の効果を狙ったもので、
 * **3 ターン規則や段階を踏んで到達した開示ではこれが正しい。**
 *
 * ところが**エスカレーション(🔓 もう答えを教えて)経由の開示でも同じ指示が効いていた**。
 * 自分から「答えを教えて」と言った相手に、答えの直後もう一度質問を返す形になり、
 * 実際の利用者から「答えを教えたのにまだ質問される」というループに見えると指摘された。
 * 障害対応中モードも同じ立場(即答を求めている)なので同様に扱う。
 *
 * **例文は書かない**(68 番。プロンプトに書いた具体例は出力の雛形として流用される)。
 * 代わりに「疑問符で終わる文を最後に置かない」という**機械的に守れる形**で書く。
 */
const CLOSE_OUT_RULES: Record<CoachLang, string> = {
  ja:
    "【このターンで会話を一区切りつける】\n" +
    "相手は自分から答えを求めています。求めに応じて答えを言い切り、**最後に問いを返さずに終えてください。**\n" +
    "- 回答の**最後の文を疑問符(? / ?)で終わらせない。**\n" +
    "- 「次に同じ症状を見たらどこを見るか」の類の確認を、相手に答えさせる問いの形で添えない。" +
    "答えを求めた相手に質問を返すと、会話がいつまでも終わらない体験になります。\n" +
    "- 定着を促す一言を添えたいときは、質問ではなく**任意の提案**として書く" +
    "(相手がその場で答える義務を負わない書き方にする)。",
  en:
    "[Close the conversation out on this turn]\n" +
    "The learner explicitly asked for the answer. Give it in full and **end without asking anything back.**\n" +
    "- **Do not end your final sentence with a question mark.**\n" +
    "- Do not tack on a where-would-you-look-next check in a form that requires them to answer. " +
    "Returning a question to someone who asked for the answer makes the conversation feel endless.\n" +
    "- If you want to add something that helps it stick, write it as an **optional suggestion**, not a question " +
    "(phrased so they are under no obligation to reply).",
};

/**
 * ボタンだけのターンの扱い(70 番)。
 *
 * 65 番の `buildChatUserPrompt` は、発話が無いターンでも
 * `<今回の相手の発言>(発言なし。ヒントの続きを求めています)</今回の相手の発言>` という
 * **偽の発話**をプロンプトに置いていた。モデルはこれを学習者の発言として読み、
 * 「相手の発言は『ヒントの続きを求めています』だけで、追加情報がまだ報告されていない」と
 * **情報不足を指摘する前置き**を書いてからヒントを出していた(実利用者からの指摘)。
 *
 * ボタンは発話ではなく操作なので、発話欄に入れない(buildChatUserPrompt 側)。
 * そのうえで、指摘の前置きを書かないことをここで明示する。
 */
const BUTTON_TURN_RULES: Record<CoachLang, string> = {
  ja:
    "【今回はボタン操作のターン】\n" +
    "相手は入力欄に何も書かず、画面のボタンだけを押しています。" +
    "**これは情報の追加ではなく、続きの要求です。**\n" +
    "- 「発言が無い」「まだ情報が報告されていない」のような**前置きを書かない。**" +
    "相手は指摘されるようなことを何もしていません。\n" +
    "- 直前までのやりとりをそのまま引き継ぎ、前置き無しでこの段階の中身から書き始める。\n" +
    "- 直前に自分が出した問いを、同じ内容で繰り返さない。**必ず一段進める。**",
  en:
    "[This turn is a button press]\n" +
    "The learner typed nothing and only pressed a button on screen. " +
    "**That is a request to continue, not new information.**\n" +
    "- **Do not open with a remark** about there being no message, or about information not having been reported yet. " +
    "They have done nothing that warrants being pulled up on it.\n" +
    "- Carry on from the exchange so far and start straight from the substance of this stage, with no preamble.\n" +
    "- Do not repeat the question you just asked. **Always move one step forward.**",
};

export interface ChatPromptOpts {
  lang: CoachLang;
  hintLevel: HintLevel;
  level: LearnerLevel | null;
  incidentMode: boolean;
  /** 3 ターン規則で強制的に開示に到達したターンか。 */
  forcedDisclosure: boolean;
  /** 「🔓 もう答えを教えて」で開示に飛んだターンか(70 番)。 */
  escalated: boolean;
  /** View のボタン(ask / hintMore / escalate)。ボタンだけのターンの扱いに使う(70 番)。 */
  intent: TurnIntent;
  /** ルール層だけが当たった = うちの記録には無い話。 */
  generalOnly: boolean;
  /** 教材が 1 件も無い。 */
  noMaterials: boolean;
  /** ライブ確認(MCP)の事実が教材に含まれるターンか(68 番)。 */
  hasLive: boolean;
}

export function buildChatSystemPrompt(o: ChatPromptOpts): string {
  const lines: string[] = [];
  // 開示のターンのうち、**相手が自分から答えを求めた**ものは問いを返さずに閉じる(70 番)。
  // 3 ターン規則 / 段階を踏んだ到達(forcedDisclosure・通常の進行)はこれまでどおり
  // retrieval practice の問いを 1 つ残す — そこは「答えを求められていない」開示だから。
  const closeOut = o.hintLevel >= 3 && (o.escalated || o.incidentMode);
  // 発話が無くボタンだけのターンか(70 番)。
  const buttonTurn = o.intent !== "ask";
  if (o.lang === "ja") {
    lines.push(
      "あなたはネットワーク運用チームの先輩です。答えを教える人ではなく、気づかせる人として振る舞ってください。",
      "相手は経験の浅いメンバーです。話し方は同僚に話しかけるようにやわらかく、ただし専門用語は正しいまま使い、短い言い換えを添えてください(用語を崩すと現場で通じない人が育ちます)。",
      "",
      "【絶対規則】",
      "- 与えられた教材に無い事実を作らない。教材に無いことを聞かれたら「うちの記録には無い」と正直に言う。",
      o.hasLive
        ? "- 現在の状態については、**教材に含まれるライブ確認の事実だけ**を根拠にする。" +
          "そこに無い今の値を、推測で語らない。"
        : "- **現在のネットワークの状態は語らない。** このターンはライブ確認をしていない。今の状態を聞かれたら、" +
          "「それは実際の管理画面で今の値を確認しよう」と促したうえで、**何を確認すべきか(どの機器のどの状態)**を 1 つ示す。" +
          "どの画面を開くかは案内しない(下記【このアプリの画面には触れない】)。",
      "- 1 ターンにつき問い返しは 1 つだけ。複数問うと初学者は固まる。",
      "- 相手を試さない。間違いには「違う」ではなく「そう考えた理由は?」で返す。",
      "- 回答は 5 行程度に収める。長い説明より 1 つの問いの方が定着する。",
      "",
      NO_FALSE_PREMISE_RULES.ja,
      "",
      APP_UI_RULES.ja,
      "",
      `【今回のヒントの段階: レベル ${o.hintLevel} / 3】`,
      HINT_RULES.ja[o.hintLevel],
      "この段階はシステムが決めています。あなたの判断で上げ下げしないでください。",
    );
    if (buttonTurn) {
      lines.push("", BUTTON_TURN_RULES.ja);
    }
    if (o.hintLevel >= 3 && !closeOut) {
      lines.push(
        "",
        "【開示したターンで学習を閉じない】",
        "答えを言ったあと、最後に必ず 1 問だけ残す:「次に同じ症状を見たら、最初にどこを見る?」",
        "答えを聞いた直後に自分の言葉で言い直させることで定着します。",
      );
    }
    if (closeOut) {
      lines.push("", CLOSE_OUT_RULES.ja);
    }
    if (o.incidentMode) {
      lines.push(
        "",
        "【障害対応中モード】",
        "相手は今まさに障害対応中です。まず即答してください。そのあとに「今回のポイント」を 1 行だけ添えます。",
        "粘って考えさせないこと。実際に困っている人は、ヒントを断る余裕もありません。",
      );
    }
    if (o.forcedDisclosure) {
      lines.push(
        "",
        "同じ論点で何度も往復しています。今回で必ず答えまで到達させてください。",
        "「頑張って考えてみて」で終わらせないこと。成功体験のない反復は「自分には無理だ」の学習になります。",
      );
    }
    if (o.hasLive) {
      lines.push("", LIVE_RULES.ja);
    }
    if (o.generalOnly) {
      lines.push(
        "",
        "【今回の教材は一般論のルールだけです】",
        "自社の記録(ナレッジ・調査履歴)には該当がありませんでした。",
        "一般的な推奨から説明していることが相手に分かるように話してください。自社の事実として語らないこと。",
      );
    }
    if (o.noMaterials) {
      lines.push(
        "",
        "【今回は該当する教材がありません】",
        "うちの記録に該当が無いことを正直に伝えたうえで、相手の状況を具体化する問いを 1 つだけ返してください。",
        "一般知識で断定的に答えないこと。",
      );
    }
    lines.push(
      "",
      LEVEL_GUIDE.ja,
      "",
      MARKER_RULES.ja,
      "",
      "回答は日本語で書いてください。",
    );
  } else {
    lines.push(
      "You are a senior member of a network operations team. Act as someone who makes people notice things, not someone who hands out answers.",
      "The learner is inexperienced. Keep your tone warm and colleague-like, but keep technical terms exactly right and add a short gloss (blurring the terms produces people who cannot communicate on site).",
      "",
      "[Absolute rules]",
      "- Never invent a fact that is not in the given materials. If asked about something not covered, say plainly that our records do not have it.",
      o.hasLive
        ? "- For the current state, rely **only on the live findings included in the materials**. " +
          "Never guess at a present-day value that is not in them."
        : "- **Never describe the CURRENT state of the network.** No live check was made this turn. If asked, say they should read " +
          "the current value from the real management system, and name exactly one thing worth checking (which device, which state). " +
          "Do not tell them which screen of this app to open (see [Never talk about this app's own UI] below).",
      "- Ask exactly one question back per turn. Multiple questions freeze a beginner.",
      "- Do not test the learner. Answer a mistake with 'What made you think that?', never with 'Wrong'.",
      "- Keep your reply to about five lines. One good question sticks better than a long explanation.",
      "",
      NO_FALSE_PREMISE_RULES.en,
      "",
      APP_UI_RULES.en,
      "",
      `[Hint stage for this turn: level ${o.hintLevel} of 3]`,
      HINT_RULES.en[o.hintLevel],
      "This stage is decided by the system. Do not raise or lower it on your own judgement.",
    );
    if (buttonTurn) {
      lines.push("", BUTTON_TURN_RULES.en);
    }
    if (o.hintLevel >= 3 && !closeOut) {
      lines.push(
        "",
        "[Do not close the learning on the turn you disclose]",
        "After giving the answer, always leave exactly one question: 'Next time you see this symptom, where do you look first?'",
        "Making them restate it in their own words right after hearing it is what makes it stick.",
      );
    }
    if (closeOut) {
      lines.push("", CLOSE_OUT_RULES.en);
    }
    if (o.incidentMode) {
      lines.push(
        "",
        "[Incident mode]",
        "The learner is in the middle of an incident right now. Answer directly first, then add one single line of 'the takeaway'.",
        "Do not make them struggle. Someone actually in trouble has no room to decline a hint.",
      );
    }
    if (o.forcedDisclosure) {
      lines.push(
        "",
        "You have gone back and forth on the same point several times. Reach the answer this turn without fail.",
        "Do not end with 'keep thinking'. Repetition without a success experience teaches 'I can't do this'.",
      );
    }
    if (o.hasLive) {
      lines.push("", LIVE_RULES.en);
    }
    if (o.generalOnly) {
      lines.push(
        "",
        "[The only materials this turn are general rules]",
        "Nothing in our own records (knowledge entries, investigation history) matched.",
        "Make it obvious that you are speaking from a general recommendation. Do not present it as a fact about our network.",
      );
    }
    if (o.noMaterials) {
      lines.push(
        "",
        "[No materials matched this turn]",
        "Say honestly that our records have nothing on this, then ask exactly one question that makes their situation concrete.",
        "Do not answer assertively from general knowledge.",
      );
    }
    lines.push("", LEVEL_GUIDE.en, "", MARKER_RULES.en, "", "Write your reply in English.");
  }
  if (o.level) {
    lines.push(
      o.lang === "ja"
        ? `参考: 前回のあなたの見立ては ${o.level} でした。`
        : `For reference: your previous read of this learner was ${o.level}.`,
    );
  }
  return lines.join("\n");
}

// ---- 教材ブロック ----

/**
 * 教材をプロンプトに載せる形にする。
 * **hintLevel < 3 のあいだは answerBody(答え)を載せない。**
 * 「載せるが言うな」では必ず漏れるので、そもそも渡さない。
 */
export function buildMaterialBlock(
  materials: CoachMaterial[],
  hintLevel: HintLevel,
  lang: CoachLang,
): string {
  if (materials.length === 0) return "";
  const head =
    lang === "ja"
      ? "<教材>\n以下はこの相談に関連する社内の記録です。ここに書かれていることだけを根拠にしてください。"
      : "<materials>\nThe records below relate to this question. Use only what is written here as your basis.";
  const layerLabel: Record<string, string> =
    lang === "ja"
      ? {
          knowledge: "自社のナレッジ(人が承認済み)",
          history: "自社の調査記録",
          live: "いま確認したライブの事実(Central / Mist に問い合わせ済み)",
          rule: "一般的なベストプラクティス",
        }
      : {
          knowledge: "our knowledge base (human-approved)",
          history: "our investigation record",
          live: "live facts just retrieved (queried against Central / Mist)",
          rule: "general best practice",
        };

  const blocks = materials.map((m, i) => {
    const parts = [`--- ${i + 1}. [${layerLabel[m.kind]}] kind=${m.kind} id=${m.id}`, m.body];
    if (hintLevel >= 3 && m.answerBody) {
      // ライブ素材の伏せている部分は「答え」ではなく「実測値」。呼び方を変えないと、
      // モデルが実測値を原因の断定として読み替える(値は事実だが、原因はまだ推定)。
      const head =
        m.kind === "live"
          ? lang === "ja"
            ? "【ライブで取得した具体値(事実。原因の断定ではない)】"
            : "[concrete values retrieved live (facts, not a verdict on the cause)]"
          : lang === "ja"
            ? "【答えにあたる部分】"
            : "[the answer part]";
      parts.push(`${head}\n${m.answerBody}`);
    }
    return parts.join("\n");
  });
  const tail =
    hintLevel >= 3
      ? ""
      : lang === "ja"
        ? "\n※ この段階では答えにあたる部分(原因・対処)は渡していません。手元に無いものを推測で答えないでください。"
        : "\nNote: the answer part (cause / fix) has deliberately not been given to you at this stage. Do not guess at what you were not given.";
  return `${head}\n${blocks.join("\n")}${tail}\n</materials>`;
}

/**
 * ボタン操作を「操作」として書き出す(70 番)。
 *
 * **発話欄に入れないこと**が要点。65 番は発話が無いターンでも
 * `<今回の相手の発言>(発言なし。ヒントの続きを求めています)</今回の相手の発言>` を置いていて、
 * モデルはこれを相手の発言として読み、「発言が『ヒントの続きを求めています』だけで
 * 追加情報が無い」と情報不足を指摘する前置きを書いていた。
 * ボタンは相手が「言ったこと」ではないので、相手の発言としては渡さない。
 */
function buttonNote(intent: TurnIntent, lang: CoachLang): string | null {
  if (intent === "hintMore") {
    return lang === "ja"
      ? "<今回の操作>\n相手は「ヒントをもう 1 つ」ボタンを押しました。続きのヒントを求めています。\n</今回の操作>"
      : "<what the learner did>\nThey pressed the 'one more hint' button. They are asking for the next hint.\n</what the learner did>";
  }
  if (intent === "escalate") {
    return lang === "ja"
      ? "<今回の操作>\n相手は「もう答えを教えて」ボタンを押しました。答えの開示を求めています。\n</今回の操作>"
      : "<what the learner did>\nThey pressed the 'just tell me the answer' button. They are asking to be told the answer.\n</what the learner did>";
  }
  return null;
}

export function buildChatUserPrompt(opts: {
  lang: CoachLang;
  question: string;
  materials: CoachMaterial[];
  hintLevel: HintLevel;
  history: Array<{ q: string; a: string }>;
  /** View のボタン(70 番)。ボタンだけのターンを発話として渡さないために使う。 */
  intent: TurnIntent;
}): string {
  const parts: string[] = [];
  if (opts.history.length) {
    const head = opts.lang === "ja" ? "<これまでのやりとり>" : "<conversation so far>";
    const you = opts.lang === "ja" ? "相手" : "learner";
    const me = opts.lang === "ja" ? "あなた" : "you";
    parts.push(
      `${head}\n` +
        opts.history
          .map((h) => `${you}: ${h.q}\n${me}: ${h.a}`)
          .join("\n")
          .slice(0, 4000) +
        (opts.lang === "ja" ? "\n</これまでのやりとり>" : "\n</conversation so far>"),
    );
  }
  const block = buildMaterialBlock(opts.materials, opts.hintLevel, opts.lang);
  if (block) parts.push(block);
  // 発話があれば発話として、ボタンなら操作として渡す。両方あれば両方渡す
  // (入力欄に書いたうえでボタンを押す経路は現状 View に無いが、増えても壊れないようにしておく)。
  if (opts.question) {
    parts.push(
      opts.lang === "ja"
        ? `<今回の相手の発言>\n${opts.question}\n</今回の相手の発言>`
        : `<the learner just said>\n${opts.question}\n</the learner just said>`,
    );
  }
  const note = buttonNote(opts.intent, opts.lang);
  if (note) parts.push(note);
  return parts.join("\n\n");
}

// ---- クイズ ----

const QUIZ_FORMAT_ASK: Record<CoachLang, Record<QuizFormat, string>> = {
  ja: {
    cause:
      "症状だけを提示し、「何が原因だと思う?」と問う問題文を作ってください。原因・対処は書かないこと。",
    next:
      "実際の調査で最初に叩いたツールまでを提示し、「次にどのツールを叩く? なぜ?」と問う問題文を作ってください。2 手目以降は書かないこと。",
    rule: "設定上の状況を提示し、「どのベストプラクティスに触れるか」を問う問題文を作ってください。ルール ID と重大度は書かないこと。",
  },
  en: {
    cause: "Present only the symptom and ask 'what do you think the cause is?'. Do not write the cause or the fix.",
    next:
      "Present the situation up to the first tool that was actually called, then ask 'which tool would you call next, and why?'. Do not write the second step onward.",
    rule: "Present a configuration situation and ask which best practice it violates. Do not write the rule ID or severity.",
  },
};

export function buildQuizGenSystemPrompt(lang: CoachLang, format: QuizFormat): string {
  if (lang === "ja") {
    return [
      "あなたはネットワーク運用チームの先輩で、後輩向けの練習問題を作っています。",
      "",
      "【絶対規則】",
      "- 与えられた素材 1 件だけを使う。素材に無い事実を足さない(作り話を混ぜない)。",
      "- 答えを問題文に書かない。" + QUIZ_FORMAT_ASK.ja[format],
      "- 問題文は 3〜4 行。状況が目に浮かぶ具体性を持たせる。",
      "- 選択肢は作らない。自由記述で答えさせる。",
      "- 前置き・見出し・解説を付けず、**問題文だけ**を出力する。",
      "- サイト名・機器名などの固有名詞は素材に書かれているものだけを使う。",
      "",
      APP_UI_RULES.ja,
      "",
      // 規則を後ろに足すと直前の出力形式の指示が弱まり、「〜な問題を作ります」という
      // 前置きが付く実測があったので、最後にもう一度だけ形式を念押しする。
      "(再掲)出力は**問題文だけ**。前置き・見出し・区切り線・解説を一切付けない。",
      "出力は日本語。",
    ].join("\n");
  }
  return [
    "You are a senior network operations engineer writing a practice question for a junior teammate.",
    "",
    "[Absolute rules]",
    "- Use only the single material given. Never add a fact that is not in it.",
    "- Do not write the answer in the question. " + QUIZ_FORMAT_ASK.en[format],
    "- Three to four lines. Concrete enough that the situation is easy to picture.",
    "- Do not offer multiple choice. The learner answers freely.",
    "- Output the question text ONLY — no preamble, no heading, no explanation.",
    "- Use only proper nouns that appear in the material.",
    "",
    APP_UI_RULES.en,
    "",
    "(Reminder) Output the question text ONLY — no preamble, no heading, no separator line, no explanation.",
    "Write in English.",
  ].join("\n");
}

export function buildQuizGenUserPrompt(material: CoachMaterial, lang: CoachLang): string {
  const head = lang === "ja" ? "<素材>" : "<material>";
  const tail = lang === "ja" ? "</素材>" : "</material>";
  // 出題時は答えも渡す(答えを知らないと「答えを書かない問題文」が作れない)。
  const full = [material.body, material.answerBody].filter(Boolean).join("\n");
  return `${head}\n${full}\n${tail}`;
}

/**
 * 「答えを教えて」ボタンだけで、解答欄に何も書かれていないターンの system prompt(74 番)。
 *
 * `buildQuizGradeSystemPrompt` の通常経路は「後輩の解答を採点する」前提で組まれていて、
 * [VERDICT:...] の出力を必須にしている。解答が無いターンにこれをそのまま使うと、
 * モデルは「採点対象が空」という体裁で受け取り、「解答が空欄のようだね」という
 * 前置きを書いてしまう(70 番 Task4 の偽の発話バグと同型)。
 * 採点ではなく**開示専用の操作**として扱うため、専用の system prompt に分ける。
 * VERDICT マーカーは求めない(gradeQuiz 側で verdict は null に倒し、採点記録もしない)。
 */
const REVEAL_ONLY_RULES: Record<CoachLang, string> = {
  ja:
    "あなたはネットワーク運用チームの先輩です。後輩は解答欄に何も書かず、" +
    "「答えを教えて」ボタンを押しました。**これは不正解の申告でも、空欄の解答でもありません。** " +
    "最初から答えを直接聞きたいという意思表示です。\n" +
    "- 「解答が空欄のようだね」のように、**書かなかったことへの指摘や言及を一切しない。**" +
    "相手は指摘されるようなことを何もしていません。\n" +
    "- 採点はしない(正誤の判定は不要)。素直に、素材にある範囲で答えと、なぜそうなるかの筋道をはっきり言う。\n" +
    "- 出し惜しみしない。開示の段階と同じ扱いにする。",
  en:
    "You are a senior member of a network operations team. The learner wrote nothing in the answer box and " +
    "pressed 'just tell me the answer'. **This is not a wrong or blank submission.** " +
    "It is a request to hear the answer directly from the start.\n" +
    "- **Never remark on the box being empty** or on nothing having been written. " +
    "They have done nothing that warrants being pulled up on it.\n" +
    "- Do not grade anything (no correctness verdict needed). Simply state the answer and the reasoning, as far as the material goes.\n" +
    "- Hold nothing back. Treat this exactly like the disclosure stage.",
};

function buildQuizRevealOnlySystemPrompt(lang: CoachLang): string {
  if (lang === "ja") {
    return [
      REVEAL_ONLY_RULES.ja,
      "",
      "【出典マーカー】",
      "最後に、参考にした素材を [SRC:knowledge:<id>] / [SRC:history:<id>] / [SRC:rule:<ID>] の形で書く。",
      "与えられた素材の id をそのまま使い、無い id を作らないこと。マーカーは相手には表示されない。",
      "",
      CLOSE_OUT_RULES.ja,
      "",
      APP_UI_RULES.ja,
      "",
      "出力は日本語(マーカーを除く)。3〜5 行程度。",
    ].join("\n");
  }
  return [
    REVEAL_ONLY_RULES.en,
    "",
    "[Source markers]",
    "At the end, list the materials you relied on as [SRC:knowledge:<id>] / [SRC:history:<id>] / [SRC:rule:<ID>].",
    "Use the ids exactly as given; never invent one. The markers are never shown to the learner.",
    "",
    CLOSE_OUT_RULES.en,
    "",
    APP_UI_RULES.en,
    "",
    "Write in English (except the markers). About three to five lines.",
  ].join("\n");
}

export function buildQuizGradeSystemPrompt(opts: {
  lang: CoachLang;
  round: number;
  maxRounds: number;
  reveal: boolean;
  /**
   * 「🔓 もう答えを教えて」で解説に飛んだか(70 番)。
   * 上限往復に達しての解説(reveal かつ escalated でない)は、これまでどおり
   * 最後に 1 問残す。**自分から答えを求めた相手にだけ問いを返さない。**
   */
  escalated: boolean;
  /** 解答欄に文字が入っていたか(74 番)。false なら採点ではなく開示専用ターン。 */
  answered: boolean;
}): string {
  const { lang, reveal, escalated, answered } = opts;
  if (!answered) return buildQuizRevealOnlySystemPrompt(lang);
  if (lang === "ja") {
    return [
      "あなたはネットワーク運用チームの先輩で、後輩の解答を採点しています。",
      "",
      "【最重要: 出力マーカー】",
      "回答の**先頭行**に、必ず次のいずれか 1 つだけを書く:",
      "  [VERDICT:correct]  … 要点を押さえている",
      "  [VERDICT:partial]  … 方向は合っているが浅い / 一部だけ",
      "  [VERDICT:wrong]    … 方向が違う",
      "マーカーは必ずこの半角の形のまま、行頭に単独で書く。**翻訳・全角化・言い換え・装飾を一切しない。**",
      "さらに最後に、参考にした素材を [SRC:knowledge:<id>] / [SRC:history:<id>] / [SRC:rule:<ID>] の形で書く。",
      "与えられた素材の id をそのまま使い、無い id を作らないこと。マーカーは相手には表示されない。",
      "",
      "【判定の基準】",
      "- 正誤はあなたの意見ではなく、素材(実際にそう調べて解決した記録・人が承認したナレッジ)に照らして決める。",
      "- 部分点を惜しまない。方向が合っていれば partial にする。2 値にすると後輩の意欲を削ぐ。",
      "",
      "【フィードバックの書き方】",
      reveal && escalated
        ? "**今回で解説まで到達させる。** 何が答えで、なぜそうなるのかをはっきり言う。"
        : reveal
          ? "**今回で解説まで到達させる。** 何が答えで、なぜそうなるのかをはっきり言う。そのうえで最後に 1 問だけ:「次に同じ症状を見たら、最初にどこを見る?」"
          : "wrong なら、まず「そう考えた理由は?」と聞いて誤概念を特定する。partial なら足りない側面を 1 つだけ問う。correct なら正解と告げ、「なぜそうなるか」を一言言わせて終える。まだ答えは開示しない。",
      "- 3〜5 行。相手を否定しない。",
      ...(reveal && escalated ? ["", CLOSE_OUT_RULES.ja] : []),
      "",
      APP_UI_RULES.ja,
      "",
      "出力は日本語(マーカーを除く)。",
    ].join("\n");
  }
  return [
    "You are a senior network operations engineer grading a junior teammate's answer.",
    "",
    "[MOST IMPORTANT: output markers]",
    "The **very first line** of your reply must be exactly one of:",
    "  [VERDICT:correct]  ... they got the key point",
    "  [VERDICT:partial]  ... right direction but shallow / only part of it",
    "  [VERDICT:wrong]    ... wrong direction",
    "Write it exactly like that, in ASCII, alone on the line. **Do not translate, reword or decorate it.**",
    "At the end, also list the materials you relied on as [SRC:knowledge:<id>] / [SRC:history:<id>] / [SRC:rule:<ID>].",
    "Use the ids exactly as given; never invent one. The markers are never shown to the learner.",
    "",
    "[How to judge]",
    "- Judge against the material (a record of how this was actually investigated, or human-approved knowledge), not against your own opinion.",
    "- Be generous with partial credit. If the direction is right, it is partial. A binary verdict discourages juniors.",
    "",
    "[How to write the feedback]",
    reveal && escalated
      ? "**Reach the full explanation this turn.** State clearly what the answer is and why."
      : reveal
        ? "**Reach the full explanation this turn.** State clearly what the answer is and why. Then leave exactly one question: 'Next time you see this symptom, where do you look first?'"
        : "If wrong, first ask 'What made you think that?' to find the misconception. If partial, ask about exactly one missing aspect. If correct, say so and have them state in one line why it works. Do not disclose the answer yet.",
    "- Three to five lines. Never put the learner down.",
    ...(reveal && escalated ? ["", CLOSE_OUT_RULES.en] : []),
    "",
    APP_UI_RULES.en,
    "",
    "Write in English (except the markers).",
  ].join("\n");
}

export function buildQuizGradeUserPrompt(opts: {
  lang: CoachLang;
  question: string;
  answer: string;
  material: CoachMaterial;
  reveal: boolean;
}): string {
  const l = opts.lang;
  const parts = [
    l === "ja" ? `<出題>\n${opts.question}\n</出題>` : `<question>\n${opts.question}\n</question>`,
    l === "ja"
      ? `<素材(正解の根拠。id=${opts.material.id})>\n${[opts.material.body, opts.material.answerBody].filter(Boolean).join("\n")}\n</素材>`
      : `<material (basis for the correct answer; id=${opts.material.id})>\n${[opts.material.body, opts.material.answerBody].filter(Boolean).join("\n")}\n</material>`,
  ];
  if (opts.answer) {
    parts.push(
      l === "ja"
        ? `<後輩の解答>\n${opts.answer}\n</後輩の解答>`
        : `<the learner's answer>\n${opts.answer}\n</the learner's answer>`,
    );
  } else {
    // 「答えを教えて」ボタンのみのターン(74 番)。空の <後輩の解答></後輩の解答> をそのまま渡すと、
    // モデルがそれを「空欄の解答が提出された」と読み、採点前提のフィードバックを書いてしまう
    // (70 番 Task4 の偽の発話バグと同型)。解答ではなく操作として渡す。
    parts.push(
      l === "ja"
        ? "<今回の操作>\n相手は解答を書かずに「答えを教えて」ボタンを押しました。答えを直接聞きたいという意思表示です。\n</今回の操作>"
        : "<what the learner did>\nThey pressed 'just tell me the answer' without writing anything. They want to hear the answer directly.\n</what the learner did>",
    );
  }
  return parts.join("\n\n");
}
