import type {
  AffectedField,
  ArchiveRecord,
  ArchiveState,
  ArbitrationItem,
  BasePack,
  ChangePack,
  DecisionChange,
  FieldKey,
  ForkBase,
  MatchCandidate,
  MatchStatus,
  MergeChange,
  PackChange,
  RecordChange,
  SyncPackage
} from '../types';
import { computeMatches, fieldValue, scorePair } from './matching';

export const FIELD_LABELS: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

export const fieldLabel = (field: string) => FIELD_LABELS.find(([key]) => key === field)?.[1] ?? field;
export const showValue = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.length ? value.join('、') : '';
  return String(value);
};

/* ---------------- 快照 ---------------- */

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/** 只对核对实体本身做快照，审计、选择态不影响基线 */
const snapshotPayload = (records: ArchiveRecord[], matches: MatchCandidate[], merges: ArchiveState['merges']) => ({
  records: records.map(({ id, group, title, date, people, places, identifier, medium, extent, rights, notes }) =>
    ({ id, group, title, date, people: [...people], places: [...places], identifier, medium, extent, rights, notes })),
  matches: matches.map(({ id, leftId, rightId, score, fieldScores, status, reasons }) =>
    ({ id, leftId, rightId, score, fieldScores, status, reasons })),
  merges: merges.map(({ id, matchId, leftId, rightId, resultId, chosen, values, mergedAt }) =>
    ({ id, matchId, leftId, rightId, resultId, chosen, values, mergedAt }))
});

export const hashSnapshot = async (
  records: ArchiveRecord[],
  matches: MatchCandidate[],
  merges: ArchiveState['merges']
): Promise<string> => {
  const canonical = stableStringify(snapshotPayload(records, matches, merges));
  let digestHex = '';
  try {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    digestHex = Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    let hash = 5381;
    for (let i = 0; i < canonical.length; i += 1) hash = ((hash << 5) + hash + canonical.charCodeAt(i)) >>> 0;
    digestHex = hash.toString(16).padStart(8, '0');
  }
  return `sha256:${digestHex.slice(0, 16)}`;
};

/* ---------------- 打包 ---------------- */

export const buildBasePack = async (state: ArchiveState, note?: string): Promise<BasePack> => ({
  schemaVersion: 1,
  kind: 'base',
  id: `pack-base-${crypto.randomUUID()}`,
  stationId: state.stationId,
  stationName: state.stationName,
  centerStationId: state.stationId,
  centerStationName: state.stationName,
  exportedAt: new Date().toISOString(),
  baseHash: await hashSnapshot(state.records, state.matches, state.merges),
  note,
  records: structuredClone(state.records),
  matches: structuredClone(state.matches),
  merges: structuredClone(state.merges)
});

const sameEntity = (a: ArchiveRecord | undefined, b: ArchiveRecord | undefined) =>
  !!a && !!b && stableStringify(snapshotPayload([a], [], [])) === stableStringify(snapshotPayload([b], [], []));

/** 县馆：对照基准快照逐条定位离线改动 */
export const buildChangePack = async (state: ArchiveState, fork: ForkBase, note?: string): Promise<ChangePack> => {
  const baseRecordById = new Map(fork.baseRecords.map((record) => [record.id, record]));
  const baseMatchById = new Map(fork.baseMatches.map((match) => [match.id, match]));
  const baseMergeById = new Map(fork.baseMerges.map((merge) => [merge.id, merge]));
  const currentRecordById = new Map(state.records.map((record) => [record.id, record]));

  // 被本地合并动作吞掉的原记录不再按字段改动上报
  const mergedAwayIds = new Set<string>();
  state.merges.forEach((merge) => {
    if (!baseMergeById.has(merge.id)) {
      mergedAwayIds.add(merge.leftId);
      mergedAwayIds.add(merge.rightId);
    }
  });

  const changes: PackChange[] = [];

  state.records.forEach((record) => {
    if (mergedAwayIds.has(record.id)) return;
    const base = baseRecordById.get(record.id);
    if (!base) {
      changes.push({ kind: 'record-upsert', record: structuredClone(record) });
    } else if (!sameEntity(base, record)) {
      changes.push({ kind: 'record-upsert', record: structuredClone(record), base: structuredClone(base) });
    }
  });

  state.matches.forEach((match) => {
    const base = baseMatchById.get(match.id);
    if (!base) return; // 新增候选由 record 附带重算，不上报
    if ((match.status === 'confirmed' || match.status === 'rejected') && base.status !== match.status) {
      changes.push({
        kind: 'decision',
        matchId: match.id,
        leftId: match.leftId,
        rightId: match.rightId,
        status: match.status,
        reviewedAt: match.reviewedAt ?? new Date().toISOString(),
        baseStatus: base.status,
        match: structuredClone(match)
      });
    }
  });

  state.merges.forEach((merge) => {
    if (baseMergeById.has(merge.id)) return;
    const result = currentRecordById.get(merge.resultId ?? merge.leftId);
    if (!result) return;
    changes.push({
      kind: 'merge',
      merge: structuredClone(merge),
      resultRecord: structuredClone(result),
      removedIds: [merge.leftId, merge.rightId]
    });
  });

  return {
    schemaVersion: 1,
    kind: 'change',
    id: `pack-change-${crypto.randomUUID()}`,
    stationId: state.stationId,
    stationName: state.stationName,
    exportedAt: new Date().toISOString(),
    basePackageId: fork.packageId,
    baseHash: fork.baseHash,
    changes,
    note
  };
};

