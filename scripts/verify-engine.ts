// 引擎逻辑端到端验证（node 运行编译产物）
import { seedState } from '../src/data/seed';
import { applyPatch, augmentMatches, beginOfflineSession, issueWorkPackage, mergePackageIntoState, recordDecision, recordEdited, recordMerge, resolveConflictApply, resolveConflictIgnore, sealReturnPackage } from '../src/utils/offline';
import type { ArchiveRecord, ArchiveState, OfflinePackage } from '../src/types';

let failures = 0;
const assert = (name: string, condition: boolean, extra = '') => {
  if (condition) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name} ${extra}`); }
};

const makeStationCopy = (center: ArchiveState, station: string) => {
  const wp = issueWorkPackage(center, station);
  const { session, state } = beginOfflineSession(wp);
  return { wp, session, state: state as ArchiveState };
};

// 场景一：无冲突改动直接汇入
console.log('场景一：无冲突改动直接汇入');
{
  const center = seedState();
  const station = makeStationCopy(center, '临河县馆');
  const target = station.state.records.find((r) => r.id === 'a-001')!;
  const edited = applyPatch(target, { notes: '离线补充的备注' });
  station.state.records = station.state.records.map((r) => (r.id === 'a-001' ? edited : r));
  recordEdited(station.session, target, { notes: '离线补充的备注' });

  const suggested = station.state.matches.find((m) => m.status === 'suggested')!;
  station.state.matches.find((m) => m.id === suggested.id)!.status = 'confirmed';
  recordDecision(station.session, {
    kind: 'match-decision', matchId: suggested.id, leftId: suggested.leftId, rightId: suggested.rightId,
    status: 'confirmed', at: new Date().toISOString(), reviewedAt: new Date().toISOString()
  });

  const pkg: OfflinePackage = sealReturnPackage(station.session, [
    { id: 'offline-au-1', at: new Date().toISOString(), action: '离线核对', detail: '县馆完成', recordIds: [] }
  ]);
  const result = mergePackageIntoState(center, pkg);
  augmentMatches(center);
  assert('2 项改动全部直接汇入', result.applied === 2, `applied=${result.applied}`);
  assert('无待裁决项', result.conflicted === 0);
  assert('县馆备注已写入中心', center.records.find((r) => r.id === 'a-001')!.notes === '离线补充的备注');
  assert('匹配结论已确认', center.matches.find((m) => m.id === suggested.id)!.status === 'confirmed');
  assert('包进入台账', center.receivedPackages.some((p) => p.packageId === pkg.packageId));
  assert('县馆审计轨迹已并入', center.audit.some((a) => a.id === 'offline-au-1'));
  assert('匹配标记来源县馆', center.matches.find((m) => m.id === suggested.id)!.decidedByStation === '临河县馆');
}

// 场景二：重复包不重复入账
console.log('场景二：重复包不重复入账');
{
  const center = seedState();
  const station = makeStationCopy(center, '临河县馆');
  recordEdited(station.session, station.state.records[0], { notes: '只提交一次' });
  station.state.records[0] = applyPatch(station.state.records[0], { notes: '只提交一次' });
  const pkg = sealReturnPackage(station.session, []);
  mergePackageIntoState(center, pkg);
  const notesAfterFirst = center.records[0].notes;
  const second = mergePackageIntoState(center, pkg);
  assert('第二次提交识别为重复包', second.duplicated === true);
  assert('记录未被二次处理', center.records[0].notes === notesAfterFirst);
  assert('台账仍只有 1 条', center.receivedPackages.filter((p) => p.packageId === pkg.packageId).length === 1);
}

// 场景三：同字段快照变化 → 待裁决；不同字段直接汇入
console.log('场景三：字段编辑的快照冲突');
{
  const center = seedState();
  const station = makeStationCopy(center, '怀远县馆');
  const base = station.state.records.find((r) => r.id === 'a-002')!;
  // 县馆改 notes 和 rights
  station.state.records = station.state.records.map((r) => r.id === 'a-002' ? applyPatch(r, { notes: '县馆新备注', rights: '县馆新授权' }) : r);
  recordEdited(station.session, base, { notes: '县馆新备注', rights: '县馆新授权' });
  // 中心同期也改 notes（同字段冲突），但不动 rights
  center.records = center.records.map((r) => r.id === 'a-002' ? applyPatch(r, { notes: '中心新备注' }) : r);

  const pkg = sealReturnPackage(station.session, []);
  const result = mergePackageIntoState(center, pkg);
  assert('1 项进入待裁决', result.conflicted === 1, `conflicted=${result.conflicted}`);
  const conflict = center.pendingConflicts[0];
  assert('冲突类型为快照变化', conflict.kind === 'snapshot-changed-edit');
  assert('列出影响字段仅 notes', conflict.fields.length === 1 && conflict.fields[0].field === 'notes', `fields=${conflict.fields.map((f) => f.field).join(',')}`);
  assert('三向值齐全（基线/中心/来值）', conflict.fields[0].base === '第三页有手写补记' && conflict.fields[0].current === '中心新备注' && conflict.fields[0].incoming === '县馆新备注');
  assert('确认前县馆 notes 不进入最终记录', center.records.find((r) => r.id === 'a-002')!.notes === '中心新备注');
  assert('非冲突字段 rights 已直接汇入', center.records.find((r) => r.id === 'a-002')!.rights === '县馆新授权');
  assert('列出涉事包', conflict.packageId === pkg.packageId && conflict.station === '怀远县馆');

  resolveConflictApply(center, conflict.id, '测试采纳');
  assert('采纳后县馆值进入最终记录', center.records.find((r) => r.id === 'a-002')!.notes === '县馆新备注');
  assert('裁决动作写入审计', center.audit.some((a) => a.action === '裁决采纳'));
}

// 场景四：两人对同一匹配给出不同结论 → 待裁决；相同结论幂等
console.log('场景四：结论不同待裁决');
{
  const center = seedState();
  const matchId = center.matches[0].id;
  // 中心已忽略
  center.matches[0].status = 'rejected';
  const station = makeStationCopy(center, '定远县馆');
  // 县馆在同一匹配上确认
  recordDecision(station.session, {
    kind: 'match-decision', matchId, leftId: station.state.matches[0].leftId, rightId: station.state.matches[0].rightId,
    status: 'confirmed', at: new Date().toISOString(), reviewedAt: new Date().toISOString()
  });
  const pkg = sealReturnPackage(station.session, []);
  const result = mergePackageIntoState(center, pkg);
  assert('结论冲突进入待裁决', result.conflicted === 1 && center.pendingConflicts[0].kind === 'conclusion-mismatch');
  assert('确认前中心结论保持忽略', center.matches[0].status === 'rejected');
  assert('冲突展示中心结论与县馆来值', center.pendingConflicts[0].fields[0].current === '忽略' && center.pendingConflicts[0].fields[0].incoming === '确认');
  resolveConflictIgnore(center, center.pendingConflicts[0].id);
  assert('忽略后中心结论仍为忽略', center.matches[0].status === 'rejected');
  assert('忽略动作写入审计', center.audit.some((a) => a.action === '裁决忽略'));

  // 相同结论重复提交：幂等
  const station2 = makeStationCopy(center, '定远县馆');
  const target = station2.state.matches.find((m) => m.id === matchId)!;
  recordDecision(station2.session, {
    kind: 'match-decision', matchId, leftId: target.leftId, rightId: target.rightId,
    status: 'rejected', at: new Date().toISOString(), reviewedAt: new Date().toISOString()
  });
  const pkg2 = sealReturnPackage(station2.session, []);
  const r2 = mergePackageIntoState(center, pkg2);
  assert('相同结论幂等汇入、无冲突', r2.applied === 1 && r2.conflicted === 0);
}

// 场景五：合并的快照冲突与直接合并
console.log('场景五：离线合并');
{
  // 5a 快照一致直接合并
  const center = seedState();
  const station = makeStationCopy(center, '蒙城县馆');
  const match = station.state.matches[0];
  const left = station.state.records.find((r) => r.id === match.leftId)!;
  const right = station.state.records.find((r) => r.id === match.rightId)!;
  const values = { title: `${left.title}；${right.title}` };
  const mergedRecordId = 'rec-merged-1';
  recordMerge(station.session, { matchId: match.id, left, right, chosen: { title: 'combine' }, values, mergedRecordId });
  station.state.records = [...station.state.records.filter((r) => r.id !== left.id && r.id !== right.id), { ...left, ...values, id: mergedRecordId, status: 'merged' } as ArchiveRecord];
  const pkg = sealReturnPackage(station.session, []);
  const result = mergePackageIntoState(center, pkg);
  assert('快照一致时合并直接执行', result.applied === 1 && result.conflicted === 0);
  assert('中心生成合并记录', center.records.some((r) => r.id === mergedRecordId));
  assert('合并追溯带来源包', center.merges[0]?.station === '蒙城县馆');

  // 5b 中心改过待合并记录 → 合并冲突待裁决
  const center2 = seedState();
  const station2 = makeStationCopy(center2, '利辛县馆');
  const match2 = station2.state.matches[0];
  const left2 = station2.state.records.find((r) => r.id === match2.leftId)!;
  const right2 = station2.state.records.find((r) => r.id === match2.rightId)!;
  recordMerge(station2.session, { matchId: match2.id, left: left2, right: right2, chosen: { title: 'A' }, values: { title: left2.title }, mergedRecordId: 'rec-merged-2' });
  // 中心同期修改左侧标题
  center2.records = center2.records.map((r) => r.id === left2.id ? applyPatch(r, { title: '中心改过的标题' }) : r);
  const pkg2 = sealReturnPackage(station2.session, []);
  const result2 = mergePackageIntoState(center2, pkg2);
  assert('快照变化时合并进入待裁决', result2.conflicted === 1 && center2.pendingConflicts[0].kind === 'snapshot-changed-merge');
  assert('确认前原记录仍保留', center2.records.some((r) => r.id === left2.id) && center2.records.some((r) => r.id === right2.id));
  assert('列出漂移字段', center2.pendingConflicts[0].fields.some((f) => f.field === 'title'));
  resolveConflictApply(center2, center2.pendingConflicts[0].id);
  assert('裁决采纳后执行合并', center2.records.some((r) => r.id === 'rec-merged-2'));
}

// 场景六：离线重开后续做（会话可序列化重建）
console.log('场景六：离线重开继续处理');
{
  const center = seedState();
  const station = makeStationCopy(center, '涡阳县馆');
  recordEdited(station.session, station.state.records[0], { notes: '第一天的改动' });
  // 模拟重开：从工作包重建会话（改动另存）
  const resumed = beginOfflineSession(station.wp);
  resumed.session.changes = station.session.changes;
  recordEdited(resumed.session, resumed.state.records[1], { notes: '第二天的改动' });
  const pkg = sealReturnPackage(resumed.session, []);
  assert('跨重开的改动都在包内', pkg.changes.length === 2);
  const result = mergePackageIntoState(center, pkg);
  assert('重开后改动仍正常汇入', result.applied === 2);
}

// 场景七：新增记录 + 增量匹配
console.log('场景七：新增记录汇入与增量匹配');
{
  const center = seedState();
  const before = center.records.length;
  const station = makeStationCopy(center, '五河县馆');
  const fresh: ArchiveRecord = {
    id: 'rec-new-1', group: 'B', title: '李秀珍口述史访谈（补遗）', date: '2019-04-12',
    people: ['李秀珍'], places: ['临河县', '河口村'], identifier: 'OH-LXZ-2019-01B',
    medium: '数字录音', extent: '12分钟', rights: '研究者授权', notes: '',
    updatedAt: new Date().toISOString(), status: 'unreviewed'
  };
  station.state.records.push(fresh);
  station.session.changes.push({ kind: 'add-record', record: fresh });
  const pkg = sealReturnPackage(station.session, []);
  mergePackageIntoState(center, pkg);
  const created = augmentMatches(center);
  assert('新增记录进入中心', center.records.length === before + 1);
  assert('为新增记录生成匹配建议', created >= 1, `created=${created}`);

  // 重复编号新增 → 冲突
  const station2 = makeStationCopy(center, '五河县馆');
  station2.session.changes.push({ kind: 'add-record', record: fresh });
  const pkg2 = sealReturnPackage(station2.session, []);
  const r2 = mergePackageIntoState(center, pkg2);
  assert('编号重复的新增进入待裁决', r2.conflicted === 1 && center.pendingConflicts[0].kind === 'duplicate-add');
}

// 场景八（附加）：同一县馆多类改动混合 + 重复提交 + 裁决后台账数字
console.log('场景八：混合包与台账');
{
  const center = seedState();
  const station = makeStationCopy(center, '凤台县馆');
  // 编辑
  const r0 = station.state.records[0];
  station.state.records[0] = applyPatch(r0, { medium: '离线改载体' });
  recordEdited(station.session, r0, { medium: '离线改载体' });
  // 确认一条
  const m = station.state.matches.find((x) => x.status === 'suggested')!;
  m.status = 'confirmed';
  recordDecision(station.session, { kind: 'match-decision', matchId: m.id, leftId: m.leftId, rightId: m.rightId, status: 'confirmed', at: new Date().toISOString(), reviewedAt: new Date().toISOString() });
  // 合并一条（另选匹配避免与确认冲突）
  const m2 = station.state.matches.filter((x) => x.id !== m.id && x.status === 'suggested')[0];
  const l = station.state.records.find((r) => r.id === m2.leftId)!;
  const rr = station.state.records.find((r) => r.id === m2.rightId)!;
  recordMerge(station.session, { matchId: m2.id, left: l, right: rr, chosen: { title: 'A' }, values: { title: l.title }, mergedRecordId: 'rec-mix-merge' });

  const pkg = sealReturnPackage(station.session, []);
  const first = mergePackageIntoState(center, pkg);
  assert('混合包 3 项全部汇入', first.applied === 3 && first.conflicted === 0, `applied=${first.applied}`);
  const info = center.receivedPackages[0];
  assert('台账记录 3 项改动、0 待裁决', info.changeCount === 3 && info.applied === 3 && info.conflicted === 0);
  const dup = mergePackageIntoState(center, pkg);
  assert('再次提交为重复包', dup.duplicated && info.duplicate === true);
  assert('审计含重复包忽略记录', center.audit.some((a) => a.action === '重复包忽略'));
}

console.log(failures ? `\n${failures} 项断言失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
