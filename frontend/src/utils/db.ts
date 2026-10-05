import Dexie, { type Table } from 'dexie'
import type { Hall } from '@/types/hall'
import type { Element } from '@/types/element'
import type { PaintLayer } from '@/types/layer'
import type { Decay } from '@/types/decay'
import type { RepairStep } from '@/types/repair'
import type { RepairConflict, RepairDraft, RepairLedgerEntry } from '@/types/ledger'
import { reconcileLedger } from '@/utils/reconcile'

/** 本地结构版本号：新增/修改表结构时必须递增，并补充 upgrade 迁移 */
export const DB_VERSION = 3

/** 本地存储键名（localStorage 侧的少量元数据） */
export const LS_KEYS = {
  dbVersion: 'gbmuralarch:db-version',
  lastBackupAt: 'gbmuralarch:last-backup-at',
  uiPrefs: 'gbmuralarch:ui-prefs'
} as const

export interface UiPrefs {
  lastHallId: string | null
  repairSort: 'manual' | 'severity'
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastHallId: null,
  repairSort: 'manual'
}

/** 备份文件结构，供 export.ts / BackupView 使用 */
export interface BackupPayload {
  app: 'gbmuralarch'
  dbVersion: number
  exportedAt: string
  halls: Hall[]
  elements: Element[]
  layers: PaintLayer[]
  decays: Decay[]
  repairSteps: RepairStep[]
  /** v3：正式施工流水；旧备份缺失时按工序现状补初始记录 */
  repairLedger?: RepairLedgerEntry[]
  /** v3：待合并区裁决记录（含已裁决留痕） */
  repairConflicts?: RepairConflict[]
  // repairDrafts 是写入失败的本地草稿，不进入备份
}

export class MuralArchDatabase extends Dexie {
  halls!: Table<Hall, string>
  elements!: Table<Element, string>
  layers!: Table<PaintLayer, string>
  decays!: Table<Decay, string>
  repairSteps!: Table<RepairStep, string>
  repairLedger!: Table<RepairLedgerEntry, string>
  repairConflicts!: Table<RepairConflict, string>
  repairDrafts!: Table<RepairDraft, string>

  constructor() {
    super('gbmuralarch')
    this.version(1).stores({
      halls: 'id, name, era, structureType, roofType, updatedAt',
      elements: 'id, hallId, position, status, updatedAt',
      layers: 'id, elementId, level, patternName, pigment',
      decays: 'id, layerId, type, severity, repaired, updatedAt',
      repairSteps: 'id, decayId, seq, state, updatedAt'
    })
    // v2：病害表补充 repairedAt 索引，工序表补充 name 索引
    this.version(2)
      .stores({
        halls: 'id, name, era, structureType, roofType, updatedAt',
        elements: 'id, hallId, position, status, updatedAt',
        layers: 'id, elementId, level, patternName, pigment',
        decays: 'id, layerId, type, severity, repaired, repairedAt, updatedAt',
        repairSteps: 'id, decayId, seq, name, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据 repaired 为 true 但缺少 repairedAt，用 updatedAt 回填
        await tx
          .table<Decay>('decays')
          .toCollection()
          .modify((decay) => {
            if (decay.repaired && !decay.repairedAt) {
              decay.repairedAt = decay.updatedAt ?? Date.now()
            }
            if (typeof decay.repaired !== 'boolean') {
              decay.repaired = false
            }
          })
      })
    // v3：施工流水（只追加）+ 待合并区 + 失败草稿
    this.version(DB_VERSION)
      .stores({
        halls: 'id, name, era, structureType, roofType, updatedAt',
        elements: 'id, hallId, position, status, updatedAt',
        layers: 'id, elementId, level, patternName, pigment',
        decays: 'id, layerId, type, severity, repaired, repairedAt, updatedAt',
        repairSteps: 'id, decayId, seq, name, state, updatedAt',
        repairLedger: 'id, seq, decayId, stepId, action, acceptedAt',
        repairConflicts: 'id, decayId, stepId, status, createdAt',
        repairDrafts: 'id, decayId, stepId, updatedAt'
      })
      .upgrade(async (tx) => {
        const steps = await tx.table<RepairStep>('repairSteps').toArray()
        const decays = await tx.table<Decay>('decays').toArray()

        // v3 迁移：缺少流水版本的旧工序按现状补初始记录
        const entries = bootstrapLegacyLedgerEntries(steps, 'migration')
        if (entries.length > 0) {
          await tx.table<RepairLedgerEntry>('repairLedger').bulkPut(entries)
        }

        // 按对账结果回写病害现状（有工序的病害全部以流水为准）
        const result = reconcileLedger({ entries, conflicts: [], steps, decays })
        const now = Date.now()
        await tx
          .table<Decay>('decays')
          .toCollection()
          .modify((decay) => {
            const hasSteps = steps.some((step) => step.decayId === decay.id)
            if (!hasSteps) return
            const repaired = result.repairedDecayIds.has(decay.id)
            if (repaired) {
              decay.repaired = true
              if (!decay.repairedAt) decay.repairedAt = result.repairedAtMap.get(decay.id) ?? now
            } else {
              decay.repaired = false
              decay.repairedAt = null
            }
          })
      })
  }
}

