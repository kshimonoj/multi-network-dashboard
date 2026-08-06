// タグ付き Client — 詳細ビュー(58 §2-2 の分離設計)。
//
// ClientDetailPanel は platform で分岐するだけの薄いディスパッチャで、
// CentralClientDetailView / MistClientDetailView は**互いの型を一切知らない**。
// 共有するのは primitives.tsx の見た目部品だけ。
//
// 両方から返った場合はカードを縦に 2 枚並べる(1 枚にマージしない。58 §2-6)。
// アプリ名の体系もチャネル表記も品質指標の単位も違うため、混ぜると誤読を招く。

import { formatDateTime, useT, type TFunc } from "../../../src/i18n";
import {
  ChipList,
  FieldRow,
  MacText,
  NotSupported,
  PlatformBadge,
  SectionCard,
  SignalBadge,
  formatBps,
  formatBytes,
} from "./primitives";
import { centralLastSeen, formatUptime, meaningful, mloValue } from "./format";
import type {
  CentralClientDetail,
  ClientDetail,
  EventRow,
  MistClientDetail,
  Section,
} from "./types";

export function ClientDetailPanel({ detail }: { detail: ClientDetail }) {
  switch (detail.platform) {
    case "central":
      return <CentralClientDetailView d={detail} />;
    case "mist":
      return <MistClientDetailView d={detail} />;
  }
}

// ---------------------------------------------------------------- Central

