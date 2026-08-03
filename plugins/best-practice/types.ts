/**
 * ベストプラクティス診断の共通型。
 * 設計は instructions/49_findings.md §3-2、PMF の確定内容は 50_findings.md を参照。
 *
 * 重要(49 §1-5(a)): running-config の生テキストは保存しない。
 * ここで定義する構造体に鍵・パスフレーズ・ハッシュ・RADIUS シークレットを入れないこと。
 * 収集フェーズは「パース → この構造体 → 生テキスト破棄」の順で動く(collect-central.ts)。
 */

// ── 拡張ポイント: カテゴリはここに足す ──────────────────────
export type CheckCategory = "security" | "rf";
// 将来: | "firmware" | "redundancy" | "monitoring" | "wired"

export type CheckPlatform = "central" | "mist" | "both";

/** 判定の粒度。UI のグルーピングにも使う */
export type CheckTarget = "org" | "site" | "group" | "ssid" | "ap" | "radio";

/** 重要度。公式ドキュメントの語調に対応させる */
export type CheckSeverity =
  | "must"        // 規格・規制上そうでなければならない(6GHz の WPA3 必須 等)
  | "strong"      // 強く推奨(WPA3 移行・PMF・WIDS 検知の有効化 等)
  | "recommended" // 推奨(Tx 電力レンジ・基本レート 等)
  | "advisory";   // 注意喚起(誤検知リスク・法務確認要・環境依存)

export type CheckMethod = "mechanical" | "llm";

export interface RuleReference {
  /** 表示用タイトル(原文タイトル。出典は翻訳しない) */
  title: string;
  url: string;
}

/** どの生データから判定材料を取るか。収集フェーズがこれを見てコマンドを決める */
export type RuleSource =
  | { kind: "central-show"; command: string }     // ホワイトリスト固定
  | { kind: "central-mcp"; tool: string }         // central_get_aps 等
  | { kind: "mist-config"; resourceType: string } // wlans / rftemplates
  | { kind: "mist-stats"; statsType: string }     // org_devices 等
  | { kind: "derived" };

export interface BestPracticeRule {
  id: string;                    // "SEC-01" / "RF-05"
  category: CheckCategory;
  platform: CheckPlatform;
  target: CheckTarget;
  severity: CheckSeverity;
  method: CheckMethod;
  /** i18n キー。UI 実装時に ja.json / en.json の両方へ必ず追加する */
  titleKey: string;
  descriptionKey: string;
  references: RuleReference[];
  sources: RuleSource[];
  /** 法務・規制上の確認を促すルール(封じ込め系) */
  requiresLegalReview?: boolean;
  /** 既定で有効か。ノイズの多いルールは false で出荷し、UI で有効化させる */
  enabledByDefault: boolean;
}

export type FindingStatus =
  | "pass"
  | "warn"
  | "fail"
  | "not_applicable" // 例: AOS 10 に ARM ルールを当てた
  | "unknown"        // 例: 設定値を取得できなかった
  | "info";          // LLM 所見。合否を出さない(49 §3-1 の 2)

/**
 * 49 §3-2 の設計に "info" を足してある。
 * 49 の時点では LLM 所見の Finding 表現が決まっておらず、合否を出さない所見を
 * pass/warn/fail のどれにも寄せられなかったため(unknown に混ぜると
 * 「取得できなかった」件数が水増しされる)。

/** observed に入れてよい値。オブジェクト・配列は入れない(文章化・機微混入の防止) */
export type ObservedValue = string | number | boolean | null;

export interface Finding {
  ruleId: string;
  status: FindingStatus;
  platform: "central" | "mist";
  targetType: CheckTarget;
  targetId: string;
  targetLabel: string;
  siteId?: string;
  /** 素材(値)だけ。文章にしない。機微情報は入れない */
  observed: Record<string, ObservedValue>;
  /** 画面側の辞書で文にするためのコードと値 */
  messageCode: string;
  messageParams: Record<string, string | number>;
  collectedAt: string; // ISO8601
  /** 法務・セキュリティ部門の確認を促す所見(封じ込め系。ルール定義から転記) */
  requiresLegalReview?: boolean;
  /** LLM 所見ルールの本文。機械判定ルールでは undefined */
  note?: string;
}

