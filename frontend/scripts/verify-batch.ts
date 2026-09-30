/**
 * 批量重编引擎的可核对验证脚本（node 直接运行，不依赖浏览器）。
 * 运行：npx esbuild scripts/verify-batch.ts | node
 * 覆盖：预览、共用不改、替代关系、整批隔离、各类冲突、撤销数据构造。
 */
import { planBatchRebuild } from '../src/utils/batchRebuild'
import type { BatchRebuildRequest } from '../src/utils/batchRebuild'
import type { Postmark } from '../src/types/postmark'
import type { Cover } from '../src/types/cover'
import type { PostalRoute } from '../src/types/route'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures += 1
    console.error(`  ✗ ${msg}`)
  }
}

const TS = '2024-01-01T00:00:00.000Z'
const pm = (id: number, office: string): Postmark => ({
  id,
  pmNo: `PM-${id}`,
  type: '圆形日戳',
  office,
  province: '上海',
  yearFrom: 1910,
  yearTo: 1920,
  dateOnStamp: '',
  inkColor: '黑',
  diameter: 26,
  lettering: { top: office, middle: '', bottom: '' },
  bilingual: false,
  scarceLevel: '常见',
  imageDataUrl: '',
  note: '',
  supersedesId: null,
  createdAt: TS,
  updatedAt: TS
})
const rt = (id: number, nodes: Array<[string, string]>): PostalRoute => ({
  id,
  routeNo: `RT-${id}`,
  name: `邮路${id}`,
  era: '1910-1919',
  transport: '铁路',
  nodes: nodes.map(([office, d], i) => ({ key: `n${id}-${i}`, office, arriveDate: d, transitMark: '' })),
  totalDays: 3,
  frequency: '逐日班',
  remark: '',
  supersedesId: null,
  createdAt: TS,
  updatedAt: TS
})
const cover = (id: number, cancelPmIds: number[], routeId: number | null): Cover => ({
  id,
  coverNo: `CV-${id}`,
  sentFrom: '上海',
  sentTo: '南京',
  postDate: '1910-06-18',
  arriveDate: '1910-06-21',
  franking: [],
  cancelPmIds,
  routeId,
  viaPoints: [],
  registered: false,
  conditionGrade: '中品',
  acquireFrom: '',
  price: 0,
  storageAlbum: '',
  frontImage: '',
  backImage: '',
  note: '',
  needRepair: false,
  createdAt: TS,
  updatedAt: TS
})

const postmarks = [pm(1, '上海邮政总局'), pm(2, '天津邮局'), pm(3, '广州邮局')]
// 让现有编号出现明显的流水号间隔，验证 nextSerialNo 取「最大流水号 + 1」
postmarks[2].pmNo = 'PM-0009'
const routes = [
  rt(1, [
    ['上海', '1910-06-18'],
    ['苏州', '1910-06-19'],
    ['南京', '1910-06-21']
  ]),
  rt(2, [
    ['天津', '1921-03-05'],
    ['济南', '1921-03-06'],
    ['上海', '1921-03-10']
  ])
]
routes[1].routeNo = 'RT-0007'
const covers = [cover(10, [1, 2], 1), cover(11, [1], 1), cover(12, [2], 2)]
covers[2].postDate = '1921-03-05'
covers[2].arriveDate = '1921-03-10'

const ctx = { covers, postmarks, routes }

console.log('场景一：共用戳 #1 被选封 10 另立替代；非选封 11 不受影响')
{
  const req: BatchRebuildRequest = {
    coverIds: [10],
    instructions: [
      {
        coverId: 10,
        cancelPmRefs: [{ newKey: 'd1' }, 2],
        routeRef: 1
      }
    ],
    newPostmarks: [
      {
        key: 'd1',
        pmNo: '',
        type: '圆形日戳',
        office: '上海邮政总局（改）',
        province: '上海',
        yearFrom: 1910,
        yearTo: 1920,
        dateOnStamp: '',
        inkColor: '黑',
        diameter: 26,
        lettering: { top: '上海', middle: '', bottom: '' },
        bilingual: false,
        scarceLevel: '常见',
        note: '据封背复核',
        cloneFromId: 1
      }
    ],
    newRoutes: []
  }
  const plan = planBatchRebuild(req, ctx)
  assert(plan.ok, '无冲突，可提交')
  assert(plan.createdPostmarks.length === 1, '计划新建 1 枚替代戳')
  assert(plan.createdPostmarks[0].cloneFromId === 1, '替代戳记录 supersedesId=1')
  assert(plan.createdPostmarks[0].pmNo === 'PM-0010', '空编号取现有最大流水号续号为 PM-0010')
  assert(plan.resolvedPostmarks[0].supersedesId === 1, '落库行带 supersedesId=1，原戳对象保留')
  const view = plan.views[0]
  const created = view.postmarkDeltas.find((d) => d.action === 'replace' && d.to?.kind === 'created')
  assert(Boolean(created), '逐封预览包含一条「替换为新建替代戳」')
  const kept = view.postmarkDeltas.find((d) => d.action === 'keep' && d.fromId === 2)
  assert(Boolean(kept), '共用戳 #2 标记为保留')
  assert(plan.coversBefore.length === 1 && plan.coversBefore[0].id === 10, '快照只含所选封 10，11/12 不写入')
}

