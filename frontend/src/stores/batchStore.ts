/**
 * 批量重编 store：
 * - 预览 / 冲突在写入前完成，整批有冲突则不写入；
 * - 全部写操作在一个 Dexie 事务内，失败自动回滚，恢复整批开始前的数据；
 * - 成功后保留一份撤销快照，允许撤销一次（快照持久化到 localStorage，刷新后仍可撤销）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { Table } from 'dexie'
import { useCoverStore } from './coverStore'
import { usePostmarkStore } from './postmarkStore'
import { useRouteStore } from './routeStore'
import type { Cover } from '@/types/cover'
import type { Postmark } from '@/types/postmark'
import type { PostalRoute } from '@/types/route'
import type { AssociationReplacement, BatchOp, BatchUndoPayload, ApplyResult } from '@/types/batch'
import {
  applyOpsToCover,
  collectConflicts,
  previewCover,
  stampEntryMutations,
  type BatchContext
} from '@/utils/batchReedit'
import { nowIso, uid } from '@/utils/id'

const UNDO_STORAGE_KEY = 'gbpostmark:lastBatchUndo'

function loadUndo(): BatchUndoPayload | null {
  try {
    const raw = window.localStorage.getItem(UNDO_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as BatchUndoPayload
    return parsed && Array.isArray(parsed.coverSnapshots) ? parsed : null
  } catch {
    return null
  }
}

function persistUndo(payload: BatchUndoPayload | null): void {
  try {
    if (payload) window.localStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify(payload))
    else window.localStorage.removeItem(UNDO_STORAGE_KEY)
  } catch {
    /* localStorage 不可用时仅保存在内存 */
  }
}

