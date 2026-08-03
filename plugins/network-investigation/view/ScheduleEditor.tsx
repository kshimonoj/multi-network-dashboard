import { useCallback, useEffect, useState } from "react";
import { useT, type TFunc } from "../../../src/i18n";
import { weekdayLabel } from "./session";
import type { ScheduleConfig, ScheduledQuery, SiteEntry } from "./types";
import { MODEL_OPTIONS, DEFAULT_MODEL } from "./types";
import {
  addScheduledQuery,
  deleteScheduledQuery,
  fetchScheduleConfig,
  fetchScheduledQueries,
  updateScheduleConfig,
  updateScheduledQuery,
  type LaunchdSyncResult,
} from "./api";

/**
 * cron 反映結果(サーバの detailCode + detailParams)を表示文にする(33 Task 4)。
 * detailCode を持たない応答(想定外・旧サーバ)はサーバの日本語文をそのまま出す
 * = 「何も出ない」より運用しやすい、というのが 29 番以降の一貫した方針。
 */
function scheduleDetailText(t: TFunc, r: LaunchdSyncResult): string {
  if (!r.detailCode) return r.detail;
  const p = r.detailParams ?? {};
  if (r.detailCode !== "applied") {
    return t(`networkInvestigation.schedule.detail.${r.detailCode}`, p);
  }
  const weekly = p.frequency === "weekly";
  const freq = weekly
    ? t("networkInvestigation.schedule.detail.freqWeekly", {
        weekday: weekdayLabel(t, Number(p.dayOfWeek)),
        time: String(p.time ?? ""),
      })
    : t("networkInvestigation.schedule.detail.freqDaily", { time: String(p.time ?? "") });
  return t("networkInvestigation.schedule.detail.applied", {
    freq,
    expression: String(p.expression ?? ""),
    tz: String(p.tz ?? ""),
  });
}

// 定期実行のカスタマイズ UI(Task 5)。
// - 上段: 実行時刻・頻度(daily/weekly)・有効/無効 → 保存でサーバー側の cron ジョブを張り直す
//   (移植元 Corstack では launchd plist の再生成 + unload→load だった)。
// - 下段: 定期実行するクエリの一覧(追加・編集・削除・enable 切替)。
// CLAUDE.md 原則に従い、View はキャッシュ・楽観的更新を持たず、サーバーが返した「今の値」で置き換える。

// 33 L-5: 曜日の並びは 0=日曜 … 6=土曜(cron / launchd と同じ)。ラベルは辞書側
// (networkInvestigation.schedule.weekday.*)に完全な曜日名を置き、session.ts の
// weekdayLabel() 経由で引く。Timeline.tsx の定期実行サマリと同じ 1 箇所を共有する。
const WEEKDAY_VALUES = [0, 1, 2, 3, 4, 5, 6];

const DEFAULT_CONFIG: ScheduleConfig = { hour: 7, minute: 0, frequency: "daily", enabled: true };

