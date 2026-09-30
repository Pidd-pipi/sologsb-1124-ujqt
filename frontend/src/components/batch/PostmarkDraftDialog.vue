<script setup lang="ts">
/**
 * 「按新事实另立替代邮戳」编辑弹窗：只改本批新建的替代对象，
 * 原邮戳保留给其他实寄封共用。
 */
import { reactive, watch } from 'vue'
import {
  INK_COLORS,
  POSTMARK_TYPES,
  PROVINCES,
  SCARCE_LEVELS
} from '@/types/postmark'
import type { PostmarkFactDraft } from '@/utils/batchRebuild'

const props = defineProps<{
  modelValue: boolean
  draft: PostmarkFactDraft | null
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const form = reactive<PostmarkFactDraft>({
  key: '',
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
  note: '',
  cloneFromId: null
})

watch(
  () => props.draft,
  (draft) => {
    if (draft) Object.assign(form, JSON.parse(JSON.stringify(draft)))
  },
  { immediate: true }
)

function close(): void {
  if (props.draft) Object.assign(props.draft, JSON.parse(JSON.stringify(form)))
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="按新事实另立替代邮戳" width="640px" @update:model-value="emit('update:modelValue', $event)">
    <p v-if="form.cloneFromId !== null" class="gb-batch__tip">
      原邮戳 #{{ form.cloneFromId }} 仍被其他实寄封引用，将原样保留；此处编辑的是本批新建的替代戳（记录替代关系）。
    </p>
    <el-form label-width="96px">
      <el-row :gutter="12">
        <el-col :span="12">
          <el-form-item label="编目号">
            <el-input v-model="form.pmNo" placeholder="留空自动续号，如 PM-0007" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="戳型">
            <el-select v-model="form.type" style="width: 100%">
              <el-option v-for="t in POSTMARK_TYPES" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="局所">
            <el-input v-model="form.office" placeholder="如 上海邮政总局" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="省份">
            <el-select v-model="form.province" filterable allow-create default-first-option style="width: 100%">
              <el-option v-for="p in PROVINCES" :key="p" :label="p" :value="p" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="年代起">
            <el-input-number v-model="form.yearFrom" :min="1800" :max="2100" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="年代止">
            <el-input-number v-model="form.yearTo" :min="1800" :max="2100" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="戳面日期">
            <el-date-picker
              v-model="form.dateOnStamp"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="墨色">
            <el-select v-model="form.inkColor" style="width: 100%">
              <el-option v-for="c in INK_COLORS" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="戳径(mm)">
            <el-input-number v-model="form.diameter" :min="10" :max="80" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="稀见度">
            <el-select v-model="form.scarceLevel" style="width: 100%">
              <el-option v-for="s in SCARCE_LEVELS" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="中英双文">
            <el-switch v-model="form.bilingual" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="戳面上格">
            <el-input v-model="form.lettering.top" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="戳面中格">
            <el-input v-model="form.lettering.middle" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="戳面下格">
            <el-input v-model="form.lettering.bottom" />
          </el-form-item>
        </el-col>
        <el-col :span="24">
          <el-form-item label="备注">
            <el-input v-model="form.note" type="textarea" :rows="2" placeholder="记新事实依据，如「据封背到达戳改定局所」" />
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>
    <template #footer>
      <el-button type="primary" @click="close">完成</el-button>
    </template>
  </el-dialog>
</template>
