import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useDecayStore } from '@/stores/decayStore'
import { useHallStore } from '@/stores/hallStore'
import { useLedgerStore, type SubmitResult } from '@/stores/ledgerStore'
import type { Decay } from '@/types/decay'
import type { Element } from '@/types/element'
import type { Hall } from '@/types/hall'
import type { PaintLayer } from '@/types/layer'
import type { RepairGroup, RepairState, RepairStep, RepairStepName } from '@/types/repair'

/**
 * 工序 store：页面侧的时间线视图。
 * 完成 / 撤回的唯一事实来源是 ledgerStore 的正式施工流水（只追加、按接纳顺序对账）。
 */
export const useRepairStore = defineStore('repair', () => {
  const ledgerStore = useLedgerStore()
  const decayStore = useDecayStore()
  const hallStore = useHallStore()

  const sortMode = ref<'manual' | 'severity'>(readUiPrefs().repairSort)
  const activeDecayId = ref<string | null>(null)

  const steps = computed<RepairStep[]>(() => ledgerStore.steps)

  /** 按病害归组的工序时间线（完成度读取对账后的正式流水） */
  const groups = computed<RepairGroup[]>(() => {
    const layerMap = new Map<string, PaintLayer>()
    decayStore.layers.forEach((layer) => layerMap.set(layer.id, layer))
    const elementMap = new Map<string, Element>()
    decayStore.elements.forEach((element) => elementMap.set(element.id, element))
    const decayMap = new Map<string, Decay>()
    decayStore.decays.forEach((decay) => decayMap.set(decay.id, decay))

    const grouped = new Map<string, RepairStep[]>()
    steps.value.forEach((step) => {
      const list = grouped.get(step.decayId) ?? []
      list.push(step)
      grouped.set(step.decayId, list)
    })

    const result: RepairGroup[] = []
    grouped.forEach((list, decayId) => {
      const sorted = [...list].sort((a, b) => a.seq - b.seq)
      const decay = decayMap.get(decayId) ?? null
      const layer = decay ? layerMap.get(decay.layerId) ?? null : null
      const element = layer ? elementMap.get(layer.elementId) ?? null : null
      const doneCount = sorted.filter((step) => ledgerStore.isStepDone(step.id)).length
      result.push({
        decayId,
        decay,
        layer,
        element,
        hall: null,
        steps: sorted,
        doneCount,
        totalCount: sorted.length,
        percent: sorted.length === 0 ? 0 : Math.round((doneCount / sorted.length) * 100),
        disputed: ledgerStore.isDecayDisputed(decayId)
      })
    })
    return result.sort((a, b) => {
      if (sortMode.value === 'severity') {
        const weight = (group: RepairGroup): number => {
          const severity = group.decay?.severity
          if (severity === '重度') return 3
          if (severity === '中度') return 2
          return 1
        }
        const diff = weight(b) - weight(a)
        if (diff !== 0) return diff
      }
      return a.decayId.localeCompare(b.decayId)
    })
  })

  const totalSteps = computed(() => steps.value.length)
  /** 当前已完成工序数（对账后净完成） */
  const doneSteps = computed(() =>
    steps.value.filter((step) => ledgerStore.isStepDone(step.id)).length
  )
  const runningSteps = computed(
    () =>
      steps.value.filter((step) => step.state === '进行中' && !ledgerStore.isStepDone(step.id))
        .length
  )
  /** 完成次数：按正式流水累计（撤回产生反向记录，不抹除次数） */
  const totalCompletionCount = computed(() => ledgerStore.reconcile.totalCompletionCount)
  /** 未裁决待合并项数量：未裁决项不进入修复统计 */
  const pendingConflictCount = computed(() => ledgerStore.pendingConflicts.length)
  /** 写入失败待重试的流水草稿数量 */
  const pendingDraftCount = computed(() => ledgerStore.unresolvedDrafts.length)
  const overallPercent = computed(() =>
    totalSteps.value === 0 ? 0 : Math.round((doneSteps.value / totalSteps.value) * 100)
  )

  /** 待安排工序的病害（尚无任何工序） */
  const pendingDecays = computed<Decay[]>(() =>
    decayStore.decays.filter((decay) => !steps.value.some((step) => step.decayId === decay.id))
  )

  function groupOf(decayId: string): RepairGroup | undefined {
    return groups.value.find((group) => group.decayId === decayId)
  }

  function decayById(id: string): Decay | null {
    return decayStore.decays.find((decay) => decay.id === id) ?? null
  }

  function setSortMode(mode: 'manual' | 'severity'): void {
    sortMode.value = mode
    writeUiPrefs({ ...readUiPrefs(), repairSort: mode })
  }

  function setActiveDecay(id: string | null): void {
    activeDecayId.value = id
  }

  function nextSeq(decayId: string): number {
    const list = steps.value.filter((step) => step.decayId === decayId)
    return list.length === 0 ? 1 : Math.max(...list.map((step) => step.seq)) + 1
  }

  async function addStep(payload: {
    decayId: string
    name: RepairStepName
    material: string
    operator: string
    state?: RepairState
    seq?: number
  }): Promise<RepairStep> {
    return ledgerStore.createStep({
      decayId: payload.decayId,
      seq: payload.seq,
      name: payload.name,
      material: payload.material,
      operator: payload.operator,
      state: payload.state
    })
  }

  async function updateStep(id: string, patch: Partial<RepairStep>): Promise<void> {
    await ledgerStore.updateStepFields(id, patch)
  }

  async function removeStep(id: string): Promise<void> {
    await ledgerStore.removeStep(id)
  }

  async function removeGroup(decayId: string): Promise<void> {
    await ledgerStore.removeGroup(decayId)
  }

  async function reorder(decayId: string, orderedIds: string[]): Promise<void> {
    await ledgerStore.reorder(decayId, orderedIds)
  }

  /**
   * 页面提交工序状态（带基准流水序号，基准序号在 store 侧按提交瞬间 headSeq 捕获）：
   * - 置「已完成」→ 追加 complete 正向流水；
   * - 从「已完成」撤回 → 追加 reverse 反向记录，原施工过程继续可查；
   * - 未开始 / 进行中互改 → 只写工序工作态，不入流水。
   */
  async function setStepState(id: string, state: RepairState): Promise<SubmitResult | null> {
    const step = steps.value.find((item) => item.id === id)
    if (!step) return null
    const currentlyDone = ledgerStore.isStepDone(id)

    if (state === '已完成') {
      if (currentlyDone) return null
      return ledgerStore.submitStepEntry({ decayId: step.decayId, stepId: id, action: 'complete' })
    }

    if (currentlyDone) {
      // 撤回完成：生成反向记录，并记录撤回后回落的工作态
      const view = ledgerStore.stepView(id)
      const lastComplete = [...view.history]
        .reverse()
        .find((entry) => entry.action === 'complete')
      return ledgerStore.submitStepEntry({
        decayId: step.decayId,
        stepId: id,
        action: 'reverse',
        targetState: state === '进行中' ? '进行中' : '未开始',
        reverseOf: lastComplete?.id
      })
    }

    await ledgerStore.updateStepFields(id, { state })
    return null
  }

  /** 档案台按病害整体标记修复：整组同基准序号提交 */
  async function setDecayRepairedBySteps(decayId: string, repaired: boolean): Promise<SubmitResult[]> {
    return ledgerStore.markDecaySteps(decayId, repaired)
  }

  /** 一键为某殿宇下所有未修复病害补齐标准工序链 */
  async function scaffoldForHall(hallId: string, template: RepairStepName[]): Promise<number> {
    const targets = decayStore.rows
      .filter(
        (row) =>
          row.hallId === hallId &&
          !steps.value.some((step) => step.decayId === row.decay.id)
      )
      .map((row) => row.decay.id)
    return ledgerStore.scaffoldSteps(template, targets)
  }

  /** 工序分组所属殿宇，用于时间线标题回显 */
  function hallOfGroup(group: RepairGroup): Hall | null {
    const hallId = group.element?.hallId
    if (!hallId) return null
    return hallStore.hallById(hallId) ?? null
  }

  return {
    steps,
    groups,
    sortMode,
    activeDecayId,
    totalSteps,
    doneSteps,
    runningSteps,
    totalCompletionCount,
    pendingConflictCount,
    pendingDraftCount,
    overallPercent,
    pendingDecays,
    groupOf,
    decayById,
    hallOfGroup,
    setSortMode,
    setActiveDecay,
    nextSeq,
    addStep,
    updateStep,
    removeStep,
    removeGroup,
    reorder,
    setStepState,
    setDecayRepairedBySteps,
    scaffoldForHall
  }
})
