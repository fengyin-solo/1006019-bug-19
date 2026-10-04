import { emitDataChange } from './events'
import { MODULE_BY_KEY } from './modules'
import {
  dedupeRows,
  deriveTeamPending,
  FLIGHT_KEY,
  FLIGHT_STATUS,
  FLIGHT_TERMINALS,
  normalizeRows,
  releaseFlightOccupancy,
  TEAM_KEY,
} from './reconcile'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function idFieldOf(key: string): string {
  return MODULE_BY_KEY.get(key)?.fields[0] ?? 'id'
}

/**
 * 存量回填对账：处理「状态已经写成保障完成、占用释放与汇总却漏写」的老账。
 * 按计划到达升序逐条补账（先到先放，释放顺序可复现），与实时确认完成走同一段原语：
 * - 保障完成的航班：补放对得上牌的机位与班组占用，对不上的跳过，绝不错放别人的；
 * - 已终止的航班：终态保持，不补放、不回到保障完成；
 * - 各表 pending 一律按当前明细状态重算，消除被减成负数/没减下去的偏差；
 * - 业务编号去重，同编号只保留一份，消除重复记录。
 */
export function reconcileTables(
  source: Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  const tables: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(source)) {
    tables[key] = dedupeRows(clone(source[key] ?? []), idFieldOf(key))
  }

  const flights = tables[FLIGHT_KEY] ?? []
  const doneFlights = flights
    .filter((row) => String(row.status) === FLIGHT_STATUS.done)
    .sort(
      (a, b) =>
        String(a['计划到达'] ?? '').localeCompare(String(b['计划到达'] ?? '')) ||
        Number(a.id) - Number(b.id),
    )
  for (const flight of doneFlights) {
    // 宽松模式：只补能对上牌的占用，不阻断存量数据的其余部分。
    releaseFlightOccupancy(tables, flight, false)
  }

  for (const key of Object.keys(tables)) {
    if (key === TEAM_KEY) {
      // 班组待办是航班明细的投影，不能用「在岗≠终态」这种班组自身口径算。
      tables[TEAM_KEY] = deriveTeamPending(tables[TEAM_KEY] ?? [], tables[FLIGHT_KEY] ?? [])
    } else {
      tables[key] = normalizeRows(
        key,
        tables[key],
        key === FLIGHT_KEY ? FLIGHT_TERMINALS : undefined,
      )
    }
  }
  return tables
}

function freshSeed(): Record<string, EntryRow[]> {
  return reconcileTables(clone(SEED_ROWS))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = freshSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const base = { ...clone(SEED_ROWS), ...parsed }
    // 每次读入都幂等跑一遍对账：老账套的漏释放/重复记录/错汇总在加载时一次性补齐，
    // 对账本身无副作用地可重复执行，不依赖版本号。
    const reconciled = reconcileTables(base)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reconciled))
    return reconciled
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveTables({ [key]: rows })
}

/**
 * 多键原子写入：一次「确认完成」要同时落 flight / stand / team 三处，
 * 必须在内存里整包改完后一次性提交，再发一次变更事件。
 *
 * 这里是 pending/占用派生位的唯一收口：任何调用方即便手工改过这些汇总字段，
 * 提交前都会被按明细重算覆盖——所以不存在「占用记录与汇总记录各改各的」的第二套账。
 */
export function saveTables(updates: Record<string, EntryRow[]>): void {
  const next = { ...allRows() }
  for (const [key, rows] of Object.entries(updates)) {
    next[key] = rows
  }
  // flight 或 team 任一变化都要按航班明细重算班组占用待办。
  if (FLIGHT_KEY in updates || TEAM_KEY in updates) {
    next[TEAM_KEY] = deriveTeamPending(next[TEAM_KEY] ?? [], next[FLIGHT_KEY] ?? [])
  }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  const changed = Object.keys(updates)
  if (FLIGHT_KEY in updates || TEAM_KEY in updates) {
    changed.push(TEAM_KEY)
  }
  emitDataChange([...new Set(changed)])
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, normalizeRows(key, rows, key === FLIGHT_KEY ? FLIGHT_TERMINALS : undefined))
  return listRows(key)
}

export function storageKey(): string {
  return STORAGE_KEY
}
