import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { liveQuery } from 'dexie'
import { db, createId } from '@/utils/db'
import {
  findReversibleCompleteId,
  foldDecayStatus,
  foldEntries,
  getClientId
} from '@/utils/ledger'
import type { StepLedgerState } from '@/types/ledger'
import type { Decay } from '@/types/decay'
import type { RepairStep } from '@/types/repair'
import type {
  LedgerDraft,
  LedgerEntry,
  LedgerResolveResult,
  LedgerSubmitInput,
  LedgerSubmitOutcome,
  PendingMerge
} from '@/types/ledger'

/**
 * 施工流水 store：唯一的工序完成/撤回写入口。
 *
 * 约定：
 * - 正式流水 ledgerEntries 只追加，完成记 complete、撤回记 revert（反向记录）；
 * - 页面提交时带「基准流水序号」baseSeq，数据库事务内按接纳顺序认第一条；
 * - 后到页面若最新序号已变化（或现状已被对方改写），整笔落入 pendingMerges 待合并区，
 *   绝不覆盖已完成的工序或病害现状；
 * - 完成次数、工序/病害现状只由 accepted 正式流水折叠，未裁决项不进统计；
 * - 写入失败时保留 ledgerDrafts 草稿，重试按同一 id 幂等入账，不重复累计。
 */
