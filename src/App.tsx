import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, FieldKey, MatchCandidate, RecordGroup,
  SyncPackage, BasePack, ChangePack, ArbitrationItem
} from './types';
import { computeMatches, fieldValue } from './utils/matching';
import {
  FIELD_LABELS, adoptBasePack, buildBasePack, buildChangePack,
  ingestChangePack, parseSyncPack, refreshScoresTouching, resolveArbitration
} from './utils/sync';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-archive-state-v2';
const LEGACY_STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const fieldLabels = FIELD_LABELS;

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const shortId = (id: string) => id.replace(/^pack-(base|change)-/, '').slice(0, 8);

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};

const downloadJson = (filename: string, payload: unknown) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  // 离线同步
  const syncOpen = useSignal(false);
  const syncTab = useSignal(0);
  const syncRaw = useSignal('');
  const syncFileName = useSignal('');
  const syncNote = useSignal('');
  const ingestSummary = useSignal('');
  const pendingBasePack = useSignal<BasePack | null>(null);
  const arbFilter = useSignal<'pending' | 'resolved' | 'ignored' | 'all'>('pending');
  const selectedArbIds = useSignal<string[]>([]);
  const arbFieldChoice = useStore<Record<string, Record<string, 'incoming' | 'center'>>>({});

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit,
    stationId: state.stationId,
    stationName: state.stationName,
    stationRole: state.stationRole,
    fork: state.fork,
    packages: state.packages,
    arbitrations: state.arbitrations,
    provenance: state.provenance
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
    state.stationId = next.stationId ?? state.stationId;
    state.stationName = next.stationName ?? state.stationName;
    state.stationRole = next.stationRole ?? state.stationRole;
    state.fork = next.fork;
    state.packages = next.packages ?? [];
    state.arbitrations = next.arbitrations ?? [];
    state.provenance = next.provenance ?? {};
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  const commit = (action: string, detail: string, recordIds: string[] = []) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds });
    state.audit = state.audit.slice(0, 300);
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
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < .68).length);
  const pendingArbitrations = useComputed$(() => state.arbitrations.filter((item) => item.status === 'pending'));
  const visibleArbitrations = useComputed$(() => state.arbitrations
    .filter((item) => arbFilter.value === 'all' || item.status === arbFilter.value));

  const heldRecordIds = useComputed$(() => {
    const ids = new Set<string>();
    pendingArbitrations.value.forEach((item) => item.recordIds.forEach((id) => ids.add(id)));
    return ids;
  });

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    capture();
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    commit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId]);
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    capture();
    ids.forEach((id) => {
      const match = state.matches.find((item) => item.id === id);
      if (!match) return;
      match.status = status;
      match.reviewedAt = new Date().toISOString();
    });
    commit('批量复核', `${ids.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}`, ids.flatMap((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? [match.leftId, match.rightId] : [];
    }));
    selectedMatchIds.value = [];
    notify(`已批量处理 ${ids.length} 条匹配`);
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => { choices[field] = 'A'; });
    mergeOpen.value = true;
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
    });
    const merged: ArchiveRecord = {
      ...left,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      status: 'merged',
      updatedAt: new Date().toISOString()
    };
    state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
    state.matches.forEach((item) => {
      if (item.id === match.id) item.status = 'merged';
      else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) item.status = 'rejected';
    });
    state.merges.unshift({
      id: crypto.randomUUID(),
      matchId: match.id,
      leftId: left.id,
      rightId: right.id,
      resultId: merged.id,
      chosen: { ...choices },
      values,
      mergedAt: new Date().toISOString()
    });
    commit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`, [left.id, right.id, merged.id]);
    mergeOpen.value = false;
    notify('记录已合并，来源与字段选择已写入审计记录');
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
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
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
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
      state.records.push(record);
    });
    // 重算候选时保留已有复核结论，避免导入新记录把离线期间的确认/忽略冲回待复核
    const previousMatches = new Map(state.matches.map((match) => [match.id, match]));
    state.matches = computeMatches(state.records).map((fresh) => {
      const previous = previousMatches.get(fresh.id);
      return previous && previous.status !== 'suggested'
        ? { ...fresh, status: previous.status, reviewedAt: previous.reviewedAt }
        : fresh;
    });
    commit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录`, []);
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录并重新匹配`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  /* ---------------- 离线包：接收 ---------------- */

  const syncFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    syncRaw.value = await file.text();
    syncFileName.value = file.name;
    ingestSummary.value = '';
    pendingBasePack.value = null;
  });

  const inspectPack = $(() => {
    const raw = syncRaw.value.trim();
    if (!raw) return;
    let pack: SyncPackage;
    try {
      pack = parseSyncPack(raw);
    } catch (error) {
      notify((error as Error).message || '离线包无法解析');
      return;
    }
    if (pack.kind === 'base') {
      // 基准包会替换本机工作区，必须二次确认
      pendingBasePack.value = pack as BasePack;
      ingestSummary.value = '';
      return;
    }
    pendingBasePack.value = null;
    const changePack = pack as ChangePack;
    const duplicate = state.packages.some((receipt) => receipt.packageId === changePack.id);
    if (duplicate) {
      ingestSummary.value = `重复包：${changePack.stationName} 的核对包 ${shortId(changePack.id)} 已入账，未重复并入。`;
      state.packages.unshift({
        id: crypto.randomUUID(),
        packageId: changePack.id,
        kind: 'change',
        stationId: changePack.stationId,
        stationName: changePack.stationName,
        importedAt: new Date().toISOString(),
        baseHash: changePack.baseHash,
        note: changePack.note,
        records: changePack.changes.filter((change) => change.kind === 'record-upsert').length,
        decisions: changePack.changes.filter((change) => change.kind === 'decision').length,
        merges: changePack.changes.filter((change) => change.kind === 'merge').length,
        arbitrated: 0,
        duplicate: true
      });
      commit('重复离线包已忽略', `核对包 ${shortId(changePack.id)}（来自 ${changePack.stationName}）重复带回，按包身份去重，未重复入账`, []);
      return;
    }
    if (state.stationRole === 'county') {
      ingestSummary.value = '本机处于县馆离线模式，县馆改动包需带回中心核对室合并。';
      return;
    }
    capture();
    const touchedRecordIds = changePack.changes
      .filter((change) => change.kind === 'record-upsert' && state.records.some((record) => record.id === change.record.id))
      .map((change) => (change as { record: ArchiveRecord }).record.id);
    const result = ingestChangePack(state, changePack);
    refreshScoresTouching(state, touchedRecordIds);
    state.packages.unshift({
      id: crypto.randomUUID(),
      packageId: changePack.id,
      kind: 'change',
      stationId: changePack.stationId,
      stationName: changePack.stationName,
      importedAt: new Date().toISOString(),
      baseHash: changePack.baseHash,
      note: changePack.note,
      records: result.recordChanges,
      decisions: result.decisions,
      merges: result.merges,
      arbitrated: result.arbitrated,
      duplicate: false
    });
    const affectedIds = [...new Set(changePack.changes.flatMap((change) =>
      change.kind === 'record-upsert' ? [change.record.id] : change.kind === 'decision' ? [change.leftId, change.rightId] : [change.resultRecord.id]))];
    commit(
      '接收离线核对包',
      `并入 ${changePack.stationName} 核对包 ${shortId(changePack.id)}：${result.applied} 项无冲突直接汇入，${result.arbitrated} 项进入待裁决队列`,
      affectedIds
    );
    ingestSummary.value = `包 ${shortId(changePack.id)}（${changePack.stationName}）共 ${result.received} 项改动：${result.applied} 项已汇入，${result.arbitrated} 项因快照变化或结论分歧进入待裁决。`;
    syncRaw.value = '';
    syncFileName.value = '';
    if (result.arbitrated > 0) syncTab.value = 1;
    notify(result.arbitrated > 0 ? `已接收核对包，${result.arbitrated} 项待裁决` : '核对包已全部无冲突汇入');
  });

  const confirmAdoptBase = $(() => {
    const pack = pendingBasePack.value;
    if (!pack) return;
    const duplicate = state.packages.some((receipt) => receipt.packageId === pack.id);
    capture();
    adoptBasePack(state, pack);
    state.stationRole = 'county';
    if (!duplicate) {
      state.packages.unshift({
        id: crypto.randomUUID(),
        packageId: pack.id,
        kind: 'base',
        stationId: pack.centerStationId,
        stationName: pack.centerStationName,
        importedAt: new Date().toISOString(),
        baseHash: pack.baseHash,
        note: pack.note,
        records: pack.records.length,
        decisions: 0,
        merges: pack.merges.length,
        arbitrated: 0,
        duplicate: false
      });
    }
    commit('接收基准快照包', `载入 ${pack.centerStationName} 下发的基准包 ${shortId(pack.id)}，本机进入县馆离线模式（快照 ${pack.baseHash.slice(0, 18)}…）`, []);
    pendingBasePack.value = null;
    syncRaw.value = '';
    syncFileName.value = '';
    ingestSummary.value = `已按基准包 ${shortId(pack.id)} 建立离线工作区，可开始核对；完成后在「离线工作」页签导出核对包带回中心。`;
    notify('已载入基准快照，进入县馆离线模式');
  });

  /* ---------------- 离线包：导出 ---------------- */

  const exportBase = $(async () => {
    const pack = await buildBasePack(state, syncNote.value.trim() || undefined);
    downloadJson(`基准快照包-${shortId(pack.id)}.json`, pack);
    commit('导出基准快照包', `向县馆下发基准包 ${shortId(pack.id)}，含 ${pack.records.length} 条记录、${pack.matches.length} 条匹配（快照 ${pack.baseHash.slice(0, 18)}…）`, []);
    notify('基准快照包已导出，可交给县馆核对员');
  });

  const exportChange = $(async () => {
    if (!state.fork) {
      notify('本机尚未接收中心基准快照包，无法定位离线改动');
      return;
    }
    const pack = await buildChangePack(state, state.fork, syncNote.value.trim() || undefined);
    if (!pack.changes.length) {
      notify('相对基准快照没有改动，无需导出');
      return;
    }
    downloadJson(`离线核对包-${state.stationName}-${shortId(pack.id)}.json`, pack);
    commit('导出离线核对包', `核对包 ${shortId(pack.id)} 含 ${pack.changes.length} 项改动（记录 ${pack.changes.filter((c) => c.kind === 'record-upsert').length}、结论 ${pack.changes.filter((c) => c.kind === 'decision').length}、合并 ${pack.changes.filter((c) => c.kind === 'merge').length}），基准 ${shortId(pack.basePackageId)}`, []);
    notify(`离线核对包已生成，共 ${pack.changes.length} 项改动，带回中心后在「接收」页签并入`);
  });

  const exportFinal = $(() => {
    const held = heldRecordIds.value;
    const exportedRecords = state.records.filter((record) => !held.has(record.id));
    const payload = {
      exportedAt: new Date().toISOString(),
      stationName: state.stationName,
      pendingArbitration: pendingArbitrations.value.length,
      heldByArbitration: [...held],
      records: exportedRecords,
      matches: state.matches,
      merges: state.merges,
      packages: state.packages,
      audit: state.audit
    };
    downloadJson(`档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`, payload);
    commit('导出最终核对结果', `导出 ${exportedRecords.length} 条已确认记录；${held.size} 条因待裁决未决暂不进入最终核对包`, [...held]);
    notify(held.size ? `已导出，${held.size} 条待裁决记录未纳入` : '最终核对结果已导出');
  });

  /* ---------------- 待裁决 ---------------- */

  const fieldChoice = (item: ArbitrationItem, field: string): 'incoming' | 'center' =>
    arbFieldChoice[item.id]?.[field] ?? 'incoming';

  const setFieldChoice = (item: ArbitrationItem, field: string, side: 'incoming' | 'center') => {
    if (!arbFieldChoice[item.id]) arbFieldChoice[item.id] = {};
    arbFieldChoice[item.id][field] = side;
  };

  const resolveItem = $((item: ArbitrationItem, outcome: 'merged' | 'ignored', choice?: 'incoming' | 'center') => {
    capture();
    const fields = item.kind === 'record-upsert' && outcome === 'merged' && !choice
      ? Object.fromEntries(item.fields.map((affected) => [affected.field, fieldChoice(item, affected.field)]))
      : undefined;
    const detail = resolveArbitration(state, item, { outcome, choice, fields });
    commit(outcome === 'ignored' ? '待裁决项已忽略' : '待裁决项已并入', detail, item.recordIds);
    selectedArbIds.value = selectedArbIds.value.filter((id) => id !== item.id);
    notify(outcome === 'ignored' ? '该改动已忽略并记录' : '裁决结果已并入核对工作区');
  });

  const bulkResolve = $((outcome: 'merged' | 'ignored', choice?: 'incoming' | 'center') => {
    const items = pendingArbitrations.value.filter((item) => selectedArbIds.value.includes(item.id));
    if (!items.length) return;
    capture();
    items.forEach((item) => {
      const detail = resolveArbitration(state, item, { outcome, choice });
      state.revision += 1;
      state.audit.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        action: outcome === 'ignored' ? '批量忽略待裁决项' : '批量裁决并入',
        detail,
        recordIds: item.recordIds
      });
    });
    state.audit = state.audit.slice(0, 300);
    selectedArbIds.value = [];
    notify(`已批量处理 ${items.length} 个待裁决项`);
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

  useVisibleTask$(() => {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) raw = legacy;
      }
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ArchiveState>;
        restore(JSON.stringify(saved));
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => snapshot());
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
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
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); syncOpen.value = true; return; }
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

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `${state.stationRole === 'county' ? '县馆离线' : '中心'} · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button ghost sync-button" onClick$={() => { syncOpen.value = true; syncTab.value = pendingArbitrations.value.length ? 1 : 0; }}>
            离线包同步{pendingArbitrations.value.length > 0 && <span class="arb-badge">{pendingArbitrations.value.length}</span>}
          </button>
          <button class="button light" onClick$={exportFinal}>导出最终核对结果</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>县馆离线核对包按包身份与快照三向合并：无冲突直接汇入，结论分歧进入待裁决，确认前不进入最终核对包。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class={pendingArbitrations.value.length ? 'danger' : ''}><strong>{pendingArbitrations.value.length}</strong><span>待裁决改动</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并</span>
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
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
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
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条{heldRecordIds.value.size > 0 ? ` · ${heldRecordIds.value.size} 条待裁决挂起` : ''}</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => {
              const held = heldRecordIds.value.has(record.id);
              const source = state.provenance[record.id];
              return (
                <div class={`table-row ${held ? 'held' : ''}`} key={record.id}>
                  <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                  <strong>{record.title}{source && <em class="source-tag" title={`来自离线包：${source.stationName}`}>{source.stationName}</em>}</strong>
                  <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                  <code>{record.identifier}</code>
                  <span class={`record-status ${held ? 'arbitration' : record.status}`}>{held ? '待裁决' : record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
                </div>
              );
            })}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const left = recordById(state, activeMatch.value!.leftId)!;
                const right = recordById(state, activeMatch.value!.rightId)!;
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack"><button class="button primary wide" onClick$={openMerge}>逐字段合并</button><div class="split-actions"><button class="button confirm" onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                const source = state.provenance[merge.id];
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}{source && <em class="source-tag">{source.stationName}</em>}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开记录导入窗口</span></div><div><kbd>Ctrl/⌘ + Shift + O</kbd><span>打开离线包同步中心</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>离线合并与保护规则</h3></div></div>
          <p>每个离线包带唯一身份与基准快照哈希，中心按包身份去重，按快照做三向比较，不再整体替换本机工作区。</p>
          <div class="rule-row"><span>1</span><p>无冲突改动直接汇入；快照变化或两人结论不同，先进入待裁决队列并列明影响字段。</p></div>
          <div class="rule-row"><span>2</span><p>待裁决项确认前，相关记录不进入最终核对包；并入与忽略动作都写入审计轨迹。</p></div>
          <div class="rule-row"><span>3</span><p>包台账、待裁决队列和审计记录均离线保存，重开浏览器后继续处理。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。县馆离线时新增的记录会自动进入离线核对包。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const left = recordById(state, activeMatch.value!.leftId)!;
            const right = recordById(state, activeMatch.value!.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。选择后，生成一条新合并记录，原记录编号与选择依据仍保留在审计轨迹中。县馆侧执行的合并会作为一项改动进入离线核对包。</Modal.Description>
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
          })()}
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={syncOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel sync-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">OFFLINE SYNC</span><Modal.Title>离线包同步中心</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">县馆核对员离线工作后把核对包带回中心；系统按包身份与基准快照定位每条改动，重复包不重复入账。</Modal.Description>

          <div class="sync-tabs">
            <button class={syncTab.value === 0 ? 'on' : ''} onClick$={() => syncTab.value = 0}>接收核对包</button>
            <button class={syncTab.value === 1 ? 'on' : ''} onClick$={() => syncTab.value = 1}>待裁决队列{pendingArbitrations.value.length > 0 && <span class="arb-badge">{pendingArbitrations.value.length}</span>}</button>
            <button class={syncTab.value === 2 ? 'on' : ''} onClick$={() => syncTab.value = 2}>包台账</button>
            <button class={syncTab.value === 3 ? 'on' : ''} onClick$={() => syncTab.value = 3}>离线工作</button>
          </div>

          {syncTab.value === 0 && <div class="sync-pane">
            <div class="sync-drop">
              <label class="file-button wide-file">选择离线包文件（基准包或县馆核对包）<input type="file" accept=".json" onChange$={(event, element) => syncFile(event, element)} /></label>
              {syncFileName.value && <div class="file-name">已读取：{syncFileName.value}</div>}
              <textarea class="sync-textarea" value={syncRaw.value} onInput$={(event) => { syncRaw.value = (event.target as HTMLTextAreaElement).value; pendingBasePack.value = null; ingestSummary.value = ''; }} placeholder="也可直接粘贴离线包 JSON 内容……" />
            </div>

            {pendingBasePack.value && <div class="base-warning">
              <strong>检测到基准快照包：{pendingBasePack.value.centerStationName} → 本机</strong>
              <p>载入后将以基准快照替换本机工作区（{pendingBasePack.value.records.length} 条记录、{pendingBasePack.value.matches.length} 条匹配），本机切换为「县馆离线模式」。快照哈希 {pendingBasePack.value.baseHash}。该操作可撤销。</p>
              <div class="sync-actions">
                <button class="button ghost" onClick$={() => { pendingBasePack.value = null; syncRaw.value = ''; syncFileName.value = ''; }}>取消</button>
                <button class="button primary" onClick$={confirmAdoptBase}>确认替换并进入离线模式</button>
              </div>
            </div>}

            {ingestSummary.value && <div class={`ingest-summary ${ingestSummary.value.includes('重复') || ingestSummary.value.includes('需带回中心') ? 'warn' : ''}`}>{ingestSummary.value}</div>}

            <div class="sync-actions right">
              <button class="button primary" disabled={!syncRaw.value.trim() || !!pendingBasePack.value} onClick$={inspectPack}>解析并并入</button>
            </div>
          </div>}

          {syncTab.value === 1 && <div class="sync-pane">
            <div class="toolbar-row arb-toolbar">
              <select class="input" value={arbFilter.value} onChange$={(event) => { arbFilter.value = (event.target as HTMLSelectElement).value as typeof arbFilter.value; }}>
                <option value="pending">待裁决</option><option value="resolved">已并入</option><option value="ignored">已忽略</option><option value="all">全部</option>
              </select>
              {arbFilter.value === 'pending' && <>
                <button class="button small" disabled={!selectedArbIds.value.length} onClick$={() => bulkResolve('merged', 'incoming')}>批量采用县馆</button>
                <button class="button small" disabled={!selectedArbIds.value.length} onClick$={() => bulkResolve('merged', 'center')}>批量保留中心</button>
                <button class="button small ghost" disabled={!selectedArbIds.value.length} onClick$={() => bulkResolve('ignored')}>批量忽略</button>
              </>}
              <span class="arb-count">已选 {selectedArbIds.value.length} / {pendingArbitrations.value.length} 待裁决</span>
            </div>
            <div class="arb-list">
              {visibleArbitrations.value.map((item) => <div class={`arb-card ${item.status}`} key={item.id}>
                <div class="arb-head">
                  {item.status === 'pending' && <Checkbox.Root
                    class="qwik-check"
                    aria-label="选择待裁决项"
                    initialValue={selectedArbIds.value.includes(item.id)}
                    onClick$={() => {
                      selectedArbIds.value = selectedArbIds.value.includes(item.id)
                        ? selectedArbIds.value.filter((id) => id !== item.id)
                        : [...selectedArbIds.value, item.id];
                    }}
                  ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>}
                  <span class={`arb-kind kind-${item.kind}`}>{item.kind === 'record-upsert' ? '记录改动' : item.kind === 'decision' ? '复核结论' : '记录合并'}</span>
                  <strong>{item.title}</strong>
                  <span class="arb-package">涉事包 {shortId(item.packageId)} · {item.stationName}</span>
                  <span class={`arb-state state-${item.status}`}>{item.status === 'pending' ? '待裁决' : item.status === 'resolved' ? '已并入' : '已忽略'}</span>
                </div>
                <p class="arb-reason">{item.reason}</p>
                <div class="arb-fields">
                  <div class="arb-field-head"><span>影响字段</span><span>基准快照</span><span>中心当前</span><span>县馆来包</span></div>
                  {item.fields.map((affected) => <div class="arb-field-row" key={affected.field}>
                    <span>{affected.label}</span>
                    <span>{affected.base || '—'}</span>
                    <span class="center-val">{affected.center || '—'}</span>
                    <span class="incoming-val">{affected.incoming || '—'}</span>
                  </div>)}
                </div>
                {item.kind === 'record-upsert' && item.status === 'pending' && <div class="arb-pick-line">
                  逐字段选择并入值：
                  {item.fields.map((affected) => <label class="mini-pick" key={affected.field}>
                    <span>{affected.label}</span>
                    <select value={fieldChoice(item, affected.field)} onChange$={(event) => setFieldChoice(item, affected.field, (event.target as HTMLSelectElement).value as 'incoming' | 'center')}>
                      <option value="incoming">取县馆</option><option value="center">留中心</option>
                    </select>
                  </label>)}
                </div>}
                {item.status === 'pending' ? <div class="sync-actions">
                  {item.kind === 'record-upsert'
                    ? <><button class="button small primary" onClick$={() => resolveItem(item, 'merged')}>按所选字段并入</button><button class="button small" onClick$={() => resolveItem(item, 'merged', 'incoming')}>全部采用县馆</button><button class="button small ghost" onClick$={() => resolveItem(item, 'merged', 'center')}>全部保留中心</button></>
                    : <><button class="button small primary" onClick$={() => resolveItem(item, 'merged', 'incoming')}>采用县馆{item.kind === 'decision' ? '结论' : '合并'}</button><button class="button small ghost" onClick$={() => resolveItem(item, 'merged', 'center')}>保留中心现状</button></>}
                  <button class="button small danger" onClick$={() => resolveItem(item, 'ignored')}>忽略此改动</button>
                </div> : <div class="arb-resolved">{item.resolution?.note || ''} · {item.resolution ? new Date(item.resolution.at).toLocaleString('zh-CN') : ''}</div>}
              </div>)}
              {!visibleArbitrations.value.length && <div class="empty-state">没有{arbFilter.value === 'pending' ? '待裁决' : arbFilter.value === 'resolved' ? '已并入' : arbFilter.value === 'ignored' ? '已忽略' : ''}的条目。无冲突改动会直接汇入，不占裁决队列。</div>}
            </div>
          </div>}

          {syncTab.value === 2 && <div class="sync-pane">
            <div class="ledger-table">
              <div class="ledger-head"><span>包身份</span><span>类型</span><span>来源 / 去向</span><span>入账时间</span><span>改动</span><span>快照哈希</span><span>备注</span></div>
              {state.packages.map((receipt) => <div class="ledger-row" key={receipt.id}>
                <code>{shortId(receipt.packageId)}</code>
                <span>{receipt.kind === 'base' ? '基准快照' : '县馆改动'}</span>
                <span>{receipt.stationName}</span>
                <span>{new Date(receipt.importedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                <span>{receipt.kind === 'change' ? `记${receipt.records} / 结${receipt.decisions} / 合${receipt.merges}，裁${receipt.arbitrated}` : `${receipt.records} 条记录基线`}</span>
                <code class="hash">{receipt.baseHash.slice(7, 17)}</code>
                <span>{receipt.duplicate ? '重复包' : receipt.note || '—'}</span>
              </div>)}
              {!state.packages.length && <div class="empty-state">还没有入账过离线包。</div>}
            </div>
          </div>}

          {syncTab.value === 3 && <div class="sync-pane">
            <div class="station-card">
              <div class="station-row">
                <label>本机身份
                  <select value={state.stationRole} onChange$={(event) => { state.stationRole = (event.target as HTMLSelectElement).value as 'center' | 'county'; }}>
                    <option value="center">中心核对室</option><option value="county">县馆核对员（离线）</option>
                  </select>
                </label>
                <label>站点名称<input value={state.stationName} onInput$={(event) => { state.stationName = (event.target as HTMLInputElement).value; }} /></label>
                <label>站点编号<input value={state.stationId} onInput$={(event) => { state.stationId = (event.target as HTMLInputElement).value; }} /></label>
              </div>

              {state.stationRole === 'center' ? <div class="flow-box">
                <strong>中心 → 县馆：下发基准快照</strong>
                <p>导出当前工作区快照（记录、匹配、既有合并与快照哈希），县馆载入后据此定位离线改动。</p>
                <input class="input" placeholder="包备注（可选，如：第二批县馆巡回）" value={syncNote.value} onInput$={(event) => syncNote.value = (event.target as HTMLInputElement).value} />
                <button class="button primary" onClick$={exportBase}>导出基准快照包</button>
              </div> : <div class="flow-box">
                <strong>县馆 → 中心：带回离线核对包</strong>
                {state.fork ? <>
                  <p>基准来自 {state.fork.centerStationName}（包 {shortId(state.fork.packageId)}，{new Date(state.fork.exportedAt).toLocaleDateString('zh-CN')} 下发，快照 {state.fork.baseHash.slice(0, 18)}…）。本机的确认、忽略、合并与记录改动将按该快照逐条定位。</p>
                  <input class="input" placeholder="包备注（可选，如：临河县馆 王芳 9月30日）" value={syncNote.value} onInput$={(event) => syncNote.value = (event.target as HTMLInputElement).value} />
                  <button class="button primary" onClick$={exportChange}>导出离线核对包</button>
                </> : <p class="warn-text">本机尚未接收中心基准快照包。请先在「接收核对包」页签载入基准包，再开始离线核对。</p>}
              </div>}
            </div>
          </div>}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
