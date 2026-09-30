# 邮戳与实寄封编目台（gbpostmark）

面向邮品收藏者与邮政史研究者：为邮戳、邮路和实寄封建编目，记录戳型、使用年代、邮路节点与封上票戳组合，并以时间轴还原一封邮件的实际寄递过程。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21824>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21824 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`postmarkStore` / `coverStore` / `routeStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地数据 | IndexedDB（Dexie，含版本号与升级迁移）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Postmark 邮戳 | `frontend/src/types/postmark.ts` | 编目号、戳型、局所、省份、使用年代、戳面日期、墨色、戳径、戳面文字、中英双文字、稀见度、戳样图、备注 |
| Cover 实寄封 | `frontend/src/types/cover.ts` | 封号、寄出/收件地、寄出/到达日期、贴票构成、关联邮戳、邮路、中转地、给据、品相、来源、购入价、藏册页位 |
| PostalRoute 邮路 | `frontend/src/types/route.ts` | 邮路号、名称、时期、运输方式、节点数组（局所/到达日期/中转戳）、全程天数、班期、备注 |
| StamplessEntry 票戳组合 | `frontend/src/types/stampentry.ts` | 所属封、邮票名称、面值、发行年份、齿度、变体、封上位置 |

另有 `frontend/src/types/asset.ts`：戳样与封的正反面原图在 IndexedDB 中**单独建表**（`assets`）。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 重定向到 `/postmarks` | — |
| `/postmarks` | 邮戳目录（按戳型、局所、年代区间筛选，图片墙 ↔ 列表切换） | Postmark |
| `/covers` | 实寄封目录（按收寄地、年代、品相、是否给据、关联是否待修筛选，行内显示贴票枚数与关联邮戳数） | Cover |
| `/covers/:id` | 实寄封详情（正反面图、票戳组合表、寄递事实时间轴、断链待修警示） | Cover、StamplessEntry、PostalRoute |
| `/covers-batch-rebuild` | 批量重编向导（多封选区 → 逐封设定邮戳/邮路/日期 → 冲突预览 → 事务提交/单次撤销） | Cover、Postmark、PostalRoute |
| `/routes/:id` | 邮路编辑器（节点拖拽排序、增删中转地、按节点日期自动算全程天数） | PostalRoute |
| `/search` | 综合检索（跨三类按关键词与年代分组检索，实寄封可按待修筛选） | Postmark、Cover、PostalRoute |

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `StampCard.vue`、`CoverCard.vue`、`RouteTimeline.vue`、`ScarceTag.vue`
- hooks：`frontend/src/hooks/useCatalogFilter.ts`（统一过滤与排序）、`frontend/src/hooks/useCoverRoute.ts`（寄递时间轴与在途天数）、`frontend/src/hooks/useLinkIntegrity.ts`（邮戳/邮路断链的统一待修判定，目录、详情、检索共用）、`frontend/src/hooks/useBatchRebuild.ts`（批量重编向导状态机）
- 批量重编引擎：`frontend/src/utils/batchRebuild.ts`（纯函数预览计划 + 单事务提交 + 快照撤销），规则见下节
- utils：`frontend/src/utils/db.ts`（Dexie 封装/版本迁移/样例数据）、`frontend/src/utils/linkIntegrity.ts`（关联完整性纯函数）、`frontend/src/utils/dateRange.ts`（年代区间、干支互转、日期先后校验）、`frontend/src/utils/id.ts`（编目号与唯一键）、`frontend/src/utils/draft.ts`（localStorage 草稿）

## 六、本地开发（可选，需要本机 Node 20+）

```bash
cd frontend
npm install
npm run dev          # http://localhost:21824
npm run build        # vue-tsc 类型检查 + vite 构建
```

## 七、目录结构

```
sologsb-1124/
├── docker-compose.yml
├── .env.example / .env
├── README.md
└── frontend/
    ├── Dockerfile          # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf          # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/          # postmark / cover / route / stampentry / asset
        ├── stores/         # postmarkStore / coverStore / routeStore
        ├── components/common/
        ├── hooks/
        ├── pages/
        ├── router/
        ├── utils/
        ├── styles/
        ├── App.vue
        └── main.ts
```

## 八、数据存储说明

- **编目数据**：IndexedDB（Dexie，库名 `gbpostmark`）。表结构含版本号：`version(2)` 把戳样与封图迁移到独立 `assets` 表并补齐历史记录缺省字段；`version(3)` 增加邮戳/邮路的替代关系字段 `supersedesId`、实寄封待修标记 `needRepair`，并新增 `batchMeta` 表存最近一次批量重编的撤销快照。升级时把指向不存在邮戳或邮路的实寄封按实际引用归入待修；首次运行写入样例数据。

### 批量重编规则（可核对、可回滚）

1. **只动所选封**：从实寄封目录选多封进入向导，未选实寄封整行不写入；向导先对每封算出将「保留 / 替换 / 移除」的邮戳与「不动 / 改挂 / 摘除 / 另立替代」的邮路，预览确认后才提交。
2. **共用对象不原地改删**：需要新事实时新建带 `supersedesId` 的替代邮戳 / 邮路，原对象留给其他实寄封继续引用；原位补登（无旧对象）时 `supersedesId` 为 null。
3. **冲突整批不写入**：日期非法、到达早于寄出、邮路节点倒置、节点日期落在封寄出/到达区间之外、目标邮戳/邮路不存在、草稿缺字段、编号重复等任一命中即列出冲突（含所属封），整批不落库。
4. **失败恢复**：提交在单个 Dexie 事务内完成（新对象、封改写、快照同事务），任一步失败自动回滚到整批开始前，提交后还有一次引用与计数校验。
5. **撤销一次**：成功后 `batchMeta` 保留整批前的所选封整行快照与本批新建 id；允许撤销一次（恢复旧封、删除本批新建对象、清快照），撤销后不可再次撤销。
6. **待修同源判定**：断链待修的明细统一由 `useLinkIntegrity` 实时核算，目录卡片/表格、详情页警示、检索页筛选三处结果一致；删除邮戳/邮路或批量提交/撤销后会重算持久化的 `needRepair` 标记。
- **表单草稿**：localStorage，键名前缀 `gbpostmark:draft:`（邮戳、实寄封、邮路各一份），刷新或误关页面后可恢复，可一键清除。
- **无后端**：不请求任何外部接口，容器无状态，不使用数据库服务与命名卷；清除浏览器站点数据即等于清空数据。