export const useBatchStore = defineStore('batch', () => {
  const applying = ref(false)
  const lastUndo = ref<BatchUndoPayload | null>(loadUndo())

  const canUndo = computed(() => lastUndo.value != null)

  function buildContext(): BatchContext {
    const postmarkStore = usePostmarkStore()
    const routeStore = useRouteStore()
    const postmarkById = new Map<number, Postmark>()
    for (const pm of postmarkStore.list) {
      if (typeof pm.id === 'number') postmarkById.set(pm.id, pm)
    }
    const routeById = new Map<number, PostalRoute>()
    for (const rt of routeStore.list) {
      if (typeof rt.id === 'number') routeById.set(rt.id, rt)
    }
    return { postmarkById, routeById }
  }

  /** 预览所选封的应用结果（纯计算，不写库）。 */
  function preview(selected: Cover[], ops: BatchOp[]) {
    const coverStore = useCoverStore()
    const ctx = buildContext()
    return selected.map((cover) => {
      const entries = cover.id == null ? [] : coverStore.entriesOf(cover.id)
      return previewCover(cover, ops, ctx, entries)
    })
  }

  /**
   * 应用批量重编。
   * 有冲突时返回 ok=false 且不写入；写入失败由 Dexie 事务回滚。
   */
  async function applyBatch(selected: Cover[], ops: BatchOp[]): Promise<ApplyResult> {
    applying.value = true
    try {
      const coverStore = useCoverStore()
      const ctx = buildContext()
      const previews = preview(selected, ops)
      const conflicts = collectConflicts(previews)
      if (conflicts.length > 0) {
        return { ok: false, conflicts, previews, changedCount: 0, replacementCount: 0 }
      }

      const changedPreviews = previews.filter((p) => p.changed)
      if (changedPreviews.length === 0) {
        return { ok: true, conflicts: [], previews, changedCount: 0, replacementCount: 0 }
      }

      const coverSnapshots: Cover[] = []
      const entrySnapshots: BatchUndoPayload['entrySnapshots'] = []
      const createdReplacementIds: number[] = []
      const createdEntryIds: number[] = []
      const now = nowIso()

      await db.transaction(
        'rw',
        [db.covers, db.stampEntries, db.replacements],
        async (tx) => {
          // 1) 封：快照后应用关联变更
          for (const prev of changedPreviews) {
            const cover = await tx.covers.get(prev.coverId)
            if (!cover) continue
            coverSnapshots.push({ ...cover })
            const updated = applyOpsToCover(cover, ops)
            updated.updatedAt = now
            await tx.covers.put(updated)
          }

          // 2) 票戳组合：快照后改名 / 删除（组合归属封，直接改不影响其他封）
          for (const prev of changedPreviews) {
            const rows = await tx.stampEntries.where('coverId').equals(prev.coverId).toArray()
            for (const row of rows) {
              const mutations = stampEntryMutations([row], ops)
              const mut = mutations[0]
              if (!mut || typeof row.id !== 'number') continue
              entrySnapshots.push({ ...row })
              if (mut.action === 'remove') {
                await tx.stampEntries.delete(row.id)
              } else if (mut.toName) {
                await tx.stampEntries.update(row.id, { stampName: mut.toName })
              }
            }
          }

          // 3) 替代关系：被其他封引用的邮戳 / 邮路保留原对象，仅补记替代事实
          for (const prev of changedPreviews) {
            for (const change of prev.pmReplaced) {
              const id = await upsertReplacement(tx.replacements, 'postmark', change.from, change.to, now)
              if (id != null) createdReplacementIds.push(id)
            }
            if (prev.routeReplaced) {
              const id = await upsertReplacement(
                tx.replacements,
                'route',
                prev.routeReplaced.from,
                prev.routeReplaced.to,
                now
              )
              if (id != null) createdReplacementIds.push(id)
            }
          }
        }
      )

      const undoPayload: BatchUndoPayload = {
        id: uid('batch'),
        at: now,
        coverSnapshots,
        entrySnapshots,
        createdReplacementIds,
        createdEntryIds
      }
      lastUndo.value = undoPayload
      persistUndo(undoPayload)

      await coverStore.load()
      return {
        ok: true,
        conflicts: [],
        previews,
        changedCount: changedPreviews.length,
        replacementCount: createdReplacementIds.length
      }
    } catch (err) {
      // 事务内任一写操作抛错，Dexie 已回滚全部变更；此处仅兜底返回
      return {
        ok: false,
        conflicts: [],
        previews: [],
        changedCount: 0,
        replacementCount: 0,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      applying.value = false
    }
  }

  /** 撤销上一次成功的批量重编（仅允许一次）。 */
  async function undoLast(): Promise<boolean> {
    const payload = lastUndo.value
    if (!payload) return false
    const coverStore = useCoverStore()
    try {
      await db.transaction(
        'rw',
        [db.covers, db.stampEntries, db.replacements],
        async (tx) => {
          if (payload.coverSnapshots.length) await tx.covers.bulkPut(payload.coverSnapshots)
          if (payload.entrySnapshots.length) await tx.stampEntries.bulkPut(payload.entrySnapshots)
          if (payload.createdEntryIds.length) await tx.stampEntries.bulkDelete(payload.createdEntryIds)
          if (payload.createdReplacementIds.length) {
            await tx.replacements.bulkDelete(payload.createdReplacementIds)
          }
        }
      )
      lastUndo.value = null
      persistUndo(null)
      await coverStore.load()
      return true
    } catch {
      return false
    }
  }

  function dismissUndo(): void {
    lastUndo.value = null
    persistUndo(null)
  }

  return { applying, lastUndo, canUndo, preview, applyBatch, undoLast, dismissUndo }
})

/** 写入替代关系；同一 (kind, fromId, toId) 已存在则复用，返回 null 表示非本批新建。 */
async function upsertReplacement(
  replacements: Table<AssociationReplacement, number>,
  kind: AssociationReplacement['kind'],
  fromId: number,
  toId: number,
  now: string
): Promise<number | null> {
  const existing = await replacements.where('[kind+fromId]').equals([kind, fromId]).toArray()
  const found = existing.find((r) => r.toId === toId)
  if (found) return null
  return replacements.add({
    kind,
    fromId,
    toId,
    note: '',
    createdAt: now
  })
}