export function ScheduleEditor({ entries, onChanged }: { entries: SiteEntry[]; onChanged?: () => void }) {
  const t = useT();
  const [queries, setQueries] = useState<ScheduledQuery[]>([]);
  const [config, setConfig] = useState<ScheduleConfig>(DEFAULT_CONFIG);
  const [savingConfig, setSavingConfig] = useState(false);
  // 反映結果は「文にしたもの」ではなく応答そのものを持つ。文にするのは描画時。
  // 文字列で持つと、保存したあとに表示言語を切り替えてもこの行だけ前の言語で残ってしまう。
  const [launchdResult, setLaunchdResult] = useState<LaunchdSyncResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 新規クエリ入力。
  const [newQuery, setNewQuery] = useState("");
  const [newSite, setNewSite] = useState("");
  const [newModel, setNewModel] = useState(DEFAULT_MODEL); // 既定は Sonnet(常に明示的な値)

  // 編集中のクエリ(id → 下書き)。
  const [editId, setEditId] = useState<string | null>(null);
  const [editQuery, setEditQuery] = useState("");
  const [editSite, setEditSite] = useState("");
  const [editModel, setEditModel] = useState("");

  const load = useCallback(() => {
    fetchScheduledQueries().then(setQueries).catch((e) => setErr(String(e)));
    fetchScheduleConfig().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const central = entries.filter((e) => e.platform === "central");
  const mist = entries.filter((e) => e.platform === "mist");

  const siteSelect = (value: string, onChange: (v: string) => void, id?: string) => (
    <select className="ni-select" value={value} onChange={(e) => onChange(e.target.value)} id={id}>
      <option value="">{t("networkInvestigation.schedule.siteAny")}</option>
      <optgroup label="Central">
        {central.map((e) => (
          <option key={e.siteId} value={e.siteName}>
            {e.siteName}
          </option>
        ))}
      </optgroup>
      <optgroup label="Mist">
        {mist.map((e) => (
          <option key={e.siteId} value={e.siteName}>
            {e.siteName}
          </option>
        ))}
      </optgroup>
    </select>
  );

  const modelSelect = (value: string, onChange: (v: string) => void) => (
    <select className="ni-select ni-model-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {MODEL_OPTIONS.map((m) => (
        <option key={m.value} value={m.value}>
          {t("networkInvestigation.console.modelOption", { label: m.label })}
        </option>
      ))}
    </select>
  );

  const onAdd = async () => {
    const q = newQuery.trim();
    if (!q) return;
    setErr(null);
    try {
      const next = await addScheduledQuery({ query: q, site: newSite || null, enabled: true, model: newModel || null });
      setQueries(next);
      setNewQuery("");
      setNewSite("");
      setNewModel(DEFAULT_MODEL);
      onChanged?.();
    } catch (e) {
      setErr(String(e));
    }
  };

  const onToggle = async (rec: ScheduledQuery) => {
    setErr(null);
    try {
      setQueries(await updateScheduledQuery(rec.id, { enabled: !rec.enabled }));
      onChanged?.();
    } catch (e) {
      setErr(String(e));
    }
  };

  const onDelete = async (rec: ScheduledQuery) => {
    setErr(null);
    try {
      setQueries(await deleteScheduledQuery(rec.id));
      onChanged?.();
    } catch (e) {
      setErr(String(e));
    }
  };

  const startEdit = (rec: ScheduledQuery) => {
    setEditId(rec.id);
    setEditQuery(rec.query);
    setEditSite(rec.site ?? "");
    // 過去に model 未指定で作られたクエリは、編集を開くと明示的な既定(Sonnet)を選択状態にする
    // (MODEL_OPTIONS に "" 選択肢は無く、保存すれば明示値になる)。
    setEditModel(rec.model ?? DEFAULT_MODEL);
  };

  const saveEdit = async () => {
    if (!editId) return;
    const q = editQuery.trim();
    if (!q) return;
    setErr(null);
    try {
      const next = await updateScheduledQuery(editId, { query: q, site: editSite || null, model: editModel || null });
      setQueries(next);
      setEditId(null);
      onChanged?.();
    } catch (e) {
      setErr(String(e));
    }
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    setLaunchdResult(null);
    setErr(null);
    try {
      const { config: saved, launchd } = await updateScheduleConfig(config);
      setConfig(saved);
      onChanged?.();
      // 33 Task 4: サーバは日本語の文章ではなく機械可読な detailCode + params を返す。
      setLaunchdResult(launchd);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="ni-sched-editor">
      {err && (
        <div className="ni-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}

      {/* 実行時刻・頻度 */}
      <div className="ni-sched-config">
        <label className="ni-sched-field">
          <span>{t("networkInvestigation.schedule.frequency")}</span>
          <select
            className="ni-select"
            value={config.frequency}
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                frequency: e.target.value as "daily" | "weekly",
                dayOfWeek: e.target.value === "weekly" ? c.dayOfWeek ?? 1 : undefined,
              }))
            }
          >
            <option value="daily">{t("networkInvestigation.schedule.daily")}</option>
            <option value="weekly">{t("networkInvestigation.schedule.weekly")}</option>
          </select>
        </label>

        {config.frequency === "weekly" && (
          <label className="ni-sched-field">
            <span>{t("networkInvestigation.schedule.dayOfWeek")}</span>
            <select
              className="ni-select"
              value={config.dayOfWeek ?? 1}
              onChange={(e) => setConfig((c) => ({ ...c, dayOfWeek: Number(e.target.value) }))}
            >
              {WEEKDAY_VALUES.map((i) => (
                <option key={i} value={i}>
                  {weekdayLabel(t, i)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="ni-sched-field">
          <span>{t("networkInvestigation.schedule.time")}</span>
          <span className="ni-sched-time">
            <input
              className="ni-input ni-time-input"
              type="number"
              min={0}
              max={23}
              value={config.hour}
              onChange={(e) => setConfig((c) => ({ ...c, hour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) }))}
            />
            <span>:</span>
            <input
              className="ni-input ni-time-input"
              type="number"
              min={0}
              max={59}
              value={config.minute}
              onChange={(e) => setConfig((c) => ({ ...c, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) }))}
            />
          </span>
        </label>

        <label className="ni-sched-field ni-sched-check">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
          />
          <span>{t("networkInvestigation.schedule.enableLabel")}</span>
        </label>

        <button className="ni-btn primary sm" onClick={saveConfig} disabled={savingConfig}>
          {savingConfig
            ? t("networkInvestigation.schedule.savingBtn")
            : t("networkInvestigation.schedule.saveBtn")}
        </button>
      </div>
      {launchdResult && (
        <div className="ni-mono ni-dim ni-launchd-msg">
          {t("networkInvestigation.schedule.applyMsg", {
            state: t(`networkInvestigation.schedule.apply${launchdResult.ok ? "Ok" : "Fail"}`),
            detail: scheduleDetailText(t, launchdResult),
          })}
        </div>
      )}

      {/* クエリ一覧 */}
      <div className="ni-sched-qlist">
        {queries.length === 0 && (
          <div className="ni-dim sm">{t("networkInvestigation.schedule.emptyList")}</div>
        )}
        {queries.map((q) => (
          <div className={`ni-sched-qrow${q.enabled ? "" : " off"}`} key={q.id}>
            {editId === q.id ? (
              <div className="ni-sched-edit">
                <textarea
                  className="ni-input"
                  rows={2}
                  value={editQuery}
                  onChange={(e) => setEditQuery(e.target.value)}
                />
                <div className="ni-form-row">
                  {siteSelect(editSite, setEditSite)}
                  {modelSelect(editModel, setEditModel)}
                  <button className="ni-btn primary sm" onClick={saveEdit}>
                    {t("networkInvestigation.schedule.save")}
                  </button>
                  <button className="ni-btn sm" onClick={() => setEditId(null)}>
                    {t("networkInvestigation.schedule.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <label
                  className="ni-sched-toggle"
                  title={t(`networkInvestigation.schedule.toggle${q.enabled ? "On" : "Off"}`)}
                >
                  <input type="checkbox" checked={q.enabled} onChange={() => onToggle(q)} />
                </label>
                <div className="ni-sched-qbody">
                  <div className="ni-sched-qtext">{q.query}</div>
                  <div className="ni-mono ni-dim sm">
                    {t("networkInvestigation.schedule.qmeta", {
                      site: q.site
                        ? t("networkInvestigation.schedule.siteValue", { site: q.site })
                        : t("networkInvestigation.schedule.siteUnset"),
                      model: q.model
                        ? t("networkInvestigation.schedule.modelValue", { model: q.model })
                        : t("networkInvestigation.schedule.modelLegacy"),
                    })}
                  </div>
                </div>
                <div className="ni-sched-qactions">
                  <button className="ni-btn sm" onClick={() => startEdit(q)}>
                    {t("networkInvestigation.schedule.edit")}
                  </button>
                  <button
                    className="ni-btn sm"
                    onClick={() => onDelete(q)}
                    title={t("networkInvestigation.schedule.deleteTitle")}
                  >
                    {t("networkInvestigation.schedule.delete")}
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* 新規追加 */}
      <div className="ni-sched-add">
        <textarea
          className="ni-input"
          rows={2}
          placeholder={t("networkInvestigation.schedule.addPlaceholder")}
          value={newQuery}
          onChange={(e) => setNewQuery(e.target.value)}
        />
        <div className="ni-form-row">
          {siteSelect(newSite, setNewSite)}
          {modelSelect(newModel, setNewModel)}
          <button className="ni-btn sm" onClick={onAdd} disabled={!newQuery.trim()}>
            {t("networkInvestigation.schedule.addBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
