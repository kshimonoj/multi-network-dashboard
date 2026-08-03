// ベストプラクティス「ルール一覧 / リファレンス」サブビュー(53)。
//
// 診断結果とは独立に、29 ルール全部の title/desc/category/priority/method/references を
// 常時閲覧できる一覧。サイト選択・診断実行は不要(GET /api/best-practice/rules だけで完結)。
//
// 結果一覧(RuleCard)の「ルール一覧で詳しく見る」から遷移してきた場合は highlightRuleId が
// 立っており、該当ルールへスクロールして一時的にハイライトする。

import { useEffect, useRef } from "react";
import type { TFunc } from "../../../src/i18n";
import { ruleDesc, ruleTitle } from "./findingText";
import { CATEGORY_ORDER, SEVERITY_ORDER, type BestPracticeRule, type CheckCategory } from "./types";

interface Props {
  t: TFunc;
  rules: BestPracticeRule[] | null;
  rulesError: string | null;
  highlightRuleId: string | null;
  onHighlightDone: () => void;
}

function groupByCategory(rules: BestPracticeRule[]): Map<CheckCategory, BestPracticeRule[]> {
  const byCategory = new Map<CheckCategory, BestPracticeRule[]>();
  for (const r of rules) {
    const arr = byCategory.get(r.category);
    if (arr) arr.push(r);
    else byCategory.set(r.category, [r]);
  }
  for (const arr of byCategory.values()) {
    arr.sort((a, b) => {
      const sa = SEVERITY_ORDER.indexOf(a.severity);
      const sb = SEVERITY_ORDER.indexOf(b.severity);
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });
  }
  return byCategory;
}

export function RuleReference({ t, rules, rulesError, highlightRuleId, onHighlightDone }: Props) {
  if (rulesError) {
    return <div className="go-error">{t("bestPractice.reference.error") + rulesError}</div>;
  }
  if (rules === null) {
    return <div className="go-loading">{t("bestPractice.reference.loading")}</div>;
  }

  const grouped = groupByCategory(rules);

  return (
    <div className="bp-reference">
      <div className="go-note">{t("bestPractice.reference.headerSub", { n: rules.length })}</div>
      {CATEGORY_ORDER.map((cat) => {
        const inCat = grouped.get(cat);
        if (!inCat || inCat.length === 0) return null;
        return (
          <section key={cat} className="bp-category">
            <h2 className="bp-category-title">{t(`bestPractice.category.${cat}`)}</h2>
            <div className="bp-rule-list">
              {inCat.map((rule) => (
                <ReferenceCard
                  key={rule.id}
                  t={t}
                  rule={rule}
                  highlighted={highlightRuleId === rule.id}
                  onHighlightDone={onHighlightDone}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ReferenceCard({
  t,
  rule,
  highlighted,
  onHighlightDone,
}: {
  t: TFunc;
  rule: BestPracticeRule;
  highlighted: boolean;
  onHighlightDone: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const isLlm = rule.method === "llm";

  useEffect(() => {
    if (!highlighted) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(onHighlightDone, 2000);
    return () => window.clearTimeout(timer);
  }, [highlighted, onHighlightDone]);

  return (
    <div
      ref={ref}
      id={`bp-ref-${rule.id}`}
      className={`bp-rule-card bp-ref-card${highlighted ? " bp-ref-highlight" : ""}`}
    >
      <div className="bp-rule-head">
        <span className="bp-rule-id go-mono">{rule.id}</span>
        <span className="bp-rule-title">{ruleTitle(t, rule)}</span>
        <span className={`bp-badge bp-severity-${rule.severity}`}>
          {t(`bestPractice.severity.${rule.severity}`)}
        </span>
        {isLlm && <span className="bp-badge bp-badge-llm">{t("bestPractice.llmFinding.badge")}</span>}
      </div>
      <div className="bp-rule-desc">{ruleDesc(t, rule)}</div>
      <dl className="bp-rule-meta">
        <div className="bp-rule-meta-item">
          <dt>{t("bestPractice.detail.category")}</dt>
          <dd>{t(`bestPractice.category.${rule.category}`)}</dd>
        </div>
        <div className="bp-rule-meta-item">
          <dt>{t("bestPractice.detail.priority")}</dt>
          <dd>{t(`bestPractice.severity.${rule.severity}`)}</dd>
        </div>
        <div className="bp-rule-meta-item">
          <dt>{t("bestPractice.detail.method")}</dt>
          <dd>{t(`bestPractice.method.${rule.method}`)}</dd>
        </div>
      </dl>
      {isLlm && <div className="bp-note bp-note-llm">{t("bestPractice.llmFinding.note")}</div>}
      {rule.requiresLegalReview && <div className="bp-note bp-note-legal">{t("bestPractice.legalReview.note")}</div>}
      {rule.references.length > 0 && (
        <div className="bp-refs">
          <span className="bp-refs-title">{t("bestPractice.references.title")}: </span>
          {rule.references.map((r) => (
            <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className="bp-ref-link">
              {r.title}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
