<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, MagicStick, Plus, Sort } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useDecayStore } from '@/stores/decayStore'
import { useHallStore } from '@/stores/hallStore'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useRepairStore } from '@/stores/repairStore'
import type { LedgerEntry, PendingMerge } from '@/types/ledger'
import type { RepairGroup } from '@/types/repair'
import { REPAIR_STATES, REPAIR_STEP_NAMES, type RepairState, type RepairStep, type RepairStepName } from '@/types/repair'
import { formatArea } from '@/utils/severity'
import { formatLedgerTime } from '@/utils/ledger'

const hallStore = useHallStore()
const decayStore = useDecayStore()
const repairStore = useRepairStore()
const ledger = useLedgerStore()

const hallFilter = ref<string>('')
const stateFilter = ref<RepairState | ''>('')
const draggingId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)

/** 工序材料与责任人的编辑草稿：工序 id → 字段值，失焦或回车时写回 IndexedDB */
const stepDrafts = reactive<Record<string, { material: string; operator: string }>>({})

function syncDrafts(list: RepairStep[]): void {
  const alive = new Set(list.map((step) => step.id))
  Object.keys(stepDrafts).forEach((id) => {
    if (!alive.has(id)) delete stepDrafts[id]
  })
  list.forEach((step) => {
    if (!stepDrafts[step.id]) {
      stepDrafts[step.id] = { material: step.material, operator: step.operator }
    }
  })
}

watch(() => repairStore.steps, syncDrafts, { immediate: true, deep: false })

function commitDraft(step: RepairStep, field: 'material' | 'operator'): void {
  const draft = stepDrafts[step.id]
  if (!draft) return
  const value = draft[field].trim()
  if (value === step[field]) return
  void repairStore.updateStep(step.id, { [field]: value } as Partial<RepairStep>)
}

const stepDialogVisible = ref(false)
const editingStepId = ref<string | null>(null)
const stepForm = reactive<{
  decayId: string
  name: RepairStepName
  material: string
  operator: string
}>({
  decayId: '',
  name: '除尘',
  material: '',
  operator: ''
})

const scratchDialogVisible = ref(false)
const scratchHallId = ref<string>('')
const scratchTemplate = ref<RepairStepName[]>(['除尘', '回贴', '灌浆', '补绘', '封护'])

/** 施工流水历史对话框 */
const historyVisible = ref(false)
const historyStep = ref<RepairStep | null>(null)
const historyEntries = ref<LedgerEntry[]>([])

const hallOptions = computed(() =>
  hallStore.halls.map((hall) => ({ label: `${hall.name}（${hall.era}）`, value: hall.id }))
)

const groups = computed<RepairGroup[]>(() =>
  repairStore.groups.filter((group) => {
    if (hallFilter.value && group.element?.hallId !== hallFilter.value) return false
    if (stateFilter.value && !group.steps.some((step) => repairStore.displayState(step) === stateFilter.value)) return false
    return true
  })
)

const visibleStepCount = computed(() => groups.value.reduce((sum, group) => sum + group.steps.length, 0))

const visibleDoneCount = computed(() => groups.value.reduce((sum, group) => sum + group.doneCount, 0))

/** 当前筛选病害下的待合并项 */
const visiblePending = computed<PendingMerge[]>(() => {
  if (!hallFilter.value) return ledger.pendingMerges
  const allow = new Set(groups.value.map((group) => group.decayId))
  return ledger.pendingMerges.filter((item) => allow.has(item.decayId))
})

const pendingDecays = computed(() =>
  repairStore.pendingDecays.filter((decay) => {
    if (!hallFilter.value) return true
    const layer = decayStore.layers.find((item) => item.id === decay.layerId)
    const element = layer ? decayStore.elements.find((item) => item.id === layer.elementId) : undefined
    return element?.hallId === hallFilter.value
  })
)