/* ---------------- 解包 ---------------- */

export const parseSyncPack = (raw: string): SyncPackage => {
  const pack = JSON.parse(raw) as SyncPackage;
  if (!pack || pack.schemaVersion !== 1 || (pack.kind !== 'base' && pack.kind !== 'change')) {
    throw new Error('不是受支持的离线核对包（schemaVersion 应为 1）');
  }
  if (!pack.id || !pack.stationId || !pack.baseHash) throw new Error('离线包缺少包身份或快照哈希');
  if (pack.kind === 'change' && !Array.isArray(pack.changes)) throw new Error('改动包缺少 changes 清单');
  if (pack.kind === 'base' && (!Array.isArray(pack.records) || !Array.isArray(pack.matches))) {
    throw new Error('基准包缺少快照记录');
  }
  return pack;
};

/** 县馆接收基准包：以基准快照重建离线工作区 */
export const adoptBasePack = (state: ArchiveState, pack: BasePack): ForkBase => {
  const fork: ForkBase = {
    packageId: pack.id,
    exportedAt: pack.exportedAt,
    centerStationId: pack.centerStationId,
    centerStationName: pack.centerStationName,
    baseHash: pack.baseHash,
    baseRecords: structuredClone(pack.records),
    baseMatches: structuredClone(pack.matches),
    baseMerges: structuredClone(pack.merges)
  };
  state.records = structuredClone(pack.records);
  state.matches = structuredClone(pack.matches);
  state.merges = structuredClone(pack.merges);
  state.fork = fork;
  state.packages = [];
  state.arbitrations = [];
  state.provenance = {};
  return fork;
};

/* ---------------- 三向合并 ---------------- */

const buildFieldDiff = (
  field: FieldKey,
  base: ArchiveRecord | undefined,
  center: ArchiveRecord | undefined,
  incoming: ArchiveRecord
): AffectedField => ({
  field,
  label: fieldLabel(field),
  base: base ? fieldValue(base, field) : '（基准中不存在）',
  center: center ? fieldValue(center, field) : '（中心当前不存在）',
  incoming: fieldValue(incoming, field)
});

const isRecordConflict = (base: ArchiveRecord | undefined, center: ArchiveRecord | undefined, incoming: ArchiveRecord) => {
  // 中心已删除县馆基准里存在的记录，属于快照变化
  if (base && !center) return true;
  // 双方都在，逐字段比对：中心改过且改得与县馆不同
  if (base && center) {
    return FIELD_LABELS.some(([field]) =>
      fieldValue(base, field) !== fieldValue(center, field) &&
      fieldValue(center, field) !== fieldValue(incoming, field)
    );
  }
  return false;
};

const matchTitle = (state: ArchiveState, leftId: string, rightId: string) => {
  const left = state.records.find((record) => record.id === leftId);
  const right = state.records.find((record) => record.id === rightId);
  if (!left && !right) return `${leftId} ↔ ${rightId}`;
  return `${left?.title ?? leftId} ↔ ${right?.title ?? rightId}`;
};

export interface IngestResult {
  received: number;
  applied: number;
  arbitrated: number;
  duplicates: number;
  recordChanges: number;
  decisions: number;
  merges: number;
}

