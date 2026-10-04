import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, saveTables } from '@/data/local-store'
import {
  FLIGHT_KEY,
  FLIGHT_STATUS,
  FLIGHT_TERMINALS,
  normalizeRows,
  releaseFlightOccupancy,
  STAND_KEY,
} from '@/data/reconcile'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 航班保障的动作权限矩阵：只允许沿着状态机正向走，终态任务不再出现任何动作。
const FLIGHT_ACTION_RULES: Record<string, { from: string[]; target: string }> = {
  接收任务: { from: ['待接收'], target: FLIGHT_STATUS.serving },
  开始保障: { from: ['待接收', '保障中'], target: FLIGHT_STATUS.serving },
  确认完成: { from: ['保障中'], target: FLIGHT_STATUS.done },
}

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
  if (key === FLIGHT_KEY) {
    return runFlightAction(id, action)
  }
  return runGenericAction(key, id, action)
}

function runGenericAction(key: string, id: number, action: string): ActionResult {
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
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runFlightAction(id: number, action: string): ActionResult {
  const rule = FLIGHT_ACTION_RULES[action]
  if (!rule) {
    return { ok: false, message: `航班保障任务没有登记「${action}」这个动作` }
  }
  const rows = listRows(FLIGHT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的航班保障任务` }
  }
  const flight = rows[index]
  const current = String(flight.status)

  // 已终止是终态：任何动作都不能把它带回保障完成或其他状态。
  if (current === FLIGHT_STATUS.terminated) {
    return { ok: false, message: '该任务已终止，不能再执行任何状态流转' }
  }
  if (!rule.from.includes(current)) {
    if (current === rule.target) {
      // 同一航班重复点击：只落一次账，直接幂等返回成功，不重复释放、不重复减待处理。
      return { ok: true, message: `任务已经是「${rule.target}」，无需重复操作` }
    }
    return {
      ok: false,
      message: `当前状态「${current}」不允许执行「${action}」`,
    }
  }

  if (action !== '确认完成') {
    const updated: EntryRow = {
      ...flight,
      status: rule.target,
      保障状态: rule.target,
      pending: true,
    }
    const next = [...rows]
    next[index] = updated
    saveRows(FLIGHT_KEY, normalizeRows(FLIGHT_KEY, next, FLIGHT_TERMINALS))
    return { ok: true, message: `航班保障任务已${action}，当前状态「${rule.target}」` }
  }

  return completeFlight(index, flight)
}

/**
 * 确认完成的一次收口：flight 状态、机位占用、班组占用、待处理汇总在同一个事务里落账。
 * 顺序是「先校验并释放派生占用，最后才改主状态」——释放任一硬校验不过就整体回滚，
 * 主状态退回「保障中」（本来就没提交，天然回到原值）。
 *
 * 取舍：释放失败时**退回/保留保障中，不保留保障完成**。
 * 依据：机位是排他性硬资源，若先挂「保障完成」而占用没释放，机位会被永久算占、
 * 后续航班无法分配，且现场会以列表上的「完成」为准撤离人员，造成账实不符；
 * 而留在「保障中」只是让任务继续挂在待处理里，重试成本低、不会产生资源泄漏，
 * 宁可提示失败让人重试，也不允许假完成。
 */
function completeFlight(index: number, flight: EntryRow): ActionResult {
  // 全部改动先写在内存副本上，校验不通过就丢弃副本，已落盘数据一个字节都不动。
  const tables: Record<string, EntryRow[]> = {
    [FLIGHT_KEY]: listRows(FLIGHT_KEY).map((row) => ({ ...row })),
    [STAND_KEY]: listRows(STAND_KEY).map((row) => ({ ...row })),
  }

  const release = releaseFlightOccupancy(tables, flight, true)
  if (!release.ok) {
    return {
      ok: false,
      message: `确认完成未提交，任务保持「${FLIGHT_STATUS.serving}」：${release.message}`,
    }
  }

  tables[FLIGHT_KEY][index] = {
    ...flight,
    status: FLIGHT_STATUS.done,
    保障状态: FLIGHT_STATUS.done,
    abnormal: false,
  }
  tables[FLIGHT_KEY] = normalizeRows(FLIGHT_KEY, tables[FLIGHT_KEY], FLIGHT_TERMINALS)
  tables[STAND_KEY] = normalizeRows(STAND_KEY, tables[STAND_KEY])

  // 占用与状态整包提交：flight 与 stand 一起生效；
  // 班组占用待办由 saveTables 按航班明细统一派生（不在这里手写第二套）。
  saveTables({
    [FLIGHT_KEY]: tables[FLIGHT_KEY],
    [STAND_KEY]: tables[STAND_KEY],
  })

  return {
    ok: true,
    message: `航班「${flight['航班号']}」已保障完成，机位与班组占用同步释放`,
  }
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
    return {
      name: meta.name,
      created: entries.length,
      // 待处理永远从明细行实时重算：明细是唯一事实源，不存在独立的汇总账本，
      // 也就不存在「占用记录与汇总记录冲突以谁为准」——汇总只是明细的投影。
      pending: entries.filter((row) => row.pending).length,
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
