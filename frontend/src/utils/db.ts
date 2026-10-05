import Dexie, { type Table } from 'dexie'
import type { Hall } from '@/types/hall'
import type { Element } from '@/types/element'
import type { PaintLayer } from '@/types/layer'
import type { Decay } from '@/types/decay'
import type { RepairStep } from '@/types/repair'
import type { LedgerDraft, LedgerEntry, PendingMerge } from '@/types/ledger'
import { foldDecayStatus, foldEntries } from '@/utils/ledger'

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
  /** 正式施工流水（只追加） */
  ledgerEntries: LedgerEntry[]
  /** 待合并区（未裁决项） */
  pendingMerges: PendingMerge[]
  /** 写入失败后保留、待重试的流水草稿 */
  ledgerDrafts: LedgerDraft[]
}

export class MuralArchDatabase extends Dexie {
  halls!: Table<Hall, string>
  elements!: Table<Element, string>
  layers!: Table<PaintLayer, string>
  decays!: Table<Decay, string>
  repairSteps!: Table<RepairStep, string>
  ledgerEntries!: Table<LedgerEntry, string>
  pendingMerges!: Table<PendingMerge, string>
  ledgerDrafts!: Table<LedgerDraft, string>

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
    // v3：引入只追加的施工流水（ledgerEntries）、待合并区（pendingMerges）与流水草稿（ledgerDrafts）
    this.version(DB_VERSION)
      .stores({
        halls: 'id, name, era, structureType, roofType, updatedAt',
        elements: 'id, hallId, position, status, updatedAt',
        layers: 'id, elementId, level, patternName, pigment',
        decays: 'id, layerId, type, severity, repaired, repairedAt, updatedAt',
        repairSteps: 'id, decayId, seq, name, state, updatedAt',
        ledgerEntries: 'id, seq, status, kind, stepId, decayId, reversesEntryId, createdAt, resolvedAt',
        pendingMerges: 'id, kind, stepId, decayId, createdAt',
        ledgerDrafts: 'id, stepId, decayId, createdAt'
      })
      .upgrade(async (tx) => {
        // 迁移：缺少流水版本的旧工序按现状补初始流水记录
        const stepTable = tx.table<RepairStep>('repairSteps')
        const decayTable = tx.table<Decay>('decays')
        const entryTable = tx.table<LedgerEntry>('ledgerEntries')

        const steps = await stepTable.toArray()
        const initialEntries: LedgerEntry[] = []
        let seq = 0
        const stamp = Date.now()
        // 接纳顺序按旧数据最后更新时间稳定排列
        const sortedSteps = [...steps].sort(
          (a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a.id.localeCompare(b.id)
        )
        sortedSteps.forEach((step) => {
          if (step.state === '已完成') {
            seq += 1
            initialEntries.push({
              id: createId('led'),
              seq,
              kind: 'complete',
              status: 'accepted',
              stepId: step.id,
              decayId: step.decayId,
              stepName: step.name,
              material: step.material,
              operator: step.operator,
              baseSeq: 0,
              clientId: 'migration-v3',
              reason: null,
              reversesEntryId: null,
              createdAt: step.updatedAt ?? stamp,
              resolvedAt: step.updatedAt ?? stamp
            })
          }
        })
        if (initialEntries.length > 0) await entryTable.bulkAdd(initialEntries)
        await stepTable.toCollection().modify((step) => {
          step.ledgerVersion = 1
        })

        // 病害现状统一以对账结果重算：无正式流水支撑的旧 repaired 标记退回未修复，需重新走流水
        const folds = foldEntries(initialEntries)
        const decayStatus = foldDecayStatus(sortedSteps, folds)
        await decayTable.toCollection().modify((decay) => {
          const status = decayStatus.get(decay.id)
          if (status) {
            decay.repaired = status.repaired
            decay.repairedAt = status.repairedAt
          } else {
            decay.repaired = false
            decay.repairedAt = null
          }
          decay.updatedAt = decay.updatedAt ?? stamp
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
      db.ledgerEntries,
      db.pendingMerges,
      db.ledgerDrafts
    ],
    async () => {
      await Promise.all([
        db.halls.clear(),
        db.elements.clear(),
        db.layers.clear(),
        db.decays.clear(),
        db.repairSteps.clear(),
        db.ledgerEntries.clear(),
        db.pendingMerges.clear(),
        db.ledgerDrafts.clear()
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
