<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useBatchRebuild } from '@/hooks/useBatchRebuild'
import { useLinkIntegrity } from '@/hooks/useLinkIntegrity'
import { useCoverStore } from '@/stores/coverStore'
import { usePostmarkStore } from '@/stores/postmarkStore'
import { useRouteStore } from '@/stores/routeStore'
import CoverEditBlock from '@/components/batch/CoverEditBlock.vue'
import PostmarkDraftDialog from '@/components/batch/PostmarkDraftDialog.vue'
import RouteDraftDialog from '@/components/batch/RouteDraftDialog.vue'
import type { PostmarkFactDraft, RouteFactDraft } from '@/utils/batchRebuild'

const router = useRouter()
const coverStore = useCoverStore()
const postmarkStore = usePostmarkStore()
const routeStore = useRouteStore()
const wizard = useBatchRebuild()
const integrity = useLinkIntegrity()

const repairOnly = ref(true)

onMounted(async () => {
  if (!coverStore.loaded) await coverStore.load()
  if (!postmarkStore.loaded) await postmarkStore.load()
  if (!routeStore.loaded) await routeStore.load()
  await wizard.refreshUndoSnapshot()
})

const selectableCovers = computed(() =>
  repairOnly.value ? coverStore.list.filter((c) => integrity.isBroken(c)) : coverStore.list
)

/* el-table 受控选择：选区以 wizard.selectedIds 为唯一事实来源 */
function onSelectionChange(rows: { id?: number }[]): void {
  wizard.selectAll(
    selectableCovers.value.map((c) => c.id).filter((id): id is number => typeof id === 'number'),
    false
  )
  wizard.selectAll(
    rows.map((r) => r.id).filter((id): id is number => typeof id === 'number'),
    true
  )
}

function startEdit(): void {
  if (!wizard.selectedIds.value.length) {
    ElMessage.warning('请先勾选至少一封实寄封')
    return
  }
  wizard.step.value = 'edit'
}

function goPreview(): void {
  const result = wizard.refreshPlan()
  if (!result) return
  wizard.step.value = 'preview'
  if (!result.ok) {
    ElMessage.warning(`发现 ${result.conflicts.length} 项冲突，整批不会写入，请先处理。`)
  }
}

async function commit(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将对 ${wizard.selectedIds.value.length} 封实寄封提交批量重编。共用的邮戳 / 邮路会保留原对象并建立替代关系，确认提交？`,
      '提交整批重编',
      { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const ok = await wizard.submit()
  if (ok) ElMessage.success('批量重编已提交，可在完成页核对或撤销一次。')
}

async function doUndo(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '撤销将恢复整批开始前的实寄封数据，并删去本批新建的替代邮戳 / 邮路。确认撤销？',
      '撤销本次批量重编',
      { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const ok = await wizard.undo()
  if (ok) ElMessage.success('已恢复整批开始前的数据')
}

const pmOptions = computed(() =>
  postmarkStore.list.flatMap((pm) =>
    typeof pm.id === 'number' ? [{ label: `${pm.pmNo} ${pm.office}`, value: pm.id }] : []
  )
)

const routeOptions = computed(() =>
  routeStore.list.flatMap((rt) =>
    typeof rt.id === 'number' ? [{ label: `${rt.routeNo} ${rt.name}`, value: rt.id }] : []
  )
)

function pmLabel(id: number): string {
  return postmarkStore.labelOf(id)
}

function routeLabel(id: number | null): string {
  if (id == null) return '未挂邮路'
  const route = routeStore.byId(id)
  return route ? `${route.routeNo} ${route.name}` : `未登记邮路 #${id}`
}

const pmDialogVisible = ref(false)
const routeDialogVisible = ref(false)
const activePmDraft = ref<PostmarkFactDraft | null>(null)
const activeRouteDraft = ref<RouteFactDraft | null>(null)

function openPmDraft(draftKey: string): void {
  activePmDraft.value = wizard.pmDrafts.get(draftKey) ?? null
  pmDialogVisible.value = true
}

function openRouteDraft(coverId: number): void {
  const key = wizard.ensureRouteDraft(coverId)
  activeRouteDraft.value = wizard.routeDrafts.get(key) ?? null
  routeDialogVisible.value = true
}

