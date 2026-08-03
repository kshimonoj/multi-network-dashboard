// ナレッジタブ(46)— カード本体の共通パーツ。
//
// 候補カード(CandidateCard)と承認済み一覧(Knowledge.tsx)で同じ見た目を使うため、
// 「4 項目 + タグ + 対象 + 出典」の描画をここに集約する。
//
// 本文(タイトル / 症状 / 根本原因 / 対処法)は **生成時の言語のまま出す**。
// 実行時の記録として残る文言は翻訳しない、という CLAUDE.md の方針に従う。
// ラベル(「症状」「根本原因」…)だけが表示言語に追従する。

import { useLanguage } from "../../../src/i18n/LanguageContext";
import { formatDateTime } from "../../../src/i18n";
import type { PendingHistoryFocus } from "../../../src/shell";
import type { EntryPatch, KnowledgeEntry, KnowledgeScope } from "./types";

/** 適用範囲・プラットフォームのバッジ列。 */
export function EntryBadges({ entry }: { entry: KnowledgeEntry }) {
  const { t } = useLanguage();
  return (
    <span className="kb-badges">
      <span className={`kb-scope kb-scope-${entry.scope}`}>{t(`knowledge.scope.${entry.scope}`)}</span>
      {entry.platform && (
        <span className={`kb-plat kb-plat-${entry.platform}`}>{t(`knowledge.platform.${entry.platform}`)}</span>
      )}
      {entry.edited && <span className="go-tag kb-tag-edited">{t("knowledge.meta.edited")}</span>}
    </span>
  );
}

/** 4 項目のうち中身のあるものだけを並べる。 */
export function EntryFields({ entry }: { entry: KnowledgeEntry }) {
  const { t } = useLanguage();
  const rows: Array<[string, string]> = [
    ["symptom", entry.symptom],
    ["rootCause", entry.rootCause],
    ["action", entry.action],
  ];
  return (
    <div className="kb-fields">
      {rows.map(([key, value]) =>
        value ? (
          <div className="kb-field" key={key}>
            <span className="kb-field-label">{t(`knowledge.card.${key}`)}</span>
            <span className="kb-field-value">{value}</span>
          </div>
        ) : null,
      )}
    </div>
  );
}

/** タグ・対象(サイト / 機器)。クリックでタグ絞り込みできる場合は onTag を渡す。 */
export function EntryMeta({
  entry,
  onTag,
  activeTag,
}: {
  entry: KnowledgeEntry;
  onTag?: (tag: string) => void;
  activeTag?: string | null;
}) {
  const { t } = useLanguage();
  const target: string[] = [];
  if (entry.site) target.push(t("knowledge.card.site", { value: entry.site }));
  if (entry.device) target.push(t("knowledge.card.device", { value: entry.device }));
  if (entry.tags.length === 0 && target.length === 0) return null;
  return (
    <div className="kb-meta">
      {entry.tags.map((tag) =>
        onTag ? (
          <button
            key={tag}
            className={`kb-tag${activeTag === tag ? " kb-tag-on" : ""}`}
            onClick={() => onTag(tag)}
            title={t("knowledge.approved.filterByTag", { tag })}
          >
            #{tag}
          </button>
        ) : (
          <span key={tag} className="kb-tag">
            #{tag}
          </span>
        ),
      )}
      {target.length > 0 && <span className="kb-target go-mono">{target.join(" / ")}</span>}
    </div>
  );
}