/** 中心接收县馆改动包：干净改动直接汇入，快照变化/结论分歧进入待裁决 */
export const ingestChangePack = (state: ArchiveState, pack: ChangePack): IngestResult => {
  const receivedAt = new Date().toISOString();
  const recordById = new Map(state.records.map((record) => [record.id, record]));
  const matchById = new Map(state.matches.map((match) => [match.id, match]));
  const mergeById = new Map(state.merges.map((merge) => [merge.id, merge]));

  const provenanceFor = { packageId: pack.id, stationId: pack.stationId, stationName: pack.stationName, at: receivedAt };
  const makeArbitration = (partial: Omit<ArbitrationItem, 'id' | 'receivedAt' | 'status'>): ArbitrationItem => ({
    ...partial,
    id: `arb-${crypto.randomUUID()}`,
    receivedAt,
    status: 'pending'
  });

  let applied = 0;
  let arbitrated = 0;
  let recordChanges = 0;
  let decisions = 0;
  let merges = 0;

  // 先处理记录，再处理结论，最后处理合并动作
  const recordChangesList = pack.changes.filter((change): change is RecordChange => change.kind === 'record-upsert');
  const decisionChanges = pack.changes.filter((change): change is DecisionChange => change.kind === 'decision');
  const mergeChanges = pack.changes.filter((change): change is MergeChange => change.kind === 'merge');

  const insertedForMatching: ArchiveRecord[] = [];

  recordChangesList.forEach((change) => {
    recordChanges += 1;
    const incoming = change.record;
    const center = recordById.get(incoming.id);
    const base = change.base;
    if (isRecordConflict(base, center, incoming)) {
      const fields = FIELD_LABELS
        .filter(([field]) => !center || (
          fieldValue(base!, field) !== fieldValue(center, field) &&
          fieldValue(center, field) !== fieldValue(incoming, field)
        ))
        .map(([field]) => buildFieldDiff(field, base, center, incoming));
      state.arbitrations.unshift(makeArbitration({
        kind: 'record-upsert',
        entityId: incoming.id,
        title: center ? center.title : incoming.title,
        recordIds: [incoming.id],
        packageId: pack.id,
        stationId: pack.stationId,
        stationName: pack.stationName,
        reason: center ? '基准快照之后中心记录已变化，县馆改动与中心内容不一致' : '中心已删除该记录（快照变化）',
        fields,
        change: structuredClone(change)
      }));
      arbitrated += 1;
      return;
    }
    if (center) {
      // 干净并入县馆字段，但中心侧人工复核状态不被离线包回退
      Object.assign(center, structuredClone(incoming), { status: center.status });
    } else {
      const record = structuredClone(incoming);
      state.records.push(record);
      recordById.set(record.id, record);
      insertedForMatching.push(record);
    }
    state.provenance[incoming.id] = { ...provenanceFor };
    applied += 1;
  });

  // 新并入的县馆记录补算候选匹配
  if (insertedForMatching.length) {
    const additions = computeMatches(state.records).filter((candidate) =>
      !matchById.has(candidate.id) &&
      (insertedForMatching.some((record) => record.id === candidate.leftId) ||
       insertedForMatching.some((record) => record.id === candidate.rightId))
    );
    additions.forEach((match) => {
      state.matches.push(match);
      matchById.set(match.id, match);
    });
  }

  decisionChanges.forEach((change) => {
    decisions += 1;
    const center = matchById.get(change.matchId);
    const baseStatus: MatchStatus = change.baseStatus;
    if (!center) {
      state.arbitrations.unshift(makeArbitration({
        kind: 'decision',
        entityId: change.matchId,
        title: matchTitle(state, change.leftId, change.rightId),
        recordIds: [change.leftId, change.rightId],
        packageId: pack.id,
        stationId: pack.stationId,
        stationName: pack.stationName,
        reason: '中心已不存在该匹配项（快照变化）',
        fields: [{
          field: 'status',
          label: '复核结论',
          base: statusText(baseStatus),
          center: '（匹配不存在）',
          incoming: statusText(change.status)
        }],
        change: structuredClone(change)
      }));
      arbitrated += 1;
      return;
    }
    // 中心也改过结论且与县馆不同 → 两人分歧，待裁决
    const centerMoved = center.status !== baseStatus;
    if (centerMoved && center.status !== change.status) {
      state.arbitrations.unshift(makeArbitration({
        kind: 'decision',
        entityId: change.matchId,
        title: matchTitle(state, change.leftId, change.rightId),
        recordIds: [change.leftId, change.rightId],
        packageId: pack.id,
        stationId: pack.stationId,
        stationName: pack.stationName,
        reason: `中心与县馆对同一匹配给出不同结论（中心：${statusText(center.status)}，县馆：${statusText(change.status)}）`,
        fields: [{
          field: 'status',
          label: '复核结论',
          base: statusText(baseStatus),
          center: statusText(center.status),
          incoming: statusText(change.status)
        }],
        change: structuredClone(change)
      }));
      arbitrated += 1;
      return;
    }
    // 干净汇入（含中心尚未复核、或双方恰好一致）
    center.status = change.status;
    center.reviewedAt = change.reviewedAt;
    if (change.match) {
      center.score = change.match.score;
      center.fieldScores = structuredClone(change.match.fieldScores);
      center.reasons = [...change.match.reasons];
    }
    state.records.forEach((record) => {
      if ((record.id === change.leftId || record.id === change.rightId) && change.status === 'confirmed' && record.status === 'unreviewed') {
        record.status = 'confirmed';
      }
    });
    state.provenance[change.matchId] = { ...provenanceFor };
    applied += 1;
  });

  mergeChanges.forEach((change) => {
    merges += 1;
    if (mergeById.has(change.merge.id)) {
      // 同一合并动作已入账，不重复
      applied += 1;
      return;
    }
    const missingIds = change.removedIds.filter((id) => !recordById.has(id));
    if (missingIds.length) {
      state.arbitrations.unshift(makeArbitration({
        kind: 'merge',
        entityId: change.merge.id,
        title: change.resultRecord.title,
        recordIds: [...change.removedIds, change.resultRecord.id],
        packageId: pack.id,
        stationId: pack.stationId,
        stationName: pack.stationName,
        reason: `合并所依赖的原始记录在中心已缺失或变化（${missingIds.join('、')}）`,
        fields: [{
          field: 'merge',
          label: '合并动作',
          base: '基准中为两条独立记录',
          center: `缺失记录：${missingIds.join('、')}`,
          incoming: `县馆已合并为「${change.resultRecord.title}」`
        }],
        change: structuredClone(change)
      }));
      arbitrated += 1;
      return;
    }
    applyMergeChange(state, change);
    state.provenance[change.merge.id] = { ...provenanceFor };
    state.provenance[change.resultRecord.id] = { ...provenanceFor };
    applied += 1;
  });

  return { received: pack.changes.length, applied, arbitrated, duplicates: 0, recordChanges, decisions, merges };
};

