/** 修复工序：针对某条病害记录的施工步骤 */
export type RepairStepName = '除尘' | '回贴' | '灌浆' | '补绘' | '封护'
/**
 * 工序计划态（施工过程标注）。
 * 「已完成」不再直接保存在该字段：完成/撤回一律走只追加施工流水，
 * 现状由正式流水折叠得出（见 stores/ledgerStore.ts）。
 */
export type RepairState = '未开始' | '进行中' | '已完成'

export interface RepairStep {
  id: string
  decayId: string
  /** 工序先后序号，从 1 开始 */
  seq: number
  name: RepairStepName
  material: string
  operator: string
  /** 计划态缓存；是否真正已完成以正式流水对账结果为准 */
  state: RepairState
  /** 流水版本标记：v3 迁移补齐初始流水后为 1，v3 起新建工序即为 1 */
  ledgerVersion?: number
  createdAt: number
  updatedAt: number
}

export const REPAIR_STEP_NAMES: RepairStepName[] = ['除尘', '回贴', '灌浆', '补绘', '封护']
export const REPAIR_STATES: RepairState[] = ['未开始', '进行中', '已完成']
/** 页面上可直接切换的计划态（完成/撤回必须经施工流水提交） */
export const PLAN_STATES: RepairState[] = ['未开始', '进行中']

/** 工序按病害归组后的时间线节点 */
export interface RepairGroup {
  decayId: string
  decay: import('./decay').Decay | null
  layer: import('./layer').PaintLayer | null
  element: import('./element').Element | null
  hall: import('./hall').Hall | null
  steps: RepairStep[]
  doneCount: number
  totalCount: number
  percent: number
  /** 该组是否存在未裁决项（完成数因此暂时冻结） */
  hasPending: boolean
  pendingCount: number
}
