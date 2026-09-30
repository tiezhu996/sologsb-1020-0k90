import type {
  ArchiveRecord, ArchiveState, AuditEntry, FieldKey, MatchCandidate,
  OfflineChange, OfflineEditedRecord, OfflineMatchDecision, OfflineMerge,
  OfflinePackage, OfflineWorkPackage, PendingConflict, PendingConflictField, ReceivedPackageInfo
} from '../types';
import { fieldValue, scorePair } from './matching';

export const PACKAGE_STORAGE_KEY = 'sologsb-1020-work-package-v1';

export const fieldLabelOf = (field: FieldKey): string => ({
  title: '标题', date: '日期', people: '人物', places: '地点', identifier: '编号',
  medium: '载体', extent: '数量', rights: '权利', notes: '备注'
}[field]);

const comparableFields: FieldKey[] = ['title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'];
const stringFields: FieldKey[] = ['title', 'date', 'identifier', 'medium', 'extent', 'rights', 'notes'];
const listFields: FieldKey[] = ['people', 'places'];

const valueOf = (record: ArchiveRecord | undefined, field: FieldKey): string =>
  record ? fieldValue(record, field) : '';

/** 字段值参与快照哈希的规范化形式 */
export const canonicalField = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean).join('|');
  return (value ?? '').trim();
};

/** 记录级快照哈希：按包身份与快照定位改动 */
export const hashRecord = (record: ArchiveRecord): string => {
  const body = JSON.stringify(comparableFields.map((field) => canonicalField(record[field] as string | string[])));
  let hash = 5381;
  for (let index = 0; index < body.length; index += 1) hash = ((hash << 5) + hash + body.charCodeAt(index)) | 0;
  return `h${(hash >>> 0).toString(36)}`;
};

export const snapshotHashes = (records: ArchiveRecord[]): Record<string, string> =>
  Object.fromEntries(records.map((record) => [record.id, hashRecord(record)]));

export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

export const auditOf = (action: string, detail: string, recordIds: string[] = [], extra: Partial<AuditEntry> = {}): AuditEntry => ({
  id: newId('au'), at: new Date().toISOString(), action, detail, recordIds, ...extra
});

const splitList = (value: string | string[] | undefined): string[] =>
  Array.isArray(value) ? value : String(value ?? '').split(/[；;、,，]/).map((item) => item.trim()).filter(Boolean);

/** 把编辑补丁应用到记录上 */
export const applyPatch = (record: ArchiveRecord, patch: OfflineEditedRecord['patch']): ArchiveRecord => {
  const next: ArchiveRecord = { ...record, people: [...record.people], places: [...record.places], updatedAt: new Date().toISOString() };
  const view = next as unknown as Record<FieldKey, unknown>;
  stringFields.forEach((field) => {
    const value = patch[field];
    if (typeof value === 'string') view[field] = value;
  });
  listFields.forEach((field) => {
    const value = patch[field];
    if (Array.isArray(value)) view[field] = value;
    else if (typeof value === 'string') view[field] = splitList(value);
  });
  return next;
};

const changedFieldsOf = (patch: OfflineEditedRecord['patch']): FieldKey[] =>
  comparableFields.filter((field) => patch[field] !== undefined);

const buildConflictFields = (
  fields: FieldKey[],
  base: ArchiveRecord | undefined,
  current: ArchiveRecord | undefined,
  incomingPatch?: OfflineEditedRecord['patch']
): PendingConflictField[] => fields.map((field) => ({
  field,
  label: fieldLabelOf(field),
  base: base ? valueOf(base, field) : '',
  current: current ? valueOf(current, field) : '',
  incoming: incomingPatch
    ? canonicalField(incomingPatch[field])
    : current ? '' : ''
}));

/* ---------------- 县馆：检出 / 离线记录变更 / 回传 ---------------- */

/** 中心：制作县馆离线工作包 */
export const issueWorkPackage = (state: ArchiveState, station: string): OfflineWorkPackage => ({
  kind: 'offline-work-package',
  format: 1,
  packageId: newId('pkg'),
  station: station.trim() || '未命名县馆',
  issuedAt: new Date().toISOString(),
  baseRevision: state.revision,
  state: {
    revision: state.revision,
    records: structuredClone(state.records),
    matches: structuredClone(state.matches),
    merges: structuredClone(state.merges),
    audit: structuredClone(state.audit)
  }
});

