import { MODULES } from './modules'
import type { EntryRow } from './types'

// 航班保障台账的终态：到达这两个状态后，占用必须释放、待处理必须减账。
// 「已终止」同样释放——任务终止后机位不能继续挂在它名下，且终态不可回退。
export const FLIGHT_FINISHED_STATUSES = ['保障完成', '已终止']
export const FLIGHT_ACTIVE_STATUSES = ['待接收', '保障中']

// 停机位的非占用态；只有「占用中」产生机位占用待办。
export const STAND_OCCUPIED_STATUS = '占用中'
export const STAND_FREE_STATUS = '空闲'

// 班组占用投影存在这个隐藏字段里（不在页面 fields 中），始终由航班台账重放，
// 保证班组页读到的占用航班与航班页是同一套数据。
export const TEAM_OCCUPIED_FLIGHTS_FIELD = '占用航班'

export type CompletionOutcome =
  | { ok: true; idempotent: boolean; releasedStandNos: string[]; releasedTeamNos: string[]; rows: Record<string, EntryRow[]> }
  | { ok: false; code: 'TERMINATED' | 'OCCUPANCY_CONFLICT' | 'NOT_FOUND'; message: string; standNo?: string }

export type ReconcileReport = {
  version: number
  dedupedRows: number
  pendingFixedRows: number
  releasedStandNos: string[]
  releasedTeamNos: string[]
  reboundStandNos: string[]
}

export function cloneRows(value: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  return JSON.parse(JSON.stringify(value)) as Record<string, EntryRow[]>
}

// 待处理（汇总）口径：直接由业务状态推导，不允许各页面另算一套。
// - 航班：保障完成/已终止即出账，其余状态入账；
// - 机位：占用中才是待释放的占用待办，释放即出账；
// - 其余模块：沿用各自状态机末状态为出账点。
export function isPendingRow(moduleKey: string, row: EntryRow): boolean {
  const meta = MODULES.find((item) => item.key === moduleKey)
  const status = String(row.status)
  if (moduleKey === 'flight') {
    return !FLIGHT_FINISHED_STATUSES.includes(status)
  }
  if (moduleKey === 'stand') {
    return status === STAND_OCCUPIED_STATUS
  }
  if (!meta) {
    return Boolean(row.pending)
  }
  return status !== meta.statuses[meta.statuses.length - 1]
}

function statusRank(moduleKey: string, status: string): number {
  const meta = MODULES.find((item) => item.key === moduleKey)
  if (!meta) {
    return -1
  }
  return meta.statuses.indexOf(status)
}

// 同一业务编号出现多条时的取舍：以状态机中流转更靠后的记录为准（更新的业务事实），
// 状态相同则以 id 更大者（后写入）为准；字段互补合并，保留稳定 id。
function mergeDuplicate(moduleKey: string, older: EntryRow, newer: EntryRow): EntryRow {
  const olderRank = statusRank(moduleKey, String(older.status))
  const newerRank = statusRank(moduleKey, String(newer.status))
  const [primary, secondary] =
    newerRank > olderRank || (newerRank === olderRank && Number(newer.id) >= Number(older.id))
      ? [newer, older]
      : [older, newer]
  return { ...secondary, ...primary }
}

function dedupeModule(moduleKey: string, rows: EntryRow[], report: ReconcileReport): EntryRow[] {
  const meta = MODULES.find((item) => item.key === moduleKey)
  const codeField = meta?.fields[0]
  const indexByCode = new Map<string, number>()
  const result: EntryRow[] = []
  for (const row of rows) {
    const code = codeField && row[codeField] !== undefined && String(row[codeField]) !== ''
      ? String(row[codeField])
      : `id:${String(row.id)}`
    const existingIndex = indexByCode.get(code)
    if (existingIndex === undefined) {
      indexByCode.set(code, result.length)
      result.push({ ...row })
      continue
    }
    report.dedupedRows += 1
    result[existingIndex] = mergeDuplicate(moduleKey, result[existingIndex], row)
  }
  return result
}

// 航班在机位/班组侧可能留下的全部关联标识。
function flightRefs(flight: EntryRow): Set<string> {
  const refs = new Set<string>()
  for (const field of ['航班号', '保障编号']) {
    const value = String(flight[field] ?? '').trim()
    if (value) {
      refs.add(value)
    }
  }
  return refs
}

function flightStandNo(flight: EntryRow): string {
  return String(flight['机位号'] ?? '').trim()
}

export function flightStatus(flight: EntryRow): string {
  return String(flight.status)
}

export function isFinishedFlight(flight: EntryRow): boolean {
  return FLIGHT_FINISHED_STATUSES.includes(flightStatus(flight))
}

