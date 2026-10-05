import type { Decay } from '@/types/decay'
import type { RepairStep } from '@/types/repair'
import type {
  ReconcileResult,
  RepairConflict,
  RepairLedgerEntry,
  StepLedgerView
} from '@/types/ledger'

/** 空的对账结果（无流水 / 无待决项时使用） */
export function emptyReconcileResult(): ReconcileResult {
  return {
    headSeq: 0,
    stepViews: new Map(),
    completedStepIds: new Set(),
    repairedDecayIds: new Set(),
    repairedAtMap: new Map(),
    disputedDecayIds: new Set(),
    disputedStepIds: new Set(),
    totalCompletionCount: 0
  }
}

function emptyStepView(): StepLedgerView {
  return { completionCount: 0, balance: 0, isDone: false, history: [] }
}

/**
 * 对正式流水 + 待合并区做对账，输出所有页面与统计统一消费的结果。
 *
 * 规则：
 * - 只认正式流水（已接纳记录），按 seq 接纳顺序逐条结算；
 * - 完成次数按正向记录累计，撤回只产生反向记录、不抹除原过程；
 * - 工序是否已完成看净完成余额（complete 数 - reverse 数 > 0）；
 * - 病害有未裁决待合并项时，本笔对账不把它计入已修复（未裁决不进统计）；
 * - 病害全部工序净完成才视为已修复；没有工序的病害按其当前 repaired 现状计。
 */
export function reconcileLedger(input: {
  entries: RepairLedgerEntry[]
  conflicts: RepairConflict[]
  steps: RepairStep[]
  decays: Decay[]
}): ReconcileResult {
  const accepted = input.entries
    .filter((entry) => entry.seq > 0)
    .sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.acceptedAt! - b.acceptedAt!))

  const stepViews = new Map<string, StepLedgerView>()
  let headSeq = 0
  let totalCompletionCount = 0

  accepted.forEach((entry) => {
    headSeq = Math.max(headSeq, entry.seq)
    const view = stepViews.get(entry.stepId) ?? emptyStepView()
    if (entry.action === 'complete') {
      view.completionCount += 1
      view.balance += 1
      totalCompletionCount += 1
    } else {
      view.balance -= 1
    }
    view.isDone = view.balance > 0
    view.history.push(entry)
    stepViews.set(entry.stepId, view)
  })

  const completedStepIds = new Set<string>()
  stepViews.forEach((view, stepId) => {
    if (view.isDone) completedStepIds.add(stepId)
  })

  const pending = input.conflicts.filter((conflict) => conflict.status === 'pending')
  const disputedDecayIds = new Set<string>()
  const disputedStepIds = new Set<string>()
  const pendingByDecay = new Map<string, RepairConflict[]>()
  pending.forEach((conflict) => {
    disputedDecayIds.add(conflict.decayId)
    disputedStepIds.add(conflict.stepId)
    const list = pendingByDecay.get(conflict.decayId) ?? []
    list.push(conflict)
    pendingByDecay.set(conflict.decayId, list)
  })

  // 病害 → 其全部现存工序
  const stepsByDecay = new Map<string, RepairStep[]>()
  input.steps.forEach((step) => {
    const list = stepsByDecay.get(step.decayId) ?? []
    list.push(step)
    stepsByDecay.set(step.decayId, list)
  })

  const repairedDecayIds = new Set<string>()
  const repairedAtMap = new Map<string, number>()

  input.decays.forEach((decay) => {
    // 未裁决项存在：病害整体不进入修复统计
    if (disputedDecayIds.has(decay.id)) return

    const decaySteps = stepsByDecay.get(decay.id)
    if (!decaySteps || decaySteps.length === 0) {
      // 无工序的病害：保留人工维护的 repaired 现状
      if (decay.repaired) {
        repairedDecayIds.add(decay.id)
        repairedAtMap.set(decay.id, decay.repairedAt ?? decay.updatedAt ?? decay.createdAt)
      }
      return
    }

    const allDone = decaySteps.every((step) => completedStepIds.has(step.id))
    if (!allDone) return
    repairedDecayIds.add(decay.id)

    // repairedAt 取该病害所有已完成工序最近一次完成的接纳时间
    let latest = 0
    decaySteps.forEach((step) => {
      const view = stepViews.get(step.id)
      if (!view) return
      const lastComplete = [...view.history].reverse().find((entry) => entry.action === 'complete')
      if (lastComplete) latest = Math.max(latest, lastComplete.acceptedAt ?? lastComplete.createdAt)
    })
    repairedAtMap.set(decay.id, latest || decay.repairedAt || Date.now())
  })

  return {
    headSeq,
    stepViews,
    completedStepIds,
    repairedDecayIds,
    repairedAtMap,
    disputedDecayIds,
    disputedStepIds,
    totalCompletionCount
  }
}

/** 取某道工序对账视图（缺省为空视图） */
export function stepViewOf(result: ReconcileResult, stepId: string): StepLedgerView {
  return result.stepViews.get(stepId) ?? emptyStepView()
}
