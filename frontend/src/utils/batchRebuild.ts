/**
 * 批量重编引擎：
 * - planBatchRebuild：纯函数，按库内现状算出所选每封将替换 / 移除的关联、
 *   将新建的替代邮戳 / 邮路，以及阻塞性冲突；不写任何数据，供预览核对。
 * - commitBatchRebuild：单个 Dexie 事务内落库，同时写入撤销快照；
 *   任一步失败事务整体回滚，整批开始前的数据由 IndexedDB 原子回滚保护，
 *   提交后再做一次结果校验。
 * - undoBatchRebuild：按快照恢复整批开始前的实寄封并删去本批新建对象，
 *   只保留最近一次成功批次，成功后仅允许撤销一次。
 *
 * 不变量：非所选实寄封绝不写入；共用邮戳 / 邮路绝不原地改删，
 * 需要新事实时一律新建带 supersedesId 的替代对象。
 */
import { db, recomputeRepairFlags } from '@/utils/db'
import type { Cover } from '@/types/cover'
import type {
  Postmark,
  PostmarkLettering,
  PostmarkType,
  ScarceLevel
} from '@/types/postmark'
import type { PostalRoute, RouteNode, TransportMode } from '@/types/route'
import { daysBetween, isValidDate } from '@/utils/dateRange'
import { nextSerialNo, nowIso, uid } from '@/utils/id'

/* ------------------------------ 请求类型 ------------------------------ */

/** 指向本批新建事实（邮戳 / 邮路草稿）。 */
export interface FactRef {
  newKey: string
}

/** 邮戳关联：已登记 id，或本批新建草稿键。 */
export type PmRef = number | FactRef

/** 邮路关联：已登记 id、本批新建草稿键，或 null（摘除邮路）。 */
export type RouteRef = number | FactRef | null

/** 单封重编指令；缺省字段表示该封对应事实不改。 */
export interface CoverRebuildInstruction {
  coverId: number
  postDate?: string
  arriveDate?: string
  /** 给出即为最终完整关联邮戳列表；缺省表示不动 */
  cancelPmRefs?: PmRef[]
  /** 缺省表示不动；null 表示摘除邮路 */
  routeRef?: RouteRef
}

/** 新事实邮戳草稿（基于共用旧戳改出来的替代戳）。 */
export interface PostmarkFactDraft {
  key: string
  /** 留空则自动续号 */
  pmNo: string
  type: PostmarkType
  office: string
  province: string
  yearFrom: number
  yearTo: number
  dateOnStamp: string
  inkColor: string
  diameter: number
  lettering: PostmarkLettering
  bilingual: boolean
  scarceLevel: ScarceLevel
  note: string
  /** 所替代的原邮戳 id；原位补登（无旧对象）为 null */
  cloneFromId: number | null
}

/** 新事实邮路草稿。 */
export interface RouteFactDraft {
  key: string
  routeNo: string
  name: string
  era: string
  transport: TransportMode
  nodes: RouteNode[]
  frequency: string
  remark: string
  cloneFromId: number | null
}

export interface BatchRebuildRequest {
  coverIds: number[]
  instructions: CoverRebuildInstruction[]
  newPostmarks: PostmarkFactDraft[]
  newRoutes: RouteFactDraft[]
  reason?: string
}

/* ------------------------------ 计划类型 ------------------------------ */

export type ConflictCode =
  | 'cover-not-found'
  | 'duplicate-cover'
  | 'invalid-date'
  | 'arrive-before-post'
  | 'missing-postmark-ref'
  | 'missing-route-ref'
  | 'draft-not-found'
  | 'postmark-draft-invalid'
  | 'route-draft-invalid'
  | 'route-node-order'
  | 'route-vs-cover-dates'
  | 'pm-no-conflict'
  | 'route-no-conflict'

export interface BatchConflict {
  /** null 表示与某封无关的草稿级冲突 */
  coverId: number | null
  code: ConflictCode
  message: string
}

export type WarningCode = 'kept-missing-link' | 'duplicate-pm-ref' | 'unchanged'

