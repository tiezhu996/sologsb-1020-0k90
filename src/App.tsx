import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, AuditEntry, FieldKey, MatchCandidate,
  OfflineChange, OfflineEditedRecord, OfflinePackage, OfflineSession,
  OfflineWorkPackage, RecordGroup
} from './types';
import { computeMatches, fieldValue } from './utils/matching';
import { seedState } from './data/seed';
import {
  PACKAGE_STORAGE_KEY, applyPatch, augmentMatches, beginOfflineSession,
  fieldLabelOf, issueWorkPackage, mergePackageIntoState,
  newId, recordAdded, recordDecision, recordEdited, recordMerge,
  resolveConflictApply, resolveConflictIgnore, sealReturnPackage
} from './utils/offline';

const STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

/** 县馆本机保存的离线工作台 */
interface OfflineStore {
  workPackage: OfflineWorkPackage;
  session: OfflineSession;
  state: Pick<ArchiveState, 'revision' | 'records' | 'matches' | 'merges' | 'audit'>;
  audit: AuditEntry[];
  sealedPackage: OfflinePackage | null;
}

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};

const downloadJson = (name: string, payload: unknown) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

/**
 * 当前视图操作的工作区：县馆离线时直接返回离线副本（必须返回底层可变对象本身，
 * 不能返回新包装对象，否则合并等场景对 records/matches 的整体替换不会落回 store），
 * 中心模式返回中心工作区。
 */