/** 县馆：打开工作包，建立可离线续做的会话 */
export const beginOfflineSession = (workPackage: OfflineWorkPackage) => {
  const session = {
    packageId: workPackage.packageId,
    station: workPackage.station,
    issuedAt: workPackage.issuedAt,
    baseRevision: workPackage.baseRevision,
    baseHashes: snapshotHashes(workPackage.state.records),
    changes: [] as OfflineChange[]
  };
  const state: Pick<ArchiveState, 'revision' | 'records' | 'matches' | 'merges' | 'audit'> = structuredClone(workPackage.state);
  return { session, state };
};

export const recordAdded = (session: { changes: OfflineChange[] }, record: ArchiveRecord): void => {
  session.changes.push({ kind: 'add-record', record: structuredClone(record) });
};

export const recordEdited = (
  session: { baseHashes: Record<string, string>; changes: OfflineChange[] },
  record: ArchiveRecord,
  patch: OfflineEditedRecord['patch']
): void => {
  session.changes.push({
    kind: 'edit-record',
    recordId: record.id,
    patch: structuredClone(patch),
    at: new Date().toISOString(),
    base: Object.fromEntries(
      changedFieldsOf(patch).map((field) => [field, canonicalField(record[field] as string | string[])])
    )
  });
};

export const recordDecision = (session: { changes: OfflineChange[] }, decision: OfflineMatchDecision): void => {
  session.changes.push(structuredClone(decision));
};

export const recordMerge = (
  session: { changes: OfflineChange[] },
  params: {
    matchId: string;
    left: ArchiveRecord;
    right: ArchiveRecord;
    chosen: OfflineMerge['chosen'];
    values: OfflineMerge['values'];
    mergedRecordId: string;
  }
): void => {
  session.changes.push({
    kind: 'merge',
    matchId: params.matchId,
    leftId: params.left.id,
    rightId: params.right.id,
    chosen: structuredClone(params.chosen),
    values: structuredClone(params.values),
    mergedRecordId: params.mergedRecordId,
    at: new Date().toISOString(),
    baseLeft: structuredClone(params.left),
    baseRight: structuredClone(params.right)
  });
};

/** 县馆：把离线会话打成回传核对包 */
export const sealReturnPackage = (
  session: { packageId: string; station: string; issuedAt: string; baseRevision: number; baseHashes: Record<string, string>; changes: OfflineChange[] },
  offlineAudit: AuditEntry[]
): OfflinePackage => ({
  kind: 'offline-check-package',
  format: 1,
  packageId: session.packageId,
  station: session.station,
  issuedAt: session.issuedAt,
  returnedAt: new Date().toISOString(),
  baseRevision: session.baseRevision,
  baseHashes: session.baseHashes,
  changes: structuredClone(session.changes),
  audit: structuredClone(offlineAudit)
});

/* ---------------- 中心：合并回传包 ---------------- */

export interface MergeOutcome {
  applied: number;
  conflicted: number;
  duplicated: boolean;
  conflicts: PendingConflict[];
  info?: ReceivedPackageInfo;
}

/**
 * 把离线核对包合并回中心工作区：
 * - 按 packageId 去重，重复包不重复入账；
 * - 无冲突内容直接汇入；
 * - 快照变化或结论不同进入待裁决队列，确认前不进入最终核对包。
 * 直接修改传入的 state，并返回汇总结果。
 */