const stepItems = [{ title: '选择实寄封' }, { title: '设定新事实' }, { title: '预览与冲突' }, { title: '完成 / 撤销' }]
const stepIndex = computed(() => ['select', 'edit', 'preview', 'done'].indexOf(wizard.step.value))

function coverConflicts(coverId: number) {
  return wizard.plan.value?.conflicts.filter((c) => c.coverId === coverId) ?? []
}

function openCover(id: number): void {
  void router.push(`/covers/${id}`)
}

function tagType(action: string): 'info' | 'warning' | 'danger' | 'success' {
  if (action === 'remove') return 'danger'
  if (action === 'replace') return 'warning'
  if (action === 'keep') return 'success'
  return 'info'
}

function routeActionLabel(action: string): string {
  if (action === 'detach') return '摘除'
  if (action === 'replace') return '替换'
  if (action === 'keep') return '保留'
  return '不动'
}
</script>

<template>
  <div class="gb-page gb-batch">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">批量重编：邮戳 · 邮路 · 票戳组合</h1>
        <p class="gb-page__subtitle">
          从实寄封目录选多封同来源实寄封，先预览每封将替换 / 移除的关联再提交；共用的邮戳、邮路只另立替代对象，改动不波及未选封。
        </p>
      </div>
      <el-button @click="router.push('/covers')">返回实寄封目录</el-button>
    </header>

    <el-steps :active="stepIndex" align-center finish-status="success" class="gb-batch__steps">
      <el-step v-for="item in stepItems" :key="item.title" :title="item.title" />
    </el-steps>

    <el-alert
      v-if="wizard.commitError.value"
      :title="`提交失败，已整体回滚：${wizard.commitError.value}`"
      type="error"
      :closable="false"
      show-icon
      class="gb-batch__alert"
    />

    <!-- ① 选区 -->
    <section v-if="wizard.step.value === 'select'" class="gb-panel">
      <div class="gb-batch__head">
        <h2 class="gb-panel__title">① 选择要重编的实寄封（{{ wizard.selectedIds.value.length }} 封已选）</h2>
        <el-checkbox v-model="repairOnly">只列出待修（指向不存在的邮戳 / 邮路）</el-checkbox>
      </div>
      <el-table
        :data="selectableCovers"
        border
        stripe
        height="460"
        row-key="id"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="48" reserve-selection />
        <el-table-column prop="coverNo" label="封号" width="110" />
        <el-table-column label="收寄地" min-width="170">
          <template #default="{ row }">{{ row.sentFrom }} → {{ row.sentTo }}</template>
        </el-table-column>
        <el-table-column label="寄出 / 到达" width="200">
          <template #default="{ row }">{{ row.postDate || '待考' }} / {{ row.arriveDate || '待考' }}</template>
        </el-table-column>
        <el-table-column label="现关联邮戳" min-width="210">
          <template #default="{ row }">
            <span v-if="!row.cancelPmIds.length" class="gb-batch__muted">无</span>
            <el-tag
              v-for="id in row.cancelPmIds"
              :key="id"
              size="small"
              :type="postmarkStore.byId(id) ? 'info' : 'danger'"
              effect="plain"
              class="gb-batch__tag"
            >
              {{ pmLabel(id) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="现邮路" min-width="150">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.routeId == null || routeStore.byId(row.routeId) ? 'info' : 'danger'"
              effect="plain"
            >
              {{ routeLabel(row.routeId) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag v-if="integrity.isBroken(row)" type="danger" effect="dark" size="small">待修</el-tag>
            <el-tag v-else type="success" effect="plain" size="small">完整</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <div class="gb-batch__actions">
        <el-button @click="router.push('/covers')">取消</el-button>
        <el-button type="primary" @click="startEdit">下一步：设定新事实</el-button>
      </div>
    </section>

    <!-- ② 逐封设定 -->
    <section v-else-if="wizard.step.value === 'edit'" class="gb-batch__edit">
      <div class="gb-batch__head gb-panel">
        <h2 class="gb-panel__title">② 逐封设定新事实（{{ wizard.selectedIds.value.length }} 封）</h2>
        <el-input v-model="wizard.reason.value" placeholder="本批改编依据（可选），如 据封背到达戳复核" style="width: 320px" />
      </div>

      <CoverEditBlock
        v-for="coverId in wizard.selectedIds.value"
        :key="coverId"
        :cover="coverStore.byId(coverId) as NonNullable<ReturnType<typeof coverStore.byId>>"
        :wizard="wizard"
        :pm-options="pmOptions"
        :route-options="routeOptions"
        @open-pm-draft="openPmDraft"
        @open-route-draft="openRouteDraft"
      />

      <div class="gb-batch__actions">
        <el-button @click="wizard.step.value = 'select'">上一步</el-button>
        <el-button type="primary" @click="goPreview">下一步：预览与冲突核对</el-button>
      </div>
    </section>

    <!-- ③ 预览与冲突 -->
    <section v-else-if="wizard.step.value === 'preview'" class="gb-panel">
      <div class="gb-batch__head">
        <h2 class="gb-panel__title">
          ③ 预览每封将替换 / 移除的关联
          <el-tag
            :type="wizard.plan.value?.ok ? 'success' : 'danger'"
            effect="dark"
            size="small"
            class="gb-batch__tag"
          >
            {{ wizard.plan.value?.ok ? '无冲突，可提交' : `${wizard.plan.value?.conflicts.length ?? 0} 项冲突，整批不写入` }}
          </el-tag>
        </h2>
        <el-button @click="goPreview">重新核对</el-button>
      </div>

      <el-alert
        v-if="wizard.plan.value && !wizard.plan.value.ok"
        type="error"
        :closable="false"
        show-icon
        class="gb-batch__alert"
        title="存在阻塞冲突，整批不会写入任何数据；请返回上一步处理后再预览。"
      >
        <ul class="gb-batch__conflicts">
          <li v-for="(c, i) in wizard.plan.value.conflicts" :key="i">{{ c.message }}</li>
        </ul>
      </el-alert>

      <el-alert
        v-if="wizard.plan.value?.warnings.length"
        type="warning"
        :closable="false"
        show-icon
        class="gb-batch__alert"
        title="不阻塞的提示（重复项自动去重、未改封原样保留）："
      >
        <ul class="gb-batch__conflicts">
          <li v-for="(w, i) in wizard.plan.value.warnings" :key="i">{{ w.message }}</li>
        </ul>
      </el-alert>

      <el-table :data="wizard.plan.value?.views ?? []" border stripe class="gb-batch__preview-table">
        <el-table-column label="封号" width="110">
          <template #default="{ row }">
            <el-button link type="primary" @click="openCover(row.coverId)">{{ row.cover.coverNo }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="日期（前 → 后）" width="230">
          <template #default="{ row }">
            <div :class="{ 'gb-batch__changed': row.postDateFrom !== row.postDateTo }">
              寄 {{ row.postDateFrom || '待考' }} → {{ row.postDateTo || '待考' }}
            </div>
            <div :class="{ 'gb-batch__changed': row.arriveDateFrom !== row.arriveDateTo }">
              达 {{ row.arriveDateFrom || '待考' }} → {{ row.arriveDateTo || '待考' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="邮戳关联变更" min-width="320">
          <template #default="{ row }">
            <div v-for="(d, i) in row.postmarkDeltas" :key="i" class="gb-batch__delta">
              <el-tag size="small" :type="tagType(d.action)" effect="plain" class="gb-batch__tag">
                {{ d.action === 'keep' ? '保留' : d.action === 'remove' ? '移除' : '替换' }}
              </el-tag>
              <template v-if="d.action === 'remove'">原 {{ pmLabel(d.fromId ?? -1) }}</template>
              <template v-else-if="d.to?.kind === 'existing'">{{ pmLabel(d.to.id) }}</template>
              <el-button v-else-if="d.to?.kind === 'created'" link type="primary" size="small" @click="openPmDraft(d.to.key)">
                新建替代戳 {{ d.to.pmNo }}{{ d.to.cloneFromId !== null ? `（代 #${d.to.cloneFromId}）` : '（原位补登）' }}
              </el-button>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="邮路变更" min-width="230">
          <template #default="{ row }">
            <div class="gb-batch__delta">
              <el-tag size="small" :type="tagType(row.routeDelta.action)" effect="plain" class="gb-batch__tag">
                {{ routeActionLabel(row.routeDelta.action) }}
              </el-tag>
              <span class="gb-batch__muted">原：{{ routeLabel(row.routeDelta.fromRouteId) }}</span>
            </div>
            <div v-if="row.routeDelta.to" class="gb-batch__delta">
              <template v-if="row.routeDelta.to.kind === 'existing'">新：{{ routeLabel(row.routeDelta.to.id) }}</template>
              <el-button v-else link type="primary" size="small" @click="openRouteDraft(row.coverId)">
                新建替代邮路 {{ row.routeDelta.to.routeNo }}{{ row.routeDelta.to.cloneFromId !== null ? `（代 #${row.routeDelta.to.cloneFromId}）` : '（原位补登）' }}
              </el-button>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="本封冲突" min-width="220">
          <template #default="{ row }">
            <span v-if="!coverConflicts(row.coverId).length" class="gb-batch__muted">无</span>
            <div v-for="(c, i) in coverConflicts(row.coverId)" :key="i" class="gb-batch__conflict-line">
              {{ c.message }}
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="wizard.plan.value" class="gb-batch__created">
        本批将新建替代邮戳 {{ wizard.plan.value.createdPostmarks.length }} 枚、替代邮路
        {{ wizard.plan.value.createdRoutes.length }} 条；被其他实寄封共用的原对象一律保留。
      </div>

      <div class="gb-batch__actions">
        <el-button @click="wizard.step.value = 'edit'">上一步</el-button>
        <el-button
          type="primary"
          :disabled="!wizard.plan.value?.ok"
          :loading="wizard.submitting.value"
          @click="commit"
        >
          确认提交整批
        </el-button>
      </div>
    </section>

    <!-- ④ 完成 / 撤销 -->
    <section v-else class="gb-panel">
      <el-result
        icon="success"
        title="批量重编已提交"
        sub-title="改动只落在所选实寄封；可撤销一次恢复整批开始前的数据。"
      >
        <template #extra>
          <div class="gb-batch__done">
            <p v-if="wizard.lastCommitted.value">
              已重编 {{ wizard.lastCommitted.value.coverCount }} 封，新建替代邮戳
              {{ wizard.lastCommitted.value.postmarkCount }} 枚、替代邮路
              {{ wizard.lastCommitted.value.routeCount }} 条。
            </p>
            <el-space>
              <el-button @click="wizard.reset()">开始新一批</el-button>
              <el-button type="primary" @click="router.push('/covers')">返回目录核对</el-button>
              <el-button type="warning" plain @click="doUndo">撤销本次批量重编</el-button>
            </el-space>
          </div>
        </template>
      </el-result>
    </section>

    <PostmarkDraftDialog v-model="pmDialogVisible" :draft="activePmDraft" />
    <RouteDraftDialog v-model="routeDialogVisible" :draft="activeRouteDraft" />
  </div>
</template>

<style scoped>
.gb-batch__steps {
  margin: 4px 0 16px;
}
.gb-batch__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.gb-batch__edit {
  margin-bottom: 16px;
}
.gb-batch__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
.gb-batch__alert {
  margin-bottom: 12px;
}
.gb-batch__tag {
  margin: 2px 4px 2px 0;
}
.gb-batch__muted {
  color: var(--gb-muted);
  font-size: 12px;
}
.gb-batch__delta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin: 2px 0;
  flex-wrap: wrap;
}
.gb-batch__changed {
  color: #b06f16;
  font-weight: 600;
}
.gb-batch__conflicts {
  margin: 6px 0 0;
  padding-left: 18px;
}
.gb-batch__conflicts li {
  margin: 2px 0;
}
.gb-batch__conflict-line {
  color: #b02a1e;
  font-size: 12px;
}
.gb-batch__preview-table {
  margin-bottom: 10px;
}
.gb-batch__created {
  font-size: 13px;
  color: var(--gb-muted);
}
.gb-batch__done p {
  color: var(--gb-muted);
}
</style>