console.log('场景二：日期顺序对不上 → 阻塞冲突，整批不写入')
{
  const req: BatchRebuildRequest = {
    coverIds: [10],
    instructions: [{ coverId: 10, postDate: '1910-06-22', arriveDate: '1910-06-21' }],
    newPostmarks: [],
    newRoutes: []
  }
  const plan = planBatchRebuild(req, ctx)
  assert(!plan.ok, '到达早于寄出：plan.ok=false')
  assert(plan.conflicts.some((c) => c.code === 'arrive-before-post' && c.coverId === 10), '列出到达早于寄出冲突')
}

console.log('场景三：改挂的已登记邮路节点晚于封到达日 → 冲突')
{
  const req: BatchRebuildRequest = {
    coverIds: [10],
    instructions: [{ coverId: 10, routeRef: 2, postDate: '1910-06-18', arriveDate: '1910-06-21' }],
    newPostmarks: [],
    newRoutes: []
  }
  const plan = planBatchRebuild(req, ctx)
  assert(!plan.ok, '邮路 2 节点为 1921 年，晚于封日期：阻塞')
  assert(plan.conflicts.some((c) => c.code === 'route-vs-cover-dates'), '列出邮路与封日期冲突')
}

console.log('场景四：摘除共用邮路 + 移除邮戳，仅所选封变化')
{
  const req: BatchRebuildRequest = {
    coverIds: [10],
    instructions: [{ coverId: 10, cancelPmRefs: [2], routeRef: null }],
    newPostmarks: [],
    newRoutes: []
  }
  const plan = planBatchRebuild(req, ctx)
  assert(plan.ok, '摘除邮路 / 移除戳无冲突')
  const view = plan.views[0]
  assert(view.finalRouteId === null, '最终邮路为 null（摘除）')
  assert(
    view.postmarkDeltas.some((d) => d.action === 'remove' && d.fromId === 1) &&
      view.postmarkDeltas.some((d) => d.action === 'keep' && d.fromId === 2),
    '#1 移除、#2 保留；共用戳 #1 不删除'
  )
  assert(view.routeDelta.action === 'detach' && view.routeDelta.fromRouteId === 1, '邮路变更为摘除，原邮路保留给封 11')
}

console.log('场景五：悬空引用（旧数据升级后的待修封）必须先处理')
{
  const broken = cover(13, [1, 99], null)
  broken.needRepair = true
  const req: BatchRebuildRequest = {
    coverIds: [13],
    instructions: [{ coverId: 13, cancelPmRefs: [1, 99] }],
    newPostmarks: [],
    newRoutes: []
  }
  const plan = planBatchRebuild(req, { covers: [broken], postmarks, routes })
  assert(!plan.ok, '仍挂着未登记戳 #99：阻塞')
  assert(plan.conflicts.some((c) => c.code === 'missing-postmark-ref'), '列出未登记邮戳引用冲突')

  const reqFixed: BatchRebuildRequest = {
    coverIds: [13],
    instructions: [{ coverId: 13, cancelPmRefs: [1] }],
    newPostmarks: [],
    newRoutes: []
  }
  const fixed = planBatchRebuild(reqFixed, { covers: [broken], postmarks, routes })
  assert(fixed.ok, '移除悬空 #99 后无冲突，提交后 needRepair 复位')
}

