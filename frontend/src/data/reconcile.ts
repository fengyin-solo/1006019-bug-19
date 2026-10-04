import { MODULE_BY_KEY } from './modules'
import type { EntryRow } from './types'

// 航班保障（flight）与机位分配（stand）、保障班组（team）之间的联动对账原语。
// 实时「确认完成」与存量回填都走这一份规则，保证一次收口、同一套账。

export const FLIGHT_KEY = 'flight'
export const STAND_KEY = 'stand'
export const TEAM_KEY = 'team'

export const FLIGHT_STATUS = {
  pending: '待接收',
  serving: '保障中',
  done: '保障完成',
  terminated: '已终止',
} as const

// 航班保障的两个终态：都不再计入待处理，也都不允许被动作改写。
export const FLIGHT_TERMINALS = new Set<string>([
  FLIGHT_STATUS.done,
  FLIGHT_STATUS.terminated,
])

// 占用待办口径：
// - 机位：状态「占用中」即一条占用待办（与机位页面的动作目标一致）
// - 班组：占用待办由航班明细派生（见 deriveTeamPending），不是班组自己的状态字段
export function standOccupied(row: EntryRow): boolean {
  return String(row.status) === '占用中'
}

// 同一架航班的跨表对牌规则：机位表「当前航班」字段必须与航班表「航班号」一致。
// 这是「停机位读到的当前航班不能是另一套」的唯一校验依据。
export function sameFlight(flightRow: EntryRow, standRow: EntryRow): boolean {
  return String(standRow['当前航班'] ?? '') === String(flightRow['航班号'] ?? '')
}

export type ReleaseResult = {
  ok: boolean
  message: string
  standId?: number
}

/**
 * 释放一个已完成航班派生出去的机位占用：
 * 1) 找到航班登记的机位（按「机位号」对牌机位表「机位编号」）；
 * 2) 该机位必须是「占用中」，且「当前航班」正是本航班——账实不符不许错放；
 * 3) 置为空闲并清空「当前航班」，回写机位的占用待办。
 *
 * strict=true（实时动作）：任一硬校验不过都算失败，由调用方整体回滚，不允许「假完成」。
 * strict=false（存量回填）：对不上的占用跳过，只把能对上的账补齐，绝不错放别的航班。
 */
export function releaseFlightOccupancy(
  tables: Record<string, EntryRow[]>,
  flightRow: EntryRow,
  strict: boolean,
): ReleaseResult {
  const stands = cloneRows(tables[STAND_KEY])
  const standNo = String(flightRow['机位号'] ?? '').trim()

  const standIndex = stands.findIndex(
    (row) => String(row['机位编号'] ?? '') === standNo,
  )
  if (standIndex < 0) {
    return strict
      ? { ok: false, message: `机位「${standNo}」未登记，占用释放失败` }
      : { ok: false, message: 'skip:no-stand' }
  }

  const stand = stands[standIndex]
  if (!standOccupied(stand)) {
    if (sameFlight(flightRow, stand)) {
      // 机位已被别的入口（机位页手动释放）置空，但「当前航班」还残留本航班：
      // 顺手清掉残留，保证停机位读到的当前航班不是旧的一套。幂等，不重复落账。
      stands[standIndex] = {
        ...stand,
        当前航班: '',
        机位状态:
          String(stand['机位状态'] ?? '') === '占用中' ? '空闲' : stand['机位状态'],
      }
      tables[STAND_KEY] = stands
    }
    return { ok: true, message: 'already-released', standId: Number(stand.id) }
  }
  if (!sameFlight(flightRow, stand)) {
    return strict
      ? {
          ok: false,
          message: `机位「${standNo}」当前航班是「${stand['当前航班']}」，与本航班「${flightRow['航班号']}」不一致，拒绝释放`,
        }
      : { ok: false, message: 'skip:flight-mismatch' }
  }

  stands[standIndex] = {
    ...stand,
    status: '空闲',
    pending: true,
    当前航班: '',
    机位状态: '空闲',
  }
  tables[STAND_KEY] = stands

  // 班组占用待办不在此处理：它是航班明细的纯派生值，
  // 由唯一收口 saveTables / reconcileTables 调 deriveTeamPending 统一重算。

  return { ok: true, message: 'released', standId: Number(stand.id) }
}

/**
 * 重算一张表的 pending（待处理）汇总位。
 * pending 一律由行状态派生，不允许页面动作单独写它——这就是「冲突以占用明细为准」的落点：
 * 明细行是唯一事实源，汇总数字每次都从明细重算，任何单独改过的汇总都被覆盖。
 */
export function normalizeRows(
  key: string,
  rows: EntryRow[],
  terminalStatuses?: Set<string>,
): EntryRow[] {
  const terminals =
    terminalStatuses ??
    new Set([MODULE_BY_KEY.get(key)?.statuses.slice(-1)[0]].filter(Boolean))
  return rows.map((row) => ({
    ...row,
    pending: !terminals.has(String(row.status)),
  }))
}

/** 业务编号去重（每页第一列字段）。同编号只保留一份，消除重复落账的记录。 */
export function dedupeRows(rows: EntryRow[], idField: string): EntryRow[] {
  const seen = new Set<string>()
  const result: EntryRow[] = []
  for (const row of rows) {
    const code = String(row[idField] ?? row.id ?? '').trim()
    if (seen.has(code)) {
      continue
    }
    seen.add(code)
    result.push(row)
  }
  // 去重后 id 仍要求唯一且连续，避免页面 :key 撞车。
  return result.map((row, index) => ({ ...row, id: index + 1 }))
}

/**
 * 班组占用待办完全由航班明细派生：班组名下还挂着「保障中」的航班时 pending=true。
 * 与班组自身的轮休/培训状态无关——占用是航班的投影，不是班组台账字段，
 * 因此即便有人单独改过班组 pending，每次收口都会被航班明细覆盖（明细为准）。
 */
export function deriveTeamPending(
  teams: EntryRow[],
  flights: EntryRow[],
): EntryRow[] {
  const servingTeams = new Set(
    flights
      .filter((row) => String(row.status) === FLIGHT_STATUS.serving)
      .map((row) => String(row['保障班组'] ?? '').trim())
      .filter(Boolean),
  )
  return teams.map((team) => ({
    ...team,
    pending: servingTeams.has(String(team['班组名称'] ?? '').trim()),
  }))
}

function cloneRows(rows: EntryRow[] | undefined): EntryRow[] {
  return (rows ?? []).map((row) => ({ ...row }))
}

export function findStandByFlight(
  stands: EntryRow[],
  flightRow: EntryRow,
): EntryRow | undefined {
  const standNo = String(flightRow['机位号'] ?? '').trim()
  return stands.find(
    (row) =>
      String(row['机位编号'] ?? '') === standNo &&
      String(row['当前航班'] ?? '') === String(flightRow['航班号'] ?? ''),
  )
}
