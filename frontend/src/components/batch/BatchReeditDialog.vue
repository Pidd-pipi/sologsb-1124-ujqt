<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { db } from '@/utils/db'
import { useBatchStore } from '@/stores/batchStore'
import { useCoverStore } from '@/stores/coverStore'
import { usePostmarkStore } from '@/stores/postmarkStore'
import { useRouteStore } from '@/stores/routeStore'
import type { Cover } from '@/types/cover'
import type { AssociationReplacement, BatchOp, CoverOpPreview } from '@/types/batch'
import { collectConflicts, createBatchOp, describeOp } from '@/utils/batchReedit'

const props = defineProps<{ modelValue: boolean; candidates: Cover[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const batchStore = useBatchStore()
const coverStore = useCoverStore()
const postmarkStore = usePostmarkStore()
const routeStore = useRouteStore()

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const selectedIds = ref<number[]>([])
const ops = ref<BatchOp[]>([])
const replacements = ref<AssociationReplacement[]>([])
const applying = computed(() => batchStore.applying)

/* ------------------------------ 选择 ------------------------------ */

const selectedCovers = computed<Cover[]>(() =>
  props.candidates.filter((c) => c.id != null && selectedIds.value.includes(c.id))
)

function isSelected(cover: Cover): boolean {
  return cover.id != null && selectedIds.value.includes(cover.id)
}

function toggleOne(cover: Cover, checked: boolean): void {
  if (cover.id == null) return
  if (checked) {
    if (!selectedIds.value.includes(cover.id)) selectedIds.value.push(cover.id)
  } else {
    selectedIds.value = selectedIds.value.filter((id) => id !== cover.id)
  }
}

function onToggleRow(cover: Cover, value: boolean | string | number): void {
  toggleOne(cover, !!value)
}

const allChecked = computed({
  get: () => props.candidates.length > 0 && selectedIds.value.length === props.candidates.length,
  set: (v) => {
    selectedIds.value = v
      ? props.candidates.map((c) => c.id).filter((id): id is number => typeof id === 'number')
      : []
  }
})

/* ------------------------------ 操作行 ------------------------------ */

function addOp(): void {
  ops.value.push(createBatchOp('postmark'))
}

function removeOp(id: string): void {
  ops.value = ops.value.filter((o) => o.id !== id)
}

function isValidOp(op: BatchOp): boolean {
  if (op.kind === 'stamp') {
    if (op.mode === 'remove') return !!op.fromName?.trim()
    const from = op.fromName?.trim()
    const to = op.toName?.trim()
    return !!from && !!to && from !== to
  }
  if (op.mode === 'remove') return op.fromId != null
  return op.fromId != null && op.toId != null && op.fromId !== op.toId
}

const validOps = computed<BatchOp[]>(() => ops.value.filter(isValidOp))

/* ------------------------------ 候选项 ------------------------------ */

const pmFromOptions = computed(() => {
  const ids = new Set<number>()
  for (const c of selectedCovers.value) for (const id of c.cancelPmIds) ids.add(id)
  return [...ids].map((id) => ({ value: id, label: postmarkStore.labelOf(id) }))
})

const pmToOptions = computed(() =>
  postmarkStore.list.flatMap((pm) =>
    typeof pm.id === 'number' ? [{ value: pm.id, label: `${pm.pmNo} ${pm.office}` }] : []
  )
)

const routeFromOptions = computed(() => {
  const ids = new Set<number>()
  for (const c of selectedCovers.value) if (c.routeId != null) ids.add(c.routeId)
  return [...ids].map((id) => ({ value: id, label: routeLabel(id) }))
})

const routeToOptions = computed(() =>
  routeStore.list.flatMap((rt) =>
    typeof rt.id === 'number' ? [{ value: rt.id, label: `${rt.routeNo} ${rt.name}` }] : []
  )
)

const stampFromOptions = computed(() => {
  const names = new Set<string>()
  for (const c of selectedCovers.value) {
    for (const e of coverStore.entriesOf(c.id)) if (e.stampName) names.add(e.stampName)
  }
  return [...names].map((name) => ({ value: name, label: name }))
})

function pmLabel(id: number): string {
  return postmarkStore.labelOf(id)
}

function routeLabel(id: number | null): string {
  if (id == null) return '未挂邮路'
  const rt = routeStore.byId(id)
  return rt ? `${rt.routeNo} ${rt.name}` : `未登记邮路 #${id}`
}

/* ------------------------------ 预览与冲突 ------------------------------ */

const previews = computed<CoverOpPreview[]>(() => batchStore.preview(selectedCovers.value, validOps.value))

const changedPreviews = computed<CoverOpPreview[]>(() => previews.value.filter((p) => p.changed))

const conflicts = computed(() => collectConflicts(previews.value))

const canApply = computed(
  () =>
    !applying.value &&
    selectedCovers.value.length > 0 &&
    validOps.value.length > 0 &&
    conflicts.value.length === 0
)

/* ------------------------------ 替代关系 ------------------------------ */

async function loadReplacements(): Promise<void> {
  replacements.value = await db.replacements.orderBy('createdAt').toArray()
}

function replacementLabel(r: AssociationReplacement): string {
  const from = r.kind === 'postmark' ? pmLabel(r.fromId) : routeLabel(r.fromId)
  const to = r.kind === 'postmark' ? pmLabel(r.toId) : routeLabel(r.toId)
  return `${from} → ${to}`
}

/* ------------------------------ 应用 / 撤销 ------------------------------ */

async function apply(): Promise<void> {
  if (!canApply.value) return
  const result = await batchStore.applyBatch(selectedCovers.value, validOps.value)
  if (result.ok) {
    if (result.changedCount === 0) {
      ElMessage.info('所选封没有需要应用的变更')
    } else {
      ElMessage.success(
        `已重编 ${result.changedCount} 封，新建替代关系 ${result.replacementCount} 条`
      )
    }
    await loadReplacements()
  } else if (result.conflicts.length) {
    ElMessage.warning('存在日期 / 路线顺序冲突，整批未写入')
  } else {
    ElMessage.error(`提交失败，已恢复整批开始前的数据：${result.error ?? '未知错误'}`)
  }
}

async function undo(): Promise<void> {
  const ok = await batchStore.undoLast()
  if (ok) {
    ElMessage.success('已撤销本次批量重编')
    await loadReplacements()
  } else {
    ElMessage.error('撤销失败')
  }
}

/* ------------------------------ 生命周期 ------------------------------ */

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      selectedIds.value = props.candidates
        .map((c) => c.id)
        .filter((id): id is number => typeof id === 'number')
      ops.value = [createBatchOp('postmark')]
      await loadReplacements()
    }
  }
)

