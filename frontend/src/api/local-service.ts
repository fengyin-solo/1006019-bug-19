import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAllRows, saveRows } from '@/data/local-store'
import {
  STAND_FREE_STATUS,
  applyFlightCompletion,
  isPendingRow,
} from '@/data/reconcile'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  // 终态守卫：已终止的航班任务不能再回到任何状态（含保障完成）。
  if (key === 'flight' && current === '已终止') {
    return { ok: false, message: '任务已终止，终态不可回退，不能再执行该操作' }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 航班「确认完成」：一次写入同时收口台账、机位占用、班组占用与待处理汇总，
  // 冲突时整笔退回，避免只写一个入口。
  if (key === 'flight' && action === '确认完成') {
    const outcome = applyFlightCompletion(allRows(), id)
    if (!outcome.ok) {
      return { ok: false, message: outcome.message }
    }
    saveAllRows(outcome.rows)
    if (outcome.idempotent) {
      return { ok: true, message: '该航班此前已确认完成，占用与汇总只入账一次，未重复扣减' }
    }
    const details: string[] = []
    if (outcome.releasedStandNos.length > 0) {
      details.push(`释放机位 ${outcome.releasedStandNos.join('、')}`)
    }
    if (outcome.releasedTeamNos.length > 0) {
      details.push(`释放班组占用 ${outcome.releasedTeamNos.join('、')}`)
    }
    return {
      ok: true,
      message: `航班保障已确认完成，当前状态「${target}」；待处理已减账${
        details.length > 0 ? `，${details.join('，')}` : ''
      }`,
    }
  }

  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isPendingRow(key, { ...rows[index], status: target }),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }

  // 机位「释放机位」：同步清空当前航班标识，机位页读到的当前航班只能来自台账，
  // 不能留一套机位页自己的旧值。
  if (key === 'stand' && target === STAND_FREE_STATUS) {
    updated['当前航班'] = ''
  }

  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    // 待处理统一由业务状态推导（isPendingRow），存储里的 pending 只是缓存；
    // 汇总不读各页面重算结果，避免两个入口算出两套数。
    const pending = entries.reduce((count, row) => count + (isPendingRow(meta.key, row) ? 1 : 0), 0)
    return {
      name: meta.name,
      created: entries.length,
      // 双保险：任何情况下待处理都不允许被减成负数。
      pending: Math.max(0, pending),
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
