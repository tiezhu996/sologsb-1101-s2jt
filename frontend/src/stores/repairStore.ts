import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useDecayStore } from '@/stores/decayStore'
import { useHallStore } from '@/stores/hallStore'
import type { Decay } from '@/types/decay'
import type { Element } from '@/types/element'
import type { Hall } from '@/types/hall'
import type { PaintLayer } from '@/types/layer'
import type { LedgerSubmitOutcome } from '@/types/ledger'
import type { RepairGroup, RepairState, RepairStep, RepairStepName } from '@/types/repair'

/**
 * 工序 store：维护工序计划（顺序 / 材料 / 责任人 / 计划态）。
 * 「完成 / 撤回」一律转由 ledgerStore 记只追加施工流水，
 * 时间线完成数、病害修复态均读取正式流水对账后的结果。
 */
export const useRepairStore = defineStore('repair', () => {
  const repairTable = useIdbTable<RepairStep>((database) => database.repairSteps)
  const ledger = useLedgerStore()
  const decayStore = useDecayStore()
  const hallStore = useHallStore()

  // 把工序实时数据交给流水 store，供其折叠病害修复态
  ledger.bindSteps(() => steps.value)

  const sortMode = ref<'manual' | 'severity'>(readUiPrefs().repairSort)
  const activeDecayId = ref<string | null>(null)

  const steps = computed<RepairStep[]>(() => repairTable.rows.value)

  /** 工序的对账现状态：以正式流水为准，计划态只反映「未开始 / 进行中」 */
  function displayState(step: RepairStep): RepairState {
    return ledger.stateOf(step.id)
  }

  /** 按病害归组的工序时间线（完成数取自正式流水，未裁决项不计入） */
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
      const doneCount = sorted.filter((step) => ledger.stateOf(step.id) === '已完成').length
      const pendingCount = ledger.pendingCountByDecay[decayId] ?? 0
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
        hasPending: pendingCount > 0,
        pendingCount
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
  const doneSteps = computed(
    () => steps.value.filter((step) => ledger.stateOf(step.id) === '已完成').length
  )
  const runningSteps = computed(
    () => steps.value.filter((step) => ledger.stateOf(step.id) === '进行中').length
  )
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
    state?: '未开始' | '进行中'
    seq?: number
  }): Promise<RepairStep> {
    // 新建工序仅允许计划态；完成必须通过施工流水
    return repairTable.create(
      {
        decayId: payload.decayId,
        seq: payload.seq ?? nextSeq(payload.decayId),
        name: payload.name,
        material: payload.material,
        operator: payload.operator,
        state: payload.state ?? '未开始',
        ledgerVersion: 1
      },
      'step'
    )
  }

  /** 更新工序计划字段（材料 / 责任人 / 顺序等）；完成态不在此修改 */
  async function updateStep(
    id: string,
    patch: Partial<Pick<RepairStep, 'name' | 'material' | 'operator'>>
  ): Promise<void> {
    await repairTable.update(id, patch)
  }

  async function removeStep(id: string): Promise<void> {
    const step = steps.value.find((item) => item.id === id)
    if (!step) return
    await db.transaction(
      'rw',
      [db.repairSteps, db.pendingMerges, db.ledgerDrafts],
      async () => {
        // 正式流水（含撤回反向记录）保留可查；只清掉无法再裁决的待合并项与草稿
        await db.pendingMerges.where('stepId').equals(id).delete()
        await db.ledgerDrafts.where('stepId').equals(id).delete()
        await db.repairSteps.delete(id)
      }
    )
    await normalizeSeq(step.decayId)
  }

  async function removeGroup(decayId: string): Promise<void> {
    const list = steps.value.filter((step) => step.decayId === decayId)
    const ids = list.map((step) => step.id)
    await db.transaction(
      'rw',
      [db.repairSteps, db.pendingMerges, db.ledgerDrafts],
      async () => {
        if (ids.length > 0) {
          await db.pendingMerges.where('stepId').anyOf(ids).delete()
          await db.ledgerDrafts.where('stepId').anyOf(ids).delete()
        }
        await db.repairSteps.where('decayId').equals(decayId).delete()
      }
    )
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

  /**
   * 页面提交工序状态：带基准流水序号（页面所见 latestSeq）。
   * - 已完成 → 追加完成流水
   * - 未开始 / 进行中：若当前已完成，先追加撤回反向记录，再落计划态
   * 后到页面基准序号过期或现状已变时，整笔进入待合并区，不覆盖现状。
   */
  async function submitStepState(
    step: RepairStep,
    state: RepairState,
    baseSeq: number
  ): Promise<LedgerSubmitOutcome | { status: 'noop'; conflict: false }> {
    if (state === '已完成') {
      return ledger.submitEntry({
        kind: 'complete',
        stepId: step.id,
        decayId: step.decayId,
        stepName: step.name,
        baseSeq
      })
    }
    const done = ledger.stateOf(step.id) === '已完成'
    if (done) {
      const outcome = await ledger.submitEntry({
        kind: 'revert',
        stepId: step.id,
        decayId: step.decayId,
        stepName: step.name,
        baseSeq
      })
      // 撤回成功后若选的是「未开始」，再落计划态；进入待合并区则不改现状
      if (outcome.status === 'accepted') {
        await ledger.setPlannedState(step.id, state === '未开始' ? '未开始' : '进行中')
      }
      return outcome
    }
    // 计划态之间切换（未开始 ↔ 进行中），不产生施工流水
    await ledger.setPlannedState(step.id, state === '未开始' ? '未开始' : '进行中')
    return { status: 'noop', conflict: false }
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

  /** 一键为某殿宇下所有未修复病害补齐标准工序链 */
  async function scaffoldForHall(hallId: string, template: RepairStepName[]): Promise<number> {
    const targets = decayStore.rows.filter(
      (row) => row.hallId === hallId && !steps.value.some((step) => step.decayId === row.decay.id)
    )
    const now = Date.now()
    const records: RepairStep[] = []
    targets.forEach((row) => {
      template.forEach((name, index) => {
        records.push({
          id: `${row.decay.id}_${index}_${Math.random().toString(36).slice(2, 7)}`,
          decayId: row.decay.id,
          seq: index + 1,
          name,
          material: '',
          operator: '',
          state: '未开始',
          ledgerVersion: 1,
          createdAt: now,
          updatedAt: now
        })
      })
    })
    if (records.length > 0) await db.repairSteps.bulkPut(records)
    return records.length
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
    overallPercent,
    pendingDecays,
    groupOf,
    decayById,
    hallOfGroup,
    displayState,
    setSortMode,
    setActiveDecay,
    nextSeq,
    addStep,
    updateStep,
    removeStep,
    removeGroup,
    reorder,
    submitStepState,
    normalizeSeq,
    scaffoldForHall
  }
})
