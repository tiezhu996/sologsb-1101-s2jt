// v3 升级迁移测试：先建 v2 旧库，再首次打开 v3 触发 upgrade
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) passed += 1
  else {
    failed += 1
    console.error('✗', msg)
  }
}

// 1. 用只含 v2 schema 的 Dexie 实例构造旧库（不能先导入 v3 的 db.ts）
const oldDb = new Dexie('gbmuralarch')
oldDb.version(2).stores({
  halls: 'id, name, era, structureType, roofType, updatedAt',
  elements: 'id, hallId, position, status, updatedAt',
  layers: 'id, elementId, level, patternName, pigment',
  decays: 'id, layerId, type, severity, repaired, repairedAt, updatedAt',
  repairSteps: 'id, decayId, seq, name, state, updatedAt'
})
await oldDb.open()
const now = Date.now()
await oldDb.repairSteps.bulkPut([
  { id: 'os1', decayId: 'od1', seq: 1, name: '除尘', material: '软毛刷', operator: '甲', state: '已完成', createdAt: now, updatedAt: now },
  { id: 'os2', decayId: 'od1', seq: 2, name: '回贴', material: '鱼鳔胶', operator: '甲', state: '进行中', createdAt: now, updatedAt: now },
  { id: 'os3', decayId: 'od2', seq: 1, name: '除尘', material: '', operator: '乙', state: '已完成', createdAt: now, updatedAt: now }
])
// od1 旧数据里病害标了未修复（工序实际只完成 1/2）；od2 标了已修复（工序全完成）
await oldDb.decays.bulkPut([
  { id: 'od1', layerId: 'l', type: '起甲', severity: '重度', areaCm2: 1, causeGuess: '', repaired: false, repairedAt: null, createdAt: now, updatedAt: now },
  { id: 'od2', layerId: 'l', type: '龟裂', severity: '轻度', areaCm2: 1, causeGuess: '', repaired: true, repairedAt: now, createdAt: now, updatedAt: now }
])
await oldDb.close()

// 2. 首次导入并打开 v3：执行 upgrade
const { db } = await import('../src/utils/db')
await db.open()

const led = await db.ledgerEntries.toArray()
assert(led.length === 2, '仅两道旧的已完成工序各补一条初始流水')
const byStep = new Map(led.map((e) => [e.stepId, e]))
assert(
  byStep.get('os1')?.kind === 'complete' && byStep.get('os1')?.status === 'accepted' && byStep.get('os1')?.seq === 1,
  'os1 初始流水为已裁决完成、序号 #1'
)
assert(byStep.get('os3')?.seq === 2, 'os1 先更新、os3 次之，序号按接纳顺序递增')
assert(led.every((e) => e.clientId === 'migration-v3'), '初始流水标记迁移来源')
assert(byStep.get('os1')?.operator === '甲' && byStep.get('os1')?.material === '软毛刷', '初始流水保留施工责任人与材料快照')

const steps = await db.repairSteps.toArray()
assert(steps.every((s) => s.ledgerVersion === 1), '全部旧工序打上流水版本标记')
assert(steps.find((s) => s.id === 'os2')?.state === '进行中', '进行中工序现状保持进行中')

const d1 = await db.decays.get('od1')
assert(d1!.repaired === false && d1!.repairedAt === null, '只完成部分工序的病害仍为未修复')
const d2 = await db.decays.get('od2')
assert(d2!.repaired === true && typeof d2!.repairedAt === 'number', '全部工序完成的病害按对账保持已修复并回填时间')

assert((await db.pendingMerges.count()) === 0, '迁移不产生待裁决项')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
