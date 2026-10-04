import { reconcileAll, type ReconcileReport } from './reconcile'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
// 版本号随对账规则一起升：旧版本（含无版本）数据首次加载即按新规则回填一次。
const VERSION_KEY = 'airport-ground-ops:schema-version'
const CURRENT_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 示例数据先过一遍对账，保证首次播种的占用与汇总就是收口的，不能指望页面去修。
function seededRows(): Record<string, EntryRow[]> {
  return reconcileAll(clone(SEED_ROWS)).rows
}

function readStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seededRows()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = seededRows()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(VERSION_KEY, String(CURRENT_VERSION))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const storedVersion = Number(window.localStorage.getItem(VERSION_KEY) ?? '1')
    // 存量：「状态写完却漏了占用释放与汇总」的旧账，按计划到达排序回填修正。
    const { rows, report } = reconcileAll(parsed)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
    if (storedVersion < CURRENT_VERSION) {
      window.localStorage.setItem(VERSION_KEY, String(CURRENT_VERSION))
      lastMigrationReport = report
    }
    return rows
  } catch {
    const fallback = seededRows()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(VERSION_KEY, String(CURRENT_VERSION))
    return fallback
  }
}

// 最近一次启动回填的结果，页面可据此提示本次自动修正了哪些占用/待处理账。
export let lastMigrationReport: ReconcileReport | null = null

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
  saveAllRows({ ...allRows(), [key]: rows })
}

// 整库一次落盘：跨模块（航班台账 + 机位 + 班组）的动作必须走这个入口，
// 避免只写一个分片、另一个分片还留着旧账。
export function saveAllRows(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.localStorage.setItem(VERSION_KEY, String(CURRENT_VERSION))
  }
}

export function resetRows(key: string): EntryRow[] {
  // 重置单模块时用种子的已对账版本，保持与其他模块同一套占用口径。
  const rows = clone(SEED_ROWS[key] ?? [])
  const reconciled = reconcileAll({ ...allRows(), [key]: rows }).rows[key]
  saveRows(key, reconciled)
  return reconciled
}

export function storageKey(): string {
  return STORAGE_KEY
}
