<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type TableInstance } from 'element-plus'
import { Delete, Edit, Plus, Tools } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar.vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useDecayFilter } from '@/hooks/useDecayFilter'
import { useHallStore } from '@/stores/hallStore'
import { useDecayStore } from '@/stores/decayStore'
import { useLedgerStore } from '@/stores/ledgerStore'
import { useRepairStore } from '@/stores/repairStore'
import { DECAY_TYPES, type Decay, type DecayType, type Severity } from '@/types/decay'
import { SEVERITIES } from '@/types/decay'
import { formatArea, SEVERITY_COLOR } from '@/utils/severity'

const router = useRouter()
const hallStore = useHallStore()
const decayStore = useDecayStore()
const repairStore = useRepairStore()
const ledgerStore = useLedgerStore()

const {
  filter,
  positionOptions,
  typeOptions,
  severityOptions,
  pigmentOptions,
  hallOptions,
  sortedRows,
  severityCounts,
  filteredCount,
  filteredArea,
  hasFilter,
  patch,
  reset
} = useDecayFilter()

const batchSeverity = ref<Severity>('中度')
const batchType = ref<DecayType>('起甲')
const editDialogVisible = ref(false)
const editingDecay = ref<Decay | null>(null)
const editForm = ref<{
  type: DecayType
  severity: Severity
  areaCm2: number
  causeGuess: string
}>({ type: '起甲', severity: '轻度', areaCm2: 10, causeGuess: '' })

const filterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  halls: filter.value.halls,
  pos: filter.value.elementPositions,
  types: filter.value.types,
  sev: filter.value.severities,
  pig: filter.value.pigments
}))

const filterSelects = computed(() => [
  { key: 'halls', label: '殿宇', options: hallOptions.value },
  { key: 'pos', label: '部位', options: positionOptions.map((item) => ({ label: item, value: item })) },
  { key: 'types', label: '病害类型', options: typeOptions.map((item) => ({ label: item, value: item })) },
  { key: 'sev', label: '严重程度', options: severityOptions.map((item) => ({ label: item, value: item })) },
  { key: 'pig', label: '主色颜料', options: pigmentOptions.map((item) => ({ label: item, value: item })) }
])

const selectedRows = computed(() =>
  sortedRows.value.filter((row) => decayStore.selectedIds.has(row.decay.id))
)

watch(
  () => sortedRows.value.map((row) => row.decay.id).join(','),
  () => {
    const visible = new Set(sortedRows.value.map((row) => row.decay.id))
    Array.from(decayStore.selectedIds).forEach((id) => {
      if (!visible.has(id)) decayStore.selectedIds.delete(id)
    })
  }
)

const tableRef = ref<TableInstance | null>(null)

function handleFilterChange(value: FilterModel): void {
  patch({
    keyword: value.keyword,
    halls: Array.isArray(value.halls) ? value.halls : [],
    elementPositions: Array.isArray(value.pos) ? value.pos : [],
    types: (Array.isArray(value.types) ? value.types : []) as DecayType[],
    severities: (Array.isArray(value.sev) ? value.sev : []) as Severity[],
    pigments: Array.isArray(value.pig) ? value.pig : []
  })
}

function handleSwitch(value: boolean): void {
  patch({ onlyUnrepaired: value })
}

function handleSelectionChange(rows: Array<{ decay: Decay }>): void {
  decayStore.setSelection(rows.map((row) => row.decay.id))
}

function layerLabel(layerId: string): string {
  const layer = decayStore.layers.find((item) => item.id === layerId)
  if (!layer) return '层位已删除'
  return `第 ${layer.level} 层 · ${layer.patternName} · ${layer.pigment}`
}

function elementLabel(layerId: string): string {
  const layer = decayStore.layers.find((item) => item.id === layerId)
  if (!layer) return '-'
  const element = decayStore.elements.find((item) => item.id === layer.elementId)
  if (!element) return '-'
  return `${element.name}（${element.position}）`
}

function hallLabel(layerId: string): string {
  const layer = decayStore.layers.find((item) => item.id === layerId)
  if (!layer) return '-'
  const element = decayStore.elements.find((item) => item.id === layer.elementId)
  if (!element) return '-'
  return hallStore.hallById(element.hallId)?.name ?? '殿宇已删除'
}

function repairProgress(decayId: string): { done: number; total: number } {
  const steps = repairStore.steps.filter((step) => step.decayId === decayId)
  return { done: steps.filter((step) => ledgerStore.isStepDone(step.id)).length, total: steps.length }
}