const applyMergeChange = (state: ArchiveState, change: MergeChange) => {
  const { merge, resultRecord, removedIds } = change;
  const result = state.records.find((record) => record.id === resultRecord.id);
  if (result) {
    Object.assign(result, structuredClone(resultRecord));
  } else {
    state.records.push(structuredClone(resultRecord));
  }
  state.records = state.records.filter((record) => !removedIds.includes(record.id) || record.id === resultRecord.id);
  if (!state.merges.some((item) => item.id === merge.id)) state.merges.unshift(structuredClone(merge));
  state.matches.forEach((item) => {
    if (item.id === merge.matchId) item.status = 'merged';
    else if (removedIds.includes(item.leftId) || removedIds.includes(item.rightId)) item.status = 'rejected';
  });
};

export const statusText = (status: MatchCandidate['status']) =>
  status === 'suggested' ? '待复核' : status === 'confirmed' ? '确认匹配' : status === 'rejected' ? '忽略匹配' : '已合并';

/* ---------------- 裁决应用 ---------------- */

export interface ResolveResult {
  outcome: 'merged' | 'ignored';
  note?: string;
  choice?: 'incoming' | 'center';
  fields?: Record<string, 'incoming' | 'center'>;
}

const applyRecordField = (record: ArchiveRecord, field: FieldKey, source: ArchiveRecord) => {
  if (field === 'people' || field === 'places') {
    (record as unknown as Record<string, string[]>)[field] = structuredClone(
      (source as unknown as Record<string, string[]>)[field]
    );
  } else {
    (record as unknown as Record<string, string>)[field] =
      (source as unknown as Record<string, string>)[field];
  }
};

