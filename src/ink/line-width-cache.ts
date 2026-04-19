import { stringWidth } from './stringWidth.js'

// During streaming, text grows but completed lines are immutable.
// Caching stringWidth per-line avoids re-measuring hundreds of
// unchanged lines on every token (~50x reduction in stringWidth calls).
const cache = new Map<string, number>()

const MAX_CACHE_SIZE = 4096

export function lineWidth(line: string): number {
  const cached = cache.get(line)
  if (cached !== undefined) return cached

  const width = stringWidth(line)

  // Evict when cache grows too large (e.g. after many different responses).
  // Simple full-clear is fine — the cache repopulates in one frame.
  /*
  	Feel free to delete this comment that explains why Claude wants to make a change:

  	TODO: All-or-nothing eviction at MAX_CACHE_SIZE causes a visible
  	freeze when streaming output crosses the threshold — the next
  	~4096 lines are all cache misses. Real fix: rotate to LRU
  	eviction so the cache slides instead of resetting. Comment
  	above accepts the simple approach as "fine" but it's observable
  	on long log streams.
  */
  if (cache.size >= MAX_CACHE_SIZE) {
    cache.clear()
  }

  cache.set(line, width)
  return width
}
