/**
 * 批量重编的纯逻辑：预览每封的关联变化、列出日期 / 路线顺序冲突、把操作应用到封与票戳组合。
 * 不触碰任何被其他封引用的邮戳 / 邮路对象——只改封的关联，并由调用方另建替代关系。
 */
import type { Cover } from '@/types/cover'
import type { Postmark } from '@/types/postmark'
import type { PostalRoute } from '@/types/route'
import type { StamplessEntry } from '@/types/stampentry'
import { compareDate, isChronological, isValidDate } from '@/utils/dateRange'
import type {
  BatchConflict,
  BatchOp,
  CoverOpPreview,
  PmChange,
  RouteChange,
  StampNameChange
} from '@/types/batch'

/** 预览所需的目录上下文。 */
export interface BatchContext {
  postmarkById: Map<number, Postmark>
  routeById: Map<number, PostalRoute>
}

export function createBatchOp(kind: BatchOp['kind']): BatchOp {
  return { id: `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, kind, mode: 'replace' }
}

function stampLabel(id: number, ctx: BatchContext): string {
  const pm = ctx.postmarkById.get(id)
  return pm ? `${pm.pmNo} ${pm.office}` : `未登记邮戳 #${id}`
}

function routeLabel(id: number | null, ctx: BatchContext): string {
  if (id == null) return '未挂邮路'
  const rt = ctx.routeById.get(id)
  return rt ? `${rt.routeNo} ${rt.name}` : `未登记邮路 #${id}`
}

/** 操作的中文描述，供预览与替代关系备注使用。 */
export function describeOp(op: BatchOp, ctx: BatchContext): string {
  if (op.kind === 'postmark') {
    const from = op.fromId == null ? '?' : stampLabel(op.fromId, ctx)
    if (op.mode === 'remove') return `移除邮戳 ${from}`
    const to = op.toId == null ? '?' : stampLabel(op.toId, ctx)
    return `邮戳 ${from} → ${to}`
  }
  if (op.kind === 'route') {
    const from = op.fromId == null ? '?' : routeLabel(op.fromId, ctx)
    if (op.mode === 'remove') return `摘除邮路 ${from}`
    const to = op.toId == null ? '?' : routeLabel(op.toId, ctx)
    return `邮路 ${from} → ${to}`
  }
  const from = op.fromName?.trim() || '?'
  if (op.mode === 'remove') return `移除邮票「${from}」`
  const to = op.toName?.trim() || '?'
  return `邮票「${from}」→「${to}」`
}

/* ------------------------------ 预览 ------------------------------ */

/** 计算单封应用操作后的关联变化（不写库）。 */
export function previewCover(
  cover: Cover,
  ops: BatchOp[],
  ctx: BatchContext,
  entries: StamplessEntry[]
): CoverOpPreview {
  const pmRemoved: number[] = []
  const pmReplaced: PmChange[] = []
  const pmAfter = [...cover.cancelPmIds]

  let routeRemoved = false
  let routeReplaced: RouteChange | null = null
  let routeAfter = cover.routeId

  const stampRemoved: string[] = []
  const stampReplaced: StampNameChange[] = []

  for (const op of ops) {
    if (op.kind === 'postmark') {
      if (op.mode === 'remove' && op.fromId != null) {
        const idx = pmAfter.indexOf(op.fromId)
        if (idx >= 0) {
          pmAfter.splice(idx, 1)
          pmRemoved.push(op.fromId)
        }
      } else if (op.mode === 'replace' && op.fromId != null && op.toId != null) {
        const idx = pmAfter.indexOf(op.fromId)
        if (idx >= 0) {
          pmAfter[idx] = op.toId
          pmReplaced.push({ from: op.fromId, to: op.toId })
        }
      }
    } else if (op.kind === 'route') {
      if (op.mode === 'remove' && op.fromId != null) {
        if (routeAfter === op.fromId) {
          routeAfter = null
          routeRemoved = true
        }
      } else if (op.mode === 'replace' && op.fromId != null && op.toId != null) {
        if (routeAfter === op.fromId) {
          routeAfter = op.toId
          routeReplaced = { from: op.fromId, to: op.toId }
        }
      }
    } else if (op.kind === 'stamp') {
      if (op.mode === 'remove' && op.fromName) {
        const hit = entries.some((e) => e.stampName === op.fromName)
        if (hit && !stampRemoved.includes(op.fromName)) stampRemoved.push(op.fromName)
      } else if (op.mode === 'replace' && op.fromName && op.toName) {
        const hit = entries.some((e) => e.stampName === op.fromName)
        if (hit && !stampReplaced.some((c) => c.from === op.fromName)) {
          stampReplaced.push({ from: op.fromName, to: op.toName })
        }
      }
    }
  }

  const stampAffectedCount =
    stampRemoved.reduce(
      (sum, name) => sum + entries.filter((e) => e.stampName === name).length,
      0
    ) +
    stampReplaced.reduce(
      (sum, c) => sum + entries.filter((e) => e.stampName === c.from).length,
      0
    )

  const conflicts = detectConflicts(cover, pmAfter, routeAfter, ctx)

  const changed =
    pmRemoved.length > 0 ||
    pmReplaced.length > 0 ||
    routeRemoved ||
    routeReplaced != null ||
    stampRemoved.length > 0 ||
    stampReplaced.length > 0

  return {
    coverId: cover.id as number,
    coverNo: cover.coverNo,
    sentFrom: cover.sentFrom,
    sentTo: cover.sentTo,
    pmRemoved,
    pmReplaced,
    pmAfter,
    routeRemoved,
    routeReplaced,
    routeAfter,
    stampRemoved,
    stampReplaced,
    stampAffectedCount,
    conflicts,
    changed
  }
}

/* ------------------------------ 冲突检测 ------------------------------ */

/** 依据应用后的关联检测日期 / 路线顺序冲突。 */
function detectConflicts(
  cover: Cover,
  pmAfter: number[],
  routeAfter: number | null,
  ctx: BatchContext
): string[] {
  const conflicts: string[] = []

  // 封自身日期顺序
  if (isValidDate(cover.postDate) && isValidDate(cover.arriveDate)) {
    if (compareDate(cover.postDate, cover.arriveDate) > 0) {
      conflicts.push(`寄出日期 ${cover.postDate} 晚于到达日期 ${cover.arriveDate}`)
    }
  }

  // 邮戳：使用年代与戳面日期是否与封的寄递日期对得上
  for (const pmId of pmAfter) {
    const pm = ctx.postmarkById.get(pmId)
    if (!pm) continue // 悬空 id 属于「待修」，不在此判冲突
    if (isValidDate(cover.postDate)) {
      const year = Number(cover.postDate.slice(0, 4))
      if (year < pm.yearFrom || year > pm.yearTo) {
        conflicts.push(
          `寄出年份 ${year} 不在邮戳 ${pm.pmNo} 使用年代 ${pm.yearFrom}–${pm.yearTo} 内`
        )
      }
    }
    if (isValidDate(pm.dateOnStamp)) {
      if (isValidDate(cover.postDate) && compareDate(pm.dateOnStamp, cover.postDate) < 0) {
        conflicts.push(`邮戳 ${pm.pmNo} 戳面日期 ${pm.dateOnStamp} 早于寄出日期 ${cover.postDate}`)
      }
      if (isValidDate(cover.arriveDate) && compareDate(pm.dateOnStamp, cover.arriveDate) > 0) {
        conflicts.push(`邮戳 ${pm.pmNo} 戳面日期 ${pm.dateOnStamp} 晚于到达日期 ${cover.arriveDate}`)
      }
    }
  }

  // 邮路：中转地顺序与节点日期是否对得上
  if (routeAfter != null) {
    const rt = ctx.routeById.get(routeAfter)
    if (rt) {
      const nodeOffices = rt.nodes.map((n) => n.office)
      let cursor = 0
      for (const via of Array.isArray(cover.viaPoints) ? cover.viaPoints : []) {
        const at = nodeOffices.indexOf(via, cursor)
        if (at < 0) {
          conflicts.push(`中转地「${via}」在邮路 ${rt.routeNo} 节点中不存在或顺序不符`)
        } else {
          cursor = at + 1
        }
      }
      const dates: string[] = []
      if (isValidDate(cover.postDate)) dates.push(cover.postDate)
      for (const n of rt.nodes) {
        // 与 buildTimeline 保持一致：跳过寄出节点，其余节点日期参与顺序校验
        if (n.office === cover.sentFrom) continue
        if (isValidDate(n.arriveDate)) dates.push(n.arriveDate)
      }
      if (isValidDate(cover.arriveDate)) dates.push(cover.arriveDate)
      if (!isChronological(dates)) {
        conflicts.push(`邮路 ${rt.routeNo} 节点日期与封的寄递日期顺序对不上`)
      }
    }
  }

  return conflicts
}

/** 汇总整批冲突（仅含有冲突的封）。 */
export function collectConflicts(previews: CoverOpPreview[]): BatchConflict[] {
  return previews
    .filter((p) => p.changed && p.conflicts.length > 0)
    .map((p) => ({ coverId: p.coverId, coverNo: p.coverNo, messages: p.conflicts }))
}

/* ------------------------------ 应用到封 ------------------------------ */

/** 把操作应用到封，返回新对象（不改原对象）。 */
export function applyOpsToCover(cover: Cover, ops: BatchOp[]): Cover {
  const next: Cover = {
    ...cover,
    cancelPmIds: [...cover.cancelPmIds],
    viaPoints: [...cover.viaPoints]
  }
  for (const op of ops) {
    if (op.kind === 'postmark') {
      if (op.mode === 'remove' && op.fromId != null) {
        next.cancelPmIds = next.cancelPmIds.filter((id) => id !== op.fromId)
      } else if (op.mode === 'replace' && op.fromId != null && op.toId != null) {
        const toId = op.toId
        next.cancelPmIds = next.cancelPmIds.map((id) => (id === op.fromId ? toId : id))
      }
    } else if (op.kind === 'route') {
      if (op.mode === 'remove' && op.fromId != null) {
        if (next.routeId === op.fromId) next.routeId = null
      } else if (op.mode === 'replace' && op.fromId != null && op.toId != null) {
        if (next.routeId === op.fromId) next.routeId = op.toId
      }
    }
  }
  return next
}

/** 票戳组合的应用结果：需删除 / 需改名的条目（快照用于撤销）。 */
export interface StampEntryMutation {
  entry: StamplessEntry
  action: 'remove' | 'rename'
  toName?: string
}

/** 计算某封的票戳组合变更（不改原对象）。 */
export function stampEntryMutations(
  entries: StamplessEntry[],
  ops: BatchOp[]
): StampEntryMutation[] {
  const mutations: StampEntryMutation[] = []
  for (const entry of entries) {
    for (const op of ops) {
      if (op.kind !== 'stamp') continue
      if (op.mode === 'remove' && op.fromName && entry.stampName === op.fromName) {
        mutations.push({ entry, action: 'remove' })
        break
      }
      if (
        op.mode === 'replace' &&
        op.fromName &&
        op.toName &&
        entry.stampName === op.fromName
      ) {
        mutations.push({ entry, action: 'rename', toName: op.toName })
        break
      }
    }
  }
  return mutations
}