console.log('场景六：替代邮路（同封改路线，原邮路与封 11 共用）')
{
  const req: BatchRebuildRequest = {
    coverIds: [10],
    instructions: [{ coverId: 10, routeRef: { newKey: 'r1' } }],
    newPostmarks: [],
    newRoutes: [
      {
        key: 'r1',
        routeNo: '',
        name: '沪宁铁路邮路（改）',
        era: '1910-1919',
        transport: '铁路',
        nodes: [
          { key: 'a', office: '上海', arriveDate: '1910-06-18', transitMark: '' },
          { key: 'b', office: '镇江', arriveDate: '1910-06-20', transitMark: '' },
          { key: 'c', office: '南京', arriveDate: '1910-06-21', transitMark: '' }
        ],
        frequency: '逐日班',
        remark: '',
        cloneFromId: 1
      }
    ]
  }
  const plan = planBatchRebuild(req, ctx)
  assert(plan.ok, '替代邮路节点与封日期吻合，可提交')
  assert(plan.createdRoutes[0].cloneFromId === 1, '新邮路 supersedesId=1，原 RT-1 保留')
  assert(plan.createdRoutes[0].routeNo === 'RT-0008', '新邮路续号 RT-0008')
  assert(plan.views[0].finalRouteId === -1, '最终路由占位 -1，提交时映射为新 id')
}

console.log('场景七：新邮路自身节点倒置 → 草稿级冲突')
{
  const req: BatchRebuildRequest = {
    coverIds: [10],
    instructions: [{ coverId: 10, routeRef: { newKey: 'r2' } }],
    newPostmarks: [],
    newRoutes: [
      {
        key: 'r2',
        routeNo: '',
        name: '倒置邮路',
        era: '',
        transport: '铁路',
        nodes: [
          { key: 'a', office: '南京', arriveDate: '1910-06-21', transitMark: '' },
          { key: 'b', office: '上海', arriveDate: '1910-06-18', transitMark: '' }
        ],
        frequency: '',
        remark: '',
        cloneFromId: null
      }
    ]
  }
  const plan = planBatchRebuild(req, ctx)
  assert(!plan.ok, '节点日期倒置：阻塞')
  assert(plan.conflicts.some((c) => c.code === 'route-node-order'), '列出节点顺序冲突')
}

console.log('场景八：重复选封 / 目标邮路不存在 / 未改动提示')
{
  const req: BatchRebuildRequest = {
    coverIds: [10, 10, 11],
    instructions: [
      { coverId: 10, routeRef: 77 },
      { coverId: 11 }
    ],
    newPostmarks: [],
    newRoutes: []
  }
  const plan = planBatchRebuild(req, ctx)
  assert(!plan.ok, '存在冲突')
  assert(plan.conflicts.some((c) => c.code === 'duplicate-cover'), '列出重复选封')
  assert(plan.conflicts.some((c) => c.code === 'missing-route-ref'), '列出不存在的目标邮路')
  assert(plan.warnings.some((w) => w.code === 'unchanged'), '封 11 未改动给出提示但不阻塞')
}

console.log('场景九：多个不同封另立替代戳时各建新对象，且编号顺序确定')
{
  const req: BatchRebuildRequest = {
    coverIds: [10, 12],
    instructions: [
      { coverId: 10, cancelPmRefs: [{ newKey: 'a' }, 2] },
      { coverId: 12, cancelPmRefs: [{ newKey: 'b' }] }
    ],
    newPostmarks: [
      {
        key: 'a',
        pmNo: '',
        type: '圆形日戳',
        office: '上海（新）',
        province: '上海',
        yearFrom: 1910,
        yearTo: 1920,
        dateOnStamp: '',
        inkColor: '黑',
        diameter: 26,
        lettering: { top: '', middle: '', bottom: '' },
        bilingual: false,
        scarceLevel: '常见',
        note: '',
        cloneFromId: 1
      },
      {
        key: 'b',
        pmNo: '',
        type: '滚筒戳',
        office: '天津（新）',
        province: '天津',
        yearFrom: 1912,
        yearTo: 1928,
        dateOnStamp: '',
        inkColor: '黑',
        diameter: 30,
        lettering: { top: '', middle: '', bottom: '' },
        bilingual: false,
        scarceLevel: '常见',
        note: '',
        cloneFromId: 2
      }
    ],
    newRoutes: []
  }
  const plan = planBatchRebuild(req, ctx)
  assert(plan.ok, '两封各自另立无冲突')
  assert(plan.createdPostmarks.map((p) => p.pmNo).join(',') === 'PM-0010,PM-0011', '自动编号 PM-0010、PM-0011')
}

console.log('')
if (failures) {
  console.error(`${failures} 项断言失败`)
  process.exit(1)
}
console.log('全部断言通过')
