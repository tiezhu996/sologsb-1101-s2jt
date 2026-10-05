import {
  db,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  bootstrapLegacyLedgerEntries,
  reprojectDecays,
  type BackupPayload
} from '@/utils/db'
import type { RepairConflict, RepairLedgerEntry } from '@/types/ledger'

/** 校验备份对象的必备字段，返回错误信息数组（为空表示通过） */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbmuralarch') errors.push('app 字段应为 gbmuralarch，文件来源不明')
  const collections: Array<
    keyof Pick<BackupPayload, 'halls' | 'elements' | 'layers' | 'decays' | 'repairSteps'>
  > = ['halls', 'elements', 'layers', 'decays', 'repairSteps']
  for (const key of collections) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbmuralarch',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    halls: obj.halls ?? [],
    elements: obj.elements ?? [],
    layers: obj.layers ?? [],
    decays: obj.decays ?? [],
    repairSteps: obj.repairSteps ?? [],
    // v3 新增：旧版本备份没有这两表，导入时按工序现状补初始流水
    repairLedger: Array.isArray(obj.repairLedger) ? obj.repairLedger : undefined,
    repairConflicts: Array.isArray(obj.repairConflicts) ? obj.repairConflicts : undefined
  }
  return { ok: true, errors, payload }
}

/** 组装当前本地数据的备份对象（读取对账后的正式结果：流水 + 待合并留痕） */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [halls, elements, layers, decays, repairSteps, repairLedger, repairConflicts] =
    await Promise.all([
      db.halls.toArray(),
      db.elements.toArray(),
      db.layers.toArray(),
      db.decays.toArray(),
      db.repairSteps.toArray(),
      db.repairLedger.toArray(),
      db.repairConflicts.toArray()
    ])
  return {
    app: 'gbmuralarch',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    halls,
    elements,
    layers,
    decays,
    repairSteps,
    repairLedger,
    repairConflicts
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: Record<string, number> }> {
  const payload = await buildBackupPayload()
  const fileName = `gbmuralarch-backup-v${payload.dbVersion}-${payload.exportedAt.slice(0, 19).replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return {
    fileName,
    counts: {
      halls: payload.halls.length,
      elements: payload.elements.length,
      layers: payload.layers.length,
      decays: payload.decays.length,
      repairSteps: payload.repairSteps.length,
      repairLedger: payload.repairLedger?.length ?? 0,
      repairConflicts: payload.repairConflicts?.length ?? 0
    }
  }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 补齐旧版本备份缺失的流水：缺少流水版本的旧工序按现状补初始记录 */
export function ensureLedgerInPayload(payload: BackupPayload): BackupPayload {
  if (payload.repairLedger && payload.repairLedger.length > 0) {
    return { ...payload, repairConflicts: payload.repairConflicts ?? [] }
  }
  const entries = bootstrapLegacyLedgerEntries(payload.repairSteps, 'import', payload.repairLedger ?? [])
  return {
    ...payload,
    repairLedger: [...(payload.repairLedger ?? []), ...entries],
    repairConflicts: payload.repairConflicts ?? []
  }
}

/** 导入备份：overwrite=true 时先清空全部表，否则按主键合并（同 id 覆盖） */
export async function importBackup(
  rawPayload: BackupPayload,
  overwrite: boolean
): Promise<Record<string, number>> {
  // 统一读对账后的结果：旧版备份先补初始流水
  const payload = ensureLedgerInPayload(rawPayload)
  const ledger = payload.repairLedger ?? []
  const conflicts = payload.repairConflicts ?? []

  if (overwrite) await clearAllTables()
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
      await db.halls.bulkPut(payload.halls)
      await db.elements.bulkPut(payload.elements)
      await db.layers.bulkPut(payload.layers)
      await db.decays.bulkPut(payload.decays)
      await db.repairSteps.bulkPut(payload.repairSteps)
      await db.repairLedger.bulkPut(ledger)
      // 导入的是对账后的完整结果：本地待决项与失败草稿不再适用，先清掉再写入备份中的留痕
      await db.repairConflicts.clear()
      if (conflicts.length > 0) await db.repairConflicts.bulkPut(conflicts)
      if (!overwrite) await db.repairDrafts.clear()
      // 导入后按正式流水重新对账回写病害现状（未裁决项不进修复统计）
      await reprojectDecays()
    }
  )
  return {
    halls: payload.halls.length,
    elements: payload.elements.length,
    layers: payload.layers.length,
    decays: payload.decays.length,
    repairSteps: payload.repairSteps.length,
    repairLedger: ledger.length,
    repairConflicts: conflicts.length
  }
}

/**
 * 追加式导入：为导入数据重新分配 id，避免覆盖现有档案。
 * 流水序号在本地 headSeq 之后顺延，保证只追加、单调；待合并项及其内含草稿同步换 id。
 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const hallIdMap = new Map<string, string>()
  const elementIdMap = new Map<string, string>()
  const layerIdMap = new Map<string, string>()
  const decayIdMap = new Map<string, string>()

  const halls = payload.halls.map((hall) => {
    const id = createId('hall')
    hallIdMap.set(hall.id, id)
    return { ...hall, id }
  })
  const elements = payload.elements.map((element) => {
    const id = createId('elem')
    elementIdMap.set(element.id, id)
    return { ...element, id, hallId: hallIdMap.get(element.hallId) ?? element.hallId }
  })
  const layers = payload.layers.map((layer) => {
    const id = createId('lay')
    layerIdMap.set(layer.id, id)
    return { ...layer, id, elementId: elementIdMap.get(layer.elementId) ?? layer.elementId }
  })
  const decays = payload.decays.map((decay) => {
    const id = createId('dec')
    decayIdMap.set(decay.id, id)
    return { ...decay, id, layerId: layerIdMap.get(decay.layerId) ?? decay.layerId }
  })
  const stepIdMap = new Map<string, string>()
  const repairSteps = payload.repairSteps.map((step) => {
    const id = createId('step')
    stepIdMap.set(step.id, id)
    return { ...step, id, decayId: decayIdMap.get(step.decayId) ?? step.decayId }
  })

  const withLedger = ensureLedgerInPayload(payload)
  const ledgerEntries = withLedger.repairLedger ?? []
  // 流水条目 id 也要重映射（冲突记录内嵌的草稿用同一套映射）
  const ledgerIdMap = new Map<string, string>()
  ledgerEntries.forEach((entry) => {
    ledgerIdMap.set(entry.id, createId('led'))
  })

  // 追加导入：流水序号按原相对顺序整体顺延。与本地数据同库 bulkPut 共存时，
  // 用时间戳高位偏移保证只追加且不撞号；接纳顺序仍以 seq 大小为准。
  const seqOffset = Date.now()
  const repairLedger: RepairLedgerEntry[] = [...ledgerEntries]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => {
      const newId = ledgerIdMap.get(entry.id) ?? createId('led')
      return {
        ...entry,
        id: newId,
        seq: seqOffset + entry.seq,
        decayId: decayIdMap.get(entry.decayId) ?? entry.decayId,
        stepId: stepIdMap.get(entry.stepId) ?? entry.stepId,
        reverseOf: entry.reverseOf ? ledgerIdMap.get(entry.reverseOf) ?? entry.reverseOf : undefined
      }
    })

  const repairConflicts: RepairConflict[] = (withLedger.repairConflicts ?? []).map((conflict) => {
    const newEntryId = ledgerIdMap.get(conflict.entry.id) ?? createId('led')
    return {
      ...conflict,
      id: newEntryId,
      decayId: decayIdMap.get(conflict.decayId) ?? conflict.decayId,
      stepId: stepIdMap.get(conflict.stepId) ?? conflict.stepId,
      supersededBy: conflict.supersededBy
        ? ledgerIdMap.get(conflict.supersededBy) ?? conflict.supersededBy
        : null,
      entry: {
        ...conflict.entry,
        id: newEntryId,
        seq: 0,
        acceptedAt: null,
        decayId: decayIdMap.get(conflict.entry.decayId) ?? conflict.entry.decayId,
        stepId: stepIdMap.get(conflict.entry.stepId) ?? conflict.entry.stepId,
        reverseOf: conflict.entry.reverseOf
          ? ledgerIdMap.get(conflict.entry.reverseOf) ?? conflict.entry.reverseOf
          : undefined
      }
    }
  })

  return {
    ...withLedger,
    halls,
    elements,
    layers,
    decays,
    repairSteps,
    repairLedger,
    repairConflicts
  }
}

/** 生成演示样例数据，便于首次打开即可看到完整链路 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const hallId = createId('hall')
  const elementIds = [createId('elem'), createId('elem')]
  const layerIds = elementIds.map(() => createId('lay'))
  const decayIds = layerIds.map(() => createId('dec'))
  const stepIds = [createId('step'), createId('step')]

  await db.transaction(
    'rw',
    [
      db.halls,
      db.elements,
      db.layers,
      db.decays,
      db.repairSteps,
      db.repairLedger
    ],
    async () => {
      await db.halls.put({
        id: hallId,
        name: '大雄宝殿',
        era: '明嘉靖',
        structureType: '大木',
        roofType: '庑殿',
        createdAt: now,
        updatedAt: now
      })
      await db.elements.bulkPut([
        {
          id: elementIds[0],
          hallId,
          position: '檐下',
          name: '前檐明间额枋',
          layerCount: 2,
          baseLayer: '一麻五灰',
          status: '待修',
          createdAt: now,
          updatedAt: now
        },
        {
          id: elementIds[1],
          hallId,
          position: '梁枋',
          name: '七架梁',
          layerCount: 1,
          baseLayer: '单披灰',
          status: '观察',
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.layers.bulkPut([
        {
          id: layerIds[0],
          elementId: elementIds[0],
          level: 1,
          patternName: '旋子',
          pigment: '石青',
          thicknessMm: 1.8,
          createdAt: now,
          updatedAt: now
        },
        {
          id: layerIds[1],
          elementId: elementIds[1],
          level: 1,
          patternName: '苏式',
          pigment: '土黄',
          thicknessMm: 1.2,
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.decays.bulkPut([
        {
          id: decayIds[0],
          layerId: layerIds[0],
          type: '起甲',
          severity: '重度',
          areaCm2: 320.5,
          causeGuess: '地仗层脱胶，受檐口渗水影响',
          repaired: false,
          repairedAt: null,
          createdAt: now,
          updatedAt: now
        },
        {
          id: decayIds[1],
          layerId: layerIds[1],
          type: '龟裂',
          severity: '中度',
          areaCm2: 158,
          causeGuess: '木构件干缩引起画面开裂',
          repaired: false,
          repairedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.repairSteps.bulkPut([
        {
          id: stepIds[0],
          decayId: decayIds[0],
          seq: 1,
          name: '除尘',
          material: '软毛刷 + 去离子水',
          operator: '李文博',
          state: '已完成',
          createdAt: now,
          updatedAt: now
        },
        {
          id: stepIds[1],
          decayId: decayIds[0],
          seq: 2,
          name: '回贴',
          material: '鱼鳔胶（2% 明矾水调和）',
          operator: '李文博',
          state: '进行中',
          createdAt: now,
          updatedAt: now
        }
      ])
      // 已完成工序同步写入正式流水（只追加事实来源）
      await db.repairLedger.put({
        id: createId('led'),
        seq: 1,
        decayId: decayIds[0],
        stepId: stepIds[0],
        action: 'complete',
        baseSeq: 0,
        tabId: 'demo-seed',
        operator: '李文博',
        note: '样例数据初始完成记录',
        createdAt: now,
        acceptedAt: now
      })
      await reprojectDecays()
    }
  )
}