// ── running-config から取り出す SSID プロファイルの正規化形 ──────────

export type OpMode =
  | "opensystem"
  | "enhanced-open"
  | "static-wep"
  | "dynamic-wep"
  | "wpa-tkip"
  | "wpa-psk-tkip"
  | "wpa2-aes"
  | "wpa2-psk-aes"
  | "mpsk-aes"
  | "wpa3-sae-aes"
  | "wpa3-aes-ccm-128"
  | "wpa3-cnsa"
  | "wpa3-aes-gcm-256"
  | (string & {}); // 未知の opmode も落とさず保持する

export type Band = "2.4" | "5" | "6";

/**
 * ssid-profile 1 件の正規化結果。
 * wpa-passphrase / wep-key は **意図的に持たない**(真偽値だけ)。
 */
export interface SsidProfileConfig {
  name: string;
  essid: string | null;
  enabled: boolean;
  /** employee / guest / voice。用途と認証方式の整合(SEC-12)の材料 */
  ssidType: string | null;
  opmode: OpMode | null;
  /** 明示行 `mfp-capable` を検出した */
  mfpCapable: boolean;
  /** 明示行 `mfp-required` を検出した */
  mfpRequired: boolean;
  /** `mbo-enable`(mfp-capable を暗黙で有効化する) */
  mboEnable: boolean;
  /**
   * opmode transition mode。
   * `opmode-transition-disable` があれば false、`opmode-transition` があれば true。
   * どちらも無ければ null = 既定値(有効)。
   */
  opmodeTransition: boolean | null;
  /** 実際に電波を出す帯域 */
  bands: Band[];
  /** 802.11k(RF-09) */
  dot11k: boolean;
  /** 802.11v */
  dot11v: boolean;
  /** OKC / PMK キャッシュ(RF-10) */
  okc: boolean;
  /** broadcast-filter の値(arp / all / none / unset は null)(RF-11) */
  broadcastFilter: string | null;
  /** broadcast-filter-ipv6 unicast-router-advertisements(RF-11) */
  broadcastFilterIpv6Ra: boolean;
  /** 基本レート(Mbps)。行が無ければ null = 既定(RF-08) */
  aBasicRates: number[] | null;
  gBasicRates: number[] | null;
  /** Wi-Fi 7 の明示的な無効化(RF-12) */
  ehtDisable: boolean;
  /** Wi-Fi 6 の明示的な無効化(RF-12) */
  heDisable: boolean;
  /** 認証サーバ名(SEC-12 の材料。鍵は含まない) */
  authServers: string[];
  /** 鍵そのものは保持せず、設定の有無だけを残す */
  hasPassphrase: boolean;
  hasWepKey: boolean;
}

// ── `show radio config` / `show arm config` / `show ids-* config` の正規化形 ──

/**
 * `show radio config` のセクション見出し。
 * AP-325 のように 6GHz 無線を持たない機種でも 6.0 GHz セクションが出力される
 * (= 無線プロファイルの一覧であり、物理無線の一覧ではない)。
 * 実在する無線かどうかは central_get_ap_details の radios[] で突き合わせる。
 */
export type RadioSection = "2.4" | "5" | "5-secondary" | "6" | "6-secondary";

/** Tx 電力の「未設定」を表す番兵。AOS8 の実機で観測(= ARM 任せ) */
export const TX_POWER_UNSET = 127;