function hasSteps(decayId: string): boolean {
  return repairStore.steps.some((step) => step.decayId === decayId)
}

async function applyBatchSeverity(): Promise<void> {
  const ids = Array.from(decayStore.selectedIds)
  if (ids.length === 0) {
    ElMessage.warning('请先勾选需要修改的病害记录')
    return
  }
  await decayStore.bulkSetSeverity(ids, batchSeverity.value)
  ElMessage.success(`已将 ${ids.length} 条病害的严重程度改为「${batchSeverity.value}」`)
}

async function applyBatchType(): Promise<void> {
  const ids = Array.from(decayStore.selectedIds)
  if (ids.length === 0) {
    ElMessage.warning('请先勾选需要修改的病害记录')
    return
  }
  await decayStore.bulkSetType(ids, batchType.value)
  ElMessage.success(`已将 ${ids.length} 条病害的类型改为「${batchType.value}」`)
}

function openEdit(row: { decay: Decay }): void {
  editingDecay.value = row.decay
  editForm.value = {
    type: row.decay.type,
    severity: row.decay.severity,
    areaCm2: row.decay.areaCm2,
    causeGuess: row.decay.causeGuess
  }
  editDialogVisible.value = true
}

async function submitEdit(): Promise<void> {
  if (!editingDecay.value) return
  await decayStore.updateDecay(editingDecay.value.id, {
    type: editForm.value.type,
    severity: editForm.value.severity,
    areaCm2: editForm.value.areaCm2,
    causeGuess: editForm.value.causeGuess.trim() || '待现场复核'
  })
  editDialogVisible.value = false
  ElMessage.success('病害记录已更新')
}

