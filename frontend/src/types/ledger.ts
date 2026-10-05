import type { RepairState } from './repair'

/**
 * 施工流水（只追加）：
 * - complete：工序完成（正向记录，balance +1，完成次数累计 +1）
 * - reverse：撤回完成（反向记录，balance -1，指向被撤回的正向记录，不删除原记录）
 * - 工序的「未开始 / 进行中」等工作态直接写在工序上，不进入流水；只有「完成 / 撤回」入流水。
 */
export type LedgerAction = 'complete' | 'reverse'

/** 撤回后工序回落的工作态 */
export type StepWorkingState = Exclude<RepairState, '已完成'>

export interface RepairLedgerEntry {
  /** 流水记录主键，接纳时分配；未接纳前草稿与待合并项也预占同一 id（幂等键） */
  id: string
  /** 全局接纳顺序号，从 1 单调递增；未接纳记录为 0 */
  seq: number
  decayId: string
  stepId: string
  action: LedgerAction
  /** 提交时的基准流水序号（乐观并发：页面打开/取值时所看到的 headSeq） */
  baseSeq: number
  /** 提交方标签页 id，便于多标签页排查 */
  tabId: string
  operator: string
  /** complete：完成时记录的材料快照；reverse：撤回后回落的工作态（未开始/进行中） */
  targetState?: StepWorkingState
  /** reverse 专用：被撤回的正向流水 id（提交时页面所认定的「最新一次完成」） */
  reverseOf?: string
  note?: string
  createdAt: number
  acceptedAt: number | null
}

/** 待合并（对账裁决）状态 */
export type ConflictStatus = 'pending' | 'accepted' | 'discarded'

/**
 * 待合并区：后到页面 baseSeq 落后于数据库 headSeq 时整笔放入，
 * 裁决前既不覆盖工序现状，也不影响病害 repaired 与任何修复统计。
 */
export interface RepairConflict {
  /** 与内含流水草稿同 id：接纳时流水直接用该 id 入正式流水 */
  id: string
  decayId: string
  stepId: string
  status: ConflictStatus
  /** 提交时的基准序号 */
  baseSeq: number
  /** 入待合并区时数据库的实际 headSeq */
  headSeqAtArrival: number
  /** 被谁（流水 id）抢先：仅作裁决提示 */
  supersededBy: string | null
  /** 内含的流水草稿（seq = 0） */
  entry: Omit<RepairLedgerEntry, 'seq' | 'acceptedAt'> & { seq: 0; acceptedAt: null }
  /** 裁决备注（作废原因 / 接纳说明） */
  resolutionNote?: string
  tabId: string
  createdAt: number
  resolvedAt: number | null
}

/**
 * 流水草稿：写入失败时保留，重试使用同一流水 id，
 * 已接纳 / 已进待合并区都会按 id 去重，绝不重复累计。
 */
export interface RepairDraft {
  /** 与将来接纳的流水同 id（幂等键） */
  id: string
  decayId: string
  stepId: string
  /** 待提交的流水草稿（seq = 0） */
  entry: Omit<RepairLedgerEntry, 'seq' | 'acceptedAt'> & { seq: 0; acceptedAt: null }
  attempts: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

/** 单道工序对账后的流水视图 */
export interface StepLedgerView {
  /** 完成次数：按正式流水的正向记录累计（撤回不抹除） */
  completionCount: number
  /** 净完成余额：complete 数 - reverse 数，> 0 即工序当前为已完成 */
  balance: number
  /** 当前是否已完成（以正式流水对账结果为准） */
  isDone: boolean
  /** 该工序全部正式流水（正反向，按接纳顺序） */
  history: RepairLedgerEntry[]
}

/** 正式流水对账结果，页面 / 统计 / 备份统一消费 */
export interface ReconcileResult {
  headSeq: number
  stepViews: Map<string, StepLedgerView>
  /** 当前处于已完成的工序 id 集合 */
  completedStepIds: Set<string>
  /**
   * 当前判定为已修复的病害 id 集合：
   * 该病害尚有未裁决待合并项时不进入（未裁决项不能进入修复统计）。
   */
  repairedDecayIds: Set<string>
  /** 已修复病害对应的 repairedAt（取最近一次完成的接纳时间） */
  repairedAtMap: Map<string, number>
  /** 存在未裁决待合并项的病害 / 工序 */
  disputedDecayIds: Set<string>
  disputedStepIds: Set<string>
  /** 正式流水累计完成次数（全局） */
  totalCompletionCount: number
}