export const mergePackageIntoState = (state: ArchiveState, pkg: OfflinePackage): MergeOutcome => {
  if (state.receivedPackages.some((item) => item.packageId === pkg.packageId)) {
    const existing = state.receivedPackages.find((item) => item.packageId === pkg.packageId)!;
    if (!existing.duplicate) existing.duplicate = true;
    state.revision += 1;
    state.audit.unshift(auditOf('重复包忽略', `来自 ${pkg.station} 的核对包 ${shortPkg(pkg.packageId)} 已入账，重复内容未再次导入`, [], { packageId: pkg.packageId, station: pkg.station }));
    trimAudit(state);
    return { applied: 0, conflicted: 0, duplicated: true, conflicts: [] };
  }

  const receivedAt = new Date().toISOString();
  const conflicts: PendingConflict[] = [];
  let applied = 0;

  const queueConflict = (conflict: Omit<PendingConflict, 'id' | 'packageId' | 'station' | 'receivedAt' | 'recordIds'> & { recordIds?: string[] }) => {
    conflicts.push({
      id: newId('cf'),
      packageId: pkg.packageId,
      station: pkg.station,
      receivedAt,
      recordIds: conflict.recordIds ?? [],
      ...conflict
    });
  };

  pkg.changes.forEach((change) => {
    if (change.kind === 'add-record') {
      const duplicate = state.records.some((record) => record.id === change.record.id);
      if (duplicate) {
        queueConflict({
          kind: 'duplicate-add',
          matchId: undefined,
          summary: `新增记录「${change.record.title}」与中心已有记录编号 ${change.record.id} 冲突`,
          fields: [],
          change: structuredClone(change)
        });
        return;
      }
      state.records.push(structuredClone(change.record));
      applied += 1;
      return;
    }

    if (change.kind === 'edit-record') {
      const current = state.records.find((record) => record.id === change.recordId);
      if (!current) {
        queueConflict({
          kind: 'target-missing',
          summary: `编辑的记录 ${change.recordId} 在中心已不存在，无法定位`,
          fields: [],
          change: structuredClone(change)
        });
        return;
      }
      const touched = changedFieldsOf(change.patch);
      // 逐字段三方定位：中心现值仍等于检出基线说明中心未动该字段；
      // 仅当中心与县馆都改了同一字段且取值不同时才需要裁决
      const contested = touched.filter((field) =>
        canonicalField(current[field] as string | string[]) !== change.base[field]
        && canonicalField(current[field] as string | string[]) !== canonicalField(change.patch[field]));
      // 无争议字段（中心未动，或双方改成相同值）先直接汇入
      const safePatch: OfflineEditedRecord['patch'] = {};
      touched.filter((field) => !contested.includes(field)).forEach((field) => {
        (safePatch as Record<FieldKey, unknown>)[field] = change.patch[field];
      });
      const currentIndex = state.records.findIndex((record) => record.id === change.recordId);
      if (Object.keys(safePatch).length) state.records[currentIndex] = applyPatch(current, safePatch);
      if (!contested.length) {
        applied += 1;
        return;
      }
      const refreshed = state.records[currentIndex];
      queueConflict({
        kind: 'snapshot-changed-edit',
        recordIds: [change.recordId],
        matchId: undefined,
        summary: `记录「${refreshed.title}」自检出后在中心也被修改，县馆 ${pkg.station} 的 ${contested.length} 个字段改动待裁决`,
        fields: buildConflictFields(contested, syntheticBase(refreshed, change), refreshed, change.patch),
        change: { ...structuredClone(change), patch: structuredClone(contested.reduce((acc, field) => {
          (acc as Record<FieldKey, unknown>)[field] = change.patch[field];
          return acc;
        }, {} as OfflineEditedRecord['patch'])) }
      });
      return;
    }

    if (change.kind === 'match-decision') {
      let match = state.matches.find((item) => item.id === change.matchId);
      if (!match) {
        const left = state.records.some((record) => record.id === change.leftId);
        const right = state.records.some((record) => record.id === change.rightId);
        if (left && right) {
          // 中心重算匹配导致 id 缺失，按两端记录补位
          match = {
            id: change.matchId,
            leftId: change.leftId,
            rightId: change.rightId,
            score: 0,
            fieldScores: blankScores(),
            status: 'suggested',
            reasons: ['离线包回传时重建的匹配项']
          };
          state.matches.push(match);
        }
      }
      if (!match) {
        queueConflict({
          kind: 'target-missing',
          recordIds: [change.leftId, change.rightId],
          summary: `匹配 ${change.matchId} 的一端记录在中心已不存在`,
          fields: [],
          change: structuredClone(change),
          incoming: { status: change.status }
        });
        return;
      }
      if (match.status === change.status) {
        // 结论一致，幂等入账，只补来源标记
        match.decidedByPackageId = pkg.packageId;
        match.decidedByStation = pkg.station;
        applied += 1;
        return;
      }
      if (match.status === 'suggested') {
        // 中心尚未有结论，直接汇入
        match.status = change.status;
        match.reviewedAt = change.reviewedAt;
        match.decidedByPackageId = pkg.packageId;
        match.decidedByStation = pkg.station;
        stampRecords(state, match, change.status);
        applied += 1;
        return;
      }
      // 两人对同一记录给出不同结论 → 待裁决
      const left = state.records.find((record) => record.id === change.leftId);
      const right = state.records.find((record) => record.id === change.rightId);
      queueConflict({
        kind: 'conclusion-mismatch',
        recordIds: [change.leftId, change.rightId],
        matchId: match.id,
        summary: `「${left?.title ?? change.leftId} ↔ ${right?.title ?? change.rightId}」中心已${statusText(match.status)}，${pkg.station} 结论为${statusText(change.status)}`,
        fields: [{
          field: 'identifier',
          label: '匹配结论',
          base: '待复核（检出时）',
          current: statusText(match.status),
          incoming: statusText(change.status)
        }],
        change: structuredClone(change),
        incoming: { status: change.status }
      });
      return;
    }

    if (change.kind === 'merge') {
      const left = state.records.find((record) => record.id === change.leftId);
      const right = state.records.find((record) => record.id === change.rightId);
      if (!left || !right) {
        queueConflict({
          kind: 'target-missing',
          recordIds: [change.leftId, change.rightId].filter((id) => !state.records.some((record) => record.id === id)),
          summary: `合并涉及的记录在中心已缺失，无法安全并入`,
          fields: [],
          change: structuredClone(change),
          incoming: { merge: structuredClone(change) }
        });
        return;
      }
      const match = state.matches.find((item) => item.id === change.matchId);
      const changedSideFields = (base: ArchiveRecord, current: ArchiveRecord): FieldKey[] =>
        comparableFields.filter((field) =>
          canonicalField(current[field] as string | string[]) !== canonicalField(base[field] as string | string[]));
      const drifted = [...new Set([...changedSideFields(change.baseLeft, left), ...changedSideFields(change.baseRight, right)])];
      const blockedByConclusion = match && (match.status === 'confirmed' || match.status === 'rejected');
      if (drifted.length || blockedByConclusion) {
        queueConflict({
          kind: 'snapshot-changed-merge',
          recordIds: [change.leftId, change.rightId],
          matchId: change.matchId,
          summary: `合并「${left.title} ↔ ${right.title}」基于的快照已变化${blockedByConclusion ? `，中心现有结论为${statusText(match!.status)}` : ''}`,
          fields: drifted.map((field) => ({
            field,
            label: fieldLabelOf(field),
            base: `${valueOf(change.baseLeft, field)} / ${valueOf(change.baseRight, field)}`,
            current: `${valueOf(left, field)} / ${valueOf(right, field)}`,
            incoming: change.values[field] ?? ''
          })),
          change: structuredClone(change),
          incoming: { merge: structuredClone(change) }
        });
        return;
      }
      // 快照一致、无相反结论：直接执行合并
      applyMerge(state, change, pkg);
      applied += 1;
    }
  });

  // 县馆审计轨迹并入（按稳定 id 去重）
  const knownAudit = new Set(state.audit.map((entry) => entry.id));
  pkg.audit.filter((entry) => entry.id && !knownAudit.has(entry.id)).forEach((entry) => {
    state.audit.unshift({ ...entry, packageId: pkg.packageId, station: pkg.station });
  });

  state.pendingConflicts = [...conflicts, ...state.pendingConflicts];
  state.revision += 1;
  const info: ReceivedPackageInfo = {
    packageId: pkg.packageId,
    station: pkg.station,
    issuedAt: pkg.issuedAt,
    receivedAt,
    baseRevision: pkg.baseRevision,
    applied,
    conflicted: conflicts.length,
    duplicate: false,
    changeCount: pkg.changes.length
  };
  state.receivedPackages = [info, ...state.receivedPackages];

  state.audit.unshift(auditOf(
    '接收入账离线核对包',
    `${pkg.station} 的核对包 ${shortPkg(pkg.packageId)}：${pkg.changes.length} 项改动，直接汇入 ${applied} 项，${conflicts.length} 项进入待裁决`,
    conflicts.flatMap((item) => item.recordIds),
    { packageId: pkg.packageId, station: pkg.station }
  ));
  if (conflicts.length) {
    state.audit.unshift(auditOf('产生待裁决项', `包 ${shortPkg(pkg.packageId)} 有 ${conflicts.length} 项改动需人工裁决，确认前不进入最终核对包`, conflicts.flatMap((item) => item.recordIds), { packageId: pkg.packageId, station: pkg.station }));
  }
  trimAudit(state);
  return { applied, conflicted: conflicts.length, duplicated: false, conflicts, info };
};

