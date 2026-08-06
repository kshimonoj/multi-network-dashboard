// タグ付き Device — 詳細ビュー。Client と同じく Central 用 / Mist 用を完全に分ける。
//
// 既存タブとの重複整理(57 §2-4):
//   - Global Overview はサイト単位のサマリしか持たないので、個体の CPU/RF/ポートは新規。
//   - ベストプラクティス診断は「設定がどうなっているか」、こちらは「今どう動いているか」で
//     目的が違う。ただし取得の土台(トークン・レート制御)は Global Overview の
//     CentralClient / MistClient をそのまま共有している(plugins/tagged-targets/*-fetch.ts)。

import { formatDateTime, formatNumber, useT, type TFunc } from "../../../src/i18n";
import {
  FieldRow,
  MacText,
  NotSupported,
  PlatformBadge,
  SectionCard,
  formatBytes,
} from "./primitives";
import { formatLinkSpeed, formatUptime, formatUptimeMs, meaningful, statusKind } from "./format";
import type {
  CentralDeviceDetail,
  DeviceDetail,
  MistDeviceDetail,
  Section,
} from "./types";

export function DeviceDetailPanel({ detail }: { detail: DeviceDetail }) {
  switch (detail.platform) {
    case "central":
      return <CentralDeviceDetailView d={detail} />;
    case "mist":
      return <MistDeviceDetailView d={detail} />;
  }
}

function pct(v: number | null): string | null {
  return v === null ? null : `${v}%`;
}

function StatusTag({ value }: { value: string | null }) {
  const kind = statusKind(value);
  if (!value) return null;
  return <span className={`go-tag go-tag-${kind === "up" ? "ok" : kind === "down" ? "bad" : "dim"}`}>{value}</span>;
}

// ---------------------------------------------------------------- Central

