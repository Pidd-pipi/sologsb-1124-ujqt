/**
 * 实寄封关联完整性判定：封上的邮戳 / 邮路引用是否仍指向存在的对象。
 * 目录行内标记、详情警示、检索筛选与 v3 升级迁移共用这里的纯函数，
 * 保证「详情和检索显示同一结果」。
 */
import type { Cover } from '@/types/cover'

/** 一条断链：指向了不存在的邮戳或邮路。 */
export interface MissingLink {
  kind: 'postmark' | 'route'
  refId: number
}

/** 单封的关联完整性状态。 */
export interface CoverLinkState {
  needRepair: boolean
  missingPostmarkIds: number[]
  missingRouteId: number | null
}

const CLEAN_STATE: CoverLinkState = {
  needRepair: false,
  missingPostmarkIds: [],
  missingRouteId: null
}

/** 由一批带 id 的记录构造存在性集合。 */
export function idSet<T extends { id?: number }>(rows: T[]): Set<number> {
  const set = new Set<number>()
  for (const row of rows) {
    if (typeof row.id === 'number') set.add(row.id)
  }
  return set
}

/** 按现存邮戳 / 邮路 id 集合判定单封是否断链。 */
export function evaluateCoverLinks(
  cover: Cover,
  postmarkIds: Set<number>,
  routeIds: Set<number>
): CoverLinkState {
  const missingPostmarkIds = cover.cancelPmIds.filter((id) => !postmarkIds.has(id))
  const missingRouteId =
    typeof cover.routeId === 'number' && !routeIds.has(cover.routeId) ? cover.routeId : null
  if (missingPostmarkIds.length === 0 && missingRouteId === null) {
    return CLEAN_STATE
  }
  return { needRepair: true, missingPostmarkIds, missingRouteId }
}

/** 把状态展开为断链列表。 */
export function missingLinksOf(state: CoverLinkState): MissingLink[] {
  const links: MissingLink[] = state.missingPostmarkIds.map((refId) => ({
    kind: 'postmark' as const,
    refId
  }))
  if (state.missingRouteId !== null) links.push({ kind: 'route', refId: state.missingRouteId })
  return links
}

/** 断链的中文标签。 */
export function missingLinkLabel(link: MissingLink): string {
  return link.kind === 'postmark'
    ? `未登记邮戳 #${link.refId}`
    : `未登记邮路 #${link.refId}`
}
