import type { LedgerEntry, StepLedgerState } from '@/types/ledger'
import type { RepairStep } from '@/types/repair'

/**
 * 施工流水的纯函数工具：折叠（fold）正式流水得到工序 / 病害对账现状。
 * 所有页面读取的完成态、完成次数都必须经过这里，未裁决项一律不参与。
 */

/** 标签页（施工终端）标识：sessionStorage 按标签页隔离，天然区分两位同时在线的人员 */
const CLIENT_KEY = 'gbmuralarch:client-id'

export function getClientId(): string {
  const existing = sessionStorage.getItem(CLIENT_KEY)
  if (existing) return existing
  const rand = Math.random().toString(36).slice(2, 10)
  const id = `cli_${Date.now().toString(36)}${rand}`
  sessionStorage.setItem(CLIENT_KEY, id)
  return id
}

/** 只取已裁决入账的条目 */
export function acceptedEntries(entries: LedgerEntry[]): LedgerEntry[] {
  return entries.filter((entry) => entry.status === 'accepted')
}

/**
 * 把正式流水按工序折叠成对账现状。
 * - completionCount：正式「完成」记录条数，撤回不抵消次数（施工过程累计可查）
 * - done：完成记录多于撤回记录时处于已完成态
 * - lastAt：最后一条正式流水的时间
 */
export function foldEntries(entries: LedgerEntry[]): Map<string, StepLedgerState> {
  const byStep = new Map<string, LedgerEntry[]>()
  acceptedEntries(entries).forEach((entry) => {
    const list = byStep.get(entry.stepId) ?? []
    list.push(entry)
    byStep.set(entry.stepId, list)
  })

  const result = new Map<string, StepLedgerState>()
  byStep.forEach((list, stepId) => {
    const sorted = [...list].sort((a, b) => a.seq - b.seq)
    let completionCount = 0
    let revertCount = 0
    let lastAt: number | null = null
    sorted.forEach((entry) => {
      if (entry.kind === 'complete') completionCount += 1
      else revertCount += 1
      lastAt = entry.createdAt
    })
    result.set(stepId, {
      stepId,
      completionCount,
      done: completionCount > revertCount,
      lastAt,
      hasPending: false
    })
  })
  return result
}

/** 在某工序的正式流水里找出本次撤回应冲销的完成记录（最近一条尚未被冲销的完成） */
export function findReversibleCompleteId(entries: LedgerEntry[], stepId: string): string | null {
  const list = acceptedEntries(entries)
    .filter((entry) => entry.stepId === stepId)
    .sort((a, b) => a.seq - b.seq)
  const reversed = new Set<string>()
  let candidate: string | null = null
  list.forEach((entry) => {
    if (entry.kind === 'complete') {
      candidate = entry.id
    } else if (entry.kind === 'revert' && entry.reversesEntryId) {
      reversed.add(entry.reversesEntryId)
      if (candidate === entry.reversesEntryId) candidate = null
    }
  })
  return candidate
}

/**
 * 依据工序清单与折叠结果，计算每条病害的对账修复态。
 * 规则：病害下至少有一道工序，且全部工序都处于已完成态。
 */
export function foldDecayStatus(
  steps: RepairStep[],
  folds: Map<string, StepLedgerState>
): Map<string, { repaired: boolean; repairedAt: number | null }> {
  const byDecay = new Map<string, RepairStep[]>()
  steps.forEach((step) => {
    const list = byDecay.get(step.decayId) ?? []
    list.push(step)
    byDecay.set(step.decayId, list)
  })

  const result = new Map<string, { repaired: boolean; repairedAt: number | null }>()
  byDecay.forEach((list, decayId) => {
    const allDone = list.every((step) => folds.get(step.id)?.done ?? false)
    let repairedAt: number | null = null
    if (allDone) {
      // 病害进入已修复的时间 = 最后完工的那道工序其正式流水时间
      repairedAt = Math.max(...list.map((step) => folds.get(step.id)?.lastAt ?? 0))
      if (!Number.isFinite(repairedAt) || repairedAt <= 0) repairedAt = null
    }
    result.set(decayId, { repaired: allDone, repairedAt })
  })
  return result
}

/** 流水时间戳的中文展示 */
export function formatLedgerTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
