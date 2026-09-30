/**
 * 批量重编：从实寄封目录选多封，统一预览 / 应用邮戳、邮路、票戳组合的替换与移除。
 * 改动只落在所选封上；被其他封引用的邮戳 / 邮路保留原对象，另建「替代关系」留痕。
 */

/** 操作对象：邮戳 / 邮路 / 票戳组合 */
export type BatchOpKind = 'postmark' | 'route' | 'stamp'

/** 操作方式：替换为新对象 / 移除关联 */
export type BatchOpMode = 'replace' | 'remove'

/** 一条批量重编操作 */
export interface BatchOp {
  id: string
  kind: BatchOpKind
  mode: BatchOpMode
  /** 邮戳 / 邮路：被替换（或移除）的对象 id */
  fromId?: number
  /** 邮戳 / 邮路：替换为的对象 id（mode === 'replace' 时必填） */
  toId?: number
  /** 票戳组合：被替换（或移除）的邮票名 */
  fromName?: string
  /** 票戳组合：替换为的邮票名（mode === 'replace' 时必填） */
  toName?: string
}

/** 邮戳替换：from → to */
export interface PmChange {
  from: number
  to: number
}

/** 邮路替换：from → to */
export interface RouteChange {
  from: number
  to: number
}

/** 票戳组合改名：from → to */
export interface StampNameChange {
  from: string
  to: string
}

/** 单封预览：应用操作前后的关联变化与冲突 */
export interface CoverOpPreview {
  coverId: number
  coverNo: string
  sentFrom: string
  sentTo: string
  /** 将移除的邮戳 id */
  pmRemoved: number[]
  /** 将发生的邮戳替换 */
  pmReplaced: PmChange[]
  /** 应用后的关联邮戳 id 列表 */
  pmAfter: number[]
  /** 是否摘除邮路 */
  routeRemoved: boolean
  /** 将发生的邮路替换 */
  routeReplaced: RouteChange | null
  /** 应用后的邮路 id */
  routeAfter: number | null
  /** 将移除的票戳组合邮票名 */
  stampRemoved: string[]
  /** 将改名的票戳组合 */
  stampReplaced: StampNameChange[]
  /** 受影响的票戳组合条数 */
  stampAffectedCount: number
  /** 该封的冲突（日期 / 路线顺序对不上） */
  conflicts: string[]
  /** 是否有任何变化 */
  changed: boolean
}

/** 整批冲突汇总（按封） */
export interface BatchConflict {
  coverId: number
  coverNo: string
  messages: string[]
}

/**
 * 替代关系：被引用的邮戳 / 邮路保留原对象，按新事实记录「由 from 替代为 to」。
 * 同一 (kind, fromId, toId) 只留一条。
 */
export interface AssociationReplacement {
  id?: number
  kind: 'postmark' | 'route'
  fromId: number
  toId: number
  note: string
  createdAt: string
}

/** 撤销载荷：整批开始前的快照，用于「撤销一次」 */
export interface BatchUndoPayload {
  id: string
  at: string
  /** 受影响封的整封快照（应用前） */
  coverSnapshots: import('@/types/cover').Cover[]
  /** 受影响票戳组合的快照（应用前） */
  entrySnapshots: import('@/types/stampentry').StamplessEntry[]
  /** 本批新建的替代关系 id（撤销时删除） */
  createdReplacementIds: number[]
  /** 本批新建的票戳组合 id（撤销时删除，当前操作不会新建） */
  createdEntryIds: number[]
}

/** 批量重编结果 */
export interface ApplyResult {
  ok: boolean
  /** 整批冲突（非空时不写入） */
  conflicts: BatchConflict[]
  previews: CoverOpPreview[]
  /** 实际变化的封数 */
  changedCount: number
  /** 新建的替代关系条数 */
  replacementCount: number
  /** 失败原因（ok=false 且非冲突时） */
  error?: string
}