function CentralClientDetailView({ d }: { d: CentralClientDetail }) {
  const t = useT();
  const wireless = d.connectionType === "Wireless";
  const isRandomMac = d.clientManufacturer === "Private";
  const lastSeen = centralLastSeen(d.lastSeenAtRaw);

  // name / hostname / mac が同値の端末が多数(58 §2-4)。同じなら 1 つに畳む。
  const isMacText = (v: string | null) =>
    Boolean(v) && (v ?? "").toLowerCase().replace(/[^0-9a-f]/g, "") === d.mac;
  const nameIsMac = isMacText(d.clientName) && isMacText(d.hostName);
  const title = !isMacText(d.clientName)
    ? d.clientName
    : !isMacText(d.hostName)
      ? d.hostName
      : null;

  return (
    <div className="tt-detail tt-detail-central">
      <div className="tt-detail-head">
        <PlatformBadge platform="central" />
        {title && <span className="tt-detail-title">{title}</span>}
        <MacText value={d.mac} />
        {isRandomMac && (
          <span className="tt-random-badge" title={t("taggedTargets.randomMac.tooltipCentral")}>
            {t("taggedTargets.randomMac.badge")}
          </span>
        )}
      </div>

      <SectionCard title={t("taggedTargets.client.section.basic")}>
        {!nameIsMac && (
          <>
            <FieldRow label={t("taggedTargets.field.clientName")} value={d.clientName} />
            <FieldRow label={t("taggedTargets.field.hostName")} value={d.hostName} />
          </>
        )}
        <FieldRow label={t("taggedTargets.field.mac")} value={<MacText value={d.mac} />} />
        <FieldRow label={t("taggedTargets.field.ipv4")} value={d.ipv4} />
        <FieldRow label={t("taggedTargets.field.ipv6")} value={d.ipv6} />
        <FieldRow
          label={t("taggedTargets.field.connectionType")}
          value={d.connectionType ? t(`taggedTargets.connectionType.${wireless ? "wireless" : "wired"}`) : null}
        />
        <FieldRow label={t("taggedTargets.field.status")} value={d.status} />
        <FieldRow label={t("taggedTargets.field.category")} value={d.clientCategory} />
        <FieldRow label={t("taggedTargets.field.function")} value={d.clientFunction} />
        <FieldRow label={t("taggedTargets.field.os")} value={d.clientOperatingSystem} />
        <FieldRow label={t("taggedTargets.field.vendor")} value={d.clientVendor} />
        <FieldRow label={t("taggedTargets.field.manufacturer")} value={d.clientManufacturer} />
        <FieldRow label={t("taggedTargets.field.siteName")} value={d.siteName} />
        {/* Central 自身の ML 分類。**本アプリのタグとは別物**なので名前を必ず分ける(58 §1-8-3) */}
        {d.centralTags.length > 0 && (
          <FieldRow
            label={t("taggedTargets.field.centralClassification")}
            value={<ChipList items={d.centralTags} />}
            mono={false}
          />
        )}
      </SectionCard>

      <SectionCard title={t("taggedTargets.client.section.connection")}>
        <FieldRow label={t("taggedTargets.field.connectedTo")} value={d.connectedTo} />
        <FieldRow label={t("taggedTargets.field.connectedDeviceType")} value={d.connectedDeviceType} />
        <FieldRow label={t("taggedTargets.field.connectedDeviceSerial")} value={d.connectedDeviceSerial} />
        {!wireless && <FieldRow label={t("taggedTargets.field.port")} value={d.port} />}
        {wireless && <FieldRow label={t("taggedTargets.field.bssid")} value={d.bssid} />}
        {wireless && <FieldRow label={t("taggedTargets.field.radioMac")} value={d.radioMacAddress} />}
        <FieldRow
          label={t("taggedTargets.field.connectedAt")}
          value={d.connectedAt ? formatDateTime(d.connectedAt) : null}
        />
        {/* lastSeenAt は接続中だと文字列 "0"。日時にせず status と統合する(58 §1-8-1 / §4 #5) */}
        <FieldRow
          label={t("taggedTargets.field.lastSeen")}
          value={
            lastSeen.mode === "connected"
              ? t("taggedTargets.presence.connected")
              : lastSeen.mode === "at"
                ? formatDateTime(lastSeen.iso)
                : null
          }
        />
      </SectionCard>

      {wireless && (
        <SectionCard
          title={t("taggedTargets.client.section.wireless")}
          note={t("taggedTargets.central.snrOnlyNote")}
        >
          {/* Central は SNR のみ。**RSSI の欄そのものを作らない**(58 §2-4) */}
          <FieldRow
            label={t("taggedTargets.field.snr")}
            value={d.snr !== null ? <SignalBadge kind="snr" value={d.snr} /> : null}
            mono={false}
          />
          <FieldRow label={t("taggedTargets.field.band")} value={d.wirelessBand} />
          {/* 帯域幅込みの文字列("48E (80 MHz)")。パースしない(58 §1-8-5) */}
          <FieldRow label={t("taggedTargets.field.channel")} value={d.wirelessChannel} />
          <FieldRow label={t("taggedTargets.field.phyType")} value={d.phyType} />
          <FieldRow label={t("taggedTargets.field.mloOperMode")} value={mloValue(d.mloOperMode)} />
          <FieldRow label={t("taggedTargets.field.ssid")} value={d.wlanName} />
          <FieldRow label={t("taggedTargets.field.wirelessSecurity")} value={d.wirelessSecurity} />
          <FieldRow label={t("taggedTargets.field.keyManagement")} value={d.keyManagement} />
          {/* 802.11k/r/v の対応可否は Mist に無い Central の強み(58 §2-4) */}
          <FieldRow
            label={t("taggedTargets.field.capabilities")}
            value={<ChipList items={d.capabilities} />}
            mono={false}
          />
        </SectionCard>
      )}

      <SectionCard title={t("taggedTargets.client.section.network")}>
        <FieldRow label={t("taggedTargets.field.vlanId")} value={d.vlanId} />
        <FieldRow label={t("taggedTargets.field.vlanName")} value={d.vlanName} />
        <FieldRow label={t("taggedTargets.field.role")} value={d.role} />
        <FieldRow label={t("taggedTargets.field.tunnelType")} value={meaningful(d.tunnelType)} />
        <FieldRow label={t("taggedTargets.field.tunnelId")} value={d.tunnelId} />
        <FieldRow label={t("taggedTargets.field.userName")} value={d.userName} />
        {/* 認証方式が空のときは key_management で補う(58 §1-8-2) */}
        <FieldRow
          label={t("taggedTargets.field.authentication")}
          value={d.authenticationType ?? d.keyManagement}
        />
      </SectionCard>

      <SectionCard title={t("taggedTargets.client.section.quality")}>
        {/* Central に無いもの。空欄で黙らせず、理由を出す(58 §2-3 / §2-4) */}
        <NotSupported reason={t("taggedTargets.central.noRssi")} />
        <NotSupported reason={t("taggedTargets.central.noThroughput")} />
        <NotSupported reason={t("taggedTargets.central.noTimeSeries")} />
      </SectionCard>

      <SectionCard title={t("taggedTargets.client.section.apps")}>
        <NotSupported
          reason={
            wireless ? t("taggedTargets.central.appsDpiOnly") : t("taggedTargets.central.appsWiredNo")
          }
        />
      </SectionCard>

      <EventSection t={t} section={d.events} />
    </div>
  );
}

// ------------------------------------------------------------------- Mist

