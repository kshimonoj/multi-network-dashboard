import { useCallback, useEffect, useState } from "react";
import type { ScheduleConfig, ScheduledQuery, SiteEntry } from "./types";
import { MODEL_OPTIONS, DEFAULT_MODEL } from "./types";
import {
  addScheduledQuery,
  deleteScheduledQuery,
  fetchScheduleConfig,
  fetchScheduledQueries,
  updateScheduleConfig,
  updateScheduledQuery,
} from "./api";

// 定期実行のカスタマイズ UI(Task 5)。
// - 上段: 実行時刻・頻度(daily/weekly)・有効/無効 → 保存でサーバー側の cron ジョブを張り直す
//   (移植元 Corstack では launchd plist の再生成 + unload→load だった)。
// - 下段: 定期実行するクエリの一覧(追加・編集・削除・enable 切替)。
// CLAUDE.md 原則に従い、View はキャッシュ・楽観的更新を持たず、サーバーが返した「今の値」で置き換える。

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const DEFAULT_CONFIG: ScheduleConfig = { hour: 7, minute: 0, frequency: "daily", enabled: true };

export function ScheduleEditor({ entries, onChanged }: { entries: SiteEntry[]; onChanged?: () => void }) {
  const [queries, setQueries] = useState<ScheduledQuery[]>([]);
  const [config, setConfig] = useState<ScheduleConfig>(DEFAULT_CONFIG);
  const [savingConfig, setSavingConfig] = useState(false);
  const [launchdMsg, setLaunchdMsg] = useState<string | null>(null);
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
      <option value="">サイト指定なし(両方)</option>
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
          {`モデル: ${m.label}`}
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
    setLaunchdMsg(null);
    setErr(null);
    try {
      const { config: saved, launchd } = await updateScheduleConfig(config);
      setConfig(saved);
      onChanged?.();
      setLaunchdMsg(`${launchd.ok ? "反映しました" : "反映に失敗"}: ${launchd.detail}`);
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
          <span>頻度</span>
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
            <option value="daily">毎日</option>
            <option value="weekly">毎週</option>
          </select>
        </label>

        {config.frequency === "weekly" && (
          <label className="ni-sched-field">
            <span>曜日</span>
            <select
              className="ni-select"
              value={config.dayOfWeek ?? 1}
              onChange={(e) => setConfig((c) => ({ ...c, dayOfWeek: Number(e.target.value) }))}
            >
              {WEEKDAYS.map((w, i) => (
                <option key={i} value={i}>
                  {w}曜
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="ni-sched-field">
          <span>時刻</span>
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
          <span>定期実行を有効にする</span>
        </label>

        <button className="ni-btn primary sm" onClick={saveConfig} disabled={savingConfig}>
          {savingConfig ? "反映中…" : "時刻・頻度を保存(cron 反映)"}
        </button>
      </div>
      {launchdMsg && <div className="ni-mono ni-dim ni-launchd-msg">{launchdMsg}</div>}

      {/* クエリ一覧 */}
      <div className="ni-sched-qlist">
        {queries.length === 0 && <div className="ni-dim sm">定期実行するクエリはまだありません。下で追加してください。</div>}
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
                    保存
                  </button>
                  <button className="ni-btn sm" onClick={() => setEditId(null)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <>
                <label className="ni-sched-toggle" title={q.enabled ? "有効" : "無効"}>
                  <input type="checkbox" checked={q.enabled} onChange={() => onToggle(q)} />
                </label>
                <div className="ni-sched-qbody">
                  <div className="ni-sched-qtext">{q.query}</div>
                  <div className="ni-mono ni-dim sm">
                    {q.site ? `site=${q.site}` : "site=未指定(両方)"} ・ {q.model ? `model=${q.model}` : "model=(旧・未指定)"}
                  </div>
                </div>
                <div className="ni-sched-qactions">
                  <button className="ni-btn sm" onClick={() => startEdit(q)}>
                    編集
                  </button>
                  <button className="ni-btn sm" onClick={() => onDelete(q)} title="削除">
                    削除
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
          placeholder="定期実行するクエリを追加(例: 全サイトの健全性を確認して)"
          value={newQuery}
          onChange={(e) => setNewQuery(e.target.value)}
        />
        <div className="ni-form-row">
          {siteSelect(newSite, setNewSite)}
          {modelSelect(newModel, setNewModel)}
          <button className="ni-btn sm" onClick={onAdd} disabled={!newQuery.trim()}>
            クエリを追加
          </button>
        </div>
      </div>
    </div>
  );
}
