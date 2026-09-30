export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  resultId?: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
}

/* ============ 离线同步：包身份、快照基线、待裁决 ============ */

export type StationRole = 'center' | 'county';
export type ReviewConclusion = Extract<MatchStatus, 'confirmed' | 'rejected'>;
export type ChangeKind = 'record-upsert' | 'decision' | 'merge';

/** 县馆离线包中的单条改动，均携带其在基准快照中的旧值用于三向定位 */
export interface RecordChange {
  kind: 'record-upsert';
  record: ArchiveRecord;
  base?: ArchiveRecord;
}

export interface DecisionChange {
  kind: 'decision';
  matchId: string;
  leftId: string;
  rightId: string;
  status: ReviewConclusion;
  reviewedAt: string;
  baseStatus: MatchStatus;
  /** 县馆侧最新的完整匹配信息，干净并入时同步刷新评分 */
  match?: MatchCandidate;
}

export interface MergeChange {
  kind: 'merge';
  merge: MergeResult;
  resultRecord: ArchiveRecord;
  removedIds: string[];
}

export type PackChange = RecordChange | DecisionChange | MergeChange;

interface SyncPackageBase {
  schemaVersion: 1;
  /** 包身份：同一包重复带回只入账一次 */
  id: string;
  stationId: string;
  stationName: string;
  exportedAt: string;
  note?: string;
}

/** 中心发给县馆的基准快照包 */
export interface BasePack extends SyncPackageBase {
  kind: 'base';
  centerStationId: string;
  centerStationName: string;
  baseHash: string;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
}

/** 县馆离线工作后带回中心的核对改动包 */
export interface ChangePack extends SyncPackageBase {
  kind: 'change';
  basePackageId: string;
  baseHash: string;
  changes: PackChange[];
}

export type SyncPackage = BasePack | ChangePack;

/** 中心侧的包台账回执 */
export interface PackageReceipt {
  id: string;
  packageId: string;
  kind: 'base' | 'change';
  stationId: string;
  stationName: string;
  importedAt: string;
  baseHash: string;
  note?: string;
  records: number;
  decisions: number;
  merges: number;
  arbitrated: number;
  duplicate: boolean;
}

export interface AffectedField {
  field: string;
  label: string;
  base: string;
  center: string;
  incoming: string;
}

export interface ArbitrationResolution {
  at: string;
  outcome: 'merged' | 'ignored';
  /** decision / merge 类的总体选择 */
  choice?: 'incoming' | 'center';
  /** record 类逐字段选择 */
  fields?: Record<string, 'incoming' | 'center'>;
  note: string;
}

/** 快照变化或结论分歧时进入待裁决队列的条目 */
export interface ArbitrationItem {
  id: string;
  kind: ChangeKind;
  entityId: string;
  title: string;
  recordIds: string[];
  packageId: string;
  stationId: string;
  stationName: string;
  receivedAt: string;
  reason: string;
  fields: AffectedField[];
  change: PackChange;
  status: 'pending' | 'resolved' | 'ignored';
  resolution?: ArbitrationResolution;
}

export interface EntityProvenance {
  packageId: string;
  stationId: string;
  stationName: string;
  at: string;
}

/** 县馆机上保存的基准快照，用于定位每条改动 */
export interface ForkBase {
  packageId: string;
  exportedAt: string;
  centerStationId: string;
  centerStationName: string;
  baseHash: string;
  baseRecords: ArchiveRecord[];
  baseMatches: MatchCandidate[];
  baseMerges: MergeResult[];
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
  /* 站点身份与离线同步状态 */
  stationId: string;
  stationName: string;
  stationRole: StationRole;
  fork?: ForkBase;
  packages: PackageReceipt[];
  arbitrations: ArbitrationItem[];
  provenance: Record<string, EntityProvenance>;
}