function MistClientDetailView({ d }: { d: MistClientDetail }) {
  const t = useT();
  const wireless = d.connectionType === "wireless";

  return (
    <div className="tt-detail tt-detail-mist">
      <div className="tt-detail-head">
        <PlatformBadge platform="mist" />
        {d.hostname && <span className="tt-detail-title">{d.hostname}</span>}
        <MacText value={d.mac} />
        {d.randomMac === true && (
          <span className="tt-random-badge" title={t("taggedTargets.randomMac.tooltipMist")}>
            {t("taggedTargets.randomMac.badge")}
          </span>
        )}
        {!d.connected && wireless && (
          <span className="go-tag go-tag-dim">{t("taggedTargets.presence.notConnected")}</span>
        )}
      </div>

      <SectionCard title={t("taggedTargets.client.section.basic")}>
        <FieldRow label={t("taggedTargets.field.hostName")} value={d.hostname} />
        <FieldRow label={t("taggedTargets.field.mac")} value={<MacText value={d.mac} />} />
        <FieldRow label={t("taggedTargets.field.ipv4")} value={d.ip} />
        <FieldRow
          label={t("taggedTargets.field.connectionType")}
          value={t(`taggedTargets.connectionType.${wireless ? "wireless" : "wired"}`)}
        />
        <FieldRow label={t("taggedTargets.field.manufacturer")} value={d.manufacture} />
        <FieldRow label={t("taggedTargets.field.model")} value={d.model} />
        <FieldRow
          label={t("taggedTargets.field.os")}
          value={[d.os, d.osVersion].filter(Boolean).join(" ") || null}
        />
        <FieldRow label={t("taggedTargets.field.family")} value={d.family} />
        {/* Central に無い Mist 固有の 2 項目(58 §2-5) */}
        <FieldRow
          label={t("taggedTargets.field.randomMac")}
          value={d.randomMac === null ? null : t(`taggedTargets.bool.${d.randomMac ? "yes" : "no"}`)}
        />
        <FieldRow
          label={t("taggedTargets.field.isGuest")}
          value={d.isGuest === null ? null : t(`taggedTargets.bool.${d.isGuest ? "yes" : "no"}`)}
        />
        {/* 補助キー。**タグのキーにはしない**(未認証・PSK 共有で一意にならない。57 §3-5) */}
        <FieldRow label={t("taggedTargets.field.userName")} value={d.username} />
        <FieldRow label={t("taggedTargets.field.pskName")} value={d.pskName} />
        <FieldRow label={t("taggedTargets.field.siteName")} value={d.siteName} />
      </SectionCard>

      <SectionCard title={t("taggedTargets.client.section.connection")}>
        {wireless ? (
          <>
            <FieldRow
              label={t("taggedTargets.field.connectedTo")}
              value={d.apName ?? (d.apMac ? <MacText value={d.apMac} /> : null)}
              mono={!d.apName}
            />
            <FieldRow label={t("taggedTargets.field.bssid")} value={d.bssid} />
            <FieldRow label={t("taggedTargets.field.ssid")} value={d.ssid} />
            <FieldRow label={t("taggedTargets.field.wlanId")} value={d.wlanId} />
            <FieldRow label={t("taggedTargets.field.vlanId")} value={d.vlanId} />
            <FieldRow label={t("taggedTargets.field.band")} value={d.band ? `${d.band} GHz` : null} />
            {/* Mist のチャネルは数値・帯域は別項目(Central と形が違う。58 §2-5) */}
            <FieldRow label={t("taggedTargets.field.channel")} value={d.channel} />
            <FieldRow label={t("taggedTargets.field.proto")} value={d.proto} />
            {/* 57 §2-5 は「Mist の鍵管理は WLAN 設定を別途引く必要がある」としていたが、
                59 の実測で stats/clients に key_mgmt があることを確認したので出せる */}
            <FieldRow label={t("taggedTargets.field.keyManagement")} value={d.keyMgmt} />
            <FieldRow label={t("taggedTargets.field.uptime")} value={formatUptime(d.uptimeSec)} />
            <FieldRow label={t("taggedTargets.field.idleTime")} value={formatUptime(d.idleTimeSec)} />
          </>
        ) : (
          <>
            <FieldRow
              label={t("taggedTargets.field.connectedSwitch")}
              value={d.deviceMac ? <MacText value={d.deviceMac} /> : null}
              mono={false}
            />
            <FieldRow label={t("taggedTargets.field.port")} value={d.portId} />
            <FieldRow label={t("taggedTargets.field.vlanId")} value={d.vlanId} />
            <FieldRow label={t("taggedTargets.field.vlanName")} value={d.vlanName} />
            <FieldRow label={t("taggedTargets.field.authMethod")} value={d.authMethod} />
            <FieldRow label={t("taggedTargets.field.authState")} value={d.authState} />
          </>
        )}
        <FieldRow
          label={t("taggedTargets.field.lastSeen")}
          value={d.lastSeen ? formatDateTime(d.lastSeen) : null}
        />
      </SectionCard>

      <SectionCard title={t("taggedTargets.client.section.quality")}>
        {wireless ? (
          d.connected ? (
            <>
              {/* Central と違い RSSI がある(58 §2-5)。単位が違うので閾値表も別 */}
              <FieldRow
                label={t("taggedTargets.field.rssi")}
                value={d.rssi !== null ? <SignalBadge kind="rssi" value={d.rssi} /> : null}
                mono={false}
              />
              <FieldRow
                label={t("taggedTargets.field.snr")}
                value={d.snr !== null ? <SignalBadge kind="snr" value={d.snr} /> : null}
                mono={false}
              />
              <FieldRow
                label={t("taggedTargets.field.throughput")}
                value={
                  d.txBps === null && d.rxBps === null
                    ? null
                    : `${t("taggedTargets.field.tx")} ${formatBps(d.txBps)} / ${t("taggedTargets.field.rx")} ${formatBps(d.rxBps)}`
                }
              />
              <FieldRow
                label={t("taggedTargets.field.bytes")}
                value={
                  d.txBytes === null && d.rxBytes === null
                    ? null
                    : `${t("taggedTargets.field.tx")} ${formatBytes(d.txBytes, t)} / ${t("taggedTargets.field.rx")} ${formatBytes(d.rxBytes, t)}`
                }
              />
              <FieldRow
                label={t("taggedTargets.field.retries")}
                value={
                  d.txRetries === null && d.rxRetries === null
                    ? null
                    : `${t("taggedTargets.field.tx")} ${d.txRetries ?? "—"} / ${t("taggedTargets.field.rx")} ${d.rxRetries ?? "—"}`
                }
              />
            </>
          ) : (
            <div className="go-note">{t("taggedTargets.mist.qualityNeedsConnection")}</div>
          )
        ) : (
          // 有線クライアントは wired_clients に品質値が無い(57 §1-8)
          <NotSupported reason={t("taggedTargets.mist.wiredNoQuality")} />
        )}
      </SectionCard>

      <SectionCard
        title={t("taggedTargets.client.section.apps")}
        note={d.apps.status === "ok" ? d.apps.note : null}
      >
        <AppsSection t={t} section={d.apps} />
      </SectionCard>

      <EventSection t={t} section={d.events} />
    </div>
  );
}

