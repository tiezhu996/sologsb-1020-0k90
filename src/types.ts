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
  /** 结论由哪个离线包写入 */
  decidedByPackageId?: string;
  decidedByStation?: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
  /** 合并生成的新记录 id */
  mergedRecordId?: string;
  packageId?: string;
  station?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
  /** 县馆离线会话中产生的审计条目，回传时带稳定 id 去重 */
  packageId?: string;
  station?: string;
}

/* ---------------- 离线核对包 ---------------- */

export type OfflineChangeKind = 'add-record' | 'edit-record' | 'match-decision' | 'merge';
export type OfflineConflictKind =
  | 'snapshot-changed-edit'
  | 'conclusion-mismatch'
  | 'snapshot-changed-merge'
  | 'target-missing'
  | 'duplicate-add';

export interface OfflineAddedRecord {
  kind: 'add-record';
  record: ArchiveRecord;
}

export interface OfflineEditedRecord {
  kind: 'edit-record';
  recordId: string;
  patch: Partial<Record<FieldKey, string | string[]>>;
  at: string;
  /** 检出时该记录的基线字段值，用于中心三方定位 */
  base: Partial<Record<FieldKey, string | string[]>>;
}

export interface OfflineMatchDecision {
  kind: 'match-decision';
  matchId: string;
  leftId: string;
  rightId: string;
  status: Extract<MatchStatus, 'confirmed' | 'rejected'>;
  at: string;
  reviewedAt: string;
}

export interface OfflineMerge {
  kind: 'merge';
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedRecordId: string;
  at: string;
  /** 检出时两侧记录快照，供中心三方定位字段变化 */
  baseLeft: ArchiveRecord;
  baseRight: ArchiveRecord;
}

export type OfflineChange =
  | OfflineAddedRecord
  | OfflineEditedRecord
  | OfflineMatchDecision
  | OfflineMerge;

/** 离线包身份与快照 */
export interface OfflinePackage {
  kind: 'offline-check-package';
  format: 1;
  /** 包身份，重复导入时据此去重 */
  packageId: string;
  station: string;
  issuedAt: string;
  returnedAt?: string;
  /** 检出时中心 revision，用于按快照定位 */
  baseRevision: number;
  baseHashes: Record<string, string>;
  changes: OfflineChange[];
  audit: AuditEntry[];
}

/** 县馆领走的工作包：含一份可离线工作的完整工作区副本 */
export interface OfflineWorkPackage {
  kind: 'offline-work-package';
  format: 1;
  packageId: string;
  station: string;
  issuedAt: string;
  baseRevision: number;
  state: Pick<ArchiveState, 'revision' | 'records' | 'matches' | 'merges' | 'audit'>;
}

/* ---------------- 待裁决 ---------------- */

export interface PendingConflictField {
  field: FieldKey;
  label: string;
  base: string;
  current: string;
  incoming: string;
}

export interface PendingConflict {
  id: string;
  kind: OfflineConflictKind;
  packageId: string;
  station: string;
  receivedAt: string;
  recordIds: string[];
  matchId?: string;
  summary: string;
  fields: PendingConflictField[];
  /** 裁决所需的载荷：编辑补丁 / 匹配结论 / 合并动作 */
  change?: OfflineChange;
  incoming?: { status?: MatchStatus; mergedRecord?: ArchiveRecord; merge?: OfflineMerge };
  /** 处理结果：未处理 / 已并入 / 已忽略 */
  resolution?: 'applied' | 'ignored';
  resolvedAt?: string;
  resolutionNote?: string;
}

/** 已接收包台账 */
export interface ReceivedPackageInfo {
  packageId: string;
  station: string;
  issuedAt: string;
  receivedAt: string;
  baseRevision: number;
  applied: number;
  conflicted: number;
  duplicate: boolean;
  changeCount: number;
}

/** 县馆离线会话（本机重开后继续处理） */
export interface OfflineSession {
  packageId: string;
  station: string;
  issuedAt: string;
  baseRevision: number;
  baseHashes: Record<string, string>;
  /** 已完成、等待打包回传的变更 */
  changes: OfflineChange[];
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
  /** 已入账包身份，重复包不重复入账 */
  receivedPackages: ReceivedPackageInfo[];
  pendingConflicts: PendingConflict[];
  /** 县馆本机的离线会话；中心机上为 null */
  offlineSession: OfflineSession | null;
}