/* ---------------- 中心：合并后的增量匹配 ---------------- */

/** 为新增记录与对侧既有记录补充匹配建议，已存在的匹配不重复生成 */
export const augmentMatches = (state: ArchiveState): number => {
  const existing = new Set(state.matches.map((match) => match.id));
  const groupA = state.records.filter((record) => record.group === 'A');
  const groupB = state.records.filter((record) => record.group === 'B');
  const created: MatchCandidate[] = [];
  groupA.forEach((left) => {
    groupB.forEach((right) => {
      const id = `match-${left.id}-${right.id}`;
      if (existing.has(id)) return;
      const scored = scorePair(left, right);
      if (scored.score < 0.38) return;
      created.push({
        id, leftId: left.id, rightId: right.id,
        score: scored.score, fieldScores: scored.fieldScores,
        status: 'suggested', reasons: scored.reasons
      });
    });
  });
  if (created.length) state.matches = [...state.matches, ...created].sort((a, b) => b.score - a.score);
  return created.length;
};

/* ---------------- 中心：裁决 ---------------- */

/** 采纳县馆改动：把待裁决项并入最终核对包 */
export const resolveConflictApply = (state: ArchiveState, conflictId: string, note = ''): boolean => {
  const conflict = state.pendingConflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.resolution) return false;
  const change = conflict.change;
  if (!change) return false;

  if (change.kind === 'edit-record') {
    const current = state.records.find((record) => record.id === change.recordId);
    if (current) {
      const index = state.records.findIndex((record) => record.id === change.recordId);
      state.records[index] = applyPatch(current, change.patch);
    }
  } else if (change.kind === 'match-decision') {
    const target = change as OfflineMatchDecision;
    let match = state.matches.find((item) => item.id === target.matchId);
    if (!match) {
      match = {
        id: target.matchId, leftId: target.leftId, rightId: target.rightId,
        score: 0, fieldScores: blankScores(), status: target.status,
        reasons: ['裁决后补入的匹配项'], reviewedAt: new Date().toISOString(),
        decidedByPackageId: conflict.packageId, decidedByStation: conflict.station
      };
      state.matches.push(match);
    } else {
      match.status = target.status;
      match.reviewedAt = target.reviewedAt;
      match.decidedByPackageId = conflict.packageId;
      match.decidedByStation = conflict.station;
      stampRecords(state, match, target.status);
    }
  } else if (change.kind === 'merge') {
    const target = change as OfflineMerge;
    applyMerge(state, target, { packageId: conflict.packageId, station: conflict.station } as OfflinePackage);
  } else if (change.kind === 'add-record') {
    if (!state.records.some((record) => record.id === change.record.id)) state.records.push(structuredClone(change.record));
  }

  conflict.resolution = 'applied';
  conflict.resolvedAt = new Date().toISOString();
  conflict.resolutionNote = note;
  bumpPackageCount(state, conflict.packageId, 1, -1);
  state.revision += 1;
  state.audit.unshift(auditOf('裁决采纳', `采纳 ${conflict.station} 包 ${shortPkg(conflict.packageId)} 的改动：${conflict.summary}${note ? `（${note}）` : ''}`, conflict.recordIds, { packageId: conflict.packageId, station: conflict.station }));
  trimAudit(state);
  return true;
};

