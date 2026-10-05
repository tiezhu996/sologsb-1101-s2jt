import { defineStore } from 'pinia'
import { computed } from 'vue'
import { db, createId, reprojectDecays } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { reconcileLedger, stepViewOf } from '@/utils/reconcile'
import type { Decay } from '@/types/decay'
import type { RepairState, RepairStep, RepairStepName } from '@/types/repair'
import type {
  ReconcileResult,
  RepairConflict,
  RepairDraft,
  RepairLedgerEntry,
  StepLedgerView,
  StepWorkingState
} from '@/types/ledger'

/** 提交结果：accepted 接纳 / conflicted 进待合并区 / duplicate 幂等重复 / error 写入失败留草稿 */
export type SubmitStatus = 'accepted' | 'conflicted' | 'duplicate' | 'error'

export interface SubmitResult {
  status: SubmitStatus
  /** accepted 时的正式流水序号 */
  seq?: number
  conflictId?: string
  draftId?: string
  error?: string
}

interface PendingEntry {
  decayId: string
  stepId: string
  action: RepairLedgerEntry['action']
  /** 撤回后回落的工作态；完成时不传 */
  targetState?: StepWorkingState
  /** 撤回时页面认定的「最新一次完成」流水 id */
  reverseOf?: string
  /** 责任人 / 材料快照（默认从工序当前值取，新建即完成时由调用方显式传入） */
  operator?: string
  note?: string
}