export interface BatchWarning {
  coverId: number
  code: WarningCode
  message: string
}

export interface CreatedPostmarkView {
  key: string
  /** 已分配的编目号（可能为自动续号） */
  pmNo: string
  cloneFromId: number | null
  office: string
}

export interface CreatedRouteView {
  key: string
  routeNo: string
  cloneFromId: number | null
  name: string
}

export interface PlannedPostmarkDelta {
  action: 'keep' | 'replace' | 'remove'
  fromId: number | null
  to?:
    | { kind: 'existing'; id: number }
    | { kind: 'created'; key: string; pmNo: string; cloneFromId: number | null }
}

export interface PlannedRouteDelta {
  action: 'keep' | 'replace' | 'detach' | 'unchanged'
  fromRouteId: number | null
  to?:
    | { kind: 'existing'; id: number }
    | { kind: 'created'; key: string; routeNo: string; cloneFromId: number | null }
}

export interface CoverPlanView {
  coverId: number
  cover: Cover
  postDateFrom: string
  postDateTo: string
  arriveDateFrom: string
  arriveDateTo: string
  postmarkDeltas: PlannedPostmarkDelta[]
  routeDelta: PlannedRouteDelta
  warnings: BatchWarning[]
  /** 提交时将写入的最终值（计划内部使用） */
  finalPmIds: number[]
  finalRouteId: number | null
}

export interface BatchPlan {
  ok: boolean
  selectedIds: number[]
  views: CoverPlanView[]
  createdPostmarks: CreatedPostmarkView[]
  createdRoutes: CreatedRouteView[]
  conflicts: BatchConflict[]
  warnings: BatchWarning[]
  /** 提交所需的解析后草稿行（无 id） */
  resolvedPostmarks: Postmark[]
  resolvedRoutes: PostalRoute[]
  /** 整批开始前所选封的完整快照 */
  coversBefore: Cover[]
  reason: string
}

/* ------------------------------ 纯函数工具 ------------------------------ */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function localComputeTotalDays(nodes: RouteNode[]): number {
  const dated = nodes.filter((n) => isValidDate(n.arriveDate))
  if (dated.length < 2) return 0
  const span = daysBetween(dated[0].arriveDate, dated[dated.length - 1].arriveDate)
  return span == null || span < 0 ? 0 : span
}

function isFactRef(ref: PmRef | RouteRef): ref is FactRef {
  return typeof ref === 'object' && ref !== null && 'newKey' in ref
}

/* ------------------------------ 预览计划 ------------------------------ */