// ---------------------------------------------------------------- 共通枠

function AppsSection({ t, section }: { t: TFunc; section: Section<import("./types").AppUsageRow> }) {
  if (section.status === "unsupported") {
    return <NotSupported reason={t("taggedTargets.mist.wiredNoApps")} />;
  }
  if (section.status === "error") {
    return <div className="go-inline-error">{section.error}</div>;
  }
  if (section.items.length === 0) {
    return <div className="go-note">{t("taggedTargets.apps.empty")}</div>;
  }
  const max = Math.max(...section.items.map((a) => a.totalBytes ?? 0), 1);
  return (
    <table className="go-table tt-table">
      <thead>
        <tr>
          <th>{t("taggedTargets.apps.app")}</th>
          <th>{t("taggedTargets.apps.total")}</th>
          <th>{t("taggedTargets.field.rx")}</th>
          <th>{t("taggedTargets.field.tx")}</th>
        </tr>
      </thead>
      <tbody>
        {section.items.map((a) => {
          // "Unknown" は分類できなかった暗号化トラフィック。誠実に別扱いにする(57 §1-5)
          const unknown = a.app === "Unknown";
          return (
            <tr key={a.app} className={unknown ? "tt-app-unknown" : undefined}>
              <td>
                {unknown ? t("taggedTargets.apps.unknown") : a.app}
                <span
                  className="tt-app-bar"
                  style={{ width: `${Math.round(((a.totalBytes ?? 0) / max) * 100)}%` }}
                />
              </td>
              <td>{formatBytes(a.totalBytes, t)}</td>
              <td>{formatBytes(a.rxBytes, t)}</td>
              <td>{formatBytes(a.txBytes, t)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function EventSection({ t, section }: { t: TFunc; section: Section<EventRow> }) {
  if (section.status === "unsupported") return null;
  return (
    <SectionCard title={t("taggedTargets.client.section.events")} note={section.note ?? null}>
      {section.status === "error" ? (
        <div className="go-inline-error">{section.error}</div>
      ) : section.items.length === 0 ? (
        <div className="go-note">{t("taggedTargets.events.empty")}</div>
      ) : (
        <table className="go-table tt-table">
          <thead>
            <tr>
              <th>{t("taggedTargets.events.time")}</th>
              <th>{t("taggedTargets.events.type")}</th>
              <th>{t("taggedTargets.events.text")}</th>
            </tr>
          </thead>
          <tbody>
            {section.items.map((e, i) => (
              <tr key={`${e.timestamp}-${i}`}>
                <td>{formatDateTime(e.timestamp)}</td>
                <td>{e.type ?? "—"}</td>
                <td className="tt-event-text">{e.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}