/** 当前标签页标识：提交流水时带上，多标签页可追溯来源 */
function currentTabId(): string {
  const KEY = 'gbmuralarch:tab-id'
  try {
    let id = sessionStorage.getItem(KEY)
    if (!id) {
      id = createId('tab')
      sessionStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return 'unknown-tab'
  }
}

/**
 * 流水 store：工序表、正式流水、待合并区、失败草稿的唯一写入口。
 * 完成 / 撤回一律走只追加流水 + 基准序号乐观并发；工作态（未开始/进行中）直接写工序。
 */
export const useLedgerStore = defineStore('ledger', () => {
  const stepsTable = useIdbTable<RepairStep>((database) => database.repairSteps)
  const ledgerTable = useIdbTable<RepairLedgerEntry>((database) => database.repairLedger, {
    sortByUpdatedAt: false
  })
  const conflictsTable = useIdbTable<RepairConflict>((database) => database.repairConflicts, {
    sortByUpdatedAt: false
  })
  const draftsTable = useIdbTable<RepairDraft>((database) => database.repairDrafts)
  // decays 表由本 store 顺带订阅，使对账 liveQuery 在病害变化时也能刷新
  const decaysTable = useIdbTable<Decay>((database) => database.decays)

  const steps = computed<RepairStep[]>(() => stepsTable.rows.value)
  const ledger = computed<RepairLedgerEntry[]>(() =>
    [...ledgerTable.rows.value].sort((a, b) => a.seq - b.seq)
  )
  const conflicts = computed<RepairConflict[]>(() =>
    [...conflictsTable.rows.value].sort((a, b) => b.createdAt - a.createdAt)
  )
  const drafts = computed<RepairDraft[]>(() => draftsTable.rows.value)

  /** 正式流水 + 待合并区的对账结果（响应式，页面 / 统计统一消费） */
  const reconcile = computed<ReconcileResult>(() =>
    reconcileLedger({
      entries: ledgerTable.rows.value,
      conflicts: conflictsTable.rows.value,
      steps: stepsTable.rows.value,
      decays: decaysTable.rows.value
    })
  )

  const headSeq = computed(() => reconcile.value.headSeq)
  const pendingConflicts = computed(() =>
    conflicts.value.filter((conflict) => conflict.status === 'pending')
  )
  const unresolvedDrafts = computed(() => drafts.value)

  function stepView(stepId: string): StepLedgerView {
    return stepViewOf(reconcile.value, stepId)
  }

  function isStepDone(stepId: string): boolean {
    return reconcile.value.completedStepIds.has(stepId)
  }

  /** 病害是否计入「已修复」：未裁决待合并项存在时一律不算 */
  function isDecayRepaired(decayId: string, fallback?: boolean): boolean {
    if (reconcile.value.disputedDecayIds.has(decayId)) return false
    if (reconcile.value.repairedDecayIds.has(decayId)) return true
    return fallback ?? false
  }

  function isDecayDisputed(decayId: string): boolean {
    return reconcile.value.disputedDecayIds.has(decayId)
  }

  function isStepDisputed(stepId: string): boolean {
    return reconcile.value.disputedStepIds.has(stepId)
  }

  // ---------------------------------------------------------------------------
  // 工序工作态写入（非流水部分：创建、编辑、拖拽排序、工作态直接修改）
  // ---------------------------------------------------------------------------

  async function createStep(payload: {
    decayId: string
    seq?: number
    name: RepairStepName
    material: string
    operator: string
    state?: RepairState
  }): Promise<RepairStep> {
    const nextSeq =
      payload.seq ??
      (() => {
        const list = steps.value.filter((step) => step.decayId === payload.decayId)
        return list.length === 0 ? 1 : Math.max(...list.map((step) => step.seq)) + 1
      })()
    const state = payload.state ?? '未开始'
    const step = await stepsTable.create(
      {
        decayId: payload.decayId,
        seq: nextSeq,
        name: payload.name,
        material: payload.material,
        operator: payload.operator,
        state
      },
      'step'
    )
    // 新建时直接带「已完成」：补一条完成流水（视为当场验收）
    if (state === '已完成') {
      await submitStepEntry({
        decayId: step.decayId,
        stepId: step.id,
        action: 'complete',
        operator: payload.operator
      })
    }
    return step
  }

  /** 编辑工序字段（名称 / 材料 / 责任人）；「未开始 / 进行中」工作态可直接改，「已完成」必须走流水 */
  async function updateStepFields(id: string, patch: Partial<RepairStep>): Promise<void> {
    const safePatch: Partial<RepairStep> = { ...patch }
    if (safePatch.state === '已完成') delete safePatch.state
    await stepsTable.update(id, safePatch)
  }

  async function removeStep(id: string): Promise<void> {
    const step = steps.value.find((item) => item.id === id)
    if (!step) return
    await db.transaction(
      'rw',
      [db.repairSteps, db.repairDrafts, db.repairConflicts],
      async () => {
        await db.repairSteps.delete(id)
        await db.repairDrafts.where('stepId').equals(id).delete()
        // 未裁决项随工序删除自动作废并留痕；正式流水保留可查
        await db.repairConflicts
          .where('stepId')
          .equals(id)
          .modify((conflict) => {
            if (conflict.status === 'pending') {
              conflict.status = 'discarded'
              conflict.resolutionNote = '工序已删除，待合并项自动作废'
              conflict.resolvedAt = Date.now()
            }
          })
      }
    )
    await normalizeSeq(step.decayId)
    await reprojectDecays()
  }

  async function removeGroup(decayId: string): Promise<void> {
    await discardForDecay(decayId, '该病害工序已清空，待合并项自动作废')
    await db.repairSteps.where('decayId').equals(decayId).delete()
    await reprojectDecays()
  }

  /** 拖拽后按新顺序批量回写 seq */
  async function reorder(decayId: string, orderedIds: string[]): Promise<void> {
    const now = Date.now()
    await db.transaction('rw', db.repairSteps, async () => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await db.repairSteps.update(orderedIds[index], { seq: index + 1, updatedAt: now })
      }
      const rest = steps.value
        .filter((step) => step.decayId === decayId && !orderedIds.includes(step.id))
        .sort((a, b) => a.seq - b.seq)
      for (let index = 0; index < rest.length; index += 1) {
        await db.repairSteps.update(rest[index].id, {
          seq: orderedIds.length + index + 1,
          updatedAt: now
        })
      }
    })
  }

  async function normalizeSeq(decayId: string): Promise<void> {
    const list = await db.repairSteps.where('decayId').equals(decayId).toArray()
    const sorted = list.sort((a, b) => a.seq - b.seq)
    const now = Date.now()
    await db.transaction('rw', db.repairSteps, async () => {
      for (let index = 0; index < sorted.length; index += 1) {
        if (sorted[index].seq !== index + 1) {
          await db.repairSteps.update(sorted[index].id, { seq: index + 1, updatedAt: now })
        }
      }
    })
  }

  /** 一键为给定病害补齐标准工序链（工作态均为未开始，不产生流水） */
  async function scaffoldSteps(template: RepairStepName[], decayIds: string[]): Promise<number> {
    const targets = decayIds.filter(
      (decayId) => !steps.value.some((step) => step.decayId === decayId)
    )
    const now = Date.now()
    const records: RepairStep[] = []
    targets.forEach((decayId) => {
      template.forEach((name, index) => {
        records.push({
          id: `${decayId}_${index}_${Math.random().toString(36).slice(2, 7)}`,
          decayId,
          seq: index + 1,
          name,
          material: '',
          operator: '',
          state: '未开始',
          createdAt: now,
          updatedAt: now
        })
      })
    })
    if (records.length > 0) await db.repairSteps.bulkPut(records)
    return records.length
  }

  // ---------------------------------------------------------------------------
  // 流水提交（完成 / 撤回）：基准序号乐观并发 + 草稿 + 待合并
  // ---------------------------------------------------------------------------

  async function buildEntry(
    pending: PendingEntry,
    options: { id?: string; baseSeq?: number; tabId?: string } = {}
  ): Promise<RepairLedgerEntry> {
    const now = Date.now()
    const step = steps.value.find((item) => item.id === pending.stepId)
    // 基准序号在提交瞬间从数据库直接读取，避免响应式 liveQuery 传播延迟导致同标签页连发拿到旧基准
    const baseSeq = options.baseSeq ?? (await db.repairLedger.orderBy('seq').last())?.seq ?? headSeq.value
    return {
      id: options.id ?? createId('led'),
      seq: 0,
      acceptedAt: null,
      decayId: pending.decayId,
      stepId: pending.stepId,
      action: pending.action,
      baseSeq,
      tabId: options.tabId ?? currentTabId(),
      operator: pending.operator ?? step?.operator ?? '',
      targetState: pending.targetState,
      reverseOf: pending.reverseOf,
      note: pending.note,
      createdAt: now
    }
  }

  /**
   * 提交单笔工序完成 / 撤回。
   * 先落草稿（写入失败可重试且不重复累计），再在事务内按基准序号裁决：
   * baseSeq === 当前 headSeq 接纳；否则整笔进待合并区。
   */
  async function submitStepEntry(pending: PendingEntry): Promise<SubmitResult> {
    const entry = await buildEntry(pending)
    const draft: RepairDraft = {
      id: entry.id,
      decayId: entry.decayId,
      stepId: entry.stepId,
      entry: entry as RepairDraft['entry'],
      attempts: 0,
      lastError: null,
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt
    }
    // 草稿幂等：同 id 草稿已存在则直接复用（重复点击 / 重试不产生新流水）
    const existingDraft = await db.repairDrafts.get(entry.id)
    if (!existingDraft) await db.repairDrafts.put(draft)

    return commitEntry(entry.id)
  }

  /**
   * 同页面手势批量提交（如档案台「标记已修复」→ 该病害全部工序完成）。
   * 共享同一基准序号，整组一次性裁决：落后则整组进待合并区。
   */
  async function submitEntryBatch(pendings: PendingEntry[]): Promise<SubmitResult[]> {
    if (pendings.length === 0) return []
    const now = Date.now()
    // 同一手势共享同一基准序号：提交瞬间从数据库读取，保证整组一致
    const baseSeq = (await db.repairLedger.orderBy('seq').last())?.seq ?? headSeq.value
    const tabId = currentTabId()
    const drafts: RepairDraft[] = []
    for (const pending of pendings) {
      const entry = await buildEntry(pending, { baseSeq, tabId })
      drafts.push({
        id: entry.id,
        decayId: entry.decayId,
        stepId: entry.stepId,
        entry: entry as RepairDraft['entry'],
        attempts: 0,
        lastError: null,
        createdAt: now,
        updatedAt: now
      })
    }
    await Promise.all(
      drafts.map(async (draft) => {
        const existing = await db.repairDrafts.get(draft.id)
        if (!existing) await db.repairDrafts.put(draft)
      })
    )
    const results: SubmitResult[] = []
    for (const draft of drafts) {
      results.push(await commitEntry(draft.id))
    }
    return results
  }

  /** 重试草稿：使用原流水 id 与原基准序号，已接纳 / 已进待合并都不会重复累计 */
  async function retryDraft(draftId: string): Promise<SubmitResult> {
    return commitEntry(draftId)
  }

  async function retryAllDrafts(): Promise<SubmitResult[]> {
    const ids = drafts.value.map((draft) => draft.id)
    const results: SubmitResult[] = []
    for (const id of ids) {
      results.push(await commitEntry(id))
    }
    return results
  }

  async function discardDraft(draftId: string): Promise<void> {
    await db.repairDrafts.delete(draftId)
  }

  /** 真正的接纳裁决事务 */
  async function commitEntry(draftId: string): Promise<SubmitResult> {
    const draft = await db.repairDrafts.get(draftId)
    if (!draft) return { status: 'duplicate' }
    const { entry } = draft

    try {
      const result = await db.transaction(
        'rw',
        [db.repairLedger, db.repairConflicts, db.repairDrafts, db.repairSteps, db.decays],
        async () => {
          // 幂等 1：同 id 已接纳（重复提交 / 重试）
          const existingEntry = await db.repairLedger.get(entry.id)
          if (existingEntry) {
            await db.repairDrafts.delete(entry.id)
            return { status: 'accepted' as const, seq: existingEntry.seq, duplicate: true }
          }
          // 幂等 2：同 id 已进待合并区
          const existingConflict = await db.repairConflicts.get(entry.id)
          if (existingConflict) {
            await db.repairDrafts.delete(entry.id)
            return {
              status: 'conflicted' as const,
              conflictId: existingConflict.id,
              duplicate: true
            }
          }

          const currentHead = await db.repairLedger.orderBy('seq').last()
          const currentHeadSeq = currentHead?.seq ?? 0

          // 基准序号已变化：整笔送待合并区，不动工序与病害现状
          if (entry.baseSeq !== currentHeadSeq) {
            const supersededBy = await db.repairLedger
              .where('seq')
              .above(entry.baseSeq)
              .first()
            const conflict: RepairConflict = {
              id: entry.id,
              decayId: entry.decayId,
              stepId: entry.stepId,
              status: 'pending',
              baseSeq: entry.baseSeq,
              headSeqAtArrival: currentHeadSeq,
              supersededBy: supersededBy?.id ?? null,
              entry,
              tabId: entry.tabId,
              createdAt: Date.now(),
              resolvedAt: null
            }
            await db.repairConflicts.put(conflict)
            await db.repairDrafts.delete(entry.id)
            return { status: 'conflicted' as const, conflictId: conflict.id, duplicate: false }
          }

          // 接纳：按数据库接纳顺序认第一条
          const now = Date.now()
          const accepted: RepairLedgerEntry = {
            ...entry,
            seq: currentHeadSeq + 1,
            acceptedAt: now
          }
          await db.repairLedger.put(accepted)
          await db.repairDrafts.delete(entry.id)

          // 只在接纳后更新工序工作态与病害现状（待合并项永远不覆盖）
          const step = await db.repairSteps.get(entry.stepId)
          if (step) {
            if (entry.action === 'complete') {
              await db.repairSteps.update(entry.stepId, { state: '已完成', updatedAt: now })
            } else if (entry.targetState) {
              await db.repairSteps.update(entry.stepId, { state: entry.targetState, updatedAt: now })
            }
          }
          await reprojectDecays({
            ledger: db.repairLedger,
            conflicts: db.repairConflicts,
            steps: db.repairSteps,
            decays: db.decays
          })

          return { status: 'accepted' as const, seq: accepted.seq, duplicate: false }
        }
      )
      return {
        status: result.status,
        seq: result.seq,
        conflictId: result.conflictId
      }
    } catch (err) {
      // 写入失败：保留流水草稿，重试不重复累计
      const message = err instanceof Error ? err.message : '写入本地数据库失败'
      await db.repairDrafts.update(draftId, {
        attempts: draft.attempts + 1,
        lastError: message,
        updatedAt: Date.now()
      })
      return { status: 'error', error: message, draftId }
    }
  }

  // ---------------------------------------------------------------------------
  // 待合并区裁决
  // ---------------------------------------------------------------------------

  /**
   * 人工裁决待合并项：
   * - accept：以当前 headSeq 为新基准接纳（追加到正式流水末尾），原施工过程继续可查；
   * - discard：作废留痕，不影响任何正式记录。
   */
  async function resolveConflict(
    conflictId: string,
    decision: 'accept' | 'discard',
    note?: string
  ): Promise<SubmitResult> {
    try {
      return await db.transaction(
        'rw',
        [db.repairLedger, db.repairConflicts, db.repairSteps, db.decays],
        async () => {
          const conflict = await db.repairConflicts.get(conflictId)
          if (!conflict || conflict.status !== 'pending') {
            return { status: 'duplicate' }
          }
          const now = Date.now()

          if (decision === 'discard') {
            await db.repairConflicts.update(conflictId, {
              status: 'discarded',
              resolutionNote: note ?? '人工裁决作废',
              resolvedAt: now
            })
            return { status: 'duplicate', conflictId }
          }

          const currentHead = await db.repairLedger.orderBy('seq').last()
          const accepted: RepairLedgerEntry = {
            ...conflict.entry,
            baseSeq: currentHead?.seq ?? 0,
            seq: (currentHead?.seq ?? 0) + 1,
            acceptedAt: now,
            note: [conflict.entry.note, note].filter(Boolean).join('；') || undefined
          }
          await db.repairLedger.put(accepted)
          const step = await db.repairSteps.get(accepted.stepId)
          if (step) {
            if (accepted.action === 'complete') {
              await db.repairSteps.update(accepted.stepId, { state: '已完成', updatedAt: now })
            } else if (accepted.targetState) {
              await db.repairSteps.update(accepted.stepId, {
                state: accepted.targetState,
                updatedAt: now
              })
            }
          }
          await db.repairConflicts.update(conflictId, {
            status: 'accepted',
            resolutionNote: note ?? '人工裁决接纳',
            resolvedAt: now
          })
          await reprojectDecays({
            ledger: db.repairLedger,
            conflicts: db.repairConflicts,
            steps: db.repairSteps,
            decays: db.decays
          })
          return { status: 'accepted', seq: accepted.seq }
        }
      )
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : '裁决写入失败',
        conflictId
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 级联清理（病害 / 构件 / 殿宇删除时调用）
  // ---------------------------------------------------------------------------

  /** 作废某病害全部未裁决待合并项、清除其失败草稿；正式流水保留 */
  async function discardForDecay(decayId: string, note: string): Promise<void> {
    const now = Date.now()
    await db.transaction('rw', [db.repairConflicts, db.repairDrafts], async () => {
      await db.repairConflicts
        .where('decayId')
        .equals(decayId)
        .modify((conflict) => {
          if (conflict.status === 'pending') {
            conflict.status = 'discarded'
            conflict.resolutionNote = note
            conflict.resolvedAt = now
          }
        })
      const draftIds = (await db.repairDrafts.where('decayId').equals(decayId).toArray()).map(
        (draft) => draft.id
      )
      await db.repairDrafts.bulkDelete(draftIds)
    })
  }

  /** 删除病害时：工序 + 草稿一并删除，未裁决项作废留痕，正式流水保留可查 */
  async function cascadeDeleteDecay(decayId: string): Promise<void> {
    await db.transaction(
      'rw',
      [db.decays, db.repairSteps, db.repairConflicts, db.repairDrafts],
      async () => {
        await db.repairSteps.where('decayId').equals(decayId).delete()
        await db.repairDrafts.where('decayId').equals(decayId).delete()
        await db.repairConflicts
          .where('decayId')
          .equals(decayId)
          .modify((conflict) => {
            if (conflict.status === 'pending') {
              conflict.status = 'discarded'
              conflict.resolutionNote = '病害记录已删除，待合并项自动作废'
              conflict.resolvedAt = Date.now()
            }
          })
        await db.decays.delete(decayId)
      }
    )
  }

  /** 同 上：批量病害（删除构件 / 殿宇时） */
  async function cascadeDeleteDecays(decayIds: string[]): Promise<void> {
    if (decayIds.length === 0) return
    const now = Date.now()
    await db.transaction(
      'rw',
      [db.decays, db.repairSteps, db.repairConflicts, db.repairDrafts],
      async () => {
        await db.repairSteps.where('decayId').anyOf(decayIds).delete()
        await db.repairDrafts.where('decayId').anyOf(decayIds).delete()
        await db.repairConflicts
          .where('decayId')
          .anyOf(decayIds)
          .modify((conflict) => {
            if (conflict.status === 'pending') {
              conflict.status = 'discarded'
              conflict.resolutionNote = '上级构件 / 殿宇已删除，待合并项自动作废'
              conflict.resolvedAt = now
            }
          })
        await db.decays.bulkDelete(decayIds)
      }
    )
  }

  /** 档案台：把某病害的全部工序一次性置完成 / 撤回（同一手势、共享基准序号） */
  async function markDecaySteps(decayId: string, repaired: boolean): Promise<SubmitResult[]> {
    const decaySteps = steps.value.filter((step) => step.decayId === decayId)
    if (decaySteps.length === 0) return []
    const pendings: PendingEntry[] = decaySteps.map((step) => {
      if (repaired) {
        return { decayId, stepId: step.id, action: 'complete' as const }
      }
      const view = stepView(step.id)
      const lastComplete = [...view.history].reverse().find((entry) => entry.action === 'complete')
      return {
        decayId,
        stepId: step.id,
        action: 'reverse' as const,
        targetState: step.state === '已完成' ? '进行中' : step.state,
        reverseOf: lastComplete?.id
      }
    })
    return submitEntryBatch(pendings)
  }

  return {
    steps,
    ledger,
    conflicts,
    drafts,
    reconcile,
    headSeq,
    pendingConflicts,
    unresolvedDrafts,
    stepView,
    isStepDone,
    isDecayRepaired,
    isDecayDisputed,
    isStepDisputed,
    createStep,
    updateStepFields,
    removeStep,
    removeGroup,
    reorder,
    normalizeSeq,
    scaffoldSteps,
    buildEntry,
    submitStepEntry,
    submitEntryBatch,
    retryDraft,
    retryAllDrafts,
    discardDraft,
    resolveConflict,
    discardForDecay,
    cascadeDeleteDecay,
    cascadeDeleteDecays,
    markDecaySteps
  }
})