/** 出典(元になった調査)。「調査結果を見る」で実行スレッドへ直接ジャンプする。 */
export function EntrySources({
  entry,
  onOpenHistoryFocus,
}: {
  entry: KnowledgeEntry;
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
}) {
  const { lang, t } = useLanguage();
  if (entry.sources.length === 0) return null;
  return (
    <div className="kb-sources">
      {entry.sources.map((s) => (
        <div className="kb-source" key={s.runId}>
          <span className="go-note kb-source-text" title={s.query}>
            {t("knowledge.card.sourceLine", {
              origin: t(`knowledge.origin.${s.origin}`),
              at: formatDateTime(s.at, lang),
            })}
          </span>
          {onOpenHistoryFocus && (
            <button className="kb-link-btn" onClick={() => onOpenHistoryFocus(s.runId)}>
              {t("knowledge.actions.openRun")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 調査プロンプトへの注入実績(47 Task 3)。
 * 承認済みなのに一度も注入されていないものは「未参照」として目立たせる
 * (使われていない古い知見を見つけるため。自動削除はしない)。
 */
export function EntryRefs({ entry }: { entry: KnowledgeEntry }) {
  const { lang, t } = useLanguage();
  const n = entry.refCount ?? 0;
  if (n === 0) {
    return (
      <span className="go-tag kb-ref-none" title={t("knowledge.refs.neverTitle")}>
        {t("knowledge.refs.never")}
      </span>
    );
  }
  return (
    <span className="go-tag kb-ref-count" title={t("knowledge.refs.title")}>
      {t("knowledge.refs.count", { n })}
      {entry.lastReferencedAt
        ? ` / ${t("knowledge.refs.last", { at: formatDateTime(entry.lastReferencedAt, lang) })}`
        : ""}
    </span>
  );
}

/** 本文の言語が表示言語と違うときの注記(レポートタブと同じ考え方)。 */
export function LangNote({ entry }: { entry: KnowledgeEntry }) {
  const { lang, t } = useLanguage();
  if (entry.lang === lang) return null;
  return <div className="go-note kb-lang-note">{t("knowledge.card.langNote", { lang: t(`language.${entry.lang}`) })}</div>;
}

// ---- 編集フォーム ----
//
// 「編集して承認」(未承認候補)と「編集」(承認済みエントリ)で同じものを使う。
// 入力は一切必須にしない = 1 クリック承認の邪魔をしない、という方針なので、
// このフォームは押した人だけが開く。

const SCOPES: KnowledgeScope[] = ["general", "site", "device"];

export interface Draft {
  title: string;
  symptom: string;
  rootCause: string;
  action: string;
  scope: KnowledgeScope;
  tags: string;
  site: string;
  device: string;
}

export function toDraft(e: KnowledgeEntry): Draft {
  return {
    title: e.title,
    symptom: e.symptom,
    rootCause: e.rootCause,
    action: e.action,
    scope: e.scope,
    tags: e.tags.join(", "),
    site: e.site ?? "",
    device: e.device ?? "",
  };
}

/** 入力欄 → サーバへ送るパッチ。タグは読点・カンマ・空白のどれで区切ってもよい。 */
export function toPatch(d: Draft): EntryPatch {
  return {
    title: d.title,
    symptom: d.symptom,
    rootCause: d.rootCause,
    action: d.action,
    scope: d.scope,
    tags: d.tags
      .split(/[,、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    site: d.site.trim() ? d.site.trim() : null,
    device: d.device.trim() ? d.device.trim() : null,
  };
}

export function EntryEditor({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
}) {
  const { t } = useLanguage();
  const set = (k: keyof Draft) => (e: { target: { value: string } }) =>
    onChange({ ...draft, [k]: e.target.value });

  return (
    <div className="kb-edit">
      <label className="kb-edit-row">
        <span className="kb-field-label">{t("knowledge.card.title")}</span>
        <input className="kb-input" value={draft.title} onChange={set("title")} />
      </label>
      <label className="kb-edit-row">
        <span className="kb-field-label">{t("knowledge.card.symptom")}</span>
        <textarea className="kb-textarea" rows={3} value={draft.symptom} onChange={set("symptom")} />
      </label>
      <label className="kb-edit-row">
        <span className="kb-field-label">{t("knowledge.card.rootCause")}</span>
        <textarea className="kb-textarea" rows={3} value={draft.rootCause} onChange={set("rootCause")} />
      </label>
      <label className="kb-edit-row">
        <span className="kb-field-label">{t("knowledge.card.action")}</span>
        <textarea className="kb-textarea" rows={3} value={draft.action} onChange={set("action")} />
      </label>
      <div className="kb-edit-grid">
        <label className="kb-edit-row">
          <span className="kb-field-label">{t("knowledge.card.scope")}</span>
          <select className="kb-input" value={draft.scope} onChange={set("scope")}>
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {t(`knowledge.scope.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="kb-edit-row">
          <span className="kb-field-label">{t("knowledge.card.tagsLabel")}</span>
          <input
            className="kb-input"
            value={draft.tags}
            onChange={set("tags")}
            placeholder={t("knowledge.card.tagsPlaceholder")}
          />
        </label>
        <label className="kb-edit-row">
          <span className="kb-field-label">{t("knowledge.card.siteLabel")}</span>
          <input className="kb-input" value={draft.site} onChange={set("site")} />
        </label>
        <label className="kb-edit-row">
          <span className="kb-field-label">{t("knowledge.card.deviceLabel")}</span>
          <input className="kb-input" value={draft.device} onChange={set("device")} />
        </label>
      </div>
    </div>
  );
}