const getWorkspace = (center: ArchiveState, store: OfflineStore | null): ArchiveState =>
  store ? (store.state as unknown as ArchiveState) : center;

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const offlineHolder = useStore<{ value: OfflineStore | null }>({ value: null });
  const offline = offlineHolder;
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const issueOpen = useSignal(false);
  const receiveOpen = useSignal(false);
  const editOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const receiveRaw = useSignal('');
  const receiveText = useSignal('');
  const stationName = useSignal('临河县馆');
  const editRecordId = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);
  const conflictFilter = useSignal<'open' | 'resolved'>('open');

  const workspace = (): ArchiveState => getWorkspace(state, offline.value);

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit,
    offline: offline.value
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const hydrateInto = (target: ArchiveState, saved: Partial<ArchiveState>) => {
    target.revision = saved.revision ?? target.revision;
    target.records = saved.records ?? target.records;
    target.matches = saved.matches ?? target.matches;
    target.merges = saved.merges ?? target.merges;
    target.audit = saved.audit ?? target.audit;
    target.receivedPackages = saved.receivedPackages ?? [];
    target.pendingConflicts = saved.pendingConflicts ?? [];
    target.offlineSession = saved.offlineSession ?? null;
  };

  const restore = (raw: string) => {
    const saved = JSON.parse(raw) as Partial<ArchiveState> & { offline?: OfflineStore | null };
    hydrateInto(state, saved);
    if (saved.offline) {
      offline.value = saved.offline;
      state.offlineSession = saved.offline.session;
    }
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  const localAudit = (action: string, detail: string, recordIds: string[] = [], extra: Partial<AuditEntry> = {}) => {
    const target = offline.value ?? null;
    const entry: AuditEntry = {
      id: newId('au'), at: new Date().toISOString(), action, detail, recordIds,
      packageId: target?.session.packageId, station: target?.session.station,
      ...extra
    };
    if (target) {
      target.audit = [entry, ...target.audit].slice(0, 500);
      target.state.audit = [entry, ...target.state.audit].slice(0, 500);
      target.state.revision += 1;
    } else {
      state.revision += 1;
      state.audit = [entry, ...state.audit].slice(0, 500);
    }
    return entry;
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
  });

  const filteredRecords = useComputed$(() => {
    const ws = workspace();
    const term = query.value.trim().toLowerCase();
    return ws.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => workspace().matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => workspace().matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictCount = useComputed$(() => workspace().matches.filter((match) => match.status === 'suggested' && match.score < .68).length);
  const openConflicts = useComputed$(() => state.pendingConflicts.filter((item) => !item.resolution));
  const shownConflicts = useComputed$(() => conflictFilter.value === 'open'
    ? state.pendingConflicts.filter((item) => !item.resolution)
    : state.pendingConflicts.filter((item) => item.resolution));
  const pendingChangeCount = useComputed$(() => offline.value?.session.changes.length ?? 0);

  const updateMatch = $((id: string, status: Extract<MatchCandidate['status'], 'confirmed' | 'rejected'>) => {
    const ws = workspace();
    const match = ws.matches.find((item) => item.id === id);
    if (!match) return;
    capture();
    const reviewedAt = new Date().toISOString();
    match.status = status;
    match.reviewedAt = reviewedAt;
    ws.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    if (offline.value) {
      recordDecision(offline.value.session, {
        kind: 'match-decision', matchId: match.id, leftId: match.leftId, rightId: match.rightId,
        status, at: reviewedAt, reviewedAt
      });
    }
    localAudit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(ws, match), [match.leftId, match.rightId]);
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: Extract<MatchCandidate['status'], 'confirmed' | 'rejected'>) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    const ws = workspace();
    capture();
    const touched: string[] = [];
    ids.forEach((id) => {
      const match = ws.matches.find((item) => item.id === id);
      if (!match) return;
      const reviewedAt = new Date().toISOString();
      match.status = status;
      match.reviewedAt = reviewedAt;
      touched.push(match.leftId, match.rightId);
      if (offline.value) {
        recordDecision(offline.value.session, {
          kind: 'match-decision', matchId: match.id, leftId: match.leftId, rightId: match.rightId,
          status, at: reviewedAt, reviewedAt
        });
      }
    });
    localAudit('批量复核', `${ids.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}`, [...new Set(touched)]);
    selectedMatchIds.value = [];
    notify(`已批量处理 ${ids.length} 条匹配`);
  });

  /* ---------- 逐字段合并 ---------- */
  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const openMerge = $(() => {
    const ws = workspace();
    const match = activeMatch.value;
    if (!match) return;
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => { choices[field] = 'A'; });
    mergeOpen.value = true;
  });

  const mergeCurrent = $(() => {
    const ws = workspace();
    const match = activeMatch.value;
    if (!match) return;
    const left = ws.records.find((record) => record.id === match.leftId);
    const right = ws.records.find((record) => record.id === match.rightId);
    if (!left || !right) return;
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
    });
    const mergedRecordId = newId('rec');
    const merged: ArchiveRecord = {
      ...left,
      ...values,
      people: values.people?.split(/[；;、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；;、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      id: mergedRecordId,
      status: 'merged',
      updatedAt: new Date().toISOString()
    };
    ws.records = [...ws.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
    ws.matches.forEach((item) => {
      if (item.id === match.id) item.status = 'merged';
      else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) item.status = 'rejected';
    });
    ws.merges.unshift({
      id: newId('mg'), matchId: match.id, leftId: left.id, rightId: right.id,
      chosen: { ...choices }, values, mergedAt: new Date().toISOString(), mergedRecordId,
      packageId: offline.value?.session.packageId, station: offline.value?.session.station
    });
    if (offline.value) {
      recordMerge(offline.value.session, {
        matchId: match.id, left, right, chosen: { ...choices }, values, mergedRecordId
      });
    }
    localAudit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`, [left.id, right.id, mergedRecordId]);
    mergeOpen.value = false;
    notify(offline.value ? '合并已记入离线改动，回传时按快照核对' : '记录已合并，来源与字段选择已写入审计记录');
  });

  /* ---------- 记录编辑（同时是产生字段级冲突的入口） ---------- */
  const editDraft = useStore<{ title: string; date: string; people: string; places: string; identifier: string; medium: string; extent: string; rights: string; notes: string }>({
    title: '', date: '', people: '', places: '', identifier: '', medium: '', extent: '', rights: '', notes: ''
  });

  const openEdit = $((recordId: string) => {
    const ws = workspace();
    const record = ws.records.find((item) => item.id === recordId);
    if (!record) return;
    editRecordId.value = recordId;
    fieldLabels.forEach(([field]) => {
      (editDraft as Record<string, string>)[field] = fieldValue(record, field);
    });
    editOpen.value = true;
  });

  const saveEdit = $(() => {
    const ws = workspace();
    const current = ws.records.find((item) => item.id === editRecordId.value);
    if (!current) return;
    capture();
    const patch: OfflineEditedRecord['patch'] = {};
    fieldLabels.forEach(([field]) => {
      const raw = (editDraft as Record<string, string>)[field];
      if (field === 'people' || field === 'places') {
        const next = raw.split(/[；;、,，]/).map((item) => item.trim()).filter(Boolean);
        if (next.join('|') !== current[field].join('|')) patch[field] = next;
      } else if (raw !== String(current[field])) {
        patch[field] = raw;
      }
    });
    if (!Object.keys(patch).length) { editOpen.value = false; return; }
    const changed: FieldKey[] = fieldLabels.map(([field]) => field).filter((field) => patch[field] !== undefined);
    const updated = applyPatch(current, patch);
    const index = ws.records.findIndex((item) => item.id === current.id);
    ws.records[index] = updated;
    if (offline.value) recordEdited(offline.value.session, current, patch);
    localAudit('编辑记录字段', `「${current.title}」修改 ${changed.map((field) => fieldLabelOf(field)).join('、')}`, [current.id]);
    editOpen.value = false;
    notify(offline.value ? '字段改动已记入离线包，回传时按快照定位' : '字段改动已保存到中心工作区');
  });

  /* ---------- 普通导入 ---------- */
  const parseImport = $(() => {
    const ws = workspace();
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('{') || raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    const created: ArchiveRecord[] = [];
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: newId('rec'),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed'
      };
      ws.records.push(record);
      created.push(record);
      if (offline.value) recordAdded(offline.value.session, record);
    });
    if (!offline.value) ws.matches = computeMatches(ws.records);
    localAudit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录`, created.map((record) => record.id));
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录${offline.value ? '，计入离线改动' : '并重新匹配'}`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  /* ---------- 中心：检出工作包 ---------- */
  const issuePackage = $(() => {
    capture();
    const workPackage = issueWorkPackage(state, stationName.value);
    const { session, state: offlineState } = beginOfflineSession(workPackage);
    offline.value = {
      workPackage,
      session,
      state: offlineState as OfflineStore['state'],
      audit: [],
      sealedPackage: null
    };
    state.offlineSession = session;
    localAudit('检出离线工作包', `向 ${session.station} 发放工作包 ${session.packageId}（基线 r${session.baseRevision}），本机已切换为离线工作台`);
    issueOpen.value = false;
    downloadJson(`离线工作包-${session.station}-${new Date().toISOString().slice(0, 10)}.json`, workPackage);
    notify(`已为 ${session.station} 检出工作包并进入离线工作台`);
  });

  /* ---------- 县馆：封包回传 ---------- */
  const sealPackage = $(() => {
    if (!offline.value) return;
    if (!offline.value.session.changes.length) { notify('当前离线会话还没有任何改动'); return; }
    const sealed = sealReturnPackage(offline.value.session, offline.value.audit);
    offline.value.sealedPackage = sealed;
    localAudit('封发离线核对包', `打包 ${sealed.changes.length} 项改动回传中心，包身份 ${sealed.packageId}`);
    downloadJson(`离线核对包-${offline.value.session.station}-${new Date().toISOString().slice(0, 10)}.json`, sealed);
    notify('核对包已生成并下载，回到中心「接回离线包」即可合并');
  });

  /** 县馆重开后继续处理：载入工作包文件并恢复本机会话 */
  const loadWorkPackageFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as OfflineWorkPackage;
      if (parsed.kind !== 'offline-work-package') throw new Error('bad kind');
      capture();
      const { session, state: offlineState } = beginOfflineSession(parsed);
      offline.value = {
        workPackage: parsed,
        session,
        state: offlineState as OfflineStore['state'],
        audit: [],
        sealedPackage: null
      };
      state.offlineSession = session;
      localAudit('重开离线工作台', `县馆 ${session.station} 重新打开工作包 ${session.packageId}，继续离线处理`);
      notify(`已重开 ${session.station} 的离线工作台`);
    } catch {
      notify('文件不是有效的离线工作包');
    }
  });

  const exitOffline = $(() => {
    if (!offline.value) return;
    capture();
    offline.value = null;
    state.offlineSession = null;
    notify('已回到中心工作区');
  });

  /* ---------- 中心：接回核对包并合并 ---------- */
  const receivePackageFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    receiveRaw.value = await file.text();
    receiveText.value = file.name;
  });

  const acceptPackage = $(() => {
    if (offline.value) { notify('县馆离线工作台不能接包，请先回到中心'); return; }
    let pkg: OfflinePackage;
    try {
      pkg = JSON.parse(receiveRaw.value) as OfflinePackage;
      if (pkg.kind !== 'offline-check-package') throw new Error('bad kind');
    } catch {
      notify('文件不是有效的离线核对包');
      return;
    }
    capture();
    const outcome = mergePackageIntoState(state, pkg);
    const newMatches = augmentMatches(state);
    if (newMatches) localAudit('补充增量匹配', `接包后为新增记录生成 ${newMatches} 条匹配建议`);
    receiveRaw.value = '';
    receiveText.value = '';
    receiveOpen.value = false;
    if (outcome.duplicated) notify(`检测到重复包（${pkg.station}），未重复入账`);
    else notify(`已接回 ${pkg.station} 核对包：汇入 ${outcome.applied} 项，${outcome.conflicted} 项待裁决${newMatches ? `，新增 ${newMatches} 条匹配` : ''}`);
  });

  /* ---------- 中心：裁决 ---------- */
  const adjudicate = $((conflictId: string, resolution: 'applied' | 'ignored') => {
    capture();
    const ok = resolution === 'applied' ? resolveConflictApply(state, conflictId, '人工裁决确认') : resolveConflictIgnore(state, conflictId, '人工裁决忽略');
    if (ok) notify(resolution === 'applied' ? '已采纳县馆改动并入最终核对包' : '已忽略该改动，中心现状保持不变');
  });

  const exportAudit = $(() => {
    const ws = workspace();
    downloadJson(`档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`, {
      exportedAt: new Date().toISOString(),
      mode: offline.value ? 'offline-station' : 'center',
      records: ws.records, matches: ws.matches, merges: ws.merges, audit: ws.audit,
      receivedPackages: offline.value ? [] : state.receivedPackages,
      pendingConflicts: offline.value ? [] : state.pendingConflicts
    });
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  const kindLabel = (kind: string) => ({
    'snapshot-changed-edit': '快照已变化',
    'conclusion-mismatch': '结论不同',
    'snapshot-changed-merge': '合并快照冲突',
    'target-missing': '目标缺失',
    'duplicate-add': '编号重复'
  }[kind] ?? kind);

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) restore(raw);
      // 县馆重开浏览器后自动恢复离线会话
      const held = localStorage.getItem(PACKAGE_STORAGE_KEY);
      if (held && !offline.value) {
        const parsed = JSON.parse(held) as OfflineStore;
        if (parsed.session?.packageId) {
          offline.value = parsed;
          state.offlineSession = parsed.session;
        }
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(PACKAGE_STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({
      revision: state.revision, records: state.records, matches: state.matches,
      merges: state.merges, audit: state.audit,
      receivedPackages: state.receivedPackages, pendingConflicts: state.pendingConflicts,
      offlineSession: offline.value ? offline.value.session : null,
      offline: offline.value
    }));
    if (!state.hydrated) return;
    localStorage.setItem(STORAGE_KEY, payload);
    if (offline.value) localStorage.setItem(PACKAGE_STORAGE_KEY, JSON.stringify(offline.value));
    else localStorage.removeItem(PACKAGE_STORAGE_KEY);
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  const isOffline = !!offline.value;

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class={`top-stat ${isOffline ? 'offline' : ''}`}>
          <span class={`online-dot ${isOffline ? 'off' : ''}`} />
          {!state.hydrated ? '正在恢复本地工作区'
            : isOffline
              ? `县馆离线 · ${offline.value!.session.station} · ${pendingChangeCount.value} 项待回传`
              : `中心工作区 · r${state.revision}${openConflicts.value.length ? ` · ${openConflicts.value.length} 项待裁决` : ''}`}
        </div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          {isOffline ? <>
            <button class="button ghost" onClick$={() => importOpen.value = true}>导入记录</button>
            <button class="button light" disabled={!pendingChangeCount.value} onClick$={sealPackage}>封包回传</button>
            <button class="button primary" onClick$={exitOffline}>回到中心</button>
          </> : <>
            <button class="button ghost" onClick$={() => issueOpen.value = true}>检出离线工作包</button>
            <button class="button ghost" onClick$={() => receiveOpen.value = true}>接回离线包</button>
            <button class="button light" onClick$={exportAudit}>导出核对包</button>
          </>}
        </div>
      </header>

      {isOffline && (
        <div class="offline-banner">
          <div>
            <strong>{offline.value!.session.station} · 离线核对中</strong>
            <span>包身份 {offline.value!.session.packageId} · 检出基线 r{offline.value!.session.baseRevision} · 改动仅留在本机，封包后回传中心合并</span>
          </div>
          <div class="banner-actions">
            {offline.value!.sealedPackage && <em>已于 {new Date(offline.value!.sealedPackage.returnedAt!).toLocaleString('zh-CN')} 封发，可继续处理后再次封包</em>}
            <button class="button small light" disabled={!pendingChangeCount.value} onClick$={sealPackage}>生成回传包</button>
          </div>
        </div>
      )}

      <div class="overview">
        <div><span class="eyebrow">{isOffline ? 'OFFLINE STATION DESK' : 'RECONCILIATION CENTER'}</span><h2>{isOffline ? `${offline.value!.session.station}离线核对` : '口述史与手稿元数据比对中心'}</h2><p>{isOffline ? '在县馆本机完成核对，封包带回中心；合并按包身份与检出快照定位，重复包不重复入账。' : '离线包按包身份与快照合并，无冲突直接汇入，快照变化或结论不同进入待裁决，确认前不进入最终核对包。'}</p></div>
        <div class="metrics">
          <div><strong>{workspace().records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{workspace().records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{workspace().matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          {isOffline
            ? <div class="warn"><strong>{pendingChangeCount.value}</strong><span>待回传改动</span></div>
            : <div class={openConflicts.value.length ? 'danger' : ''}><strong>{openConflicts.value.length}</strong><span>待裁决项</span></div>}
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并 · C/R 确认忽略</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const ws = workspace();
              const left = recordById(ws, match.leftId);
              const right = recordById(ws, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{match.status === 'suggested' ? '待复核' : match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已忽略' : '已合并'}</span>
                    {match.decidedByStation && <span class="station-tag" title={`由 ${match.decidedByStation} 离线包写入`}>{match.decidedByStation}</span>}
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{match.reasons.join(' · ')}</div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span><span></span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
                <button class="button tiny ghost" onClick$={() => openEdit(record.id)}>编辑</button>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>{isOffline ? '离线会话' : '入账包 / 键盘帮助'}</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const ws = workspace();
                const left = recordById(ws, activeMatch.value!.leftId)!;
                const right = recordById(ws, activeMatch.value!.rightId)!;
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small>{activeMatch.value!.decidedByStation && <small class="station-line">结论来源：{activeMatch.value!.decidedByStation} 离线包</small>}</div></div>
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack"><button class="button primary wide" onClick$={openMerge}>逐字段合并</button><div class="split-actions"><button class="button confirm" onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {workspace().merges.length ? workspace().merges.map((merge) => {
                const ws = workspace();
                const left = ws.records.find((record) => record.id === merge.mergedRecordId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.mergedRecordId ?? '合并记录'}<small>{merge.leftId} + {merge.rightId}</small></summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}{merge.station ? ` · ${merge.station}离线包` : ''}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              {isOffline ? (
                <div class="session-panel">
                  <div><kbd>包身份</kbd><span>{offline.value!.session.packageId}</span></div>
                  <div><kbd>县馆</kbd><span>{offline.value!.session.station}</span></div>
                  <div><kbd>基线</kbd><span>中心 r{offline.value!.session.baseRevision} · {Object.keys(offline.value!.session.baseHashes).length} 条记录快照</span></div>
                  <div><kbd>改动</kbd><span>{pendingChangeCount.value} 项：{countKinds(offline.value!.session.changes)}</span></div>
                  {offline.value!.sealedPackage && <div><kbd>封发</kbd><span>{new Date(offline.value!.sealedPackage.returnedAt!).toLocaleString('zh-CN')}，可带回中心接回</span></div>}
                  <button class="button primary wide" disabled={!pendingChangeCount.value} onClick$={sealPackage}>封发回传核对包</button>
                  <p class="hint">离线重开浏览器会自动恢复本机会话；也可用「检出」时下载的工作包文件重新打开继续处理。</p>
                </div>
              ) : (
                <>
                  <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div>
                </>
              )}
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      {!isOffline && (
        <section class="panel conflict-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">03 / ADJUDICATION QUEUE</span><h3>待裁决队列</h3></div>
            <div class="segmented">
              <button class={conflictFilter.value === 'open' ? 'active' : ''} onClick$={() => conflictFilter.value = 'open'}>待处理 {openConflicts.value.length}</button>
              <button class={conflictFilter.value === 'resolved' ? 'active' : ''} onClick$={() => conflictFilter.value = 'resolved'}>已处理</button>
            </div>
          </div>
          {shownConflicts.value.length ? <div class="conflict-list">
            {shownConflicts.value.map((conflict) => (
              <details class={`conflict-card ${conflict.resolution ?? 'open'}`} key={conflict.id} open={!conflict.resolution}>
                <summary>
                  <span class={`conflict-kind ${conflict.kind}`}>{kindLabel(conflict.kind)}</span>
                  <strong>{conflict.summary}</strong>
                  <span class="conflict-meta">{conflict.station} · {new Date(conflict.receivedAt).toLocaleString('zh-CN')}</span>
                  {conflict.resolution && <em class={`resolution ${conflict.resolution}`}>{conflict.resolution === 'applied' ? '已采纳并入' : '已忽略'}</em>}
                </summary>
                <div class="conflict-body">
                  <div class="package-line">涉事包 <code>{conflict.packageId}</code>{conflict.matchId ? <> · 匹配 <code>{conflict.matchId}</code></> : null}{conflict.recordIds.length ? <> · 影响记录 {conflict.recordIds.map((id) => <code key={id}>{id}</code>)}</> : null}</div>
                  {conflict.fields.length > 0 && <div class="conflict-fields">
                    <div class="cf-head"><span>影响字段</span><span>检出基线</span><span>中心现值</span><span>县馆来值</span></div>
                    {conflict.fields.map((field) => <div class="cf-row" key={field.field}>
                      <span>{field.label}</span>
                      <span class="base">{field.base || '—'}</span>
                      <span class="current">{field.current || '—'}</span>
                      <span class="incoming">{field.incoming || '—'}</span>
                    </div>)}
                  </div>}
                  {!conflict.resolution && <div class="conflict-actions">
                    <button class="button confirm" onClick$={() => adjudicate(conflict.id, 'applied')}>采纳县馆改动并入</button>
                    <button class="button ghost" onClick$={() => adjudicate(conflict.id, 'ignored')}>忽略，保留中心</button>
                  </div>}
                  {conflict.resolutionNote && <p class="resolution-note">{conflict.resolutionNote} · {new Date(conflict.resolvedAt!).toLocaleString('zh-CN')}</p>}
                </div>
              </details>
            ))}
          </div> : <div class="empty-state">{conflictFilter.value === 'open' ? '没有待裁决项。离线包中快照一致、结论不冲突的内容会直接汇入。' : '还没有处理过的裁决项。'}</div>}
        </section>
      )}

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">{isOffline ? '04 / STATION TRACE' : '05 / TRACE'}</span><h3>{isOffline ? '本机处理记录（随包回传）' : '最新处理记录'}</h3></div><span>{workspace().audit.length} 条</span></div>
          <div class="audit-list">
            {workspace().audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong>{entry.station && <small class="station-line">{entry.station}{entry.packageId ? ` · ${entry.packageId.slice(-8)}` : ''}</small>}<p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        {!isOffline && <article class="panel packages-panel">
          <div class="panel-heading"><div><span class="eyebrow">04 / PACKAGE LEDGER</span><h3>已接收离线包台账</h3></div><span>{state.receivedPackages.length} 个</span></div>
          <div class="ledger-list">
            {state.receivedPackages.length ? state.receivedPackages.map((info) => (
              <div class={`ledger-row ${info.duplicate ? 'duplicate' : ''}`} key={info.packageId}>
                <div><strong>{info.station}</strong><code>{info.packageId}</code><small>检出 r{info.baseRevision} · {new Date(info.receivedAt).toLocaleString('zh-CN')}</small></div>
                <div class="ledger-stats">
                  <span>{info.changeCount} 项改动</span>
                  <span class="good">汇入 {info.applied}</span>
                  <span class={info.conflicted ? 'warn' : ''}>待裁决 {info.conflicted}</span>
                  {info.duplicate && <span class="dup-tag">重复提交已忽略</span>}
                </div>
              </div>
            )) : <div class="empty-state">尚未接回过离线核对包。</div>}
          </div>
        </article>}
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      {/* 普通导入 */}
      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。{isOffline ? ' 导入记录会计入离线改动。' : ''}</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入{isOffline ? '并计入离线包' : '并重新匹配'}</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 检出离线工作包 */}
      <Modal.Root bind:show={issueOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel">
          <Modal.Header class="modal-header"><div><span class="eyebrow">CHECK OUT</span><Modal.Title>检出县馆离线工作包</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">按当前中心快照生成工作包并下载，本机随即切换为该县馆的离线工作台。县馆可断网核对，重开浏览器后会话自动恢复；工作会按包身份与快照合并回中心。</Modal.Description>
          <label class="form-label">县馆名称<input class="input" value={stationName.value} onInput$={(event) => stationName.value = (event.target as HTMLInputElement).value} placeholder="如：临河县馆" /></label>
          <div class="snapshot-box">
            <span>基线版本 r{state.revision}</span>
            <span>{state.records.length} 条记录快照</span>
            <span>{state.matches.length} 条匹配</span>
          </div>
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={issuePackage}>检出并切换到离线工作台</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 接回离线核对包 */}
      <Modal.Root bind:show={receiveOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel">
          <Modal.Header class="modal-header"><div><span class="eyebrow">CHECK IN</span><Modal.Title>接回县馆离线核对包</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">按包身份去重（重复包不重复入账）；快照一致、结论不冲突的改动直接汇入；快照变化或结论不同的改动进入待裁决队列，确认前不进入最终核对包。也可以在这里重开县馆工作包继续离线处理。</Modal.Description>
          <label class="file-button wide">选择回传的核对包 JSON<input type="file" accept=".json" onChange$={(event, element) => receivePackageFile(event, element)} /></label>
          {receiveText.value && <div class="file-name">已读取：{receiveText.value}</div>}
          <div class="receive-divider"><span>县馆重开</span></div>
          <label class="file-button wide ghostly">选择离线工作包 JSON 继续处理<input type="file" accept=".json" onChange$={(event, element) => loadWorkPackageFile(event, element)} /></label>
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!receiveRaw.value.trim()} onClick$={acceptPackage}>合并到中心工作区</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 字段编辑 */}
      <Modal.Root bind:show={editOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel edit-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">EDIT FIELDS</span><Modal.Title>编辑记录字段</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">{isOffline ? '改动按检出快照记录，回传中心时若同字段也被修改，将进入待裁决。' : '中心改动会写入审计轨迹；与离线包冲突时以裁决为准。'}</Modal.Description>
          <div class="edit-grid">
            {fieldLabels.map(([field, label]) => <label key={field}><span>{label}</span>
              {field === 'notes'
                ? <textarea class="input" rows={2} value={(editDraft as Record<string, string>)[field]} onInput$={(event) => { (editDraft as Record<string, string>)[field] = (event.target as HTMLTextAreaElement).value; }} />
                : <input class="input" value={(editDraft as Record<string, string>)[field]} onInput$={(event) => { (editDraft as Record<string, string>)[field] = (event.target as HTMLInputElement).value; }} />}
            </label>)}
          </div>
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={saveEdit}>保存改动</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 逐字段合并 */}
      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const ws = workspace();
            const left = recordById(ws, activeMatch.value!.leftId)!;
            const right = recordById(ws, activeMatch.value!.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。选择后，生成一条新合并记录，原记录编号与选择依据仍保留在审计轨迹{isOffline ? '，回传时携带检出快照三方核对' : ''}。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});

const countKinds = (changes: OfflineChange[]): string => {
  const labels: Record<OfflineChange['kind'], string> = {
    'add-record': '新增', 'edit-record': '字段编辑', 'match-decision': '复核结论', 'merge': '合并'
  };
  const tally = new Map<string, number>();
  changes.forEach((change) => tally.set(change.kind, (tally.get(change.kind) ?? 0) + 1));
  return [...tally.entries()].map(([kind, count]) => `${labels[kind as OfflineChange['kind']]} ${count}`).join(' · ');
};
