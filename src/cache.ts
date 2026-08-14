/** 小型 TTL 缓存（Map 插入序淘汰最旧条目）。 */

interface CacheEntry {
  value: string
  expiresAt: number
}

export interface TtlCache {
  get(key: string): string | undefined
  set(key: string, value: string): void
  get size(): number
}

export function createTtlCache(maxEntries: number, ttlMs: number): TtlCache {
  const entries = new Map<string, CacheEntry>()
  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key)
        return undefined
      }
      // LRU 化：命中后移到末尾，淘汰时先淘汰最久未用。
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      if (entries.has(key)) entries.delete(key)
      entries.set(key, { value, expiresAt: ttlMs <= 0 ? Number.POSITIVE_INFINITY : Date.now() + ttlMs })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    get size() {
      return entries.size
    },
  }
}