export function planBatchRebuild(req: BatchRebuildRequest, ctx: {
  covers: Cover[]
  postmarks: Postmark[]
  routes: PostalRoute[]
}): BatchPlan {
  const conflicts: BatchConflict[] = []
  const warnings: BatchWarning[] = []
  const reason = req.reason ?? ''

  const coverMap = new Map<number, Cover>()
  for (const c of ctx.covers) if (typeof c.id === 'number') coverMap.set(c.id, c)
  const pmMap = new Map<number, Postmark>()
  for (const p of ctx.postmarks) if (typeof p.id === 'number') pmMap.set(p.id, p)
  const routeMap = new Map<number, PostalRoute>()
  for (const r of ctx.routes) if (typeof r.id === 'number') routeMap.set(r.id, r)

  const pmDraftMap = new Map<string, PostmarkFactDraft>()
  for (const d of req.newPostmarks) {
    if (!pmDraftMap.has(d.key)) pmDraftMap.set(d.key, d)
  }
  const routeDraftMap = new Map<string, RouteFactDraft>()
  for (const d of req.newRoutes) {
    if (!routeDraftMap.has(d.key)) routeDraftMap.set(d.key, d)
  }

  /* 选中去重与存在性 */
  const seenCover = new Set<number>()
  const selectedIds: number[] = []
  for (const id of req.coverIds) {
    if (seenCover.has(id)) {
      conflicts.push({
        coverId: id,
        code: 'duplicate-cover',
        message: `实寄封 #${id} 在本批中被重复选择。`
      })
      continue
    }
    seenCover.add(id)
    selectedIds.push(id)
    if (!coverMap.has(id)) {
      conflicts.push({
        coverId: id,
        code: 'cover-not-found',
        message: `未找到编号为 ${id} 的实寄封，可能已被他人删除，请刷新目录后重选。`
      })
    }
  }

  /* 草稿编号分配：显式编号查重，空号自动续号（按草稿顺序，结果确定） */
  const pmNoAssign = new Map<string, string>()
  const usedPmNos = new Set(ctx.postmarks.map((p) => p.pmNo))
  for (const d of req.newPostmarks) {
    const no = d.pmNo.trim()
    if (!no) continue
    if (usedPmNos.has(no)) {
      conflicts.push({
        coverId: null,
        code: 'pm-no-conflict',
        message: `新戳编号 ${no} 与已有邮戳重复，请改用别的编号或留空自动续号。`
      })
    }
    usedPmNos.add(no)
    pmNoAssign.set(d.key, no)
  }
  for (const d of req.newPostmarks) {
    if (!pmNoAssign.has(d.key)) {
      const no = nextSerialNo('PM-', [...usedPmNos])
      usedPmNos.add(no)
      pmNoAssign.set(d.key, no)
    }
  }

  const routeNoAssign = new Map<string, string>()
  const usedRouteNos = new Set(ctx.routes.map((r) => r.routeNo))
  for (const d of req.newRoutes) {
    const no = d.routeNo.trim()
    if (!no) continue
    if (usedRouteNos.has(no)) {
      conflicts.push({
        coverId: null,
        code: 'route-no-conflict',
        message: `新邮路编号 ${no} 与已有邮路重复，请改用别的编号或留空自动续号。`
      })
    }
    usedRouteNos.add(no)
    routeNoAssign.set(d.key, no)
  }
  for (const d of req.newRoutes) {
    if (!routeNoAssign.has(d.key)) {
      const no = nextSerialNo('RT-', [...usedRouteNos])
      usedRouteNos.add(no)
      routeNoAssign.set(d.key, no)
    }
  }

  /* 草稿自身校验（与具体封无关的阻塞项） */
  for (const d of req.newPostmarks) {
    if (!d.office.trim()) {
      conflicts.push({
        coverId: null,
        code: 'postmark-draft-invalid',
        message: `新邮戳草稿（${pmNoAssign.get(d.key) ?? d.key}）缺少使用局所。`
      })
    }
    if (d.dateOnStamp && !isValidDate(d.dateOnStamp)) {
      conflicts.push({
        coverId: null,
        code: 'invalid-date',
        message: `新邮戳 ${pmNoAssign.get(d.key) ?? d.key} 的戳面日期 ${d.dateOnStamp} 不合法。`
      })
    }
    if (d.yearFrom > d.yearTo) {
      conflicts.push({
        coverId: null,
        code: 'postmark-draft-invalid',
        message: `新邮戳 ${pmNoAssign.get(d.key) ?? d.key} 的使用年代起止倒置。`
      })
    }
    if (d.cloneFromId !== null && !pmMap.has(d.cloneFromId)) {
      conflicts.push({
        coverId: null,
        code: 'missing-postmark-ref',
        message: `新邮戳 ${pmNoAssign.get(d.key) ?? d.key} 标注替代 #${d.cloneFromId}，但该原邮戳不存在。`
      })
    }
  }
  for (const d of req.newRoutes) {
    if (!d.name.trim()) {
      conflicts.push({
        coverId: null,
        code: 'route-draft-invalid',
        message: `新邮路草稿（${routeNoAssign.get(d.key) ?? d.key}）缺少名称。`
      })
    }
    for (const node of d.nodes) {
      if (node.arriveDate && !isValidDate(node.arriveDate)) {
        conflicts.push({
          coverId: null,
          code: 'invalid-date',
          message: `新邮路 ${routeNoAssign.get(d.key) ?? d.key} 节点「${node.office || '待补'}」日期 ${node.arriveDate} 不合法。`
        })
      }
    }
    const dated = d.nodes.filter((n) => isValidDate(n.arriveDate)).map((n) => n.arriveDate)
    for (let i = 1; i < dated.length; i += 1) {
      if (dated[i - 1] > dated[i]) {
        conflicts.push({
          coverId: null,
          code: 'route-node-order',
          message: `新邮路 ${routeNoAssign.get(d.key) ?? d.key} 的节点日期顺序倒置：${dated[i - 1]} 晚于 ${dated[i]}。`
        })
        break
      }
    }
    if (d.cloneFromId !== null && !routeMap.has(d.cloneFromId)) {
      conflicts.push({
        coverId: null,
        code: 'missing-route-ref',
        message: `新邮路 ${routeNoAssign.get(d.key) ?? d.key} 标注替代 #${d.cloneFromId}，但该原邮路不存在。`
      })
    }
  }

  /* 逐封解析 */
  const instrMap = new Map<number, CoverRebuildInstruction>()
  for (const ins of req.instructions) instrMap.set(ins.coverId, ins)

  const views: CoverPlanView[] = []
  const coversBefore: Cover[] = []

  for (const coverId of selectedIds) {
    const cover = coverMap.get(coverId)
    if (!cover) continue
    coversBefore.push(clone(cover))
    const ins = instrMap.get(coverId)
    const coverWarnings: BatchWarning[] = []

    const postDateTo = ins?.postDate !== undefined ? ins.postDate : cover.postDate
    const arriveDateTo = ins?.arriveDate !== undefined ? ins.arriveDate : cover.arriveDate

    if (postDateTo && !isValidDate(postDateTo)) {
      conflicts.push({
        coverId,
        code: 'invalid-date',
        message: `${cover.coverNo} 的寄出日期 ${postDateTo} 不合法（应为 YYYY-MM-DD）。`
      })
    }
    if (arriveDateTo && !isValidDate(arriveDateTo)) {
      conflicts.push({
        coverId,
        code: 'invalid-date',
        message: `${cover.coverNo} 的到达日期 ${arriveDateTo} 不合法（应为 YYYY-MM-DD）。`
      })
    }
    if (
      isValidDate(postDateTo) &&
      isValidDate(arriveDateTo) &&
      daysBetween(postDateTo, arriveDateTo) !== null &&
      Number(daysBetween(postDateTo, arriveDateTo)) < 0
    ) {
      conflicts.push({
        coverId,
        code: 'arrive-before-post',
        message: `${cover.coverNo} 的到达日期 ${arriveDateTo} 早于寄出日期 ${postDateTo}。`
      })
    }

    /* 邮戳关联 */
    const postmarkDeltas: PlannedPostmarkDelta[] = []
    const finalPmIds: number[] = []
    let refsChanged = false
    let pmRefs: PmRef[] | undefined
    if (ins?.cancelPmRefs) pmRefs = ins.cancelPmRefs
    const refList: PmRef[] = pmRefs ?? [...cover.cancelPmIds]

    const dedupSeen = new Set<string>()
    for (const ref of refList) {
      const marker = isFactRef(ref) ? `new:${ref.newKey}` : `id:${ref}`
      if (dedupSeen.has(marker)) {
        coverWarnings.push({
          coverId,
          code: 'duplicate-pm-ref',
          message: `${cover.coverNo} 的关联邮戳存在重复项，提交时将自动去重。`
        })
        continue
      }
      dedupSeen.add(marker)

      if (isFactRef(ref)) {
        const draft = pmDraftMap.get(ref.newKey)
        if (!draft) {
          conflicts.push({
            coverId,
            code: 'draft-not-found',
            message: `${cover.coverNo} 引用了本批不存在的新邮戳草稿（${ref.newKey}）。`
          })
          continue
        }
        finalPmIds.push(-1) // 占位，提交时按 newKey→id 替换
        const wasLinked = cover.cancelPmIds.some((id) => id === draft.cloneFromId)
        postmarkDeltas.push({
          action: 'replace',
          fromId: wasLinked && draft.cloneFromId !== null ? draft.cloneFromId : null,
          to: {
            kind: 'created',
            key: draft.key,
            pmNo: pmNoAssign.get(draft.key) ?? draft.pmNo,
            cloneFromId: draft.cloneFromId
          }
        })
        refsChanged = true
      } else {
        if (!pmMap.has(ref)) {
          conflicts.push({
            coverId,
            code: 'missing-postmark-ref',
            message: `${cover.coverNo} 仍指向未登记邮戳 #${ref}，请在本批移除或改挂后再提交。`
          })
        }
        finalPmIds.push(ref)
        if (!cover.cancelPmIds.includes(ref)) {
          refsChanged = true
          postmarkDeltas.push({
            action: 'replace',
            fromId: null,
            to: { kind: 'existing', id: ref }
          })
        } else {
          postmarkDeltas.push({ action: 'keep', fromId: ref, to: { kind: 'existing', id: ref } })
        }
      }
    }
    for (const oldId of cover.cancelPmIds) {
      const stillThere = refList.some((ref) => !isFactRef(ref) && ref === oldId)
      if (!stillThere) {
        refsChanged = true
        postmarkDeltas.push({ action: 'remove', fromId: oldId })
      }
    }

    /* 邮路关联 */
    let finalRouteId: number | null = cover.routeId
    let routeDelta: PlannedRouteDelta
    let finalRouteNodes: RouteNode[] | null = null
    let routeChanged = false
    if (ins?.routeRef === undefined) {
      routeDelta = {
        action: 'unchanged',
        fromRouteId: cover.routeId,
        to: cover.routeId !== null ? { kind: 'existing', id: cover.routeId } : undefined
      }
      finalRouteNodes = cover.routeId !== null ? routeMap.get(cover.routeId)?.nodes ?? null : null
    } else if (ins.routeRef === null) {
      routeChanged = cover.routeId !== null
      routeDelta = { action: 'detach', fromRouteId: cover.routeId }
      finalRouteId = null
    } else if (isFactRef(ins.routeRef)) {
      const draft = routeDraftMap.get(ins.routeRef.newKey)
      if (!draft) {
        conflicts.push({
          coverId,
          code: 'draft-not-found',
          message: `${cover.coverNo} 引用了本批不存在的新邮路草稿（${ins.routeRef.newKey}）。`
        })
        routeDelta = {
          action: 'replace',
          fromRouteId: cover.routeId,
          to: { kind: 'created', key: ins.routeRef.newKey, routeNo: '', cloneFromId: null }
        }
      } else {
        finalRouteId = -1
        finalRouteNodes = draft.nodes
        routeChanged = true
        routeDelta = {
          action: 'replace',
          fromRouteId: cover.routeId,
          to: {
            kind: 'created',
            key: draft.key,
            routeNo: routeNoAssign.get(draft.key) ?? draft.routeNo,
            cloneFromId: draft.cloneFromId
          }
        }
      }
    } else {
      const targetId = ins.routeRef
      if (!routeMap.has(targetId)) {
        conflicts.push({
          coverId,
          code: 'missing-route-ref',
          message: `${cover.coverNo} 改挂的邮路 #${targetId} 未登记，请先在邮路编辑器建档。`
        })
      }
      finalRouteId = targetId
      finalRouteNodes = routeMap.get(targetId)?.nodes ?? null
      routeChanged = cover.routeId !== targetId
      routeDelta = {
        action: routeChanged ? 'replace' : 'keep',
        fromRouteId: cover.routeId,
        to: { kind: 'existing', id: targetId }
      }
    }

    /* 封日期 vs 邮路节点顺序 */
    if (finalRouteNodes) {
      const dated = finalRouteNodes.filter((n) => isValidDate(n.arriveDate))
      if (isValidDate(postDateTo) && dated.length) {
        const first = dated[0].arriveDate
        if (first < postDateTo) {
          conflicts.push({
            coverId,
            code: 'route-vs-cover-dates',
            message: `${cover.coverNo} 邮路首节点 ${dated[0].office}（${first}）早于本封寄出日期 ${postDateTo}。`
          })
        }
      }
      if (isValidDate(arriveDateTo) && dated.length) {
        const last = dated[dated.length - 1].arriveDate
        if (last > arriveDateTo) {
          conflicts.push({
            coverId,
            code: 'route-vs-cover-dates',
            message: `${cover.coverNo} 邮路末节点 ${dated[dated.length - 1].office}（${last}）晚于本封到达日期 ${arriveDateTo}。`
          })
        }
      }
    }

    const datesChanged =
      postDateTo !== cover.postDate || arriveDateTo !== cover.arriveDate
    if (!refsChanged && !routeChanged && !datesChanged) {
      coverWarnings.push({
        coverId,
        code: 'unchanged',
        message: `${cover.coverNo} 没有任何变更，将原样保留。`
      })
    }
    warnings.push(...coverWarnings)

    views.push({
      coverId,
      cover,
      postDateFrom: cover.postDate,
      postDateTo,
      arriveDateFrom: cover.arriveDate,
      arriveDateTo,
      postmarkDeltas,
      routeDelta,
      warnings: coverWarnings,
      finalPmIds,
      finalRouteId
    })
  }

  /* 解析后将新建的行（id 落库时分配） */
  const ts = nowIso()
  const resolvedPostmarks: Postmark[] = req.newPostmarks.map((d) => ({
    pmNo: pmNoAssign.get(d.key) ?? d.pmNo,
    type: d.type,
    office: d.office,
    province: d.province,
    yearFrom: d.yearFrom,
    yearTo: d.yearTo,
    dateOnStamp: d.dateOnStamp,
    inkColor: d.inkColor,
    diameter: d.diameter,
    lettering: { ...d.lettering },
    bilingual: d.bilingual,
    scarceLevel: d.scarceLevel,
    imageDataUrl: '',
    note: d.note,
    supersedesId: d.cloneFromId,
    createdAt: ts,
    updatedAt: ts
  }))

  const resolvedRoutes: PostalRoute[] = req.newRoutes.map((d) => ({
    routeNo: routeNoAssign.get(d.key) ?? d.routeNo,
    name: d.name,
    era: d.era,
    transport: d.transport,
    nodes: d.nodes.map((n) => ({ ...n, key: n.key || uid('node') })),
    totalDays: localComputeTotalDays(d.nodes),
    frequency: d.frequency,
    remark: d.remark,
    supersedesId: d.cloneFromId,
    createdAt: ts,
    updatedAt: ts
  }))

  const createdPostmarks: CreatedPostmarkView[] = req.newPostmarks.map((d) => ({
    key: d.key,
    pmNo: pmNoAssign.get(d.key) ?? d.pmNo,
    cloneFromId: d.cloneFromId,
    office: d.office
  }))
  const createdRoutes: CreatedRouteView[] = req.newRoutes.map((d) => ({
    key: d.key,
    routeNo: routeNoAssign.get(d.key) ?? d.routeNo,
    cloneFromId: d.cloneFromId,
    name: d.name
  }))

  return {
    ok: conflicts.length === 0,
    selectedIds,
    views,
    createdPostmarks,
    createdRoutes,
    conflicts,
    warnings,
    resolvedPostmarks,
    resolvedRoutes,
    coversBefore,
    reason
  }
}

