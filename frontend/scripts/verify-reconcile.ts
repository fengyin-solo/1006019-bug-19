/**
 * 数据层联动验收（不经过浏览器）：
 *   node --experimental-loader ./scripts/ts-loader.mjs ./scripts/verify-reconcile.ts
 *
 * 覆盖：存量回填（按计划到达）、确认完成三表收口、幂等不重复扣减、
 * 已终止守卫、释放失败整体回滚、对牌校验、重复记录去重、待处理绝不为负。
 */
import { strict as assert } from 'node:assert'

// ---- 假 localStorage / window，必须在 import 数据层之前装好 ----
const mem = new Map<string, string>()
const storage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
}
;(globalThis as any).window = { localStorage: storage }

// 动态导入，确保上面的 shim 先于数据层模块初始化执行。
const { listRows, reconcileTables, saveTables } = await import('@/data/local-store')
const { runAction, loadOverview } = await import('@/api/local-service')
import type { EntryRow } from '@/data/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

function row(key: string, id: number): EntryRow {
  const found = listRows(key).find((x) => Number(x.id) === id)
  assert.ok(found, key + '#' + id + ' 应存在')
  return found as EntryRow
}
function pending(key: string): number {
  return listRows(key).filter((r) => r.pending).length
}

// ---------- 1. 存量回填：seed 里 FLIG-1003/1006 状态完成但占用漏挂 ----------
check('存量回填：FLIG-1003（高等级）机位被补放、当前航班清空', () => {
  const stand = listRows('stand').find((s) => s['机位编号'] === 'STAN-103')!
  assert.equal(stand.status, '空闲')
  assert.equal(stand['当前航班'], '')
})
check('存量回填：FLIG-1006（计划到达最早）同样补放', () => {
  const stand = listRows('stand').find((s) => s['机位编号'] === 'STAN-201')!
  assert.equal(stand.status, '空闲')
})
check('存量回填：已完成航班对应班组占用待办释放（乙班一组/丙班一组 pending=false）', () => {
  const yi = listRows('team').find((t) => t['班组名称'] === '乙班一组')!
  const bing = listRows('team').find((t) => t['班组名称'] === '丙班一组')!
  assert.equal(yi.pending, false)
  assert.equal(bing.pending, false)
})
check('存量回填：保障中的航班占用原样保留（STAN-101/102 仍占用中）', () => {
  assert.equal(row('stand', 1).status, '占用中')
  assert.equal(row('stand', 2).status, '占用中')
})
check('存量回填：已终止 FLIG-1005 不被释放逻辑碰、不回到保障完成', () => {
  assert.equal(row('flight', 5).status, '已终止')
  assert.equal(row('stand', 5).status, '空闲')
})
check('待处理口径：保障完成与已终止都不计入，所有模块 pending 非负', () => {
  const ov = loadOverview()
  for (const m of ov.modules) assert.ok(m.pending >= 0, m.name + ' pending 不能为负')
  assert.equal(pending('flight'), 3) // 1001/1002 保障中 + 1004 待接收
})

// ---------- 2. 确认完成：一次写入收口三表 ----------
const beforeFlight = pending('flight')
check('确认完成 FLIG-1001：flight→保障完成、STAN-101 释放、甲班一组待办清掉', () => {
  const res = runAction('flight', 1, '确认完成')
  assert.equal(res.ok, true, res.message)
  assert.equal(row('flight', 1).status, '保障完成')
  assert.equal(row('flight', 1).pending, false)
  const stand = listRows('stand').find((s) => s['机位编号'] === 'STAN-101')!
  assert.equal(stand.status, '空闲')
  assert.equal(stand['当前航班'], '')
  // 甲班一组名下已无保障中航班（1001 完成、1005 终止），班组待办应清掉
  const team = listRows('team').find((t) => t['班组名称'] === '甲班一组')!
  assert.equal(team.pending, false)
})
check('待处理同步减一且不变负', () => {
  assert.equal(pending('flight'), beforeFlight - 1)
  assert.ok(pending('stand') >= 0)
  const ov = loadOverview()
  const card = ov.cards.find((c) => c.label === '待处理')!
  assert.ok(card.value >= 0)
})

// ---------- 3. 幂等：同一航班重复点只落一次账 ----------
check('重复确认完成：幂等成功，机位不重复释放、待处理不再减少', () => {
  const flightPending = pending('flight')
  const standOccupied = listRows('stand').filter((s) => s.status === '占用中').length
  const res = runAction('flight', 1, '确认完成')
  assert.equal(res.ok, true)
  assert.equal(pending('flight'), flightPending)
  assert.equal(listRows('stand').filter((s) => s.status === '占用中').length, standOccupied)
})

// ---------- 4. 已终止不能回到保障完成 ----------
check('已终止任务执行任何动作都被拒，状态不动', () => {
  for (const a of ['接收任务', '开始保障', '确认完成']) {
    const res = runAction('flight', 5, a)
    assert.equal(res.ok, false, a + ' 应被拒')
  }
  assert.equal(row('flight', 5).status, '已终止')
})