function opDescription(op: BatchOp): string {
  return describeOp(op, {
    postmarkById: new Map(postmarkStore.list.filter((p) => p.id != null).map((p) => [p.id as number, p])),
    routeById: new Map(routeStore.list.filter((r) => r.id != null).map((r) => [r.id as number, r]))
  })
}

function formatTime(iso: string): string {
  if (!iso) return ''
  return iso.replace('T', ' ').slice(0, 16)
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    title="批量重编：邮戳 · 邮路 · 票戳组合"
    width="92%"
    style="max-width: 1180px"
    top="5vh"
  >
    <div class="batch">
      <p class="batch__tip">
        勾选要重编的实寄封，添加替换 / 移除操作后可逐封预览关联变化。改动只落在所选封上；
        被其他封引用的邮戳 / 邮路保留原对象，仅补记「替代关系」。日期或路线顺序对不上时整批不写入。
      </p>

      <!-- 第一步：选封 -->
      <section class="batch__section">
        <div class="batch__section-head">
          <h3>① 选择实寄封（已选 {{ selectedCovers.length }} / {{ candidates.length }}）</h3>
          <el-checkbox v-model="allChecked">全选当前筛选结果</el-checkbox>
        </div>
        <el-table :data="candidates" border size="small" max-height="260" class="batch__covers">
          <el-table-column width="46" align="center">
            <template #default="{ row }">
              <el-checkbox
                :model-value="isSelected(row)"
                @change="(v: boolean | string | number) => onToggleRow(row, v)"
              />
            </template>
          </el-table-column>
          <el-table-column prop="coverNo" label="封号" width="110" />
          <el-table-column label="收寄地" min-width="160">
            <template #default="{ row }">{{ row.sentFrom }} → {{ row.sentTo }}</template>
          </el-table-column>
          <el-table-column prop="postDate" label="寄出" width="112" />
          <el-table-column prop="arriveDate" label="到达" width="112" />
          <el-table-column label="关联邮戳" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" type="warning" effect="plain">{{ row.cancelPmIds.length }} 枚</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="邮路" min-width="140">
            <template #default="{ row }">{{ routeLabel(row.routeId) }}</template>
          </el-table-column>
        </el-table>
      </section>

      <!-- 第二步：操作 -->
      <section class="batch__section">
        <div class="batch__section-head">
          <h3>② 添加替换 / 移除操作</h3>
          <el-button size="small" @click="addOp">添加操作</el-button>
        </div>
        <div v-for="op in ops" :key="op.id" class="batch__op-row">
          <el-select v-model="op.kind" style="width: 120px">
            <el-option label="邮戳" value="postmark" />
            <el-option label="邮路" value="route" />
            <el-option label="票戳组合" value="stamp" />
          </el-select>
          <el-select v-model="op.mode" style="width: 110px">
            <el-option label="替换为" value="replace" />
            <el-option label="移除" value="remove" />
          </el-select>

          <template v-if="op.kind === 'stamp'">
            <el-select
              v-model="op.fromName"
              placeholder="选择邮票"
              filterable
              style="width: 180px"
            >
              <el-option v-for="opt in stampFromOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
            <template v-if="op.mode === 'replace'">
              <span class="batch__op-arrow">→</span>
              <el-input v-model="op.toName" placeholder="新邮票名" style="width: 180px" />
            </template>
          </template>

          <template v-else>
            <el-select
              v-model="op.fromId"
              :placeholder="op.kind === 'postmark' ? '被替换的邮戳' : '被替换的邮路'"
              filterable
              style="width: 220px"
            >
              <el-option
                v-for="opt in op.kind === 'postmark' ? pmFromOptions : routeFromOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
            <template v-if="op.mode === 'replace'">
              <span class="batch__op-arrow">→</span>
              <el-select
                v-model="op.toId"
                :placeholder="op.kind === 'postmark' ? '新邮戳' : '新邮路'"
                filterable
                style="width: 220px"
              >
                <el-option
                  v-for="opt in op.kind === 'postmark' ? pmToOptions : routeToOptions"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </template>
          </template>

          <el-button size="small" link type="danger" @click="removeOp(op.id)">删除</el-button>
          <span v-if="isValidOp(op)" class="batch__op-desc">{{ opDescription(op) }}</span>
        </div>
        <p v-if="!ops.length" class="batch__empty">暂无操作，点击「添加操作」开始。</p>
      </section>

      <!-- 冲突汇总 -->
      <el-alert
        v-if="conflicts.length"
        type="error"
        :closable="false"
        class="batch__conflicts"
        title="存在日期 / 路线顺序冲突，整批不写入"
      >
        <ul class="batch__conflict-list">
          <li v-for="c in conflicts" :key="c.coverId">
            <strong>{{ c.coverNo }}</strong>
            <span v-for="(m, i) in c.messages" :key="i" class="batch__conflict-msg">{{ m }}</span>
          </li>
        </ul>
      </el-alert>

      <!-- 第三步：预览 -->
      <section class="batch__section">
        <div class="batch__section-head">
          <h3>
            ③ 逐封预览（{{ changedPreviews.length }} 封将变化 / 共 {{ selectedCovers.length }} 封）
          </h3>
        </div>
        <p v-if="!changedPreviews.length" class="batch__empty">
          所选封没有可应用的变更，请确认操作对象是否出现在所选封上。
        </p>
        <div v-else class="batch__previews">
          <div v-for="p in changedPreviews" :key="p.coverId" class="batch__preview">
            <header class="batch__preview-head">
              <strong>{{ p.coverNo }}</strong>
              <span class="batch__preview-route">{{ p.sentFrom }} → {{ p.sentTo }}</span>
            </header>
            <ul class="batch__preview-changes">
              <li v-for="(c, i) in p.pmReplaced" :key="'pmr' + i">
                <el-tag size="small" type="warning" effect="plain">邮戳替换</el-tag>
                {{ pmLabel(c.from) }} → <strong>{{ pmLabel(c.to) }}</strong>
              </li>
              <li v-for="(id, i) in p.pmRemoved" :key="'pmx' + i">
                <el-tag size="small" type="danger" effect="plain">邮戳移除</el-tag>
                {{ pmLabel(id) }}
              </li>
              <li v-if="p.routeReplaced">
                <el-tag size="small" type="warning" effect="plain">邮路替换</el-tag>
                {{ routeLabel(p.routeReplaced.from) }} →
                <strong>{{ routeLabel(p.routeReplaced.to) }}</strong>
              </li>
              <li v-if="p.routeRemoved">
                <el-tag size="small" type="danger" effect="plain">邮路摘除</el-tag>
                {{ routeLabel(p.routeAfter === null ? null : p.routeAfter) }}
              </li>
              <li v-for="(c, i) in p.stampReplaced" :key="'str' + i">
                <el-tag size="small" type="success" effect="plain">票戳改名</el-tag>
                「{{ c.from }}」→「{{ c.to }}」
              </li>
              <li v-for="(name, i) in p.stampRemoved" :key="'stx' + i">
                <el-tag size="small" type="info" effect="plain">票戳移除</el-tag>
                「{{ name }}」
              </li>
            </ul>
            <p v-if="p.conflicts.length" class="batch__preview-conflict">
              <span v-for="(m, i) in p.conflicts" :key="i">{{ m }}</span>
            </p>
          </div>
        </div>
      </section>

      <!-- 替代关系留痕 -->
      <section class="batch__section">
        <div class="batch__section-head">
          <h3>替代关系留痕（{{ replacements.length }} 条）</h3>
        </div>
        <p v-if="!replacements.length" class="batch__empty">暂无替代关系。</p>
        <ul v-else class="batch__replacements">
          <li v-for="r in replacements" :key="r.id">
            <el-tag size="small" effect="plain">{{ r.kind === 'postmark' ? '邮戳' : '邮路' }}</el-tag>
            <span>{{ replacementLabel(r) }}</span>
            <em>{{ formatTime(r.createdAt) }}</em>
          </li>
        </ul>
      </section>
    </div>

    <template #footer>
      <div class="batch__footer">
        <span class="batch__footer-hint">
          {{ canApply ? '预览无误后即可写入；失败将自动回滚。' : '请先选封并添加有效的替换 / 移除操作。' }}
        </span>
        <span>
          <el-button @click="dialogVisible = false">关闭</el-button>
          <el-button
            v-if="batchStore.canUndo"
            type="warning"
            plain
            @click="undo"
          >
            撤销本次批量重编
          </el-button>
          <el-button type="primary" :loading="applying" :disabled="!canApply" @click="apply">
            应用批量重编
          </el-button>
        </span>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.batch {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.batch__tip {
  margin: 0;
  font-size: 13px;
  color: var(--gb-muted);
  background: #f7f1e6;
  border: 1px solid #e6d9c2;
  border-radius: 8px;
  padding: 8px 12px;
  line-height: 1.6;
}
.batch__section {
  border: 1px solid var(--gb-line, #e4d9c8);
  border-radius: 10px;
  padding: 12px 14px;
  background: #fffdf8;
}
.batch__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.batch__section-head h3 {
  margin: 0;
  font-size: 15px;
  color: #5d3325;
}
.batch__covers {
  width: 100%;
}
.batch__op-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 0;
  border-bottom: 1px dashed var(--gb-line, #e4d9c8);
}
.batch__op-arrow {
  color: #8c3b2e;
  font-weight: 700;
}
.batch__op-desc {
  font-size: 12px;
  color: var(--gb-muted);
}
.batch__empty {
  margin: 6px 0 0;
  font-size: 13px;
  color: #a89578;
}
.batch__conflicts {
  margin: 0;
}
.batch__conflict-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 13px;
}
.batch__conflict-list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 4px;
}
.batch__conflict-msg {
  color: #8a5a1a;
}
.batch__previews {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 10px;
}
.batch__preview {
  border: 1px solid var(--gb-line, #e4d9c8);
  border-radius: 8px;
  padding: 8px 10px;
  background: #faf6ee;
}
.batch__preview-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.batch__preview-route {
  font-size: 12px;
  color: var(--gb-muted);
}
.batch__preview-changes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.batch__preview-changes li {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.batch__preview-conflict {
  margin: 6px 0 0;
  font-size: 12px;
  color: #b02a1e;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.batch__replacements {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.batch__replacements li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.batch__replacements em {
  margin-left: auto;
  font-style: normal;
  font-size: 12px;
  color: var(--gb-muted);
}
.batch__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.batch__footer-hint {
  font-size: 12px;
  color: var(--gb-muted);
}
</style>
