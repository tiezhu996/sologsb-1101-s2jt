import {
  db,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import type { LedgerDraft, LedgerEntry, PendingMerge } from '@/types/ledger'

type CollectionKey =
  | 'halls'
  | 'elements'
  | 'layers'
  | 'decays'
  | 'repairSteps'
  | 'ledgerEntries'
  | 'pendingMerges'
  | 'ledgerDrafts'

const COLLECTION_KEYS: CollectionKey[] = [
  'halls',
  'elements',
  'layers',
  'decays',
  'repairSteps',
  'ledgerEntries',
  'pendingMerges',
  'ledgerDrafts'
]

/** 校验备份对象的必备字段，返回错误信息数组（为空表示通过） */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbmuralarch') errors.push('app 字段应为 gbmuralarch，文件来源不明')
  for (const key of COLLECTION_KEYS) {
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
    ledgerEntries: obj.ledgerEntries ?? [],
    pendingMerges: obj.pendingMerges ?? [],
    ledgerDrafts: obj.ledgerDrafts ?? []
  }
  return { ok: true, errors, payload }
}

/** 组装当前本地数据的备份对象（读取的是全部数据；统计侧在页面上只认对账结果） */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [
    halls,
    elements,
    layers,
    decays,
    repairSteps,
    ledgerEntries,
    pendingMerges,
    ledgerDrafts
  ] = await Promise.all([
    db.halls.toArray(),
    db.elements.toArray(),
    db.layers.toArray(),
    db.decays.toArray(),
    db.repairSteps.toArray(),
    db.ledgerEntries.toArray(),
    db.pendingMerges.toArray(),
    db.ledgerDrafts.toArray()
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
    ledgerEntries,
    pendingMerges,
    ledgerDrafts
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
      ledgerEntries: payload.ledgerEntries.length,
      pendingMerges: payload.pendingMerges.length,
      ledgerDrafts: payload.ledgerDrafts.length
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

/** 旧版备份（v1/v2，无流水）：按旧工序「已完成」现状合成初始正式流水 */
function synthesizeLegacyEntries(payload: BackupPayload, seqOffset: number): LedgerEntry[] {
  const stamp = Date.now()
  let seq = seqOffset
  return [...payload.repairSteps]
    .filter((step) => step.state === '已完成')
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a.id.localeCompare(b.id))
    .map((step) => {
      seq += 1
      return {
        id: createId('led'),
        seq,
        kind: 'complete' as const,
        status: 'accepted' as const,
        stepId: step.id,
        decayId: step.decayId,
        stepName: step.name,
        material: step.material,
        operator: step.operator,
        baseSeq: seq - 1,
        clientId: 'migration-import',
        reason: null,
        reversesEntryId: null,
        createdAt: step.updatedAt ?? stamp,
        resolvedAt: step.updatedAt ?? stamp
      }
    })
}

/** 导入备份：overwrite=true 时先清空全部表，否则按主键合并（同 id 覆盖） */
export async function importBackup(
  payload: BackupPayload,
  overwrite: boolean
): Promise<Record<string, number>> {
  if (overwrite) await clearAllTables()

  // 旧版备份没有流水：按旧工序现状补初始记录，再由导入后的对账统一病害现状
  let ledgerEntries = payload.ledgerEntries
  if (ledgerEntries.length === 0 && payload.repairSteps.some((step) => step.state === '已完成')) {
    ledgerEntries = synthesizeLegacyEntries(payload, 0)
  }
  const pendingMerges = payload.pendingMerges
  const ledgerDrafts = payload.ledgerDrafts

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
      await db.halls.bulkPut(payload.halls)
      await db.elements.bulkPut(payload.elements)
      await db.layers.bulkPut(payload.layers)
      await db.decays.bulkPut(payload.decays)
      await db.repairSteps.bulkPut(payload.repairSteps)
      await db.ledgerEntries.bulkPut(ledgerEntries)
      await db.pendingMerges.bulkPut(pendingMerges)
      await db.ledgerDrafts.bulkPut(ledgerDrafts)
    }
  )
  // 导入后统一对账：工序完成态与病害现状以正式流水为准
  const { useLedgerStore } = await import('@/stores/ledgerStore')
  await useLedgerStore().reconcileCaches()
  return {
    halls: payload.halls.length,
    elements: payload.elements.length,
    layers: payload.layers.length,
    decays: payload.decays.length,
    repairSteps: payload.repairSteps.length,
    ledgerEntries: ledgerEntries.length,
    pendingMerges: pendingMerges.length,
    ledgerDrafts: ledgerDrafts.length
  }
}

/**
 * 追加式导入：为导入数据重新分配 id，避免覆盖现有档案。
 * 流水序号在本地当前 head 之后顺延（保持接纳顺序连续），反向引用同步改指向；
 * 草稿与待裁决项一并重映射，导入后统一走对账。
 */
