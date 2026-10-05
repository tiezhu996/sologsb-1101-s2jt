// 施工流水核心逻辑测试：node + fake-indexeddb，不经过 Vue/Pinia
// 直接复用 db.ts 的 schema 与迁移、utils/ledger.ts 的纯折叠函数
import 'fake-indexeddb/auto'

import { db } from '../src/utils/db'
import { foldEntries, foldDecayStatus, findReversibleCompleteId } from '../src/utils/ledger'
import type { LedgerEntry, LedgerSubmitInput } from '../src/types/ledger'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) passed += 1
  else {
    failed += 1
    console.error('✗', msg)
  }
}

async function reset(): Promise<void> {
  await db.delete()
  await db.open()
}

async function seedDecayAndStep(state: '未开始' | '进行中' | '已完成' = '未开始'): Promise<void> {
  const now = Date.now()
  await db.halls.put({ id: 'h1', name: '殿', era: '明', structureType: '大木', roofType: '庑殿', createdAt: now, updatedAt: now })
  await db.elements.put({ id: 'e1', hallId: 'h1', position: '梁枋', name: '构件', layerCount: 1, baseLayer: '', status: '观察', createdAt: now, updatedAt: now })
  await db.layers.put({ id: 'l1', elementId: 'e1', level: 1, patternName: '旋子', pigment: '石青', thicknessMm: 1, createdAt: now, updatedAt: now })
  await db.decays.put({ id: 'd1', layerId: 'l1', type: '起甲', severity: '重度', areaCm2: 10, causeGuess: '', repaired: false, repairedAt: null, createdAt: now, updatedAt: now })
  await db.repairSteps.put({ id: 's1', decayId: 'd1', seq: 1, name: '除尘', material: 'm', operator: '甲', state, ledgerVersion: 1, createdAt: now, updatedAt: now })
}

/** 与 ledgerStore.submitEntry 相同的事务裁决逻辑（不含 Pinia / 草稿） */
async function submit(input: LedgerSubmitInput & { id: string; clientId: string }): Promise<{ status: string }> {
  const id = input.id
  return db.transaction(
    'rw',
    [db.ledgerEntries, db.pendingMerges, db.ledgerDrafts, db.repairSteps, db.decays],
    async () => {
      if (await db.ledgerEntries.get(id)) return { status: 'duplicate' }
      if (await db.pendingMerges.get(id)) return { status: 'pending-dup' }
      const all = await db.ledgerEntries.toArray()
      const head = all.reduce((m, e) => Math.max(m, e.seq), 0)
      const doneNow = foldEntries(all).get(input.stepId)?.done ?? false
      const semantic = input.kind === 'complete' ? doneNow : !doneNow
      const stale = input.baseSeq !== undefined && head > input.baseSeq
      if (semantic || stale) {
        await db.pendingMerges.put({
          id,
          kind: input.kind,
          stepId: input.stepId,
          decayId: input.decayId,
          stepName: '除尘',
          material: '',
          operator: '',
          baseSeq: input.baseSeq ?? head,
          actualSeq: head,
          clientId: input.clientId,
          reason: 'conflict',
          reversesEntryId: input.kind === 'revert' ? findReversibleCompleteId(all, input.stepId) : null,
          createdAt: Date.now()
        })
        return { status: 'pending' }
      }
      const entry: LedgerEntry = {
        id,
        seq: head + 1,
        kind: input.kind,
        status: 'accepted',
        stepId: input.stepId,
        decayId: input.decayId,
        stepName: '除尘',
        material: '',
        operator: input.operator ?? '',
        baseSeq: input.baseSeq ?? head,
        clientId: input.clientId,
        reason: null,
        reversesEntryId: input.kind === 'revert' ? findReversibleCompleteId(all, input.stepId) : null,
        createdAt: Date.now(),
        resolvedAt: Date.now()
      }
      await db.ledgerEntries.add(entry)
      const foldsNow = foldEntries([...all, entry])
      const done = foldsNow.get(input.stepId)?.done ?? false
      await db.repairSteps.update(input.stepId, { state: done ? '已完成' : '进行中' })
      const steps = await db.repairSteps.toArray()
      const statusMap = foldDecayStatus(steps, foldsNow)
      const status = statusMap.get(input.decayId) ?? { repaired: false, repairedAt: null }
      await db.decays.update(input.decayId, status)
      return { status: 'accepted' }
    }
  )
}

const mk = (id: string, seq: number, kind: 'complete' | 'revert', stepId = 's1'): LedgerEntry => ({
  id,
  seq,
  kind,
  status: 'accepted',
  stepId,
  decayId: 'd1',
  stepName: '除尘',
  material: '',
  operator: '',
  baseSeq: seq - 1,
  clientId: 'c',
  reason: null,
  reversesEntryId: kind === 'revert' ? 'e1' : null,
  createdAt: seq,
  resolvedAt: seq
})