export interface RadioProfileConfig {
  section: RadioSection;
  band: Band;
  profileName: string | null;
  /** 127(未設定)は null に落とす */
  maxTxPower: number | null;
  minTxPower: number | null;
  maxChannelBandwidthMhz: number | null;
  minChannelBandwidthMhz: number | null;
  /** `Allowed channels`。AOS8 の `show radio config` には出ない(= null) */
  allowedChannels: string[] | null;
  scanningDisabled: boolean | null;
  aggressiveScan: boolean | null;
  backgroundSpectrumMonitor: boolean | null;
  rogueApAware: boolean | null;
  /** Wi-Fi 6/7 機能。取得できない項目は null */
  heMuOfdma: boolean | null;
  heMuMimo: boolean | null;
  heTxBf: boolean | null;
  ehtMuOfdma: boolean | null;
  ehtMuMimo: boolean | null;
  ehtTxBf: boolean | null;
}

export type IdsLevel = "off" | "low" | "medium" | "high";

export interface IdsDetectionConfig {
  infrastructureLevel: IdsLevel | null;
  clientLevel: IdsLevel | null;
  /** Status 列が enable のポリシー名 */
  enabledInfrastructurePolicies: string[];
  enabledClientPolicies: string[];
}

export interface IdsProtectionConfig {
  /** `none` 以外なら有効(SEC-10) */
  wirelessContainment: string | null;
  wiredContainment: string | null;
  wiredContainmentApAdjacentMac: string | null;
  wiredContainmentSuspectLayer3Rogue: string | null;
  infrastructureLevel: IdsLevel | null;
  clientLevel: IdsLevel | null;
  /** Status 列が enable の保護ポリシー名(SEC-11) */
  enabledPolicies: string[];
}

export interface ArmConfig {
  scanning: boolean | null;
  clientMatch: boolean | null;
  clientAware: boolean | null;
  aggressiveScan: boolean | null;
  bandSteeringMode: string | null;
  minTxPower: number | null;
  maxTxPower: number | null;
  wideChannelBands: string | null;
  support80MHz: boolean | null;
  support160MHz: boolean | null;
  customChannels: boolean | null;
  /** Status が enable のチャネルのみ。`1+` 等の HT40 表記も含む */
  channels24: string[];
  channels5: string[];
}

/** running-config の `ids` セクション(AOS8 は検知レベルもここに出る) */
export interface RunningConfigIds {
  wirelessContainment: string | null;
  infrastructureDetectionLevel: IdsLevel | null;
  clientDetectionLevel: IdsLevel | null;
}

/** running-config の `rf dot11*-radio-profile`(`show radio config` の補助) */
export interface RunningConfigRfProfile {
  section: RadioSection;
  maxTxPower: number | null;
  minTxPower: number | null;
  chBwRangeMin: number | null;
  chBwRangeMax: number | null;
}

// ── 収集結果(サイト単位のスナップショット)─────────────────────

export type Generation = "aos8" | "aos10" | "unknown";

/** ホワイトリストコマンド 1 本の取得結果。理由は必ずコードで持つ */
export type CommandStatus =
  | "ok"
  | "unsupported"   // `% Parse error.` = その世代に無いコマンド
  | "catalog_error" // カタログ検証で弾かれた(49 §1-5(b))
  | "error"
  | "skipped";

export interface CollectionStep {
  key: string;      // "show running-config" / "mist:wlans" 等
  status: CommandStatus;
  /** 失敗時のみ。先頭 N 文字に切る(巨大カタログを保存しない) */
  detail?: string;
  durationMs: number;
}

export interface ApMeta {
  serial: string;
  name: string;
  model: string;
  firmware: string;
  status: string;
  generation: Generation;
}

/** central_get_ap_details の radios[] を正規化したもの(RF-03 / RF-16 の材料) */
export interface ApRadioMeta {
  serial: string;
  apName: string;
  band: Band;
  bandwidthMhz: number | null;
  channel: string | null;
  powerDbm: number | null;
  status: string | null;
}