export async function remapIds(payload: BackupPayload): Promise<BackupPayload> {
  const hallIdMap = new Map<string, string>()
  const elementIdMap = new Map<string, string>()
  const layerIdMap = new Map<string, string>()
  const decayIdMap = new Map<string, string>()
  const stepIdMap = new Map<string, string>()
  const entryIdMap = new Map<string, string>()

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
  const repairSteps = payload.repairSteps.map((step) => {
    const id = createId('step')
    stepIdMap.set(step.id, id)
    return {
      ...step,
      id,
      decayId: decayIdMap.get(step.decayId) ?? step.decayId,
      ledgerVersion: step.ledgerVersion ?? 1
    }
  })

  // 本地流水 head 之后顺延，保持序号全局连续
  const localEntries = await db.ledgerEntries.toArray()
  const seqOffset = localEntries.reduce((max, entry) => Math.max(max, entry.seq), 0)

  const ledgerEntries: LedgerEntry[] = [...payload.ledgerEntries]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => {
      const id = createId('led')
      entryIdMap.set(entry.id, id)
      return {
        ...entry,
        id,
        seq: entry.seq + seqOffset,
        stepId: stepIdMap.get(entry.stepId) ?? entry.stepId,
        decayId: decayIdMap.get(entry.decayId) ?? entry.decayId
      }
    })
    // 反向记录的指向随新 id 改写
    .map((entry) => ({
      ...entry,
      reversesEntryId: entry.reversesEntryId ? entryIdMap.get(entry.reversesEntryId) ?? null : null
    }))

  const pendingMerges: PendingMerge[] = payload.pendingMerges.map((pending) => ({
    ...pending,
    id: createId('pmg'),
    stepId: stepIdMap.get(pending.stepId) ?? pending.stepId,
    decayId: decayIdMap.get(pending.decayId) ?? pending.decayId,
    actualSeq: pending.actualSeq + seqOffset,
    baseSeq: pending.baseSeq + seqOffset,
    reversesEntryId: pending.reversesEntryId ? entryIdMap.get(pending.reversesEntryId) ?? null : null
  }))

  const ledgerDrafts: LedgerDraft[] = payload.ledgerDrafts.map((draft) => ({
    ...draft,
    id: createId('drf'),
    stepId: stepIdMap.get(draft.stepId) ?? draft.stepId,
    decayId: decayIdMap.get(draft.decayId) ?? draft.decayId,
    baseSeq: draft.baseSeq + seqOffset
  }))

  // 旧版备份（v1/v2，无流水表数据）：追加导入后按旧工序现状补初始流水，
  // 保证导入数据同样受流水对账约束（已完成工序各一条 migration-import 正式记录）。
  if (ledgerEntries.length === 0 && payload.ledgerEntries.length === 0) {
    ledgerEntries.push(...synthesizeLegacyEntries({ ...payload, repairSteps }, seqOffset))
  }

  return {
    ...payload,
    halls,
    elements,
    layers,
    decays,
    repairSteps,
    ledgerEntries,
    pendingMerges,
    ledgerDrafts
  }
}

/** 生成演示样例数据，便于首次打开即可看到完整链路 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const hallId = createId('hall')
  const elementIds = [createId('elem'), createId('elem')]
  const layerIds = elementIds.map(() => createId('lay'))
  const decayIds = layerIds.map(() => createId('dec'))
  const doneStepId = createId('step')
  const runningStepId = createId('step')
  const clientId = 'seed-demo'

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
          id: doneStepId,
          decayId: decayIds[0],
          seq: 1,
          name: '除尘',
          material: '软毛刷 + 去离子水',
          operator: '李文博',
          state: '已完成',
          ledgerVersion: 1,
          createdAt: now,
          updatedAt: now
        },
        {
          id: runningStepId,
          decayId: decayIds[0],
          seq: 2,
          name: '回贴',
          material: '鱼鳔胶（2% 明矾水调和）',
          operator: '李文博',
          state: '进行中',
          ledgerVersion: 1,
          createdAt: now,
          updatedAt: now
        }
      ])

      // 样例同样以正式流水表达施工过程：一条已裁决入账的完成记录
      const localHead = (await db.ledgerEntries.toArray()).reduce((max, entry) => Math.max(max, entry.seq), 0)
      const entry: LedgerEntry = {
        id: createId('led'),
        seq: localHead + 1,
        kind: 'complete',
        status: 'accepted',
        stepId: doneStepId,
        decayId: decayIds[0],
        stepName: '除尘',
        material: '软毛刷 + 去离子水',
        operator: '李文博',
        baseSeq: localHead,
        clientId,
        reason: null,
        reversesEntryId: null,
        createdAt: now,
        resolvedAt: now
      }
      await db.ledgerEntries.add(entry)
    }
  )
}