async function removeRow(row: { decay: Decay }): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除「${row.decay.type}」病害记录及其关联修复工序？`,
    '删除确认',
    { type: 'warning' }
  ).catch(() => false)
  if (!confirmed) return
  await decayStore.removeDecay(row.decay.id)
  ElMessage.success('病害记录已删除')
}

async function toggleRepaired(row: { decay: Decay }): Promise<void> {
  const { decay } = row
  const repaired = !decayStore.isDecayRepaired(decay)
  if (hasSteps(decay.id)) {
    // 有工序：整组工序以同一基准序号追加完成 / 撤回流水，绝不直接覆盖现状
    if (decayStore.isDecayDisputed(decay.id)) {
      ElMessage.warning('该病害存在未裁决的待合并记录，请先到修复工序时间线裁决后再操作')
      return
    }
    const results = await repairStore.setDecayRepairedBySteps(decay.id, repaired)
    reportSubmitResults(results, repaired)
  } else {
    // 无工序的病害：保留人工标记通道
    await decayStore.setRepaired(decay.id, repaired)
    ElMessage.success(repaired ? '已标记为已修复' : '已标记为未修复')
  }
}

function reportSubmitResults(
  results: Array<{ status: string; seq?: number }>,
  repaired: boolean
): void {
  const accepted = results.filter((result) => result.status === 'accepted').length
  const conflicted = results.filter((result) => result.status === 'conflicted').length
  const errored = results.filter((result) => result.status === 'error').length
  const duplicated = results.filter((result) => result.status === 'duplicate').length
  if (accepted > 0) {
    ElMessage.success(
      repaired
        ? `已按流水提交 ${accepted} 道工序完成${accepted === results.length ? '，病害回写为已修复' : ''}`
        : `已生成 ${accepted} 条撤回（反向）记录，原施工过程继续可查`
    )
  }
  if (conflicted > 0) {
    ElMessage.warning(`${conflicted} 笔提交时基准流水序号已变化，已整笔进入待合并区等待裁决`)
  }
  if (errored > 0) {
    ElMessage.error(`${errored} 笔写入失败，流水草稿已保留，可在修复工序时间线重试`)
  }
  if (accepted === 0 && conflicted === 0 && errored === 0 && duplicated > 0) {
    ElMessage.info('这些流水此前已提交，未重复累计')
  }
}

async function bulkMarkRepaired(repaired: boolean): Promise<void> {
  const ids = Array.from(decayStore.selectedIds)
  if (ids.length === 0) {
    ElMessage.warning('请先勾选需要处理的病害记录')
    return
  }
  let directCount = 0
  for (const id of ids) {
    if (decayStore.isDecayDisputed(id)) {
      ElMessage.warning('勾选记录中存在未裁决待合并项的病害，已跳过，请先裁决')
      continue
    }
    if (hasSteps(id)) {
      const results = await repairStore.setDecayRepairedBySteps(id, repaired)
      reportSubmitResults(results, repaired)
    } else {
      await decayStore.setRepaired(id, repaired)
      directCount += 1
    }
  }
  if (directCount > 0) {
    ElMessage.success(`已直接标记 ${directCount} 条无工序病害为${repaired ? '已修复' : '未修复'}`)
  }
}

function goRepair(row: { decay: Decay }): void {
  repairStore.setActiveDecay(row.decay.id)
  void router.push('/repair')
}

function goElements(row: { decay: Decay }): void {
  const layer = decayStore.layers.find((item) => item.id === row.decay.layerId)
  const element = layer ? decayStore.elements.find((item) => item.id === layer.elementId) : undefined
  if (!element) {
    ElMessage.warning('层位或构件已被删除')
    return
  }
  hallStore.setCurrentHall(element.hallId)
  void router.push(`/halls/${element.hallId}/elements`)
}

function rowKey(row: { decay: Decay }): string {
  return row.decay.id
}

const typeOptionsForEdit = DECAY_TYPES
const severityOptionsForEdit = SEVERITIES
const severityPalette = SEVERITY_COLOR
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>病害档案台</h2>
        <p>
          共 {{ decayStore.rows.length }} 条病害，当前筛选命中 {{ filteredCount }} 条，涉及面积
          {{ formatArea(filteredArea) }}
        </p>
      </div>
      <el-button :icon="Tools" @click="router.push('/repair')">前往修复工序</el-button>
    </div>

    <div class="stat-row">
      <StatBadge
        label="重度病害"
        :value="severityCounts.重度"
        suffix="条"
        icon="CircleCloseFilled"
        tone="danger"
        :percent="decayStore.rows.length ? Math.round((severityCounts.重度 / decayStore.rows.length) * 100) : 0"
      />
      <StatBadge
        label="中度病害"
        :value="severityCounts.中度"
        suffix="条"
        icon="WarningFilled"
        tone="warning"
        :percent="decayStore.rows.length ? Math.round((severityCounts.中度 / decayStore.rows.length) * 100) : 0"
      />
      <StatBadge
        label="轻度病害"
        :value="severityCounts.轻度"
        suffix="条"
        icon="SuccessFilled"
        tone="success"
        :percent="decayStore.rows.length ? Math.round((severityCounts.轻度 / decayStore.rows.length) * 100) : 0"
      />
      <StatBadge label="未修复" :value="decayStore.unrepairedCount" suffix="条" icon="Histogram" tone="info" />
      <StatBadge
        v-if="decayStore.disputedCount > 0"
        label="待裁决（不进统计）"
        :value="decayStore.disputedCount"
        suffix="条"
        icon="WarnTriangleFilled"
        tone="warning"
      />
      <StatBadge
        label="流水累计完成"
        :value="repairStore.totalCompletionCount"
        suffix="次"
        icon="DataLine"
        tone="info"
      />
      <StatBadge
        label="修复完成率"
        :value="decayStore.repairedPercent"
        suffix="%"
        icon="TrendCharts"
        tone="primary"
        show-percent
        :percent="decayStore.repairedPercent"
      />
      <StatBadge label="病害总面积" :value="formatArea(decayStore.totalArea)" icon="PieChart" tone="default" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      has-switch
      switch-label="仅未修复"
      :switch-value="filter.onlyUnrepaired"      keyword-placeholder="按类型 / 颜料 / 成因 / 构件 搜索"
      @change="handleFilterChange"
      @update:switch-value="handleSwitch"
      @reset="reset"
    >
      <template #actions>
        <el-tag v-if="selectedRows.length > 0" type="primary" effect="plain" round>
          已选 {{ selectedRows.length }} 条
        </el-tag>
      </template>
    </FilterBar>

    <div class="section-card batch-bar">
      <span class="batch-bar__label">批量改严重程度</span>
      <el-select v-model="batchSeverity" class="batch-bar__select">
        <el-option v-for="item in severityOptionsForEdit" :key="item" :label="item" :value="item" />
      </el-select>
      <el-button type="primary" plain size="small" @click="applyBatchSeverity">应用</el-button>

      <span class="batch-bar__label">批量改类型</span>
      <el-select v-model="batchType" class="batch-bar__select">
        <el-option v-for="item in typeOptionsForEdit" :key="item" :label="item" :value="item" />
      </el-select>
      <el-button type="primary" plain size="small" @click="applyBatchType">应用</el-button>

      <el-button size="small" @click="bulkMarkRepaired(true)">标记已修复</el-button>
      <el-button size="small" @click="bulkMarkRepaired(false)">标记未修复</el-button>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>病害清单</h3>
        <span class="muted">按严重程度与面积排序</span>
      </div>

      <el-table
        v-if="sortedRows.length > 0"
        ref="tableRef"
        :data="sortedRows"
        :row-key="rowKey"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="46" reserve-selection />
        <el-table-column label="病害类型" width="100">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.decay.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="严重程度" width="170">
          <template #default="{ row }">
            <SeverityTag :severity="row.decay.severity" :area-cm2="row.decay.areaCm2" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="殿宇" width="150">
          <template #default="{ row }">{{ hallLabel(row.decay.layerId) }}</template>
        </el-table-column>
        <el-table-column label="构件（部位）" min-width="190">
          <template #default="{ row }">{{ elementLabel(row.decay.layerId) }}</template>
        </el-table-column>
        <el-table-column label="彩画层位" min-width="180">
          <template #default="{ row }">{{ layerLabel(row.decay.layerId) }}</template>
        </el-table-column>
        <el-table-column label="成因初判" prop="decay.causeGuess" min-width="200" show-overflow-tooltip />
        <el-table-column label="修复" width="180">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="decayStore.isDecayDisputed(row.decay.id)
                ? 'warning'
                : decayStore.isDecayRepaired(row.decay)
                  ? 'success'
                  : 'info'"
              effect="plain"
            >
              {{ decayStore.isDecayDisputed(row.decay.id)
                ? '待裁决'
                : decayStore.isDecayRepaired(row.decay)
                  ? '已修复'
                  : '未修复' }}
            </el-tag>
            <span class="mono muted repair-progress">
              {{ repairProgress(row.decay.id).done }}/{{ repairProgress(row.decay.id).total }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" text :icon="Tools" @click="goRepair(row)">排工序</el-button>
            <el-button size="small" text type="primary" @click="goElements(row)">看层位</el-button>
            <el-button
              size="small"
              text
              :type="decayStore.isDecayRepaired(row.decay) ? 'warning' : 'success'"
              @click="toggleRepaired(row)"
            >
              {{ decayStore.isDecayRepaired(row.decay) ? '撤回修复' : '标记修复' }}
            </el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeRow(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <EmptyPanel
        v-else
        :title="hasFilter ? '没有符合筛选条件的病害' : '尚未记录病害'"
        :description="
          hasFilter
            ? '可放宽筛选条件，或在构件与层位页为具体层位挂接病害记录。'
            : '先在殿宇总览建立殿宇、在构件与层位页圈定彩画层位，再为本页挂接病害记录。'
        "
        :action-text="hasFilter ? '' : '前往殿宇总览'"
        :secondary-text="hasFilter ? '重置筛选条件' : ''"
        @action="router.push('/halls')"
        @secondary="reset"
      >
        <template #actions>
          <el-button v-if="hasFilter" size="small" @click="reset">重置筛选</el-button>
        </template>
      </EmptyPanel>
    </div>

    <el-dialog v-model="editDialogVisible" title="编辑病害记录" width="540px">
      <el-form :model="editForm" label-width="110px">
        <el-form-item label="病害类型">
          <el-select v-model="editForm.type" class="full-width">
            <el-option v-for="item in typeOptionsForEdit" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="严重程度">
          <el-radio-group v-model="editForm.severity">
            <el-radio v-for="item in severityOptionsForEdit" :key="item" :value="item">
              <span :style="{ color: severityPalette[item] }">{{ item }}</span>
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="面积（cm²）">
          <el-input-number v-model="editForm.areaCm2" :min="0.1" :max="1000000" :step="10" :precision="1" />
        </el-form-item>
        <el-form-item label="成因初判">
          <el-input v-model="editForm.causeGuess" type="textarea" :rows="3" maxlength="120" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" :icon="Plus" @click="submitEdit">保存修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}

.batch-bar__label {
  font-size: 13px;
  color: #6b6257;
}

.batch-bar__select {
  width: 140px;
}

.full-width {
  width: 100%;
}

.repair-progress {
  margin-left: 6px;
  font-size: 12px;
}
</style>