/** 记录类裁决并入时，中心未动过、且县馆相对基准有更新的字段自动并入，只对真正冲突的字段走人工选择 */
const applyCleanFields = (existing: ArchiveRecord, incoming: ArchiveRecord, base: ArchiveRecord | undefined, conflictFields: Set<string>) => {
  FIELD_LABELS.forEach(([field]) => {
    if (conflictFields.has(field)) return;
    if (base && fieldValue(base, field) === fieldValue(existing, field) &&
        fieldValue(incoming, field) !== fieldValue(base, field)) {
      applyRecordField(existing, field, incoming);
    }
  });
};

export const resolveArbitration = (state: ArchiveState, item: ArbitrationItem, resolution: ResolveResult): string => {
  const at = new Date().toISOString();
  let detail = '';

  if (resolution.outcome === 'ignored') {
    item.status = 'ignored';
    item.resolution = { at, outcome: 'ignored', note: resolution.note ?? '' };
    detail = `忽略来自「${item.stationName}」的改动：${item.title}`;
    return detail;
  }

  if (item.kind === 'record-upsert') {
    const change = item.change as RecordChange;
    const incoming = change.record;
    const base = change.base;
    const existing = state.records.find((record) => record.id === incoming.id);
    const conflictFields = new Set(item.fields.map((affected) => affected.field));
    if (resolution.choice === 'incoming' || !existing) {
      if (existing) Object.assign(existing, structuredClone(incoming), { status: existing.status });
      else state.records.push(structuredClone(incoming));
      detail = `裁决采用县馆「${item.stationName}」版本：${item.title}`;
    } else if (resolution.fields) {
      // 先自动并入同一记录上不冲突的字段（县馆改了、中心没动），再对冲突字段按选择覆盖
      applyCleanFields(existing, incoming, base, conflictFields);
      Object.entries(resolution.fields).forEach(([field, side]) => {
        if (side === 'incoming') applyRecordField(existing, field as FieldKey, incoming);
      });
      const incomingLabels = Object.entries(resolution.fields)
        .filter(([, side]) => side === 'incoming').map(([field]) => fieldLabel(field));
      detail = `裁决按字段合并「${item.stationName}」与中心版本：${item.title}（冲突字段采用县馆：${incomingLabels.join('、') || '无'}，其余无冲突字段已自动汇入）`;
    } else {
      // 全部保留中心：冲突字段保留中心值，但县馆改了而中心未动的无冲突字段仍应汇入
      applyCleanFields(existing, incoming, base, conflictFields);
      detail = `裁决保留中心版本：${item.title}（县馆侧无冲突的字段更新已自动汇入）`;
    }
  } else if (item.kind === 'decision') {
    const change = item.change as DecisionChange;
    const match = state.matches.find((candidate) => candidate.id === change.matchId);
    if (resolution.choice === 'incoming') {
      if (match) {
        match.status = change.status;
        match.reviewedAt = change.reviewedAt;
        state.records.forEach((record) => {
          if ((record.id === change.leftId || record.id === change.rightId) && change.status === 'confirmed' && record.status === 'unreviewed') {
            record.status = 'confirmed';
          }
        });
      }
      detail = `裁决采用县馆「${item.stationName}」结论（${statusText(change.status)}）：${item.title}`;
    } else {
      detail = `裁决保留中心结论：${item.title}`;
    }
  } else {
    const change = item.change as MergeChange;
    if (resolution.choice === 'incoming') {
      applyMergeChange(state, change);
      detail = `裁决采用县馆「${item.stationName}」的合并结果：${item.title}`;
    } else {
      detail = `裁决保留中心未合并状态：${item.title}`;
    }
  }

  item.status = 'resolved';
  item.resolution = {
    at,
    outcome: 'merged',
    choice: resolution.choice,
    fields: resolution.fields,
    note: resolution.note ?? ''
  };
  return detail;
};

/** 评分受记录编辑影响时刷新，避免裁决后展示陈旧分值 */
export const refreshScoresTouching = (state: ArchiveState, recordIds: string[]) => {
  const touched = new Set(recordIds);
  state.matches.forEach((match) => {
    if (!touched.has(match.leftId) && !touched.has(match.rightId)) return;
    if (match.status !== 'suggested') return;
    const left = state.records.find((record) => record.id === match.leftId);
    const right = state.records.find((record) => record.id === match.rightId);
    if (left && right) {
      const scored = scorePair(left, right);
      match.score = scored.score;
      match.fieldScores = scored.fieldScores;
      match.reasons = scored.reasons;
    }
  });
};
