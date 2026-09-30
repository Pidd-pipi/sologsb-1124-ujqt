/**
 * 批量重编向导的状态机：选区 → 逐封设定 → 冲突预览 → 提交 / 撤销。
 * 纯状态与构造请求的逻辑都放这里，页面组件只负责渲染与表单。
 */
import { computed, reactive, ref } from 'vue'
import { useCoverStore } from '@/stores/coverStore'
import { usePostmarkStore } from '@/stores/postmarkStore'
import { useRouteStore } from '@/stores/routeStore'
import type { Cover } from '@/types/cover'
import type { Postmark } from '@/types/postmark'
import type { PostalRoute } from '@/types/route'
import { uid } from '@/utils/id'
import {
  commitBatchRebuild,
  loadUndoSnapshot,
  planBatchRebuild,
  undoBatchRebuild,
  type BatchPlan,
  type BatchRebuildRequest,
  type FactRef,
  type PmRef,
  type PostmarkFactDraft,
  type RouteFactDraft,
  type RouteRef
} from '@/utils/batchRebuild'

export type Step = 'select' | 'edit' | 'preview' | 'done'

/** 单行邮戳关联的编辑动作：保留 / 移除 / 替换为已登记戳 */
export interface PmRowEdit {
  /** 关联来源：旧关联 id，或新增（add=true 时忽略 fromId） */
  fromId: number
  add: boolean
  action: 'keep' | 'remove' | 'replace'
  /** 替换或新增的目标：已登记戳 id；为 null 表示「按新事实另立」 */
  targetPmId: number | null
  /** 另立新戳时的草稿键 */
  draftKey: string
}

/** 邮路编辑动作 */
export interface RouteEdit {
  mode: 'unchanged' | 'detach' | 'existing' | 'clone'
  targetRouteId: number | null
  draftKey: string
}

export interface CoverEditState {
  postDate: string
  arriveDate: string
  /** 是否修改寄出 / 到达日期 */
  datesTouched: boolean
  pmRows: PmRowEdit[]
  route: RouteEdit
  /** 另立的新戳草稿键集合（本封内） */
  pmDraftKeys: string[]
  expanded: boolean
}

function makePmDraftKey(coverId: number): string {
  return `pm-${coverId}-${uid('d')}`
}

function makeRouteDraftKey(coverId: number): string {
  return `rt-${coverId}-${uid('d')}`
}