export function isActiveFlight(flight: EntryRow): boolean {
  return FLIGHT_ACTIVE_STATUSES.includes(flightStatus(flight))
}

// 机位是否挂在某航班名下：机位「当前航班」命中航班标识，或机位编号命中航班的机位号。
// 两侧任一对得上就算同一占用，避免台账与机位各认一套标识。
export function standMatchesFlight(stand: EntryRow, flight: EntryRow): boolean {
  const currentFlight = String(stand['当前航班'] ?? '').trim()
  if (currentFlight && flightRefs(flight).has(currentFlight)) {
    return true
  }
  const standNo = String(stand['机位编号'] ?? '').trim()
  const flightStand = flightStandNo(flight)
  return Boolean(standNo && flightStand && standNo === flightStand)
}

function teamMatchesFlight(team: EntryRow, flight: EntryRow): boolean {
  const crew = String(flight['保障班组'] ?? '').trim()
  if (!crew) {
    return false
  }
  return crew === String(team['班组编号'] ?? '').trim() || crew === String(team['班组名称'] ?? '').trim()
}

// 计划到达升序：回填与冲突改绑都按先到先得，保证结果确定、可复算。
function sortByScheduledArrival(flights: EntryRow[]): EntryRow[] {
  return [...flights].sort((a, b) => {
    const ta = String(a['计划到达'] ?? '')
    const tb = String(b['计划到达'] ?? '')
    if (ta === tb) {
      return Number(a.id) - Number(b.id)
    }
    return ta.localeCompare(tb)
  })
}

// 班组占用投影整体重放：在岗/轮休等班组状态不动，只让「占用航班」严格等于
// 台账中仍在保障、且点名该班组的航班集合。
function rebuildTeamOccupancy(
  rows: Record<string, EntryRow[]>,
  releasedTeamNos: string[] = [],
): void {
  const teams = rows.team ?? []
  const activeFlights = (rows.flight ?? []).filter(isActiveFlight)
  for (const team of teams) {
    const occupied = sortByScheduledArrival(
      activeFlights.filter((flight) => teamMatchesFlight(team, flight)),
    ).map((flight) => String(flight['航班号'] || flight['保障编号'] || flight.id))
    const before = String(team[TEAM_OCCUPIED_FLIGHTS_FIELD] ?? '')
    if (occupied.length > 0) {
      team[TEAM_OCCUPIED_FLIGHTS_FIELD] = occupied.join('，')
    } else {
      delete team[TEAM_OCCUPIED_FLIGHTS_FIELD]
    }
    if (before && (!occupied.length || !occupied.every((key) => before.includes(key)))) {
      const code = String(team['班组编号'] ?? team.id)
      if (!releasedTeamNos.includes(code)) {
        releasedTeamNos.push(code)
      }
    }
  }
}

function releaseStand(stand: EntryRow): void {
  stand.status = STAND_FREE_STATUS
  stand.pending = false
  stand['当前航班'] = ''
}

// 存量回填：不改台账状态，只把占用/汇总两份投影对齐到台账。
// 占用中的机位同时挂着完成航班与活动航班时，以台账里的活动航班为准改绑（先到先得），
// 不允许把另一个在保航班的机位误释放。
function reconcileStands(rows: Record<string, EntryRow[]>, report: ReconcileReport): void {
  const flights = sortByScheduledArrival(rows.flight ?? [])
  const activeFlights = flights.filter(isActiveFlight)
  const finishedFlights = flights.filter(isFinishedFlight)
  for (const stand of rows.stand ?? []) {
    const activeMatches = activeFlights.filter((flight) => standMatchesFlight(stand, flight))
    const finishedMatches = finishedFlights.filter((flight) => standMatchesFlight(stand, flight))
    const standNo = String(stand['机位编号'] ?? stand.id)
    if (activeMatches.length > 0) {
      const winner = activeMatches[0]
      const currentFlight = String(stand['当前航班'] ?? '').trim()
      const expected = String(winner['航班号'] || winner['保障编号'] || '').trim()
      if (String(stand.status) === STAND_OCCUPIED_STATUS && expected && currentFlight !== expected) {
        stand['当前航班'] = expected
        report.reboundStandNos.push(standNo)
      }
      continue
    }
    if (finishedMatches.length === 0) {
      continue
    }
    if (String(stand.status) === STAND_OCCUPIED_STATUS) {
      releaseStand(stand)
      report.releasedStandNos.push(standNo)
    } else if (String(stand.status) === STAND_FREE_STATUS && String(stand['当前航班'] ?? '').trim() !== '') {
      // 已空闲但还挂着旧航班标识：清掉，保证机位页读到的当前航班来自台账。
      stand['当前航班'] = ''
    }
  }
}