export interface CentralSiteSnapshot {
  platform: "central";
  siteId: string;
  siteName: string;
  /** 代表 AP。世代が混在するサイトでは世代ごとに 1 台選ぶ */
  representatives: Array<{
    ap: ApMeta;
    ssids: SsidProfileConfig[];
    radioProfiles: RadioProfileConfig[];
    rfProfiles: RunningConfigRfProfile[];
    ids: RunningConfigIds | null;
    idsDetection: IdsDetectionConfig | null;
    idsProtection: IdsProtectionConfig | null;
    arm: ArmConfig | null;
    steps: CollectionStep[];
  }>;
  aps: ApMeta[];
  radios: ApRadioMeta[];
  steps: CollectionStep[];
}

// ── Mist 側の正規化形 ────────────────────────────────────────

export interface MistWlanConfig {
  id: string;
  ssid: string;
  enabled: boolean;
  /** psk / eap / open / wep ... */
  authType: string | null;
  /** ["wpa2-ccmp","wpa3"] 等。行が無ければ null(= Mist 既定に委ねられている) */
  pairwise: string[] | null;
  /** ["24","5","6"] → Band[] に正規化済み */
  bands: Band[];
  scope: "org" | "site";
  templateId: string | null;
  /** 鍵は持たない(Mist MCP 側も伏字だが、こちらでも取り込まない) */
  hasPsk: boolean;
}

export interface MistBandConfig {
  band: Band;
  bandwidthMhz: number | null;
  /** null = 自動(RRM 任せ)。配列 = 静的割当 */
  channels: string[] | null;
  /** null = 自動 */
  power: number | null;
  powerMin: number | null;
  powerMax: number | null;
  disabled: boolean;
}

export interface MistRfTemplate {
  id: string;
  name: string;
  countryCode: string | null;
  bands: MistBandConfig[];
  band24Usage: string | null;
  /** model_specific に上書きがあるか(RF-03 の一様性判定に効く) */
  hasModelSpecific: boolean;
}

export interface MistApMeta {
  id: string;
  name: string;
  model: string;
  version: string;
  status: string;
}

export interface MistSiteSnapshot {
  platform: "mist";
  siteId: string;
  siteName: string;
  rfTemplate: MistRfTemplate | null;
  wlans: MistWlanConfig[];
  aps: MistApMeta[];
  steps: CollectionStep[];
}

export type SiteSnapshot = CentralSiteSnapshot | MistSiteSnapshot;

// ── 診断の実行結果 ───────────────────────────────────────────

export interface DiagnosisSummary {
  pass: number;
  warn: number;
  fail: number;
  not_applicable: number;
  unknown: number;
  info: number;
  /** 法務確認を促した所見の数(status とは独立に数える) */
  legalReview: number;
}

export interface DiagnosisRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  /** 手動トリガーのみ(スケジュール実行は行わない。51 の確定事項) */
  trigger: "manual";
  /** LLM 所見を実行したか */
  llmEnabled: boolean;
  llmModel: string | null;
  findings: Finding[];
  summary: DiagnosisSummary;
  /** 収集の各ステップ。失敗理由はここに残す(生テキストは残さない) */
  steps: CollectionStep[];
  /** サイト内の設定差異を診られないことの明示(49 §4-2) */
  sampledDeviceIds: string[];
  error: string | null;
}

export interface DiagnosisRunMeta {
  id: string;
  startedAt: string;
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  summary: DiagnosisSummary;
  error: string | null;
}

export interface BestPracticeSettings {
  /** LLM 所見(SEC-12 / SEC-13 / RF-15 / RF-16)を実行するか */
  llmEnabled: boolean;
  /** null なら既定モデル */
  llmModel: string | null;
  /** 保存する実行結果の上限。超えた分は古いものから消す */
  maxRuns: number;
  /** 既定で無効にするルール ID(ノイズが多いものを利用者が切れるように) */
  disabledRuleIds: string[];
}
