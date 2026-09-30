import { seedState } from '../src/data/seed';
import {
  adoptBasePack, buildBasePack, buildChangePack, ingestChangePack,
  refreshScoresTouching, resolveArbitration
} from '../src/utils/sync';
import type { ArbitrationItem, ArchiveState, ChangePack, MatchCandidate } from '../src/types';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else { console.error(`✗ ${msg}`); failures += 1; }
}

const findMatch = (state: ArchiveState, leftId: string, rightId: string): MatchCandidate =>
  state.matches.find((m) => m.leftId === leftId && m.rightId === rightId)!;

const countyFromBase = (base: Awaited<ReturnType<typeof buildBasePack>>, name: string, id: string): ArchiveState => {
  const state = seedState();
  adoptBasePack(state, clone(base));
  state.stationName = name;
  state.stationId = id;
  return state;
};

async function main() {
  /* ---- 场景 0：基准快照包哈希稳定 ---- */
  const center0 = seedState();
  const baseA = await buildBasePack(center0);
  const baseB = await buildBasePack(seedState());
  assert(baseA.baseHash === baseB.baseHash, '相同内容产生相同快照哈希');

  /* ---- 场景 1：重复包不重复入账；干净改动直接汇入 ---- */
  const center = seedState();
  const base = await buildBasePack(center, '首轮下发');
  const county1 = countyFromBase(base, '临河县馆-王芳', 'st-c1');

  const m1 = findMatch(county1, 'a-001', 'b-001');
  m1.status = 'confirmed';
  m1.reviewedAt = '2026-09-29T08:00:00Z';
  county1.records.find((r) => r.id === 'a-007')!.rights = '王芳核对：家属授权';
  const pack1: ChangePack = clone(await buildChangePack(county1, county1.fork!, '王芳9月29'));
  assert(pack1.changes.length === 2, `改动包识别出2项改动（实际 ${pack1.changes.length}）`);

  const first = ingestChangePack(center, pack1);
  assert(first.applied === 2 && first.arbitrated === 0, `首包2项全部干净汇入（applied=${first.applied}, arbitrated=${first.arbitrated}）`);
  assert(findMatch(center, 'a-001', 'b-001').status === 'confirmed', '县馆的确认结论已汇入');
  assert(center.records.find((r) => r.id === 'a-007')!.rights === '王芳核对：家属授权', '县馆的字段修改已汇入');

  const again = ingestChangePack(center, clone(pack1));
  assert(again.applied === 2 && again.arbitrated === 0, '重复包再次接收不产生新裁决');
  const confirmedMatches = center.matches.filter((m) => m.status === 'confirmed').length;
  ingestChangePack(center, clone(pack1));
  assert(center.matches.filter((m) => m.status === 'confirmed').length === confirmedMatches, '重复包重复接收后结论计数不变（幂等）');

  /* ---- 场景 2：两人对同一匹配给出不同结论 → 待裁决 ---- */
  const center2 = seedState();
  const base2 = await buildBasePack(center2);
  const cA = countyFromBase(base2, '县馆甲', 'st-a');
  const cB = countyFromBase(base2, '县馆乙', 'st-b');
  findMatch(cA, 'a-002', 'b-002').status = 'confirmed';
  findMatch(cA, 'a-002', 'b-002').reviewedAt = '2026-09-29T08:00:00Z';
  findMatch(cB, 'a-002', 'b-002').status = 'rejected';
  findMatch(cB, 'a-002', 'b-002').reviewedAt = '2026-09-29T09:00:00Z';
  const packA = clone(await buildChangePack(cA, cA.fork!));
  const packB = clone(await buildChangePack(cB, cB.fork!));

  const rA = ingestChangePack(center2, packA);
  assert(rA.applied === 1, '县馆甲先到：干净汇入确认');
  const rB = ingestChangePack(center2, packB);
  assert(rB.arbitrated === 1 && rB.applied === 0, '县馆乙相反结论后到：进入待裁决，不覆盖先前结论');
  assert(findMatch(center2, 'a-002', 'b-002').status === 'confirmed', '裁决前中心仍保留先到的确认结论（后到包不盖掉先前）');
  assert(center2.arbitrations.length === 1, '待裁决队列有1项');
  const arb0 = center2.arbitrations[0];
  assert(arb0.fields[0].base === '待复核' && arb0.fields[0].center === '确认匹配' && arb0.fields[0].incoming === '忽略匹配',
    '裁决项列出基准/中心/县馆三方结论');
  assert(arb0.packageId === packB.id && arb0.stationName === '县馆乙', '裁决项标明涉事包与来源站点');

  // 裁决：采用县馆乙
  const detailB = resolveArbitration(center2, arb0, { outcome: 'merged', choice: 'incoming' });
  assert(findMatch(center2, 'a-002', 'b-002').status === 'rejected', '裁决采用县馆乙后结论变为忽略');
  assert(arb0.status === 'resolved' && detailB.includes('县馆乙'), '裁决项标记已并入并留痕');

  /* ---- 场景 3：中心改过同一字段 → 快照变化待裁决，逐字段选择 ---- */
  const center3 = seedState();
  const base3 = await buildBasePack(center3);
  const county3 = countyFromBase(base3, '县馆丙', 'st-c3');
  center3.records.find((r) => r.id === 'a-005')!.notes = '中心修订：盐运档案共三盘';
  county3.records.find((r) => r.id === 'a-005')!.notes = '县馆补注：分上下两盘';
  county3.records.find((r) => r.id === 'a-007')!.extent = '01:05:00（县馆实测）';
  const pack3 = clone(await buildChangePack(county3, county3.fork!));
  const r3 = ingestChangePack(center3, pack3);
  assert(r3.applied === 1 && r3.arbitrated === 1, `同字段分歧进裁决、无冲突字段直接汇入（applied=${r3.applied}, arbitrated=${r3.arbitrated}）`);
  assert(center3.records.find((r) => r.id === 'a-007')!.extent === '01:05:00（县馆实测）', '无冲突的数量字段直接汇入');
  const arb3 = center3.arbitrations.find((a) => a.kind === 'record-upsert')!;
  assert(arb3.fields.length === 1 && arb3.fields[0].field === 'notes', '裁决项只列出真正冲突的影响字段（notes）');
  assert(arb3.fields[0].center.includes('中心修订') && arb3.fields[0].incoming.includes('县馆补注'), '列出中心当前值与县馆来包值');

  // 逐字段：保留中心
  resolveArbitration(center3, arb3, { outcome: 'merged', fields: { notes: 'center' } });
  assert(center3.records.find((r) => r.id === 'a-005')!.notes === '中心修订：盐运档案共三盘', '逐字段裁决保留中心值');
  assert(arb3.status === 'resolved', '记录裁决项已标记解决');

  /* ---- 场景 3b：同一记录冲突字段 + 无冲突字段，裁决保留中心时无冲突字段仍自动汇入 ---- */
  const center3b = seedState();
  const base3b = await buildBasePack(center3b);
  const county3b = countyFromBase(base3b, '县馆丙B', 'st-c3b');
  center3b.records.find((r) => r.id === 'a-001')!.title = '中心改了标题（分歧）';
  county3b.records.find((r) => r.id === 'a-001')!.title = '县馆改了标题（分歧）';
  county3b.records.find((r) => r.id === 'a-001')!.extent = '02:15:00（县馆只改了数量）';
  const pack3b = clone(await buildChangePack(county3b, county3b.fork!));
  const r3b = ingestChangePack(center3b, pack3b);
  assert(r3b.arbitrated === 1 && r3b.applied === 0, '混合改动整体进裁决（避免半应用）');
  const arb3b = center3b.arbitrations[0];
  resolveArbitration(center3b, arb3b, { outcome: 'merged', choice: 'center' });
  assert(center3b.records.find((r) => r.id === 'a-001')!.title === '中心改了标题（分歧）', '裁决保留中心：冲突标题保留中心');
  assert(center3b.records.find((r) => r.id === 'a-001')!.extent === '02:15:00（县馆只改了数量）', '裁决保留中心：县馆独改的无冲突数量字段仍自动汇入');

  // 逐字段裁决取县馆标题时，无冲突数量字段同样汇入
  const center3c = seedState();
  const base3c = await buildBasePack(center3c);
  const county3c = countyFromBase(base3c, '县馆丙C', 'st-c3c');
  center3c.records.find((r) => r.id === 'a-001')!.title = '中心标题C';
  county3c.records.find((r) => r.id === 'a-001')!.title = '县馆标题C';
  county3c.records.find((r) => r.id === 'a-001')!.medium = '数字录音（县馆核载体）';
  const pack3c = clone(await buildChangePack(county3c, county3c.fork!));
  ingestChangePack(center3c, pack3c);
  const arb3c = center3c.arbitrations[0];
  resolveArbitration(center3c, arb3c, { outcome: 'merged', fields: { title: 'incoming' } });
  const rec3c = center3c.records.find((r) => r.id === 'a-001')!;
  assert(rec3c.title === '县馆标题C' && rec3c.medium === '数字录音（县馆核载体）', '逐字段取县馆标题，无冲突载体字段一并汇入');

  /* ---- 场景 4：中心删除记录后县馆又编辑 → 快照变化 → 可忽略 ---- */
  const center4 = seedState();
  const base4 = await buildBasePack(center4);
  const county4 = countyFromBase(base4, '县馆丁', 'st-c4');
  center4.records = center4.records.filter((r) => r.id !== 'a-003');
  county4.records.find((r) => r.id === 'a-003')!.title = '张惠兰与县立女子中学（补访）';
  const pack4 = clone(await buildChangePack(county4, county4.fork!));
  const r4 = ingestChangePack(center4, pack4);
  assert(r4.arbitrated === 1, '中心删除、县馆编辑：进入待裁决');
  const arb4 = center4.arbitrations[0];
  assert(arb4.reason.includes('已删除'), '说明原因为中心快照变化（记录已删除）');
  resolveArbitration(center4, arb4, { outcome: 'ignored' });
  assert(!center4.records.some((r) => r.id === 'a-003'), '忽略后记录不恢复，确认前未进入最终数据');
  assert(arb4.status === 'ignored', '裁决项标记为已忽略并保留在队列中');

  /* ---- 场景 5：县馆合并动作干净汇入；重复合并不重复入账 ---- */
  const center5 = seedState();
  const base5 = await buildBasePack(center5);
  const county5 = countyFromBase(base5, '县馆戊', 'st-c5');
  // 模拟县馆在本地执行合并
  const left = county5.records.find((r) => r.id === 'a-006')!;
  const right = county5.records.find((r) => r.id === 'b-006')!;
  const merged: ArchiveState['records'][number] = {
    ...left, id: 'merged-006', title: '刘绍安医案抄本（手稿合校）', status: 'merged', updatedAt: '2026-09-29T10:00:00Z'
  };
  county5.records = [...county5.records.filter((r) => r.id !== 'a-006' && r.id !== 'b-006'), merged];
  const mm = findMatch(county5, 'a-006', 'b-006');
  mm.status = 'merged';
  county5.merges.unshift({
    id: 'merge-006', matchId: mm.id, leftId: 'a-006', rightId: 'b-006', resultId: 'merged-006',
    chosen: {}, values: { title: merged.title }, mergedAt: '2026-09-29T10:00:00Z'
  });
  const pack5 = clone(await buildChangePack(county5, county5.fork!));
  const mergeChanges = pack5.changes.filter((c) => c.kind === 'merge').length;
  assert(mergeChanges === 1, `改动包含1项合并（实际 ${mergeChanges}），且被吞掉的原记录不重复上报`);
  const r5 = ingestChangePack(center5, pack5);
  assert(r5.merges === 1 && center5.records.some((r) => r.id === 'merged-006'), '县馆合并已并入中心');
  assert(!center5.records.some((r) => r.id === 'a-006') && !center5.records.some((r) => r.id === 'b-006'), '原始两条记录按合并动作移除');
  const r5b = ingestChangePack(center5, clone(pack5));
  assert(center5.merges.filter((m) => m.id === 'merge-006').length === 1, '重复合并包不产生重复合并结果');
  void r5b;

  /* ---- 场景 6：县馆新增记录会补算匹配候选 ---- */
  const center6 = seedState();
  const base6 = await buildBasePack(center6);
  const county6 = countyFromBase(base6, '县馆己', 'st-c6');
  const before = county6.matches.length;
  county6.records.push({
    id: 'new-b-100', group: 'B', title: '李秀珍女士口述访谈记录（副本）', date: '2019-04-12',
    people: ['李秀珍', '周明远'], places: ['临河县', '河口村'], identifier: 'OH-2019-001-X',
    medium: '数字音频', extent: '2小时14分', rights: '仅限研究使用', notes: '',
    updatedAt: '2026-09-29T11:00:00Z', status: 'unreviewed'
  });
  // 县馆本地重算候选（模拟真实 UI 导入流程）
  const { computeMatches } = await import('../src/utils/matching');
  county6.matches = computeMatches(county6.records);
  assert(county6.matches.length > before, '县馆侧为新记录算出候选');
  const pack6 = clone(await buildChangePack(county6, county6.fork!));
  const r6 = ingestChangePack(center6, pack6);
  assert(r6.arbitrated === 0, '新记录无冲突');
  assert(center6.records.some((r) => r.id === 'new-b-100'), '县馆新增记录已汇入');
  assert(center6.matches.some((m) => m.rightId === 'new-b-100'), '中心为新到记录补算了匹配候选');

  /* ---- 场景 7：来源 provenance 与评分刷新不影响已复核项 ---- */
  refreshScoresTouching(center, ['a-007']);
  assert(findMatch(center, 'a-001', 'b-001').status === 'confirmed', '评分刷新不改变已复核结论');
  assert(!!center.provenance['a-007'] && center.provenance['a-007'].packageId === pack1.id, '汇入实体记录了来源包身份');

  console.log(failures === 0 ? '\n全部场景通过' : `\n${failures} 个断言失败`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
