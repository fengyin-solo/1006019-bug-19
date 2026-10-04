<template>
  <section class="page" data-module="flight">
    <header class="page-head">
      <div>
        <h2>航班保障管理</h2>
        <p class="page-desc">维护航班保障任务，围绕保障编号、航班号、机型、计划到达做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记航班保障任务</button>
        <button class="btn" type="button" @click="exportRows">导出航班保障清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="busyId === String(row.id)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="actionsFor(row).length === 0" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无航班保障数据，可先登记航班保障任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航班保障记录</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useDataSync } from '@/composables/useDataSync'
import { FLIGHT_STATUS, STAND_KEY, TEAM_KEY } from '@/data/reconcile'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('flight')
const columns = ["保障编号", "航班号", "机型", "计划到达", "机位号", "保障等级", "保障班组", "保障状态"]
const statuses = ["待接收", "保障中", "保障完成", "已终止"]
const stats = [{"label": "今日保障任务", "value": 0}, {"label": "保障中任务", "value": 0}, {"label": "保障完成率", "value": 0}]

// 每个状态下页面上允许出现的动作：终态（保障完成/已终止）没有任何动作，
// 已终止的任务因此不可能通过页面回到保障完成。
const ACTIONS_BY_STATUS: Record<string, string[]> = {
  [FLIGHT_STATUS.pending]: ["接收任务", "开始保障"],
  [FLIGHT_STATUS.serving]: ["确认完成"],
  [FLIGHT_STATUS.done]: [],
  [FLIGHT_STATUS.terminated]: [],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const busyId = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): string[] {
  return ACTIONS_BY_STATUS[String(row.status)] ?? []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '航班保障任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  busyId.value = String(row.id)
  try {
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    okMessage.value = result.message
    reload()
  } finally {
    busyId.value = ''
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航班保障列表读取失败'
  }
}

onMounted(reload)
// 机位/班组在别的入口被改动时（如机位页手动释放），本页也要同步。
useDataSync(reload, [meta.key, STAND_KEY, TEAM_KEY])
</script>