export const db = new MuralArchDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/**
 * 旧数据升级（或导入旧版本备份）时，按工序现状补初始施工流水：
 * 当前为「已完成」的工序补一条 complete 初始记录，按 decayId + seq 排定接纳顺序。
 * 已有流水的工序不会重复补。
 */
export function bootstrapLegacyLedgerEntries(
  steps: RepairStep[],
  source: 'migration' | 'import',
  existingEntries: RepairLedgerEntry[] = []
): RepairLedgerEntry[] {
  const coveredStepIds = new Set(existingEntries.map((entry) => entry.stepId))
  const doneSteps = steps
    .filter((step) => step.state === '已完成' && !coveredStepIds.has(step.id))
    .sort((a, b) => {
      if (a.decayId !== b.decayId) return a.decayId.localeCompare(b.decayId)
      return a.seq - b.seq
    })

  const baseSeq = existingEntries.reduce((max, entry) => Math.max(max, entry.seq), 0)
  return doneSteps.map((step, index) => {
    const ts = step.updatedAt ?? step.createdAt ?? Date.now()
    return {
      id: createId('led'),
      seq: baseSeq + index + 1,
      decayId: step.decayId,
      stepId: step.id,
      action: 'complete' as const,
      baseSeq: baseSeq + index,
      tabId: source === 'migration' ? 'migration' : 'legacy-import',
      operator: step.operator || '历史数据补录',
      note: source === 'migration' ? '旧工序按现状补初始流水' : '旧版备份按现状补初始流水',
      createdAt: ts,
      acceptedAt: ts
    }
  })
}

/**
 * 按正式流水 + 待合并区对账，并把病害 repaired / repairedAt 现状回写。
 * 可在既有 rw 事务内调用（导入 / 裁决后做全量对账）。
 */
export async function reprojectDecays(
  scope: {
    ledger?: Table<RepairLedgerEntry, string>
    conflicts?: Table<RepairConflict, string>
    steps?: Table<RepairStep, string>
    decays?: Table<Decay, string>
  } = {}
): Promise<void> {
  const ledgerTable = scope.ledger ?? db.repairLedger
  const conflictTable = scope.conflicts ?? db.repairConflicts
  const stepTable = scope.steps ?? db.repairSteps
  const decayTable = scope.decays ?? db.decays

  const [entries, conflicts, steps, decays] = await Promise.all([
    ledgerTable.toArray(),
    conflictTable.toArray(),
    stepTable.toArray(),
    decayTable.toArray()
  ])
  const result = reconcileLedger({ entries, conflicts, steps, decays })
  const now = Date.now()

  await Promise.all(
    decays.map(async (decay) => {
      const repaired = result.repairedDecayIds.has(decay.id)
      const repairedAt = repaired ? result.repairedAtMap.get(decay.id) ?? now : null
      if (decay.repaired !== repaired || decay.repairedAt !== repairedAt) {
        await decayTable.update(decay.id, {
          repaired,
          repairedAt,
          updatedAt: now
        })
      }
    })
  )
}

/** 清空全部业务表，供「清空本地数据」与导入前的覆盖使用 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.halls,
      db.elements,
      db.layers,
      db.decays,
      db.repairSteps,
      db.repairLedger,
      db.repairConflicts,
      db.repairDrafts
    ],
    async () => {
      await Promise.all([
        db.halls.clear(),
        db.elements.clear(),
        db.layers.clear(),
        db.decays.clear(),
        db.repairSteps.clear(),
        db.repairLedger.clear(),
        db.repairConflicts.clear(),
        db.repairDrafts.clear()
      ])
    }
  )
}

/** 读取 localStorage 中的 UI 偏好 */
export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastHallId: typeof parsed.lastHallId === 'string' ? parsed.lastHallId : null,
      repairSort: parsed.repairSort === 'severity' ? 'severity' : 'manual'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/** 写入 localStorage 中的 UI 偏好 */
export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录数据库结构版本到 localStorage，便于备份页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const raw = localStorage.getItem(LS_KEYS.dbVersion)
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
