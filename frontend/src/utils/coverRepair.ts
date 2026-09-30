/**
 * 实寄封「待修」状态：关联邮戳或邮路指向了不存在的对象。
 * 旧数据升级时由迁移写入 needsRepair / repairReasons；
 * 详情页与检索页统一调用本函数，保证两处显示同一结果。
 */
import type { Cover } from '@/types/cover'

export interface CoverRepairState {
  needsRepair: boolean
  reasons: string[]
}

/** 由行记录构造 id 集合（自动忽略未保存的新记录）。 */
export function idSetOf(rows: { id?: number }[]): Set<number> {
  const set = new Set<number>()
  for (const row of rows) {
    if (typeof row.id === 'number') set.add(row.id)
  }
  return set
}

/** 实时计算封的待修状态：关联邮戳 / 邮路是否悬空。 */
export function coverRepairState(
  cover: Cover,
  postmarkIds: Set<number>,
  routeIds: Set<number>
): CoverRepairState {
  const reasons: string[] = []
  for (const pmId of Array.isArray(cover.cancelPmIds) ? cover.cancelPmIds : []) {
    if (!postmarkIds.has(pmId)) reasons.push(`关联邮戳 #${pmId} 不存在`)
  }
  const routeId = typeof cover.routeId === 'number' ? cover.routeId : null
  if (routeId != null && !routeIds.has(routeId)) reasons.push(`所属邮路 #${routeId} 不存在`)
  return { needsRepair: reasons.length > 0, reasons }
}