/* ------------------------------ 撤销快照 ------------------------------ */

/** 最近一次成功批次的撤销快照；batchMeta 表只保留 id=1 一行。 */
export interface BatchUndoSnapshot {
  id?: number
  savedAt: string
  reason: string
  coverIds: number[]
  /** 整批开始前所选封的完整行（含旧 needRepair / updatedAt） */
  coversBefore: Cover[]
  createdPostmarkIds: number[]
  createdRouteIds: number[]
}

export const UNDO_SNAPSHOT_ID = 1

export async function loadUndoSnapshot(): Promise<BatchUndoSnapshot | null> {
  return (await db.batchMeta.get(UNDO_SNAPSHOT_ID)) ?? null
}

/* ------------------------------ 提交 ------------------------------ */

export interface CommitResult {
  snapshot: BatchUndoSnapshot
  updatedCoverIds: number[]
  createdPostmarkIds: number[]
  createdRouteIds: number[]
}

/**
 * 事务内提交整批：新建替代戳 / 路 → 改写所选封 → 写撤销快照。
 * 失败时 IndexedDB 自动回滚全部写入，等于恢复整批开始前的数据。
 */
export async function commitBatchRebuild(
  plan: BatchPlan,
  drafts: { newPostmarks: PostmarkFactDraft[]; newRoutes: RouteFactDraft[] }
): Promise<CommitResult> {
  if (!plan.ok) {
    throw new Error('计划中仍有冲突，整批未写入。')
  }

  const snapshot: BatchUndoSnapshot = {
    savedAt: nowIso(),
    reason: plan.reason,
    coverIds: plan.selectedIds,
    coversBefore: clone(plan.coversBefore),
    createdPostmarkIds: [],
    createdRouteIds: []
  }

  // 提交前的实寄封总数：本批只改所选封、不增删封，提交后必须相等。
  const coverCountBefore = await db.covers.count()

  await db.transaction(
    'rw',
    db.covers,
    db.postmarks,
    db.routes,
    db.batchMeta,
    async () => {
      // 快照先落同一事务：事务一旦中止，快照与改动一起回滚。
      await db.batchMeta.put({ ...snapshot, id: UNDO_SNAPSHOT_ID })

      const createdPostmarkIds = (await db.postmarks.bulkAdd(clone(plan.resolvedPostmarks), {
        allKeys: true
      })) as unknown as number[]
      const createdRouteIds = (await db.routes.bulkAdd(clone(plan.resolvedRoutes), {
        allKeys: true
      })) as unknown as number[]

      const pmKeyToId = new Map<string, number>()
      drafts.newPostmarks.forEach((d, i) => pmKeyToId.set(d.key, createdPostmarkIds[i]))
      const routeKeyToId = new Map<string, number>()
      drafts.newRoutes.forEach((d, i) => routeKeyToId.set(d.key, createdRouteIds[i]))

      const beforeMap = new Map(plan.coversBefore.map((c) => [c.id as number, c]))
      const ts = nowIso()
      const nextCovers: Cover[] = []
      for (const view of plan.views) {
        const before = beforeMap.get(view.coverId)
        if (!before) throw new Error(`实寄封 ${view.coverId} 快照缺失，已中止整批。`)

        // view.finalPmIds 中 -1 占位按 deltas 里的 created key 依次还原为新 id
        const createdKeys = view.postmarkDeltas
          .filter((d) => d.action === 'replace' && d.to?.kind === 'created')
          .map((d) => (d.to?.kind === 'created' ? d.to.key : ''))
        let createdCursor = 0
        const cancelPmIds: number[] = []
        for (const v of view.finalPmIds) {
          if (v === -1) {
            const key = createdKeys[createdCursor]
            createdCursor += 1
            const id = pmKeyToId.get(key)
            if (id === undefined) throw new Error(`新邮戳 ${key} 未能落库，已中止整批。`)
            cancelPmIds.push(id)
          } else {
            cancelPmIds.push(v)
          }
        }

        let routeId: number | null
        if (view.finalRouteId === -1) {
          const created = view.routeDelta.to
          if (!created || created.kind !== 'created') {
            throw new Error('新邮路映射缺失，已中止整批。')
          }
          const id = routeKeyToId.get(created.key)
          if (id === undefined) throw new Error(`新邮路 ${created.key} 未能落库，已中止整批。`)
          routeId = id
        } else {
          routeId = view.finalRouteId
        }

        nextCovers.push({
          ...clone(before),
          postDate: view.postDateTo,
          arriveDate: view.arriveDateTo,
          cancelPmIds,
          routeId,
          // 计划已拦截所有悬空引用，提交后所选封不再待修
          needRepair: false,
          updatedAt: ts
        })
      }

      await db.covers.bulkPut(nextCovers)

      // 提交后校验：非所选封数量不变，所选封引用全部落到现存对象。
      const totalCovers = await db.covers.count()
      if (totalCovers !== coverCountBefore) {
        throw new Error('提交后实寄封总数校验失败，已回滚整批。')
      }
      for (const cover of nextCovers) {
        const saved = await db.covers.get(cover.id as number)
        if (!saved || saved.updatedAt !== ts) {
          throw new Error(`实寄封 ${cover.coverNo} 提交校验失败，已回滚整批。`)
        }
        for (const pmId of saved.cancelPmIds) {
          if ((await db.postmarks.get(pmId)) === undefined) {
            throw new Error(`实寄封 ${cover.coverNo} 的邮戳引用 #${pmId} 校验失败，已回滚。`)
          }
        }
        if (saved.routeId !== null && (await db.routes.get(saved.routeId)) === undefined) {
          throw new Error(`实寄封 ${cover.coverNo} 的邮路引用 #${saved.routeId} 校验失败，已回滚。`)
        }
      }

      // 回写完整快照中的新建 id，供撤销使用（同一行再 put 一次）。
      await db.batchMeta.put({
        id: UNDO_SNAPSHOT_ID,
        savedAt: snapshot.savedAt,
        reason: snapshot.reason,
        coverIds: snapshot.coverIds,
        coversBefore: snapshot.coversBefore,
        createdPostmarkIds,
        createdRouteIds
      })

      snapshot.createdPostmarkIds = createdPostmarkIds
      snapshot.createdRouteIds = createdRouteIds
    }
  )

  // 事务外统一校准全部封的待修标记（新增 / 删除对象不影响非所选封，校准为幂等操作）。
  await recomputeRepairFlags()

  return {
    snapshot,
    updatedCoverIds: plan.selectedIds,
    createdPostmarkIds: snapshot.createdPostmarkIds,
    createdRouteIds: snapshot.createdRouteIds
  }
}

