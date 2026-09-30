<script setup lang="ts">
/**
 * 批量重编向导中的单封编辑块：寄出 / 到达日期、邮戳关联逐行保留 / 移除 /
 * 替换（已登记戳或另立替代戳）、邮路不动 / 摘除 / 改挂 / 另立替代邮路。
 */
import { computed } from 'vue'
import type { Cover } from '@/types/cover'
import type { BatchRebuildWizard } from '@/hooks/useBatchRebuild'

const props = defineProps<{
  cover: Cover
  wizard: BatchRebuildWizard
  pmOptions: { label: string; value: number }[]
  routeOptions: { label: string; value: number }[]
}>()

const emit = defineEmits<{
  openPmDraft: [draftKey: string]
  openRouteDraft: [coverId: number]
}>()

const state = computed(() => props.wizard.ensureEdit(props.cover.id as number))

function rowValue(targetPmId: number | null): string | number {
  return targetPmId === null ? '__new__' : targetPmId
}

function onRowTarget(index: number, value: string | number | boolean | Record<string, unknown>): void {
  const row = state.value.pmRows[index]
  if (!row) return
  if (value === '__new__') {
    row.targetPmId = null
    row.action = 'replace'
    props.wizard.ensurePmDraft(props.cover.id as number, row)
  } else {
    row.targetPmId = Number(value)
    row.action = 'replace'
  }
}

function onRouteMode(mode: string | number | boolean | Record<string, unknown>): void {
  const s = state.value
  s.route.mode = mode as 'unchanged' | 'detach' | 'existing' | 'clone'
  if (mode === 'clone') props.wizard.ensureRouteDraft(props.cover.id as number)
  if (mode === 'existing' && s.route.targetRouteId === null) {
    s.route.targetRouteId = props.routeOptions[0]?.value ?? null
  }
}

function onRouteTarget(value: string | number | boolean | Record<string, unknown>): void {
  state.value.route.targetRouteId = Number(value)
}
</script>

<template>
  <div class="cover-edit gb-panel">
    <div class="cover-edit__head">
      <strong>{{ cover.coverNo }}</strong>
      <span class="cover-edit__muted">{{ cover.sentFrom }} → {{ cover.sentTo }}</span>
      <span class="cover-edit__muted">
        原 {{ cover.postDate || '待考' }} / {{ cover.arriveDate || '待考' }}
      </span>
    </div>

    <el-form :inline="true" label-width="82px" class="cover-edit__dates" @submit.prevent>
      <el-form-item label="寄出日期">
        <el-date-picker
          v-model="state.postDate"
          type="date"
          size="small"
          value-format="YYYY-MM-DD"
          @change="state.datesTouched = true"
        />
      </el-form-item>
      <el-form-item label="到达日期">
        <el-date-picker
          v-model="state.arriveDate"
          type="date"
          size="small"
          value-format="YYYY-MM-DD"
          @change="state.datesTouched = true"
        />
      </el-form-item>
    </el-form>

    <div class="cover-edit__section-title">关联邮戳（票戳组合的销票戳）</div>
    <div v-for="(row, index) in state.pmRows" :key="`${row.fromId}-${index}-${row.draftKey}`" class="cover-edit__row">
      <el-select
        :model-value="rowValue(row.targetPmId)"
        size="small"
        filterable
        style="width: 320px"
        @update:model-value="(v: string | number) => onRowTarget(index, v)"
      >
        <el-option v-for="opt in pmOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        <el-option label="按新事实另立替代戳…" value="__new__" />
      </el-select>
      <el-radio-group v-model="row.action" size="small">
        <el-radio-button value="keep">保留</el-radio-button>
        <el-radio-button value="remove">移除</el-radio-button>
        <el-radio-button value="replace">替换</el-radio-button>
      </el-radio-group>
      <el-button
        v-if="row.targetPmId === null"
        link
        type="primary"
        size="small"
        @click="emit('openPmDraft', row.draftKey)"
      >
        编辑新戳事实
      </el-button>
      <el-button link type="danger" size="small" @click="wizard.removePmRow(cover.id as number, index)">
        删行
      </el-button>
    </div>
    <el-button size="small" class="cover-edit__add" @click="wizard.addPmRow(cover.id as number)">
      添加邮戳关联
    </el-button>

    <div class="cover-edit__section-title">所属邮路</div>
    <div class="cover-edit__row">
      <el-radio-group
        :model-value="state.route.mode"
        size="small"
        @update:model-value="(m: string) => onRouteMode(m)"
      >
        <el-radio-button value="unchanged">邮路不动</el-radio-button>
        <el-radio-button value="detach">摘除邮路</el-radio-button>
        <el-radio-button value="existing">改挂已登记邮路</el-radio-button>
        <el-radio-button value="clone">按新事实另立替代邮路</el-radio-button>
      </el-radio-group>
      <el-select
        v-if="state.route.mode === 'existing'"
        :model-value="state.route.targetRouteId"
        size="small"
        filterable
        style="width: 280px"
        @update:model-value="(v: string | number) => onRouteTarget(v)"
      >
        <el-option v-for="opt in routeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
      <el-button
        v-if="state.route.mode === 'clone'"
        link
        type="primary"
        size="small"
        @click="emit('openRouteDraft', cover.id as number)"
      >
        编辑新邮路事实
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.cover-edit {
  margin-bottom: 12px;
}
.cover-edit__head {
  display: flex;
  gap: 12px;
  align-items: baseline;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.cover-edit__head strong {
  color: #5d3325;
  font-size: 15px;
}
.cover-edit__muted {
  color: var(--gb-muted);
  font-size: 12px;
}
.cover-edit__dates {
  margin-bottom: 4px;
}
.cover-edit__section-title {
  font-size: 13px;
  font-weight: 600;
  color: #5d3325;
  margin: 8px 0 6px;
}
.cover-edit__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.cover-edit__add {
  margin-bottom: 4px;
}
</style>