/** 忽略县馆改动：保留中心现状，审计留痕 */
export const resolveConflictIgnore = (state: ArchiveState, conflictId: string, note = ''): boolean => {
  const conflict = state.pendingConflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.resolution) return false;
  conflict.resolution = 'ignored';
  conflict.resolvedAt = new Date().toISOString();
  conflict.resolutionNote = note;
  bumpPackageCount(state, conflict.packageId, 0, -1);
  state.revision += 1;
  state.audit.unshift(auditOf('裁决忽略', `忽略 ${conflict.station} 包 ${shortPkg(conflict.packageId)} 的改动：${conflict.summary}${note ? `（${note}）` : ''}`, conflict.recordIds, { packageId: conflict.packageId, station: conflict.station }));
  trimAudit(state);
  return true;
};

/* ---------------- 内部辅助 ---------------- */

const applyMerge = (state: ArchiveState, change: OfflineMerge, pkg: Pick<OfflinePackage, 'packageId' | 'station'>): void => {
  const left = state.records.find((record) => record.id === change.leftId);
  const right = state.records.find((record) => record.id === change.rightId);
  if (!left || !right) return;
  const merged: ArchiveRecord = {
    ...left,
    ...change.values,
    people: change.values.people ? splitList(change.values.people) : left.people,
    places: change.values.places ? splitList(change.values.places) : left.places,
    id: change.mergedRecordId,
    status: 'merged',
    updatedAt: new Date().toISOString()
  };
  state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
  state.matches.forEach((item) => {
    if (item.id === change.matchId) item.status = 'merged';
    else if ([item.leftId, item.rightId].some((id) => id === left.id || id === right.id)) item.status = 'rejected';
  });
  const match = state.matches.find((item) => item.id === change.matchId);
  if (match) {
    match.status = 'merged';
    match.decidedByPackageId = pkg.packageId;
    match.decidedByStation = pkg.station;
  }
  state.merges.unshift({
    id: newId('mg'),
    matchId: change.matchId,
    leftId: left.id,
    rightId: right.id,
    chosen: change.chosen,
    values: change.values,
    mergedAt: change.at,
    mergedRecordId: merged.id,
    packageId: pkg.packageId,
    station: pkg.station
  });
};