/* ------------------------------ 撤销 ------------------------------ */

/**
 * 按快照恢复整批开始前的数据：整行还回旧实寄封、删去本批新建的戳 / 路。
 * 任一步失败事务回滚；恢复后再逐行校验，校验不过同样不写入。
 */
export async function undoBatchRebuild(): Promise<BatchUndoSnapshot> {
  let applied: BatchUndoSnapshot | null = null
  await db.transaction(
    'rw',
    db.covers,
    db.postmarks,
    db.routes,
    db.batchMeta,
    async () => {
      const snapshot = await db.batchMeta.get(UNDO_SNAPSHOT_ID)
      if (!snapshot) throw new Error('没有可撤销的批量重编记录。')
      applied = snapshot

      await db.covers.bulkPut(clone(snapshot.coversBefore))
      if (snapshot.createdPostmarkIds.length) {
        await db.postmarks.bulkDelete(snapshot.createdPostmarkIds)
      }
      if (snapshot.createdRouteIds.length) {
        await db.routes.bulkDelete(snapshot.createdRouteIds)
      }
      await db.batchMeta.delete(UNDO_SNAPSHOT_ID)

      for (const before of snapshot.coversBefore) {
        const restored = await db.covers.get(before.id as number)
        if (!restored || restored.updatedAt !== before.updatedAt) {
          throw new Error(`实寄封 ${before.coverNo} 恢复校验失败，已中止撤销。`)
        }
      }
      for (const id of snapshot.createdPostmarkIds) {
        if ((await db.postmarks.get(id)) !== undefined) {
          throw new Error(`替代邮戳 #${id} 删除校验失败，已中止撤销。`)
        }
      }
      for (const id of snapshot.createdRouteIds) {
        if ((await db.routes.get(id)) !== undefined) {
          throw new Error(`替代邮路 #${id} 删除校验失败，已中止撤销。`)
        }
      }
    }
  )
  await recomputeRepairFlags()
  if (!applied) throw new Error('撤销未执行。')
  return applied
}