export function useBatchRebuild() {
  const coverStore = useCoverStore()
  const postmarkStore = usePostmarkStore()
  const routeStore = useRouteStore()

  const step = ref<Step>('select')
  const selectedIds = ref<number[]>([])
  const edits = reactive(new Map<number, CoverEditState>())
  /** 草稿键 → 草稿实体，向导内统一存放 */
  const pmDrafts = reactive(new Map<string, PostmarkFactDraft>())
  const routeDrafts = reactive(new Map<string, RouteFactDraft>())
  const reason = ref('')

  const plan = ref<BatchPlan | null>(null)
  const submitting = ref(false)
  const commitError = ref('')
  const undoSnapshot = ref<Awaited<ReturnType<typeof loadUndoSnapshot>>>(null)
  const lastCommitted = ref<{
    coverCount: number
    postmarkCount: number
    routeCount: number
    savedAt: string
    reason: string
  } | null>(null)

  function ensureEdit(coverId: number): CoverEditState {
    let state = edits.get(coverId)
    if (state) return state
    const cover = coverStore.byId(coverId)
    state = {
      postDate: cover?.postDate ?? '',
      arriveDate: cover?.arriveDate ?? '',
      datesTouched: false,
      pmRows: (cover?.cancelPmIds ?? []).map((id) => ({
        fromId: id,
        add: false,
        action: 'keep' as const,
        targetPmId: id,
        draftKey: makePmDraftKey(coverId)
      })),
      route: {
        mode: 'unchanged',
        targetRouteId: cover?.routeId ?? null,
        draftKey: makeRouteDraftKey(coverId)
      },
      pmDraftKeys: [],
      expanded: false
    }
    edits.set(coverId, state)
    return state
  }

  const selectedCovers = computed<Cover[]>(() =>
    selectedIds.value
      .map((id) => coverStore.byId(id))
      .filter((c): c is Cover => c !== null)
  )

  function toggleSelect(coverId: number, checked: boolean): void {
    if (checked) {
      if (!selectedIds.value.includes(coverId)) selectedIds.value.push(coverId)
      ensureEdit(coverId)
    } else {
      selectedIds.value = selectedIds.value.filter((id) => id !== coverId)
    }
  }

  function selectAll(ids: number[], checked: boolean): void {
    if (checked) {
      selectedIds.value = [...new Set([...selectedIds.value, ...ids])]
      ids.forEach(ensureEdit)
    } else {
      const drop = new Set(ids)
      selectedIds.value = selectedIds.value.filter((id) => !drop.has(id))
    }
  }

  /* ------------------------ 逐封编辑操作 ------------------------ */

  function addPmRow(coverId: number): void {
    const state = ensureEdit(coverId)
    state.pmRows.push({
      fromId: -1,
      add: true,
      action: 'replace',
      targetPmId: null,
      draftKey: makePmDraftKey(coverId)
    })
  }

  function removePmRow(coverId: number, index: number): void {
    const state = ensureEdit(coverId)
    state.pmRows.splice(index, 1)
  }

  /** 由现存邮戳构造一份「另立新戳」草稿（预填旧戳事实）。 */
  function draftFromPostmark(pm: Postmark, cloneFromId: number | null): PostmarkFactDraft {
    return {
      key: '',
      pmNo: '',
      type: pm.type,
      office: pm.office,
      province: pm.province,
      yearFrom: pm.yearFrom,
      yearTo: pm.yearTo,
      dateOnStamp: pm.dateOnStamp,
      inkColor: pm.inkColor,
      diameter: pm.diameter,
      lettering: { ...pm.lettering },
      bilingual: pm.bilingual,
      scarceLevel: pm.scarceLevel,
      note: pm.note,
      cloneFromId
    }
  }

  function draftFromRoute(route: PostalRoute, cloneFromId: number | null): RouteFactDraft {
    return {
      key: '',
      routeNo: '',
      name: route.name,
      era: route.era,
      transport: route.transport,
      nodes: route.nodes.map((n) => ({ ...n, key: uid('node') })),
      frequency: route.frequency,
      remark: route.remark,
      cloneFromId
    }
  }

  /** 确保某行「另立新戳」草稿已就位并返回其键。 */
  function ensurePmDraft(coverId: number, row: PmRowEdit): string {
    const existing = pmDrafts.get(row.draftKey)
    if (existing) return existing.key
    const source = row.add ? null : postmarkStore.byId(row.fromId)
    const draft = draftFromPostmark(
      source ?? {
        pmNo: '',
        type: '圆形日戳',
        office: '',
        province: '',
        yearFrom: 1900,
        yearTo: 1900,
        dateOnStamp: '',
        inkColor: '黑',
        diameter: 26,
        lettering: { top: '', middle: '', bottom: '' },
        bilingual: false,
        scarceLevel: '常见',
        imageDataUrl: '',
        note: '',
        supersedesId: null,
        createdAt: '',
        updatedAt: ''
      },
      row.add || !source ? null : row.fromId
    )
    draft.key = row.draftKey
    pmDrafts.set(row.draftKey, draft)
    const state = ensureEdit(coverId)
    if (!state.pmDraftKeys.includes(row.draftKey)) state.pmDraftKeys.push(row.draftKey)
    return row.draftKey
  }

  /** 确保本封邮路「另立替代邮路」草稿就位。 */
  function ensureRouteDraft(coverId: number): string {
    const state = ensureEdit(coverId)
    const key = state.route.draftKey
    if (!routeDrafts.has(key)) {
      const cover = coverStore.byId(coverId)
      const source = cover?.routeId != null ? routeStore.byId(cover.routeId) : null
      const draft = draftFromRoute(
        source ?? {
          routeNo: '',
          name: '',
          era: '',
          transport: '铁路',
          nodes: [],
          totalDays: 0,
          frequency: '',
          remark: '',
          supersedesId: null,
          createdAt: '',
          updatedAt: ''
        },
        source ? (source.id ?? null) : null
      )
      draft.key = key
      routeDrafts.set(key, draft)
    }
    return key
  }

  /* ------------------------ 构造请求与计划 ------------------------ */

  function buildRequest(): BatchRebuildRequest | null {
    const instructions = []
    const usedPmDrafts = new Set<string>()
    const usedRouteDrafts = new Set<string>()

    for (const coverId of selectedIds.value) {
      const state = edits.get(coverId)
      if (!state) continue
      const cover = coverStore.byId(coverId)
      if (!cover) continue

      const cancelPmRefs: PmRef[] = []
      for (const row of state.pmRows) {
        if (row.action === 'remove') continue
        // 「保留」即沿用原关联；新增行没有旧关联时必须指向某个目标
        if (row.action === 'keep' && !row.add) {
          cancelPmRefs.push(row.fromId)
          continue
        }
        if (row.targetPmId !== null) {
          cancelPmRefs.push(row.targetPmId)
        } else {
          usedPmDrafts.add(row.draftKey)
          const ref: FactRef = { newKey: row.draftKey }
          cancelPmRefs.push(ref)
        }
      }

      let routeRef: RouteRef | undefined
      if (state.route.mode === 'unchanged') {
        routeRef = undefined
      } else if (state.route.mode === 'detach') {
        routeRef = null
      } else if (state.route.mode === 'existing') {
        routeRef = state.route.targetRouteId
      } else {
        usedRouteDrafts.add(state.route.draftKey)
        routeRef = { newKey: state.route.draftKey }
      }

      instructions.push({
        coverId,
        ...(state.datesTouched
          ? { postDate: state.postDate, arriveDate: state.arriveDate }
          : {}),
        cancelPmRefs,
        routeRef
      })
    }

    const newPostmarks = [...usedPmDrafts]
      .map((key) => pmDrafts.get(key))
      .filter((d): d is PostmarkFactDraft => Boolean(d))
    const newRoutes = [...usedRouteDrafts]
      .map((key) => routeDrafts.get(key))
      .filter((d): d is RouteFactDraft => Boolean(d))

    return {
      coverIds: [...selectedIds.value],
      instructions,
      newPostmarks,
      newRoutes,
      reason: reason.value.trim()
    }
  }

  const requestDraftCount = computed(() => ({
    postmarks: pmDrafts.size,
    routes: routeDrafts.size
  }))

  function refreshPlan(): BatchPlan | null {
    const req = buildRequest()
    if (!req) {
      plan.value = null
      return null
    }
    plan.value = planBatchRebuild(req, {
      covers: coverStore.list,
      postmarks: postmarkStore.list,
      routes: routeStore.list
    })
    return plan.value
  }

  async function submit(): Promise<boolean> {
    const current = refreshPlan()
    if (!current || !current.ok) return false
    const req = buildRequest()
    if (!req) return false
    submitting.value = true
    commitError.value = ''
    try {
      const result = await commitBatchRebuild(current, {
        newPostmarks: req.newPostmarks,
        newRoutes: req.newRoutes
      })
      lastCommitted.value = {
        coverCount: result.updatedCoverIds.length,
        postmarkCount: result.createdPostmarkIds.length,
        routeCount: result.createdRouteIds.length,
        savedAt: result.snapshot.savedAt,
        reason: result.snapshot.reason
      }
      await Promise.all([coverStore.load(), postmarkStore.load(), routeStore.load()])
      await refreshUndoSnapshot()
      // 已提交批次所用草稿清空，选区保留到完成页供核对
      pmDrafts.clear()
      routeDrafts.clear()
      step.value = 'done'
      return true
    } catch (err) {
      // 事务已整体回滚：这里把失败原因回显，数据等于整批开始前。
      commitError.value = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      submitting.value = false
    }
  }

  async function refreshUndoSnapshot(): Promise<void> {
    undoSnapshot.value = await loadUndoSnapshot()
  }

  async function undo(): Promise<boolean> {
    try {
      const snapshot = await undoBatchRebuild()
      await Promise.all([coverStore.load(), postmarkStore.load(), routeStore.load()])
      await refreshUndoSnapshot()
      reset()
      lastCommitted.value = null
      return Boolean(snapshot)
    } catch (err) {
      commitError.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  function reset(): void {
    step.value = 'select'
    selectedIds.value = []
    edits.clear()
    pmDrafts.clear()
    routeDrafts.clear()
    reason.value = ''
    plan.value = null
    commitError.value = ''
    lastCommitted.value = null
  }

  return {
    // 状态
    step,
    selectedIds,
    selectedCovers,
    edits,
    pmDrafts,
    routeDrafts,
    reason,
    plan,
    submitting,
    commitError,
    undoSnapshot,
    lastCommitted,
    requestDraftCount,
    // 选区
    toggleSelect,
    selectAll,
    ensureEdit,
    // 逐封编辑
    addPmRow,
    removePmRow,
    ensurePmDraft,
    ensureRouteDraft,
    // 计划 / 提交 / 撤销
    refreshPlan,
    buildRequest,
    submit,
    undo,
    reset,
    refreshUndoSnapshot
  }
}

export type BatchRebuildWizard = ReturnType<typeof useBatchRebuild>