const stampRecords = (state: ArchiveState, match: MatchCandidate, status: 'confirmed' | 'rejected') => {
  if (status !== 'confirmed') return;
  state.records.forEach((record) => {
    if (record.id === match.leftId || record.id === match.rightId) record.status = 'confirmed';
  });
};

const syntheticBase = (current: ArchiveRecord, change: OfflineEditedRecord): ArchiveRecord => {
  const base: ArchiveRecord = { ...current, people: [...current.people], places: [...current.places] };
  const view = base as unknown as Record<FieldKey, unknown>;
  Object.entries(change.base).forEach(([field, value]) => {
    if ((listFields as string[]).includes(field)) view[field as FieldKey] = splitList(value as string);
    else view[field as FieldKey] = value ?? '';
  });
  return base;
};

const blankScores = (): Record<FieldKey, number> => ({
  title: 0, date: 0, people: 0, places: 0, identifier: 0, medium: 0, extent: 0, rights: 0, notes: 0
});

const bumpPackageCount = (state: ArchiveState, packageId: string, appliedDelta: number, conflictDelta: number) => {
  const info = state.receivedPackages.find((item) => item.packageId === packageId);
  if (!info) return;
  info.applied += appliedDelta;
  info.conflicted = Math.max(0, info.conflicted + conflictDelta);
};

const trimAudit = (state: ArchiveState) => {
  state.audit = state.audit.slice(0, 500);
};

const shortPkg = (id: string) => id.length > 14 ? id.slice(-8) : id;

export const statusText = (status: MatchCandidate['status']): string => ({
  suggested: '待复核', confirmed: '确认', rejected: '忽略', merged: '已合并'
}[status]);