// ---- 纯折叠逻辑 ----
{
  assert(foldEntries([]).size === 0, '空流水折叠为空')

  const s = foldEntries([mk('e1', 1, 'complete'), mk('e2', 2, 'complete'), mk('e3', 3, 'revert')]).get('s1')!
  assert(s.completionCount === 2, '完成次数按正式 complete 累计为 2（撤回不抵消次数）')
  assert(s.done === true, '两条完成 − 一条撤回 → 仍有一笔净完成，当前为已完成态')

  const reverted = foldEntries([
    mk('e1', 1, 'complete'),
    mk('e2', 2, 'complete'),
    { ...mk('e3', 3, 'revert'), reversesEntryId: 'e2' },
    { ...mk('e4', 4, 'revert'), reversesEntryId: 'e1' }
  ]).get('s1')!
  assert(reverted.completionCount === 2 && reverted.done === false, '两完成两撤回 → 次数仍为 2、现状为未完成')

  const foldsPending = foldEntries([mk('e1', 1, 'complete'), { ...mk('eX', 2, 'complete'), status: 'pending' }])
  assert(foldsPending.get('s1')!.completionCount === 1, '待裁决项不参与折叠与统计')

  const st = foldDecayStatus(
    [{ id: 's1', decayId: 'd1' } as never],
    foldEntries([
      mk('e1', 1, 'complete'),
      { ...mk('e3', 3, 'revert'), reversesEntryId: 'e1' }
    ])
  )
  assert(st.get('d1')!.repaired === false, '病害修复态随流水折叠为未修复')
}

// 场景一：两标签页同基准序号并发完成同一工序
await reset()
await seedDecayAndStep()
const r1 = await submit({ kind: 'complete', stepId: 's1', decayId: 'd1', baseSeq: 0, clientId: 'A', id: 'L1' })
const r2 = await submit({ kind: 'complete', stepId: 's1', decayId: 'd1', baseSeq: 0, clientId: 'B', id: 'L2' })
assert(r1.status === 'accepted', '第一条完成入账')
assert(r2.status === 'pending', '后到页面（同基准序号）整笔进入待合并区')
const entries = await db.ledgerEntries.toArray()
assert(entries.length === 1 && entries[0].seq === 1, '正式流水只有一条，序号 #1')
const pend = await db.pendingMerges.toArray()
assert(pend.length === 1 && pend[0].actualSeq === 1, '待合并区记录实际序号已变为 1')
assert((await db.repairSteps.get('s1'))!.state === '已完成', '已完成工序未被后到提交覆盖')
assert((await db.decays.get('d1'))!.repaired === true, '病害现状按第一条流水回写为已修复')

// 幂等：同一草稿 id 重试，不重复累计
const r1retry = await submit({ kind: 'complete', stepId: 's1', decayId: 'd1', baseSeq: 0, clientId: 'A', id: 'L1' })
assert(r1retry.status === 'duplicate', '重试同一笔（相同 id）被幂等吞掉')
assert((await db.ledgerEntries.toArray()).length === 1, '重试不重复累计')

// 撤回：反向记录、次数保留、现状翻转
const r3 = await submit({ kind: 'revert', stepId: 's1', decayId: 'd1', baseSeq: 1, clientId: 'A', id: 'L3' })
assert(r3.status === 'accepted', '撤回入账为反向记录')
const entries2 = await db.ledgerEntries.toArray()
assert(entries2.length === 2, '流水追加为两条（原完成记录保留可查）')
assert(entries2[1].kind === 'revert' && entries2[1].reversesEntryId === 'L1', '撤回记录指向被冲销的完成记录')
const foldsAfter = foldEntries(entries2)
assert(foldsAfter.get('s1')!.completionCount === 1, '正式完成次数仍为 1')
assert(foldsAfter.get('s1')!.done === false, '撤回后现状为未完成')
assert((await db.decays.get('d1'))!.repaired === false, '撤回后病害现状回到未修复')
assert((await db.repairSteps.get('s1'))!.state === '进行中', '撤回后工序缓存回到进行中')

// 对未完成工序再撤回 → 语义冲突，进待合并区
const r4 = await submit({ kind: 'revert', stepId: 's1', decayId: 'd1', baseSeq: 2, clientId: 'B', id: 'L4' })
assert(r4.status === 'pending', '对未完成工序的撤回进入待合并区')

// 场景二：序号过期、不同工序，同样进待合并区且不进统计
await reset()
await seedDecayAndStep()
await db.repairSteps.put({ id: 's2', decayId: 'd1', seq: 2, name: '回贴', material: '', operator: '', state: '未开始', ledgerVersion: 1, createdAt: Date.now(), updatedAt: Date.now() })
await submit({ kind: 'complete', stepId: 's1', decayId: 'd1', baseSeq: 0, clientId: 'A', id: 'A1' })
const rb = await submit({ kind: 'complete', stepId: 's2', decayId: 'd1', baseSeq: 0, clientId: 'B', id: 'B1' })
assert(rb.status === 'pending', '基准序号过期（不同工序）同样整笔进待合并区')
const foldsB = foldEntries(await db.ledgerEntries.toArray())
assert(foldsB.get('s2') === undefined, '待裁决完成不进完成统计')
assert(foldDecayStatus(await db.repairSteps.toArray(), foldsB).get('d1')!.repaired === false, '有未裁决项时病害不算已修复')

// v3 迁移场景见独立入口 ledger.migration.test.ts（需全新 Dexie 连接）

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