// ---------- 5. 释放失败回滚：对牌不一致时整体退回 ----------
check('机位当前航班是另一套时：确认失败、flight 保持保障中、机位不被错放', () => {
  const stands = listRows('stand').map((s) => ({ ...s }))
  const idx = stands.findIndex((s) => s['机位编号'] === 'STAN-102')
  stands[idx]['当前航班'] = 'CA9999'
  saveTables({ stand: stands }) // 绕过联动直接写脏数据

  const res = runAction('flight', 2, '确认完成')
  assert.equal(res.ok, false)
  assert.match(res.message, /不一致|保持/)
  assert.equal(row('flight', 2).status, '保障中')
  assert.equal(row('flight', 2).pending, true)
  const stand = listRows('stand').find((s) => s['机位编号'] === 'STAN-102')!
  assert.equal(stand.status, '占用中') // 没被错放
  assert.equal(stand['当前航班'], 'CA9999')
})

// ---------- 6. 机位未登记也回滚 ----------
check('机位未登记：确认失败并保持保障中，不产生「假完成」', () => {
  const flights = listRows('flight').map((f) => ({ ...f }))
  const fi = flights.findIndex((f) => Number(f.id) === 2)
  flights[fi]['机位号'] = 'STAN-404'
  saveTables({ flight: flights })
  const res = runAction('flight', 2, '确认完成')
  assert.equal(res.ok, false)
  assert.equal(row('flight', 2).status, '保障中')
  // 恢复机位号，供后续用例使用
  const fixedFlights = listRows('flight').map((f) => ({ ...f }))
  fixedFlights[fi]['机位号'] = 'STAN-102'
  saveTables({ flight: fixedFlights })
})

// ---------- 6b. 机位已在别处释放、当前航班残留：完成时清残留 ----------
check('机位空闲但残留本航班号：确认完成成功且残留当前航班被清空', () => {
  // 造一个保障中航班 + 空闲但残留其航班号的机位
  const flights = listRows('flight').map((f) => ({ ...f }))
  const fi = flights.findIndex((f) => Number(f.id) === 4) // FLIG-1004 待接收
  flights[fi].status = '保障中'
  flights[fi]['保障状态'] = '保障中'
  const stands = listRows('stand').map((s) => ({ ...s }))
  const si = stands.findIndex((s) => s['机位编号'] === 'STAN-104')
  stands[si].status = '空闲'
  stands[si]['当前航班'] = 'HU7804'
  saveTables({ flight: flights, stand: stands })

  const res = runAction('flight', 4, '确认完成')
  assert.equal(res.ok, true, res.message)
  const stand = listRows('stand').find((s) => s['机位编号'] === 'STAN-104')!
  assert.equal(stand.status, '空闲')
  assert.equal(stand['当前航班'], '')
})

// ---------- 7. 回填原语：重复记录去重 + 按计划到达顺序 + 不错放 ----------
check('存量对账：同编号重复记录只保留一份，且不错放对不上牌的机位', () => {
  const dirty: Record<string, EntryRow[]> = {
    flight: [
      {
        id: 1, status: '保障完成', pending: true, abnormal: false,
        保障编号: 'FLIG-2001', 航班号: 'CA0001', 机型: 'A320',
        计划到达: '2026-10-02 10:00', 机位号: 'STAN-301', 保障等级: '高',
        保障班组: '甲班一组', 保障状态: '保障完成',
      },
      // 同编号重复落账的脏记录
      {
        id: 2, status: '保障完成', pending: true, abnormal: false,
        保障编号: 'FLIG-2001', 航班号: 'CA0001', 机型: 'A320',
        计划到达: '2026-10-02 10:00', 机位号: 'STAN-301', 保障等级: '高',
        保障班组: '甲班一组', 保障状态: '保障完成',
      },
      {
        id: 3, status: '保障完成', pending: true, abnormal: false,
        保障编号: 'FLIG-2002', 航班号: 'CA0002', 机型: 'A320',
        计划到达: '2026-10-01 08:00', 机位号: 'STAN-302', 保障等级: '普通',
        保障班组: '甲班二组', 保障状态: '保障完成',
      },
    ],
    stand: [
      { id: 1, status: '占用中', pending: true, abnormal: false,
        机位编号: 'STAN-301', 当前航班: 'CA0001' } as EntryRow,
      // 302 上挂的是别的航班 → 宽松回填必须跳过，不许错放
      { id: 2, status: '占用中', pending: true, abnormal: false,
        机位编号: 'STAN-302', 当前航班: 'MU7777' } as EntryRow,
    ],
    team: [
      { id: 1, status: '在岗', pending: true, abnormal: false, 班组名称: '甲班一组' } as EntryRow,
      { id: 2, status: '在岗', pending: true, abnormal: false, 班组名称: '甲班二组' } as EntryRow,
    ],
  }
  const fixed = reconcileTables(dirty)
  assert.equal(fixed.flight.length, 2)
  // 去重后重排 id，消除重复 :key
  assert.deepEqual(fixed.flight.map((f) => Number(f.id)), [1, 2])
  // 重复的 FLIG-2001 只剩一份
  assert.equal(fixed.flight.filter((f) => f['保障编号'] === 'FLIG-2001').length, 1)
  const s301 = fixed.stand.find((s) => s['机位编号'] === 'STAN-301')!
  assert.equal(s301.status, '空闲')
  assert.equal(s301['当前航班'], '')
  const s302 = fixed.stand.find((s) => s['机位编号'] === 'STAN-302')!
  assert.equal(s302.status, '占用中') // 对不上牌，原样保留
  assert.equal(s302['当前航班'], 'MU7777')
  // pending 重算，所有值都是布尔
  for (const t of Object.values(fixed).flat()) {
    assert.equal(typeof t.pending, 'boolean')
  }
})

console.log('\n全部 ' + passed + ' 项验收通过 ✅')
