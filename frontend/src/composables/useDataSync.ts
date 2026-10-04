import { onMounted, onUnmounted } from 'vue'

import { ALL_KEYS, subscribeDataChange } from '@/data/events'

/**
 * 页面订阅本地数据层的变更：别的入口（如航班保障页确认完成联动改了机位、班组）
 * 落账后，当前打开的页面立刻按新数据重渲染，不再等手工刷新、也不再显示旧值。
 *
 * watchKeys 传本页面涉及的模块键；运营概览这类汇总页传 ALL_KEYS。
 */
export function useDataSync(reload: () => void, watchKeys: string[] = [ALL_KEYS]): void {
  let unsubscribe: (() => void) | null = null
  onMounted(() => {
    const keys = new Set(watchKeys)
    unsubscribe = subscribeDataChange((changedKeys) => {
      if (keys.has(ALL_KEYS) || changedKeys.some((key) => keys.has(key))) {
        reload()
      }
    })
  })
  onUnmounted(() => {
    unsubscribe?.()
  })
}
