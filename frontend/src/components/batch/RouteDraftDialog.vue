<script setup lang="ts">
/**
 * 「按新事实另立替代邮路」编辑弹窗：可改节点顺序与日期，
 * 原邮路保留给其他实寄封共用。
 */
import { reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { TRANSPORT_MODES } from '@/types/route'
import type { RouteNode } from '@/types/route'
import type { RouteFactDraft } from '@/utils/batchRebuild'
import { computeTotalDays, createRouteNode } from '@/stores/routeStore'
import { isChronological } from '@/utils/dateRange'
import { uid } from '@/utils/id'

const props = defineProps<{
  modelValue: boolean
  draft: RouteFactDraft | null
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const form = reactive<RouteFactDraft>({
  key: '',
  routeNo: '',
  name: '',
  era: '',
  transport: '铁路',
  nodes: [],
  frequency: '',
  remark: '',
  cloneFromId: null
})

watch(
  () => props.draft,
  (draft) => {
    if (draft) Object.assign(form, JSON.parse(JSON.stringify(draft)))
  },
  { immediate: true }
)

function addNode(): void {
  form.nodes.push(createRouteNode())
}

function removeNode(index: number): void {
  form.nodes.splice(index, 1)
}

function moveNode(index: number, delta: number): void {
  const target = index + delta
  if (target < 0 || target >= form.nodes.length) return
  const [node] = form.nodes.splice(index, 1)
  form.nodes.splice(target, 0, node as RouteNode)
}

function close(): void {
  if (!form.name.trim()) {
    ElMessage.warning('请填写邮路名称')
    return
  }
  if (props.draft) {
    for (const node of form.nodes) {
      if (!node.key) node.key = uid('node')
    }
    Object.assign(props.draft, JSON.parse(JSON.stringify(form)))
  }
  emit('update:modelValue', false)
}

const chronoOk = () => isChronological(form.nodes.map((n) => n.arriveDate))
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="按新事实另立替代邮路"
    width="820px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p v-if="form.cloneFromId !== null" class="gb-batch__tip">
      原邮路 #{{ form.cloneFromId }} 仍被其他实寄封引用，将原样保留；此处编辑的是本批新建的替代邮路（记录替代关系）。
    </p>
    <el-form label-width="82px">
      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item label="邮路号">
            <el-input v-model="form.routeNo" placeholder="留空自动续号" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="名称">
            <el-input v-model="form.name" placeholder="如 沪宁铁路邮路（改）" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="时期">
            <el-input v-model="form.era" placeholder="如 1910-1919" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="运输方式">
            <el-select v-model="form.transport" style="width: 100%">
              <el-option v-for="t in TRANSPORT_MODES" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="班期">
            <el-input v-model="form.frequency" placeholder="如 逐日班" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="全程天数">
            <el-tag type="info" effect="plain">{{ computeTotalDays(form.nodes) }} 天（按节点自动算）</el-tag>
          </el-form-item>
        </el-col>
      </el-row>
      <p v-if="!chronoOk()" class="gb-batch__warn">
        节点日期顺序倒置，请调整顺序或日期，否则整批将因冲突不写入。
      </p>
      <el-table :data="form.nodes" border size="small">
        <el-table-column label="序" width="64">
          <template #default="{ $index }">
            <div class="gb-batch__order">
              <el-button size="small" link :disabled="$index === 0" @click="moveNode($index, -1)">↑</el-button>
              <span>{{ $index + 1 }}</span>
              <el-button
                size="small"
                link
                :disabled="$index === form.nodes.length - 1"
                @click="moveNode($index, 1)"
              >↓</el-button>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="局所" min-width="120">
          <template #default="{ row }">
            <el-input v-model="row.office" placeholder="如 苏州" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="到达日期" width="170">
          <template #default="{ row }">
            <el-date-picker
              v-model="row.arriveDate"
              type="date"
              size="small"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </template>
        </el-table-column>
        <el-table-column label="中转戳" min-width="140">
          <template #default="{ row }">
            <el-input v-model="row.transitMark" placeholder="如 苏州中转日戳" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="72">
          <template #default="{ $index }">
            <el-button size="small" link type="danger" @click="removeNode($index)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="gb-batch__node-actions">
        <el-button size="small" @click="addNode">添加节点</el-button>
      </div>
    </el-form>
    <template #footer>
      <el-button type="primary" @click="close">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.gb-batch__order {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
}
.gb-batch__node-actions {
  margin-top: 8px;
}
</style>
