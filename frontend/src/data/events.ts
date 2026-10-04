// 本地数据层的变更总线：任何写入口落账后都在这里喊一声，
// 各页面订阅自己关心的模块键，跨页派生数据（机位、班组、概览）才能跟着联动。
export type DataChangeListener = (keys: string[]) => void

// '*' 表示任意模块的变更（运营概览订阅全部）。
export const ALL_KEYS = '*'

const listeners = new Set<DataChangeListener>()

export function emitDataChange(keys: string[]): void {
  if (keys.length === 0) {
    return
  }
  listeners.forEach((listener) => listener(keys))
}

export function subscribeDataChange(listener: DataChangeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