export const useLedgerStore = defineStore('ledger', () => {
  const clientId = getClientId()

  const entries = ref<LedgerEntry[]>([])
  const pendingMerges = ref<PendingMerge[]>([])
  const drafts = ref<LedgerDraft[]>([])

  liveQuery(() => db.ledgerEntries.toArray()).subscribe({
    next: (rows) => {
      entries.value = rows.sort((a, b) => a.seq - b.seq)
    },
    error: () => undefined
  })
  liveQuery(() => db.pendingMerges.toArray()).subscribe({
    next: (rows) => {
      pendingMerges.value = rows.sort((a, b) => a.createdAt - b.createdAt)
    },
    error: () => undefined
  })
  liveQuery(() => db.ledgerDrafts.toArray()).subscribe({
    next: (rows) => {
      drafts.value = rows.sort((a, b) => a.createdAt - b.createdAt)
    },
    error: () => undefined
  })

  /** 正式流水最新接纳序号（页面基准序号的数据源） */
  const latestSeq = computed(() => entries.value.reduce((max, entry) => Math.max(max, entry.seq), 0))

  /** 正式流水折叠结果：工序 → 对账现状 */
  const folds = computed<Map<string, StepLedgerState>>(() => foldEntries(entries.value))

  /** 持有未裁决项的工序集合 */
  const pendingStepIds = computed(
    () => new Set(pendingMerges.value.map((item) => item.stepId))
  )

  /** 病害 → 未裁决条数 */
  const pendingCountByDecay = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    pendingMerges.value.forEach((item) => {
      map[item.decayId] = (map[item.decayId] ?? 0) + 1
    })
    return map
  })

  const pendingGroups = computed(() => {
    const map = new Map<string, PendingMerge[]>()
    pendingMerges.value.forEach((item) => {
      const list = map.get(item.decayId) ?? []
      list.push(item)
      map.set(item.decayId, list)
    })
    return Array.from(map, ([decayId, items]) => ({ decayId, items }))
  })

  const pendingCount = computed(() => pendingMerges.value.length)
  const draftCount = computed(() => drafts.value.length)

  /** 病害对账修复态：只由正式流水折叠得出（stepsProvider 由 repairStore 注入，依赖可被追踪） */
  const decayStatuses = computed(() => foldDecayStatus(stepsProvider(), folds.value))

  /** repairSteps 的实时数据提供者，由 repairStore 注册（store 间避免循环依赖） */
  let stepsProvider: () => RepairStep[] = () => []
  function bindSteps(provider: () => RepairStep[]): void {
    stepsProvider = provider
  }

  function stateOf(stepId: string): import('@/types/repair').RepairState {
    const fold = folds.value.get(stepId)
    if (fold?.done) return '已完成'
    const planned = stepsProvider().find((step) => step.id === stepId)?.state
    // 计划态缓存若残留旧值「已完成」但流水并不支持，退回「进行中」
    if (planned && planned !== '已完成') return planned
    return '进行中'
  }

  function completionCountOf(stepId: string): number {
    return folds.value.get(stepId)?.completionCount ?? 0
  }

  function hasPending(stepId: string): boolean {
    return pendingStepIds.value.has(stepId)
  }

  function isRepaired(decayId: string): boolean {
    return decayStatuses.value.get(decayId)?.repaired ?? false
  }

  function repairedAtOf(decayId: string): number | null {
    return decayStatuses.value.get(decayId)?.repairedAt ?? null
  }

  function historyOf(stepId: string): LedgerEntry[] {
    return entries.value
      .filter((entry) => entry.stepId === stepId && entry.status === 'accepted')
      .sort((a, b) => a.seq - b.seq)
  }

  /** 事务内：按折叠结果回写单条病害与相关工序的缓存字段（不改流水之外的真相） */
  async function applyCachesInTx(
    allEntries: LedgerEntry[],
    affectedDecayIds: Set<string>,
    now: number
  ): Promise<void> {
    const foldsNow = foldEntries(allEntries)
    const steps = await db.repairSteps.toArray()
    for (const step of steps) {
      const done = foldsNow.get(step.id)?.done ?? false
      const nextState: RepairStep['state'] = done
        ? '已完成'
        : step.state === '已完成'
          ? '进行中'
          : step.state
      if (nextState !== step.state) {
        await db.repairSteps.update(step.id, { state: nextState, updatedAt: now })
      }
    }
    const statusMap = foldDecayStatus(steps, foldsNow)
    for (const decayId of affectedDecayIds) {
      const decay = await db.decays.get(decayId)
      if (!decay) continue
      const status = statusMap.get(decayId) ?? { repaired: false, repairedAt: null }
      if (decay.repaired !== status.repaired || decay.repairedAt !== status.repairedAt) {
        await db.decays.update(decayId, {
          repaired: status.repaired,
          repairedAt: status.repairedAt,
          updatedAt: now
        })
      }
    }
  }

  /**
   * 提交一笔完成 / 撤回。
   * 基准序号在调用方从 latestSeq 读取；事务内重新计数，保证多标签页下只认第一条。
   * 抛错表示写入失败（草稿已落盘，可重试），不会产生任何累计。
   */
  async function submitEntry(input: LedgerSubmitInput, draftId?: string): Promise<LedgerSubmitOutcome> {
    const id = draftId ?? createId('led')
    const now = Date.now()
    const snapshot = await readStepSnapshot(input)
    try {
      return await db.transaction(
        'rw',
        [db.ledgerEntries, db.pendingMerges, db.ledgerDrafts, db.repairSteps, db.decays],
        async () => {
          // 幂等：重试同一笔提交时绝不重复累计
          const existed = await db.ledgerEntries.get(id)
          if (existed) {
            return { status: 'duplicate', entry: existed, conflict: existed.status !== 'accepted' }
          }
          const existedPending = await db.pendingMerges.get(id)
          if (existedPending) {
            return {
              status: 'pending',
              pending: existedPending,
              conflict: true
            }
          }

          const all = await db.ledgerEntries.toArray()
          const head = all.reduce((max, entry) => Math.max(max, entry.seq), 0)
          const currentFolds = foldEntries(all)
          const doneNow = currentFolds.get(input.stepId)?.done ?? false

          const semanticConflict =
            input.kind === 'complete' ? doneNow : input.kind === 'revert' ? !doneNow : false
          const staleConflict = input.baseSeq !== undefined && head > input.baseSeq

          if (semanticConflict || staleConflict) {
            // 整笔送进待合并区，不覆盖已完成的工序或病害现状
            const reason = semanticConflict
              ? input.kind === 'complete'
                ? '提交时该工序已被另一标签页完成，需人工合并'
                : '提交时该工序已被另一标签页撤回或尚未完成，需人工合并'
              : `基准流水序号 ${input.baseSeq} 已过期（当前为 ${head}），存在并发提交`
            const pending: PendingMerge = {
              id,
              kind: input.kind,
              stepId: input.stepId,
              decayId: input.decayId,
              stepName: snapshot.name,
              material: snapshot.material,
              operator: snapshot.operator,
              baseSeq: input.baseSeq ?? head,
              actualSeq: head,
              clientId,
              reason,
              reversesEntryId:
                input.kind === 'revert' ? findReversibleCompleteId(all, input.stepId) : null,
              createdAt: now
            }
            await db.pendingMerges.put(pending)
            await db.ledgerDrafts.delete(id)
            return { status: 'pending', pending, conflict: true }
          }

          const reversesEntryId =
            input.kind === 'revert' ? findReversibleCompleteId(all, input.stepId) : null
          const entry: LedgerEntry = {
            id,
            seq: head + 1,
            kind: input.kind,
            status: 'accepted',
            stepId: input.stepId,
            decayId: input.decayId,
            stepName: snapshot.name,
            material: snapshot.material,
            operator: snapshot.operator,
            baseSeq: input.baseSeq ?? head,
            clientId,
            reason: null,
            reversesEntryId,
            createdAt: now,
            resolvedAt: now
          }
          await db.ledgerEntries.add(entry)
          await db.ledgerDrafts.delete(id)
          await applyCachesInTx([...all, entry], new Set([input.decayId]), now)
          return { status: 'accepted', entry, conflict: false }
        }
      )
    } catch (err) {
      // 写入失败：保留流水草稿，重试不重复累计（id 不变）
      await saveDraft(input, id, err)
      throw err
    }
  }

  async function readStepSnapshot(input: LedgerSubmitInput): Promise<{
    name: LedgerEntry['stepName']
    material: string
    operator: string
  }> {
    const step = await db.repairSteps.get(input.stepId)
    return {
      name: step?.name ?? input.stepName,
      material: input.material ?? step?.material ?? '',
      operator: input.operator ?? step?.operator ?? ''
    }
  }

  async function saveDraft(input: LedgerSubmitInput, id: string, err: unknown): Promise<void> {
    try {
      const snapshot = await readStepSnapshot(input)
      const existing = await db.ledgerDrafts.get(id)
      const draft: LedgerDraft = {
        id,
        kind: input.kind,
        stepId: input.stepId,
        decayId: input.decayId,
        stepName: snapshot.name,
        material: snapshot.material,
        operator: snapshot.operator,
        baseSeq: input.baseSeq ?? latestSeq.value,
        clientId,
        createdAt: existing?.createdAt ?? Date.now(),
        lastError: err instanceof Error ? err.message : '写入失败',
        attempts: (existing?.attempts ?? 0) + 1
      }
      await db.ledgerDrafts.put(draft)
    } catch {
      // 草稿落盘本身失败时只能放弃（IndexedDB 不可用），错误继续向上抛
    }
  }

  /** 重试草稿：同一 id 重新走提交事务，成功则自动移除草稿 */
  async function retryDraft(draftId: string): Promise<LedgerSubmitOutcome | null> {
    const draft = await db.ledgerDrafts.get(draftId)
    if (!draft) return null
    return submitEntry(
      {
        kind: draft.kind,
        stepId: draft.stepId,
        decayId: draft.decayId,
        stepName: draft.stepName,
        material: draft.material,
        operator: draft.operator,
        baseSeq: draft.baseSeq
      },
      draft.id
    )
  }

  async function retryAllDrafts(): Promise<{ accepted: number; pending: number; failed: number }> {
    const list = await db.ledgerDrafts.toArray()
    let accepted = 0
    let pending = 0
    let failed = 0
    for (const draft of list) {
      try {
        const outcome = await retryDraft(draft.id)
        if (outcome?.status === 'accepted' || outcome?.status === 'duplicate') accepted += 1
        else if (outcome?.status === 'pending') pending += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
    return { accepted, pending, failed }
  }

  async function removeDraft(draftId: string): Promise<void> {
    await db.ledgerDrafts.delete(draftId)
  }

  /**
   * 裁决待合并项。
   * approve=true 时重新按当前正式流水校验（不能覆盖已完成现状），通过则追加入账；
   * approve=false 时追加一条 rejected 留痕记录。返回 null 表示当前无法接纳（仍保留在待合并区）。
   */
  async function resolvePending(
    pendingId: string,
    approve: boolean,
    note?: string
  ): Promise<LedgerResolveResult | null> {
    return db.transaction(
      'rw',
      [db.ledgerEntries, db.pendingMerges, db.repairSteps, db.decays],
      async () => {
        const pending = await db.pendingMerges.get(pendingId)
        if (!pending) return null
        const all = await db.ledgerEntries.toArray()
        const head = all.reduce((max, entry) => Math.max(max, entry.seq), 0)
        const doneNow = foldEntries(all).get(pending.stepId)?.done ?? false
        const now = Date.now()

        if (approve) {
          if (pending.kind === 'complete' && doneNow) return null
          const reversesEntryId =
            pending.kind === 'revert' ? findReversibleCompleteId(all, pending.stepId) : null
          if (pending.kind === 'revert' && !reversesEntryId) return null

          const entry: LedgerEntry = {
            id: createId('led'),
            seq: head + 1,
            kind: pending.kind,
            status: 'accepted',
            stepId: pending.stepId,
            decayId: pending.decayId,
            stepName: pending.stepName,
            material: pending.material,
            operator: pending.operator,
            baseSeq: pending.baseSeq,
            clientId: pending.clientId,
            reason: null,
            reversesEntryId,
            // 保留原始施工时间，裁决时间单独记 resolvedAt
            createdAt: pending.createdAt,
            resolvedAt: now
          }
          await db.ledgerEntries.add(entry)
          await db.pendingMerges.delete(pendingId)
          await applyCachesInTx([...all, entry], new Set([pending.decayId]), now)
          return { status: 'accepted', entry }
        }

        const entry: LedgerEntry = {
          id: createId('led'),
          seq: head + 1,
          kind: pending.kind,
          status: 'rejected',
          stepId: pending.stepId,
          decayId: pending.decayId,
          stepName: pending.stepName,
          material: pending.material,
          operator: pending.operator,
          baseSeq: pending.baseSeq,
          clientId: pending.clientId,
          reason: note ?? '人工裁决驳回',
          reversesEntryId: pending.reversesEntryId,
          createdAt: pending.createdAt,
          resolvedAt: now
        }
        await db.ledgerEntries.add(entry)
        await db.pendingMerges.delete(pendingId)
        return { status: 'rejected', entry }
      }
    )
  }

  /**
   * 全量对账：依据正式流水重建 repairSteps.state 与 decays.repaired 缓存。
   * 备份导入、样例生成后调用，保证各页读到的都是对账后的结果。
   */
  async function reconcileCaches(): Promise<void> {
    await db.transaction('rw', [db.ledgerEntries, db.repairSteps, db.decays], async () => {
      const all = await db.ledgerEntries.toArray()
      const now = Date.now()
      await applyCachesInTx(
        all,
        new Set((await db.decays.toArray()).map((decay: Decay) => decay.id)),
        now
      )
    })
  }

  /** 完成/撤回之外的计划态标注（未开始 ↔ 进行中），仅在流水不支持「已完成」时允许 */
  async function setPlannedState(
    stepId: string,
    state: Extract<RepairStep['state'], '未开始' | '进行中'>
  ): Promise<void> {
    if (folds.value.get(stepId)?.done) return
    await db.repairSteps.update(stepId, { state, updatedAt: Date.now() })
  }

  /**
   * 档案台手工标记病害修复 / 撤销：转换为该病害下全部工序的流水提交。
   * 批量场景不设基准序号（逐条按现状做语义冲突判定），逐条结果汇总。
   */
  async function markDecay(
    decayId: string,
    repaired: boolean
  ): Promise<{ accepted: number; pending: number; failed: number; skipped: number }> {
    const steps = await db.repairSteps.where('decayId').equals(decayId).toArray()
    let accepted = 0
    let pending = 0
    let failed = 0
    let skipped = 0
    for (const step of steps) {
      const done = folds.value.get(step.id)?.done ?? false
      if (repaired === done) {
        skipped += 1
        continue
      }
      try {
        const outcome = await submitEntry({
          kind: repaired ? 'complete' : 'revert',
          stepId: step.id,
          decayId,
          stepName: step.name
        })
        if (outcome.status === 'accepted' || outcome.status === 'duplicate') accepted += 1
        else pending += 1
      } catch {
        failed += 1
      }
    }
    return { accepted, pending, failed, skipped }
  }

  return {
    clientId,
    entries,
    pendingMerges,
    drafts,
    latestSeq,
    folds,
    pendingGroups,
    pendingCountByDecay,
    pendingCount,
    draftCount,
    decayStatuses,
    bindSteps,
    stateOf,
    completionCountOf,
    hasPending,
    isRepaired,
    repairedAtOf,
    historyOf,
    submitEntry,
    retryDraft,
    retryAllDrafts,
    removeDraft,
    resolvePending,
    reconcileCaches,
    setPlannedState,
    markDecay
  }
})