function CentralDeviceDetailView({ d }: { d: CentralDeviceDetail }) {
  const t = useT();

  return (
    <div className="tt-detail tt-detail-central">
      <div className="tt-detail-head">
        <PlatformBadge platform="central" />
        <span className="tt-detail-title">{d.deviceName ?? d.serialNumber}</span>
        <span className="go-mono">{d.serialNumber}</span>
        <span className="go-tag">{t(`taggedTargets.deviceKind.${d.kind}`)}</span>
        <StatusTag value={d.status} />
      </div>

      <SectionCard title={t("taggedTargets.device.section.basic")}>
        <FieldRow label={t("taggedTargets.field.deviceName")} value={d.deviceName} />
        <FieldRow label={t("taggedTargets.field.serial")} value={d.serialNumber} />
        <FieldRow
          label={t("taggedTargets.field.mac")}
          value={d.macAddress ? <MacText value={d.macAddress} /> : null}
          mono={false}
        />
        <FieldRow label={t("taggedTargets.field.model")} value={d.model} />
        <FieldRow label={t("taggedTargets.field.firmware")} value={d.firmwareVersion} />
        <FieldRow label={t("taggedTargets.field.ipv4")} value={d.ipv4} />
        <FieldRow label={t("taggedTargets.field.publicIp")} value={d.publicIpv4} />
        <FieldRow label={t("taggedTargets.field.siteName")} value={d.siteName} />
        <FieldRow label={t("taggedTargets.field.countryCode")} value={d.countryCode} />
      </SectionCard>

      <SectionCard title={t("taggedTargets.device.section.health")}>
        <FieldRow label={t("taggedTargets.field.cpu")} value={pct(d.cpuUtilization)} />
        <FieldRow label={t("taggedTargets.field.memory")} value={pct(d.memoryUtilization)} />
        <FieldRow label={t("taggedTargets.field.uptime")} value={formatUptimeMs(d.uptimeMs)} />
        <FieldRow
          label={t("taggedTargets.field.clientCount")}
          value={d.clientCount === null ? null : formatNumber(d.clientCount)}
        />
        <FieldRow label={t("taggedTargets.field.lastRebootReason")} value={meaningful(d.lastRebootReason)} />
        <FieldRow label={t("taggedTargets.field.negotiatedPower")} value={d.negotiatedPower} />
        <FieldRow label={t("taggedTargets.field.mode")} value={meaningful(d.mode)} />
        <FieldRow label={t("taggedTargets.field.meshRole")} value={d.meshRole} />
        <FieldRow label={t("taggedTargets.field.bandSelection")} value={d.bandSelection} />
        <FieldRow label={t("taggedTargets.field.uplinkInUse")} value={meaningful(d.currentUplinkInUse)} />
        <FieldRow
          label={t("taggedTargets.field.temperature")}
          value={d.systemTemperature === null ? null : `${d.systemTemperature} °C`}
        />
        <FieldRow
          label={t("taggedTargets.field.poe")}
          value={
            d.poeConsumption === null && d.poeAvailable === null
              ? null
              : `${d.poeConsumption ?? "—"} / ${d.poeAvailable ?? "—"} W`
          }
        />
        {d.hardwareHealth.map((h) => (
          <FieldRow key={h.label} label={t(`taggedTargets.hardware.${h.label}`)} value={h.value} />
        ))}
        {/* Central に無く Mist にはあるもの(57 §2-3)。空欄にせず理由を書く */}
        {d.kind === "ap" && <NotSupported reason={t("taggedTargets.central.noCertExpiry")} />}
      </SectionCard>

      {d.radios.status !== "unsupported" && (
        <SectionCard title={t("taggedTargets.device.section.radios")}>
          <TableSection
            section={d.radios}
            emptyText={t("taggedTargets.radios.empty")}
            head={[
              t("taggedTargets.field.band"),
              t("taggedTargets.field.channel"),
              t("taggedTargets.field.bandwidth"),
              t("taggedTargets.field.power"),
              t("taggedTargets.field.clientCount"),
              t("taggedTargets.field.channelUtil"),
              t("taggedTargets.field.channelQuality"),
              t("taggedTargets.field.noiseFloor"),
              t("taggedTargets.field.nonWifi"),
              t("taggedTargets.field.status"),
            ]}
            row={(r, i) => (
              <tr key={`${r.band}-${i}`}>
                <td>{r.band ?? "—"}</td>
                <td>{r.channel ?? "—"}</td>
                <td>{r.bandwidth ?? "—"}</td>
                <td>{r.power ?? "—"}</td>
                <td>{r.clientCount ?? "—"}</td>
                <td>{r.channelUtilization === null ? "—" : `${r.channelUtilization}%`}</td>
                <td>{r.channelQuality ?? "—"}</td>
                <td>{r.noiseFloor === null ? "—" : `${r.noiseFloor} dBm`}</td>
                <td>{r.nonWifiInterference === null ? "—" : `${r.nonWifiInterference}%`}</td>
                <td>{r.status ?? "—"}</td>
              </tr>
            )}
          />
        </SectionCard>
      )}

      {d.ports.status !== "unsupported" && (
        <SectionCard title={t("taggedTargets.device.section.ports")}>
          <TableSection
            section={d.ports}
            emptyText={t("taggedTargets.ports.empty")}
            head={[
              t("taggedTargets.field.portName"),
              t("taggedTargets.field.status"),
              t("taggedTargets.field.speed"),
              t("taggedTargets.field.duplex"),
              t("taggedTargets.field.connector"),
              t("taggedTargets.field.vlanMode"),
              t("taggedTargets.field.nativeVlan"),
              t("taggedTargets.field.poeStatus"),
              t("taggedTargets.field.neighbour"),
            ]}
            row={(p, i) => (
              <tr key={`${p.name}-${i}`}>
                <td>
                  {p.name ?? "—"}
                  {p.isUplink && <span className="go-tag go-tag-dim">{t("taggedTargets.field.uplink")}</span>}
                </td>
                <td className={statusKind(p.status) === "down" ? "go-down" : undefined}>{p.status ?? "—"}</td>
                <td>{formatLinkSpeed(p.speedMbps) ?? "—"}</td>
                <td>{meaningful(p.duplex) ?? "—"}</td>
                <td>{p.connector ?? "—"}</td>
                <td>{p.vlanMode ?? "—"}</td>
                <td>{p.nativeVlan ?? "—"}</td>
                <td>{p.poeStatus ?? "—"}</td>
                <td>{p.neighbour ?? "—"}</td>
              </tr>
            )}
          />
        </SectionCard>
      )}

      {d.wlans.status !== "unsupported" && (
        <SectionCard title={t("taggedTargets.device.section.wlans")}>
          <TableSection
            section={d.wlans}
            emptyText={t("taggedTargets.wlans.empty")}
            head={[
              t("taggedTargets.field.ssid"),
              t("taggedTargets.field.wirelessSecurity"),
              t("taggedTargets.field.securityLevel"),
              t("taggedTargets.field.band"),
              t("taggedTargets.field.vlanId"),
              t("taggedTargets.field.status"),
            ]}
            row={(w, i) => (
              <tr key={`${w.wlanName}-${i}`}>
                <td>{w.wlanName ?? "—"}</td>
                <td>{w.security ?? "—"}</td>
                <td>{w.securityLevel ?? "—"}</td>
                <td>{w.band ?? "—"}</td>
                <td>{w.vlan ?? "—"}</td>
                <td>{w.status ?? "—"}</td>
              </tr>
            )}
          />
        </SectionCard>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- Mist

function MistDeviceDetailView({ d }: { d: MistDeviceDetail }) {
  const t = useT();

  return (
    <div className="tt-detail tt-detail-mist">
      <div className="tt-detail-head">
        <PlatformBadge platform="mist" />
        <span className="tt-detail-title">{d.name ?? d.mac}</span>
        <MacText value={d.mac} />
        <span className="go-tag">{t(`taggedTargets.deviceKind.${d.kind}`)}</span>
        <StatusTag value={d.status} />
      </div>

      <SectionCard title={t("taggedTargets.device.section.basic")}>
        <FieldRow label={t("taggedTargets.field.deviceName")} value={d.name} />
        <FieldRow label={t("taggedTargets.field.mac")} value={<MacText value={d.mac} />} mono={false} />
        <FieldRow label={t("taggedTargets.field.serial")} value={d.serial} />
        <FieldRow label={t("taggedTargets.field.model")} value={d.model} />
        <FieldRow label={t("taggedTargets.field.hwRev")} value={d.hwRev} />
        <FieldRow label={t("taggedTargets.field.firmware")} value={d.version} />
        <FieldRow label={t("taggedTargets.field.ipv4")} value={d.ip} />
        <FieldRow label={t("taggedTargets.field.publicIp")} value={d.extIp} />
        <FieldRow label={t("taggedTargets.field.siteName")} value={d.siteName} />
      </SectionCard>

      <SectionCard title={t("taggedTargets.device.section.health")}>
        <FieldRow label={t("taggedTargets.field.cpu")} value={pct(d.cpuUtil)} />
        <FieldRow
          label={t("taggedTargets.field.memory")}
          value={
            d.memUsedPct === null
              ? null
              : d.memTotalKb && d.memUsedKb !== null
                ? `${d.memUsedPct}% (${formatBytes(d.memUsedKb * 1024, t)} / ${formatBytes(d.memTotalKb * 1024, t)})`
                : `${d.memUsedPct}%`
          }
        />
        <FieldRow label={t("taggedTargets.field.uptime")} value={formatUptime(d.uptimeSec)} />
        <FieldRow
          label={t("taggedTargets.field.lastSeen")}
          value={d.lastSeen ? formatDateTime(d.lastSeen) : null}
        />
        <FieldRow
          label={t("taggedTargets.field.clientCount")}
          value={d.numClients === null ? null : formatNumber(d.numClients)}
        />
        <FieldRow label={t("taggedTargets.field.numWlans")} value={d.numWlans} />
        {/* Central に無い Mist 固有の項目(57 §2-3) */}
        <FieldRow
          label={t("taggedTargets.field.certExpiry")}
          value={d.certExpiry ? formatDateTime(d.certExpiry) : null}
        />
        <FieldRow
          label={t("taggedTargets.field.ambientTemp")}
          value={d.ambientTemp === null ? null : `${d.ambientTemp} °C`}
        />
        <FieldRow
          label={t("taggedTargets.field.cpuTemp")}
          value={d.cpuTemp === null ? null : `${d.cpuTemp} °C`}
        />
        <FieldRow
          label={t("taggedTargets.field.humidity")}
          value={d.humidity === null ? null : `${d.humidity}%`}
        />
        <FieldRow label={t("taggedTargets.field.lastTrouble")} value={d.lastTroubleCode} />
        <FieldRow
          label={t("taggedTargets.field.lastTroubleAt")}
          value={d.lastTroubleAt ? formatDateTime(d.lastTroubleAt) : null}
        />
        <FieldRow
          label={t("taggedTargets.field.macTable")}
          value={
            d.macTableCount === null ? null : `${formatNumber(d.macTableCount)} / ${d.macTableMax === null ? "—" : formatNumber(d.macTableMax)}`
          }
        />
      </SectionCard>

      {d.kind === "ap" && (
        <SectionCard title={t("taggedTargets.device.section.uplink")}>
          {/* AP から上流スイッチ名・ポートまで直接分かるのは Mist の強み(57 §2-3) */}
          <FieldRow label={t("taggedTargets.field.lldpSystemName")} value={d.lldpSystemName} />
          <FieldRow label={t("taggedTargets.field.lldpPortId")} value={d.lldpPortId} />
          <FieldRow label={t("taggedTargets.field.lldpChassisId")} value={d.lldpChassisId} />
          <FieldRow label={t("taggedTargets.field.lldpSystemDesc")} value={d.lldpSystemDesc} mono={false} />
          <FieldRow label={t("taggedTargets.field.powerSrc")} value={d.powerSrc} />
          <FieldRow
            label={t("taggedTargets.field.powerDraw")}
            value={
              d.powerDraw === null && d.powerAllocated === null
                ? null
                : `${d.powerDraw ?? "—"} / ${d.powerAllocated ?? "—"} W`
            }
          />
          <FieldRow
            label={t("taggedTargets.field.powerConstrained")}
            value={
              d.powerConstrained === null
                ? null
                : t(`taggedTargets.bool.${d.powerConstrained ? "yes" : "no"}`)
            }
          />
        </SectionCard>
      )}

      {d.radios.status !== "unsupported" && (
        <SectionCard title={t("taggedTargets.device.section.radios")} note={t("taggedTargets.mist.radioNote")}>
          <TableSection
            section={d.radios}
            emptyText={t("taggedTargets.radios.empty")}
            head={[
              t("taggedTargets.field.band"),
              t("taggedTargets.field.channel"),
              t("taggedTargets.field.bandwidth"),
              t("taggedTargets.field.power"),
              t("taggedTargets.field.clientCount"),
              t("taggedTargets.field.noiseFloor"),
              t("taggedTargets.field.utilAll"),
              t("taggedTargets.field.utilNonWifi"),
              t("taggedTargets.field.utilTx"),
              t("taggedTargets.field.utilRxInBss"),
              t("taggedTargets.field.utilRxOtherBss"),
            ]}
            row={(r) => (
              <tr key={r.band}>
                <td>{r.band} GHz</td>
                <td>{r.channel ?? "—"}</td>
                <td>{r.bandwidth === null ? "—" : `${r.bandwidth} MHz`}</td>
                <td>{r.power === null ? "—" : `${r.power} dBm`}</td>
                <td>{r.numClients ?? "—"}</td>
                <td>{r.noiseFloor === null ? "—" : `${r.noiseFloor} dBm`}</td>
                <td>{r.utilAll === null ? "—" : `${r.utilAll}%`}</td>
                <td>{r.utilNonWifi === null ? "—" : `${r.utilNonWifi}%`}</td>
                <td>{r.utilTx === null ? "—" : `${r.utilTx}%`}</td>
                <td>{r.utilRxInBss === null ? "—" : `${r.utilRxInBss}%`}</td>
                <td>{r.utilRxOtherBss === null ? "—" : `${r.utilRxOtherBss}%`}</td>
              </tr>
            )}
          />
        </SectionCard>
      )}

      <SectionCard title={t("taggedTargets.device.section.ports")}>
        <TableSection
          section={d.ports}
          emptyText={t("taggedTargets.ports.empty")}
          head={[
            t("taggedTargets.field.portName"),
            t("taggedTargets.field.status"),
            t("taggedTargets.field.speed"),
            t("taggedTargets.field.duplex"),
            t("taggedTargets.field.rx"),
            t("taggedTargets.field.tx"),
            t("taggedTargets.field.rxErrors"),
            t("taggedTargets.field.portUsage"),
          ]}
          row={(p) => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td className={p.up === false ? "go-down" : p.up ? "go-up" : undefined}>
                {p.up === null ? "—" : t(`taggedTargets.portState.${p.up ? "up" : "down"}`)}
              </td>
              <td>{formatLinkSpeed(p.speed) ?? "—"}</td>
              <td>
                {p.fullDuplex === null ? "—" : t(`taggedTargets.duplex.${p.fullDuplex ? "full" : "half"}`)}
              </td>
              <td>{formatBytes(p.rxBytes, t)}</td>
              <td>{formatBytes(p.txBytes, t)}</td>
              <td>{p.rxErrors ?? "—"}</td>
              <td>{p.portUsage ?? "—"}</td>
            </tr>
          )}
        />
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------- 共通枠

function TableSection<T>({
  section,
  head,
  row,
  emptyText,
}: {
  section: Section<T>;
  head: string[];
  row: (item: T, index: number) => JSX.Element;
  emptyText: string;
}) {
  if (section.status === "error") return <div className="go-inline-error">{section.error}</div>;
  if (section.items.length === 0) return <div className="go-note">{emptyText}</div>;
  return (
    <div className="go-table-scroll">
      <table className="go-table tt-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{section.items.map(row)}</tbody>
      </table>
    </div>
  );
}