watch(
  () => repairStore.activeDecayId,
  async (id) => {
    if (!id) return
    if (!hallFilter.value) {
      const layer = decayStore.layers.find((item) => item.id === repairStore.decayById(id)?.layerId)
      const element = layer ? decayStore.elements.find((item) => item.id === layer.elementId) : undefined
      if (element) hallFilter.value = element.hallId
    }
    await nextTick()
    const anchor = document.getElementById(`group_${id}`)
    anchor?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
)

function groupTitle(group: RepairGroup): string {
  const element = group.element
  const hall = repairStore.hallOfGroup(group)
  return `${hall?.name ?? '未知殿宇'} · ${element?.name ?? '构件已删除'} · ${group.decay?.type ?? '病害已删除'}`
}

function groupSubtitle(group: RepairGroup): string {
  const layer = group.layer
  const decay = group.decay
  if (!layer) return '层位已删除'
  const level = `第 ${layer.level} 层 ${layer.patternName}/${layer.pigment}`
  if (!decay) return level
  return `${level} · 病害 ${decay.type} · ${formatArea(decay.areaCm2)}`
}

function openStepDialog(decayId: string, step?: RepairStep): void {
  stepForm.decayId = decayId
  if (step) {
    editingStepId.value = step.id
    stepForm.name = step.name
    stepForm.material = step.material
    stepForm.operator = step.operator
  } else {
    editingStepId.value = null
    stepForm.name = '除尘'
    stepForm.material = ''
    stepForm.operator = ''
  }
  stepDialogVisible.value = true
}

async function submitStep(): Promise<void> {
  if (!stepForm.decayId) return
  if (editingStepId.value) {
    await repairStore.updateStep(editingStepId.value, {
      name: stepForm.name,
      material: stepForm.material.trim(),
      operator: stepForm.operator.trim()
    })
    ElMessage.success('工序计划已更新')
  } else {
    await repairStore.addStep({
      decayId: stepForm.decayId,
      name: stepForm.name,
      material: stepForm.material.trim(),
      operator: stepForm.operator.trim()
    })
    ElMessage.success('已追加修复工序')
  }
  stepDialogVisible.value = false
}

async function removeStep(step: RepairStep): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除工序「${step.name}」？正式施工流水仍会保留可查。`,
    '删除确认',
    { type: 'warning' }
  ).catch(() => false)
  if (!confirmed) return
  await repairStore.removeStep(step.id)
  ElMessage.success('工序已删除（流水记录保留）')
}

async function removeGroup(group: RepairGroup): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `清空「${groupTitle(group)}」的全部 ${group.steps.length} 道工序？正式施工流水仍会保留可查。`,
    '删除确认',
    { type: 'warning' }
  ).catch(() => false)
  if (!confirmed) return
  await repairStore.removeGroup(group.decayId)
  ElMessage.success('该病害的工序已清空（流水记录保留）')
}

/**
 * 完成 / 撤回提交：携带页面所见的基准流水序号。
 * 若另一标签页抢先提交导致序号变化，整笔会进入待合并区并提示，不会覆盖对方结果。
 */
async function changeState(step: RepairStep, state: RepairState): Promise<void> {
  const baseSeq = ledger.latestSeq
  try {
    const outcome = await repairStore.submitStepState(step, state, baseSeq)
    if (outcome.status === 'pending') {
      ElMessage.warning('另一标签页已先行提交，该笔已进入待合并区，等待裁决后才计入')
      return
    }
    const group = repairStore.groupOf(step.decayId)
    if (state === '已完成' && group && group.doneCount === group.totalCount) {
      ElMessage.success('该病害全部工序完成，病害已按正式流水回写为「已修复」')
    } else if (state !== '已完成') {
      ElMessage.success(`已登记撤回流水，工序现状回到「${state}」`)
    } else {
      ElMessage.success('完成记录已追加进正式施工流水')
    }
  } catch {
    ElMessage.error('写入失败，流水草稿已保留，可在下方待处理区重试')
  }
}

function stepTagType(state: RepairState): 'success' | 'warning' | 'info' {
  if (state === '已完成') return 'success'
  if (state === '进行中') return 'warning'
  return 'info'
}

function openHistory(step: RepairStep): void {
  historyStep.value = step
  historyEntries.value = ledger.historyOf(step.id)
  historyVisible.value = true
}

function entryLabel(entry: LedgerEntry): string {
  return entry.kind === 'complete' ? '完成施工' : '撤回（反向记录）'
}

function entryTagType(entry: LedgerEntry): 'success' | 'danger' | 'info' {
  if (entry.status === 'rejected') return 'info'
  return entry.kind === 'complete' ? 'success' : 'danger'
}

async function approvePending(item: PendingMerge): Promise<void> {
  const result = await ledger.resolvePending(item.id, true)
  if (!result) {
    ElMessage.warning('当前正式流水已不支持该操作（现状冲突），请选择驳回')
    return
  }
  ElMessage.success(item.kind === 'complete' ? '已裁决接纳，完成次数已累计' : '已裁决接纳撤回，反向记录已入账')
}

async function rejectPending(item: PendingMerge): Promise<void> {
  const { value } = await ElMessageBox.prompt('驳回理由（将随流水留痕）', '裁决待合并项', {
    confirmButtonText: '确认驳回',
    cancelButtonText: '取消',
    inputValue: '与现场施工记录核对后驳回',
    inputType: 'textarea'
  }).catch(() => ({ value: null }))
  if (value === null) return
  await ledger.resolvePending(item.id, false, String(value || '人工裁决驳回'))
  ElMessage.success('已驳回并在流水中留痕，未计入完成统计')
}

async function retryDraft(id: string): Promise<void> {
  try {
    const outcome = await ledger.retryDraft(id)
    if (!outcome) return
    ElMessage.success(outcome.status === 'pending' ? '重试提交进入待合并区，等待裁决' : '重试成功，流水已入账')
  } catch {
    ElMessage.error('仍然写入失败，草稿继续保留')
  }
}

async function retryAllDrafts(): Promise<void> {
  const result = await ledger.retryAllDrafts()
  ElMessage.success(`重试结束：入账 ${result.accepted} 笔，待合并 ${result.pending} 笔，仍失败 ${result.failed} 笔`)
}

async function discardDraft(id: string): Promise<void> {
  const confirmed = await ElMessageBox.confirm('放弃该笔流水草稿？该笔施工将不会计入。', '放弃草稿', {
    type: 'warning'
  }).catch(() => false)
  if (!confirmed) return
  await ledger.removeDraft(id)
}

function onDragStart(step: RepairStep): void {
  draggingId.value = step.id
}

function onDragOver(step: RepairStep, event: DragEvent): void {
  event.preventDefault()
  dragOverId.value = step.id
}

async function onDrop(group: RepairGroup, target: RepairStep): Promise<void> {
  const sourceId = draggingId.value
  draggingId.value = null
  dragOverId.value = null
  if (!sourceId || sourceId === target.id) return
  const ordered = group.steps.map((step) => step.id).filter((id) => id !== sourceId)
  const targetIndex = ordered.indexOf(target.id)
  ordered.splice(targetIndex, 0, sourceId)
  await repairStore.reorder(group.decayId, ordered)
  ElMessage.success('工序顺序已调整')
}

async function openScratch(): Promise<void> {
  scratchHallId.value = hallFilter.value || hallStore.halls[0]?.id || ''
  scratchDialogVisible.value = true
}

async function submitScratch(): Promise<void> {
  if (!scratchHallId.value) {
    ElMessage.warning('请选择殿宇')
    return
  }
  if (scratchTemplate.value.length === 0) {
    ElMessage.warning('请至少选择一道工序')
    return
  }
  const count = await repairStore.scaffoldForHall(scratchHallId.value, scratchTemplate.value)
  scratchDialogVisible.value = false
  if (count === 0) {
    ElMessage.info('该殿宇下没有待编排的病害（可能已存在工序）')
  } else {
    ElMessage.success(`已为待编排病害生成 ${count} 道工序，可逐条拖拽排序`)
  }
}

function handleEmptyAction(): void {
  const first = pendingDecays.value[0]
  if (first) openStepDialog(first.id)
}

function pendingOf(stepId: string): PendingMerge | undefined {
  return visiblePending.value.find((item) => item.stepId === stepId)
}

const stepNameOptions = REPAIR_STEP_NAMES
const stateOptions = REPAIR_STATES
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>修复工序时间线</h2>
        <p>
          共 {{ repairStore.totalSteps }} 道工序，正式流水已完成 {{ repairStore.doneSteps }} 道，进行中
          {{ repairStore.runningSteps }} 道；当前筛选 {{ groups.length }} 组 / {{ visibleStepCount }} 道
        </p>
      </div>
      <div class="page-title__actions">
        <el-button :icon="MagicStick" @click="openScratch">按殿宇批量生成工序</el-button>
        <el-button
          type="primary"
          :icon="Plus"
          :disabled="pendingDecays.length === 0"
          @click="handleEmptyAction"
        >
          为待编排病害排工序
        </el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge
        label="工序总数"
        :value="repairStore.totalSteps"
        suffix="道"
        icon="Files"
        tone="primary"
        :percent="repairStore.overallPercent"
      />
      <StatBadge label="正式完成" :value="repairStore.doneSteps" suffix="道" icon="SuccessFilled" tone="success" />
      <StatBadge label="进行中" :value="repairStore.runningSteps" suffix="道" icon="Loading" tone="warning" />
      <StatBadge label="待编排病害" :value="pendingDecays.length" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="待合并裁决" :value="ledger.pendingCount" suffix="笔" icon="ScaleToOriginal" tone="danger" />
      <StatBadge label="失败草稿" :value="ledger.draftCount" suffix="笔" icon="DocumentRemove" tone="warning" />
      <StatBadge
        label="整体完成率"
        :value="repairStore.overallPercent"
        suffix="%"
        icon="TrendCharts"
        tone="success"
        show-percent
        :percent="repairStore.overallPercent"
      />
      <StatBadge
        label="本次筛选完成"
        :value="visibleDoneCount"
        suffix="道"
        icon="Histogram"
        :percent="visibleStepCount ? Math.round((visibleDoneCount / visibleStepCount) * 100) : 0"
      />
    </div>

    <!-- 写入失败保留的流水草稿：重试不重复累计 -->
    <div v-if="ledger.drafts.length > 0" class="section-card drafts">
      <div class="section-card__head">
        <h3>待重试流水草稿（{{ ledger.drafts.length }}）</h3>
        <el-button size="small" type="primary" @click="retryAllDrafts">全部重试</el-button>
      </div>
      <el-table :data="ledger.drafts" size="small">
        <el-table-column label="动作" width="110">
          <template #default="{ row }">{{ row.kind === 'complete' ? '完成' : '撤回' }}</template>
        </el-table-column>
        <el-table-column label="工序" prop="stepName" width="100" />
        <el-table-column label="基准序号" prop="baseSeq" width="90" />
        <el-table-column label="责任人" prop="operator" width="100" />
        <el-table-column label="重试次数" prop="attempts" width="90" />
        <el-table-column label="失败原因" prop="lastError" min-width="180" show-overflow-tooltip />
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="retryDraft(row.id)">重试</el-button>
            <el-button size="small" text type="danger" @click="discardDraft(row.id)">放弃</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 待合并区：后到页面的整笔提交，裁决前不计入任何统计 -->
    <div v-if="visiblePending.length > 0" class="section-card pending-review">
      <div class="section-card__head">
        <h3>待合并区（{{ visiblePending.length }}）</h3>
        <span class="muted">另一标签页的后到提交，需裁决；裁决前不覆盖工序与病害现状，也不进修复统计</span>
      </div>
      <el-table :data="visiblePending" size="small">
        <el-table-column label="动作" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.kind === 'complete' ? 'success' : 'danger'" effect="plain">
              {{ row.kind === 'complete' ? '完成' : '撤回' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="工序" prop="stepName" width="90" />
        <el-table-column label="病害" width="140">
          <template #default="{ row }">{{ repairStore.decayById(row.decayId)?.type ?? row.decayId }}</template>
        </el-table-column>
        <el-table-column label="基准/实际序号" width="120">
          <template #default="{ row }">
            <span class="mono">{{ row.baseSeq }} → {{ row.actualSeq }}</span>
          </template>
        </el-table-column>
        <el-table-column label="责任人" prop="operator" width="90" />
        <el-table-column label="原因" prop="reason" min-width="220" show-overflow-tooltip />
        <el-table-column label="提交时间" width="170">
          <template #default="{ row }">{{ formatLedgerTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="裁决" width="150">
          <template #default="{ row }">
            <el-button size="small" type="success" @click="approvePending(row)">接纳</el-button>
            <el-button size="small" type="danger" plain @click="rejectPending(row)">驳回</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="section-card toolbar">
      <span class="toolbar__label">殿宇</span>
      <el-select v-model="hallFilter" clearable placeholder="全部殿宇" class="toolbar__select">
        <el-option v-for="item in hallOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>

      <span class="toolbar__label">工序状态</span>
      <el-radio-group v-model="stateFilter" size="small">
        <el-radio-button value="">全部</el-radio-button>
        <el-radio-button v-for="item in stateOptions" :key="item" :value="item">{{ item }}</el-radio-button>
      </el-radio-group>

      <span class="toolbar__label">排序</span>
      <el-radio-group
        :model-value="repairStore.sortMode"
        size="small"
        @update:model-value="(value: string | number | boolean | undefined) => repairStore.setSortMode(value === 'severity' ? 'severity' : 'manual')"
      >
        <el-radio-button value="manual">手动顺序</el-radio-button>
        <el-radio-button value="severity">按病害程度</el-radio-button>
      </el-radio-group>

      <el-tag v-if="repairStore.totalSteps > 0" type="info" effect="plain" round>
        <el-icon><Sort /></el-icon>
        拖拽工序卡片可调整先后；完成 / 撤回均以施工流水为准
      </el-tag>
    </div>

    <div v-if="pendingDecays.length > 0" class="section-card pending">
      <div class="section-card__head">
        <h3>待编排病害（{{ pendingDecays.length }}）</h3>
        <span class="muted">这些病害尚无任何修复工序</span>
      </div>
      <div class="pending__list">
        <el-tag
          v-for="decay in pendingDecays"
          :key="decay.id"
          closable
          :disable-transitions="true"
          type="warning"
          effect="plain"
          @close="openStepDialog(decay.id)"
        >
          {{ decay.type }} / {{ decay.severity }} / {{ formatArea(decay.areaCm2) }}
        </el-tag>
      </div>
      <p class="muted pending__hint">点击标签右侧「×」即可为该病害新增第一道工序。</p>
    </div>

    <div v-if="groups.length > 0" class="timeline">
      <article
        v-for="group in groups"
        :id="`group_${group.decayId}`"
        :key="group.decayId"
        class="timeline__group"
        :class="{ 'is-active': repairStore.activeDecayId === group.decayId, 'is-pending': group.hasPending }"
      >
        <header class="timeline__head">
          <div>
            <h3>{{ groupTitle(group) }}</h3>
            <p class="muted">{{ groupSubtitle(group) }}</p>
          </div>
          <div class="timeline__head-right">
            <el-tag v-if="group.hasPending" type="danger" effect="dark" round>
              {{ group.pendingCount }} 笔待裁决（不计入统计）
            </el-tag>
            <SeverityTag v-if="group.decay" :severity="group.decay.severity" size="small" plain />
            <el-tag :type="group.percent === 100 ? 'success' : 'info'" effect="plain" round>
              {{ group.doneCount }}/{{ group.totalCount }}（{{ group.percent }}%）
            </el-tag>
            <el-button size="small" type="danger" text :icon="Delete" @click="removeGroup(group)">清空</el-button>
          </div>
        </header>

        <el-progress :percentage="group.percent" :stroke-width="8" :show-text="false" class="timeline__progress" />

        <ol class="timeline__steps">
          <li
            v-for="(step, index) in group.steps"
            :key="step.id"
            class="step-card"
            :class="{
              'is-dragging': draggingId === step.id,
              'is-over': dragOverId === step.id && draggingId !== step.id,
              [`is-${repairStore.displayState(step)}`]: true
            }"
            draggable="true"
            @dragstart="onDragStart(step)"
            @dragover="onDragOver(step, $event)"
            @drop="onDrop(group, step)"
            @dragend="
              () => {
                draggingId = null
                dragOverId = null
              }
            "
          >
            <div class="step-card__seq">
              <el-icon><Sort /></el-icon>
              <span class="mono">{{ index + 1 }}</span>
            </div>
            <div class="step-card__body">
              <div class="step-card__title">
                <strong>{{ step.name }}</strong>
                <el-tag size="small" effect="plain" :type="stepTagType(repairStore.displayState(step))">
                  {{ repairStore.displayState(step) }}
                </el-tag>
                <el-tag size="small" type="info" effect="plain">正式完成 {{ ledger.completionCountOf(step.id) }} 次</el-tag>
                <el-tag v-if="ledger.hasPending(step.id)" size="small" type="danger" effect="plain">有待裁决</el-tag>
              </div>
              <div class="step-card__fields">
                <el-input
                  v-model="stepDrafts[step.id].material"
                  size="small"
                  placeholder="材料 / 配比"
                  class="step-card__input"
                  @blur="commitDraft(step, 'material')"
                  @keyup.enter="commitDraft(step, 'material')"
                />
                <el-input
                  v-model="stepDrafts[step.id].operator"
                  size="small"
                  placeholder="责任人"
                  class="step-card__input"
                  @blur="commitDraft(step, 'operator')"
                  @keyup.enter="commitDraft(step, 'operator')"
                />
              </div>
              <div v-if="pendingOf(step.id)" class="step-card__conflict">
                ⚠ {{ pendingOf(step.id)?.reason }}
              </div>
            </div>
            <div class="step-card__actions">
              <el-select
                :model-value="repairStore.displayState(step)"
                size="small"
                class="step-card__state"
                @update:model-value="(value: RepairState) => changeState(step, value)"
              >
                <el-option v-for="item in stateOptions" :key="item" :label="item" :value="item" />
              </el-select>
              <el-button size="small" text @click="openHistory(step)">流水</el-button>
              <el-button size="small" text :icon="Edit" @click="openStepDialog(group.decayId, step)">编辑</el-button>
              <el-button size="small" text type="danger" @click="removeStep(step)">删除</el-button>
            </div>
          </li>
        </ol>

        <div class="timeline__add">
          <el-button size="small" :icon="Plus" @click="openStepDialog(group.decayId)">追加工序</el-button>
          <span class="muted timeline__seq">基准流水序号：#{{ ledger.latestSeq }}</span>
        </div>
      </article>
    </div>

    <div v-else class="section-card">
      <EmptyPanel
        :title="repairStore.totalSteps === 0 ? '尚未安排修复工序' : '当前筛选下没有工序'"
        :description="
          repairStore.totalSteps === 0
            ? '从待编排病害开始：为每条病害追加除尘、回贴、灌浆、补绘、封护等工序，并按施工顺序拖拽调整。完成与撤回均记只追加流水。'
            : '可切换殿宇或工序状态筛选条件。'
        "
        :action-text="pendingDecays.length > 0 ? '为待编排病害排工序' : ''"
        :secondary-text="repairStore.totalSteps > 0 ? '按殿宇批量生成工序' : ''"
        @action="handleEmptyAction"
        @secondary="openScratch"
      />
    </div>

    <el-dialog v-model="stepDialogVisible" :title="editingStepId ? '编辑工序计划' : '新增修复工序'" width="540px">
      <el-form :model="stepForm" label-width="110px">
        <el-form-item label="工序名称">
          <el-select v-model="stepForm.name" class="full-width">
            <el-option v-for="item in stepNameOptions" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="材料 / 配比">
          <el-input v-model="stepForm.material" placeholder="如：鱼鳔胶（2% 明矾水调和）" maxlength="60" />
        </el-form-item>
        <el-form-item label="责任人">
          <el-input v-model="stepForm.operator" placeholder="如：李文博" maxlength="20" />
        </el-form-item>
      </el-form>
      <p class="muted">完成 / 撤回不在此处修改：请在时间线上通过状态下拉提交，将按施工流水记账。</p>
      <template #footer>
        <el-button @click="stepDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitStep">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="scratchDialogVisible" title="按殿宇批量生成工序" width="560px">
      <el-form label-width="110px">
        <el-form-item label="目标殿宇">
          <el-select v-model="scratchHallId" class="full-width" placeholder="选择殿宇">
            <el-option v-for="item in hallOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="工序模板">
          <el-checkbox-group v-model="scratchTemplate">
            <el-checkbox v-for="item in stepNameOptions" :key="item" :value="item">
              {{ item }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <p class="muted">将为该殿宇下所有尚无工序的病害，按所选模板依次生成工序（计划态均为未开始，完工请走施工流水）。</p>
      <template #footer>
        <el-button @click="scratchDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitScratch">生成工序</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="historyVisible"
      :title="historyStep ? `施工流水 · ${historyStep.name}（正式完成 ${historyStep ? ledger.completionCountOf(historyStep.id) : 0} 次）` : '施工流水'"
      width="640px"
    >
      <el-timeline v-if="historyEntries.length > 0">
        <el-timeline-item
          v-for="entry in historyEntries"
          :key="entry.id"
          :type="entry.kind === 'complete' ? 'success' : 'danger'"
          :timestamp="`#${entry.seq} · ${formatLedgerTime(entry.createdAt)}`"
        >
          <div class="history-row">
            <el-tag size="small" :type="entryTagType(entry)" effect="plain">{{ entryLabel(entry) }}</el-tag>
            <span class="muted">{{ entry.operator || '未登记责任人' }} · {{ entry.material || '未登记材料' }}</span>
          </div>
          <div class="muted history-meta">
            提交终端 {{ entry.clientId }} · 基准序号 #{{ entry.baseSeq }}
            <template v-if="entry.reversesEntryId"> · 冲销完成记录</template>
          </div>
        </el-timeline-item>
      </el-timeline>
      <EmptyPanel v-else title="该工序暂无正式施工流水" description="完成一次工序后，这里会留下不可覆盖的施工记录。" />
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title__actions {
  display: flex;
  gap: 8px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.toolbar__label {
  font-size: 13px;
  color: #6b6257;
}

.toolbar__select {
  width: 200px;
}

.drafts {
  border-color: #f0d9ac;
}

.pending-review {
  border-color: #e6a23c;
}

.pending__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pending__hint {
  margin: 10px 0 0;
  font-size: 12px;
}

.timeline {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 16px;
}

.timeline__group {
  padding: 16px;
  background: #ffffff;
  border: 1px solid var(--line);
  border-left: 4px solid #b09a76;
  border-radius: 12px;
}

.timeline__group.is-active {
  border-left-color: #8a5a2b;
  box-shadow: 0 0 0 2px rgba(138, 90, 43, 0.16);
}

.timeline__group.is-pending {
  border-left-color: #e6a23c;
}

.timeline__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.timeline__head h3 {
  margin: 0;
  font-size: 16px;
}

.timeline__head p {
  margin: 2px 0 0;
  font-size: 12px;
}

.timeline__head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline__progress {
  margin: 10px 0 14px;
}

.timeline__steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step-card {
  display: flex;
  gap: 12px;
  padding: 10px 12px;
  background: #fbf9f5;
  border: 1px dashed #ddd3c2;
  border-radius: 10px;
  cursor: grab;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.step-card.is-已完成 {
  border-color: #bfe0c9;
  background: #f4fbf6;
}

.step-card.is-进行中 {
  border-color: #f0d9ac;
  background: #fdf8ee;
}

.step-card.is-dragging {
  opacity: 0.5;
}

.step-card.is-over {
  border-color: #8a5a2b;
  box-shadow: 0 0 0 2px rgba(138, 90, 43, 0.18);
}

.step-card__seq {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 34px;
  color: #8a5a2b;
  font-weight: 700;
}

.step-card__body {
  flex: 1;
  min-width: 0;
}

.step-card__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.step-card__conflict {
  margin-top: 6px;
  font-size: 12px;
  color: #b25c00;
}

.step-card__fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.step-card__input {
  flex: 1 1 180px;
  min-width: 140px;
}

.step-card__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.step-card__state {
  width: 110px;
}

.timeline__add {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.timeline__seq {
  font-size: 12px;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.history-meta {
  margin-top: 4px;
  font-size: 12px;
}

.full-width {
  width: 100%;
}
</style>
