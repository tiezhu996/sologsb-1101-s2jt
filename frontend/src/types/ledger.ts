import type { RepairStepName } from './repair'

/**
 * 施工流水：只追加（append-only）的正式账本。
 * 工序「完成」与「撤回」都不再覆盖任何字段，而是追加一条记录；
 * 完成次数、工序现状、病害现状均由正式流水（不含待裁决项）折叠得出。
 */

/** 流水条目类型：完成施工 / 撤回（反向记录） */
export type LedgerEntryKind = 'complete' | 'revert'

/** 流水条目状态：accepted 已裁决入账；pending 待人工合并；rejected 裁决驳回（仍留痕） */
export type LedgerEntryStatus = 'accepted' | 'pending' | 'rejected'

export interface LedgerEntry {
  id: string
  /** 全局接纳顺序号，从 1 连续递增，只增不改 */
  seq: number
  kind: LedgerEntryKind
  status: LedgerEntryStatus
  /** 目标工序 */
  stepId: string
  /** 冗余病害 id，便于按病害聚合与级联清理 */
  decayId: string
  /** 提交时携带的工序名，时间线展示用 */
  stepName: RepairStepName
  /** 材料 / 责任人快照，保留施工过程痕迹 */
  material: string
  operator: string
  /** 提交时页面所见的基准流水序号（乐观锁） */
  baseSeq: number
  /** 提交来源标签页标识，用于多标签页溯源 */
  clientId: string
  /** 待裁决原因，仅 status !== accepted 时填写 */
  reason: string | null
  /** 若为反向记录，指向被撤回的完成条目；完成条目为 null */
  reversesEntryId: string | null
  createdAt: number
  resolvedAt: number | null
}

/**
 * 待合并区条目：后到页面持有的基准序号已经变化时，
 * 整笔提交（连同其希望产生的效果）先落在这里，绝不覆盖已入账结果。
 */
export interface PendingMerge {
  id: string
  /** 与流水草稿/正式条目共用同一主键，裁决接纳后转为同 id 的正式条目 */
  kind: LedgerEntryKind
  stepId: string
  decayId: string
  stepName: RepairStepName
  material: string
  operator: string
  /** 页面提交时的基准流水序号 */
  baseSeq: number
  /** 入库时正式流水的最新序号（已大于 baseSeq） */
  actualSeq: number
  clientId: string
  reason: string
  /** 被撤回的完成条目 id（撤回类待裁决项用） */
  reversesEntryId: string | null
  createdAt: number
}

/**
 * 流水草稿：写入失败（配额 / 事务异常 / 标签页竞争）后保留，
 * 重试时按 id 幂等入账，绝不重复累计。
 */
export interface LedgerDraft {
  id: string
  kind: LedgerEntryKind
  stepId: string
  decayId: string
  stepName: RepairStepName
  material: string
  operator: string
  /** 草稿生成时的基准流水序号 */
  baseSeq: number
  clientId: string
  createdAt: number
  /** 最近一次写入失败的信息，供页面提示重试 */
  lastError: string | null
  /** 重试次数 */
  attempts: number
}

/** 页面提交一笔施工动作的入参（基准序号由页面从 store 读取） */
export interface LedgerSubmitInput {
  kind: LedgerEntryKind
  stepId: string
  decayId: string
  stepName: RepairStepName
  material?: string
  operator?: string
  /** 页面所见基准流水序号；不传表示以当前最新序号为准（不做并发校验） */
  baseSeq?: number
}

/** 提交结果：入账 / 进入待合并 / 被幂等吞掉（重试成功） */
export type LedgerSubmitOutcome =
  | { status: 'accepted'; entry: LedgerEntry; conflict: false }
  | { status: 'pending'; pending: PendingMerge; conflict: true }
  | { status: 'duplicate'; entry: LedgerEntry; conflict: boolean }

/** 裁决结果 */
export type LedgerResolveResult =
  | { status: 'accepted'; entry: LedgerEntry }
  | { status: 'rejected'; entry: LedgerEntry }

/** 单道工序折叠后的对账现状 */
export interface StepLedgerState {
  stepId: string
  /** 正式完成次数（撤回为反向记录做抵消） */
  completionCount: number
  /** 当前是否处于已完成态：正式完成次数为奇数 */
  done: boolean
  /** 最后一次入账的完成/撤回时间 */
  lastAt: number | null
  /** 该工序是否存在未裁决项（完成数与现状因此暂时冻结） */
  hasPending: boolean
}

/** 待合并区按病害归组，供时间线逐组提示 */
export interface PendingGroup {
  decayId: string
  items: PendingMerge[]
}
