/**
 * 关联完整性的组合式封装：监听三个 store 的当前数据，
 * 为每封实寄封计算统一的待修状态。CoverCard、详情页、目录表格、检索页
 * 都只消费这里的结果，避免各处各算一套导致详情与检索不一致。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { useCoverStore } from '@/stores/coverStore'
import { usePostmarkStore } from '@/stores/postmarkStore'
import { useRouteStore } from '@/stores/routeStore'
import type { Cover } from '@/types/cover'
import {
  evaluateCoverLinks,
  idSet,
  missingLinksOf,
  type CoverLinkState
} from '@/utils/linkIntegrity'

export function useLinkIntegrity() {
  const coverStore = useCoverStore()
  const postmarkStore = usePostmarkStore()
  const routeStore = useRouteStore()

  const postmarkIds = computed(() => idSet(postmarkStore.list))
  const routeIds = computed(() => idSet(routeStore.list))

  /** coverId → 完整性状态。 */
  const stateMap = computed<Map<number, CoverLinkState>>(() => {
    const map = new Map<number, CoverLinkState>()
    for (const cover of coverStore.list) {
      if (typeof cover.id !== 'number') continue
      map.set(cover.id, evaluateCoverLinks(cover, postmarkIds.value, routeIds.value))
    }
    return map
  })

  function stateOf(cover: Cover | null | undefined): CoverLinkState | null {
    if (!cover || typeof cover.id !== 'number') return null
    return stateMap.value.get(cover.id) ?? null
  }

  /** 待修判定的统一入口：优先用实时核算，回落到持久化标记。 */
  function isBroken(cover: Cover | null | undefined): boolean {
    return stateOf(cover)?.needRepair ?? cover?.needRepair ?? false
  }

  function missingCount(cover: Cover | null | undefined): number {
    const state = stateOf(cover)
    if (state) {
      return state.missingPostmarkIds.length + (state.missingRouteId !== null ? 1 : 0)
    }
    return cover?.needRepair ? 1 : 0
  }

  function linksOf(cover: Cover | null | undefined) {
    const state = stateOf(cover)
    return state ? missingLinksOf(state) : []
  }

  const repairCoverIds = computed<Set<number>>(
    () => new Set([...stateMap.value.entries()].filter(([, s]) => s.needRepair).map(([id]) => id))
  )

  const repairCount = computed(() => repairCoverIds.value.size)

  return { stateMap, stateOf, isBroken, missingCount, linksOf, repairCoverIds, repairCount }
}

export type UseLinkIntegrityReturn = ReturnType<typeof useLinkIntegrity>