// 存量数据一次性收口：去重 → 待处理重算 → 机位/班组占用对齐台账。
// 纯函数，输入输出都是整库数据，动作事务与启动迁移共用同一套规则。
export function reconcileAll(input: Record<string, EntryRow[]>): {
  rows: Record<string, EntryRow[]>
  report: ReconcileReport
} {
  const rows = cloneRows(input)
  const report: ReconcileReport = {
    version: 2,
    dedupedRows: 0,
    pendingFixedRows: 0,
    releasedStandNos: [],
    releasedTeamNos: [],
    reboundStandNos: [],
  }
  for (const meta of MODULES) {
    const moduleRows = rows[meta.key] ?? []
    const deduped = dedupeModule(meta.key, moduleRows, report)
    for (const row of deduped) {
      const expectedPending = isPendingRow(meta.key, row)
      if (Boolean(row.pending) !== expectedPending) {
        report.pendingFixedRows += 1
      }
      row.pending = expectedPending
    }
    rows[meta.key] = deduped
  }
  reconcileStands(rows, report)
  rebuildTeamOccupancy(rows, report.releasedTeamNos)
  return { rows, report }
}

// 「确认完成」的一次完整入账：台账状态、机位占用、班组占用、待处理汇总
// 在同一快照上一次写齐，要么全成，要么整体退回（调用方据此放弃落盘）。
export function applyFlightCompletion(
  input: Record<string, EntryRow[]>,
  flightId: number,
): CompletionOutcome {
  const rows = cloneRows(input)
  const flights = rows.flight ?? []
  const index = flights.findIndex((row) => Number(row.id) === flightId)
  if (index < 0) {
    return { ok: false, code: 'NOT_FOUND', message: `没有找到编号为 ${flightId} 的航班保障任务` }
  }
  const flight = flights[index]
  const status = flightStatus(flight)
  if (status === '已终止') {
    return {
      ok: false,
      code: 'TERMINATED',
      message: '任务已终止，终态不可回退，不能再确认完成',
    }
  }
  // 幂等：同一航班重复点确认完成，只认第一次账，不再重复释放、不重复减待处理。
  if (status === '保障完成') {
    return { ok: true, idempotent: true, releasedStandNos: [], releasedTeamNos: [], rows }
  }

  const stands = rows.stand ?? []
  const otherActive = flights.filter(
    (other) => Number(other.id) !== Number(flight.id) && isActiveFlight(other),
  )
  // 释放前冲突预检：本航班挂名的占用机位若同时被另一个在保航班占着，
  // 释放会误放别人的机位——直接判定释放失败，整笔退回，不落任何账。
  for (const stand of stands) {
    if (String(stand.status) !== STAND_OCCUPIED_STATUS) {
      continue
    }
    if (!standMatchesFlight(stand, flight)) {
      continue
    }
    const stolen = otherActive.some((other) => standMatchesFlight(stand, other))
    if (stolen) {
      return {
        ok: false,
        code: 'OCCUPANCY_CONFLICT',
        standNo: String(stand['机位编号'] ?? stand.id),
        message: `机位 ${String(stand['机位编号'] ?? stand.id)} 仍被其他在保航班占用，释放失败，任务退回保障中`,
      }
    }
  }

  // 1) 台账先入账（同一快照内，后续任一步失败整体丢弃此快照）。
  flight.status = '保障完成'
  flight.pending = false

  // 2) 机位占用释放并回写占用待办。
  const releasedStandNos: string[] = []
  for (const stand of stands) {
    if (String(stand.status) === STAND_OCCUPIED_STATUS && standMatchesFlight(stand, flight)) {
      releasedStandNos.push(String(stand['机位编号'] ?? stand.id))
      releaseStand(stand)
    }
  }

  // 3) 班组占用按台账剩余在保航班重放改绑。
  const beforeTeamOccupancy = new Map<string, string>()
  for (const team of rows.team ?? []) {
    beforeTeamOccupancy.set(
      String(team['班组编号'] ?? team.id),
      String(team[TEAM_OCCUPIED_FLIGHTS_FIELD] ?? ''),
    )
  }
  rebuildTeamOccupancy(rows)
  const releasedTeamNos: string[] = []
  for (const team of rows.team ?? []) {
    const code = String(team['班组编号'] ?? team.id)
    const after = String(team[TEAM_OCCUPIED_FLIGHTS_FIELD] ?? '')
    const before = beforeTeamOccupancy.get(code) ?? ''
    if (before && !after) {
      releasedTeamNos.push(code)
    }
  }

  return { ok: true, idempotent: false, releasedStandNos, releasedTeamNos, rows }
}
