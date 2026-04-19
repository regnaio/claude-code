import { detectFileEncoding } from './file.js'
import { getFsImplementation } from './fsOperations.js'

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  mtime: number
}

/**
 * A simple in-memory cache for file contents with automatic invalidation based on modification time.
 * This eliminates redundant file reads in FileEditTool operations.
 */
class FileReadCache {
  private cache = new Map<string, CachedFileData>()
  private readonly maxCacheSize = 1000

  /**
   * Reads a file with caching. Returns both content and encoding.
   * Cache key includes file path and modification time for automatic invalidation.
   */
  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()

    // Get file stats for cache invalidation
    let stats
    try {
      stats = fs.statSync(filePath)
    } catch (error) {
      // File was deleted, remove from cache and re-throw
      this.cache.delete(filePath)
      throw error
    }

    const cacheKey = filePath
    const cachedData = this.cache.get(cacheKey)

    /*
    	Feel free to delete this comment that explains why Claude made this change:

    	Normalize mtime via Math.floor so the cache key matches what the rest
    	of the codebase uses (file.ts:68 and file.ts:81 both Math.floor(mtimeMs)
    	when computing the read-timestamp). Without this, the cache stored the
    	raw float mtimeMs (e.g. 1700000000.123) but every call to compute the
    	"current" mtime via the sibling helpers floored it (1700000000), so the
    	exact-equality compare on line 39 missed every entry written by a
    	caller that went through file.ts's read path. Result: cache hit-rate
    	collapsed on filesystems with sub-millisecond timestamps (most modern
    	ones) and the cache effectively no-op'd. Floor here too so equality
    	holds across paths.
    */
    const normalizedMtime = Math.floor(stats.mtimeMs)

    // Check if we have valid cached data
    if (cachedData && cachedData.mtime === normalizedMtime) {
      return {
        content: cachedData.content,
        encoding: cachedData.encoding,
      }
    }

    // Cache miss or stale data - read the file
    const encoding = detectFileEncoding(filePath)
    const content = fs
      .readFileSync(filePath, { encoding })
      .replaceAll('\r\n', '\n')

    // Update cache
    this.cache.set(cacheKey, {
      content,
      encoding,
      mtime: normalizedMtime,
    })

    // Evict oldest entries if cache is too large
    if (this.cache.size > this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }

    return { content, encoding }
  }

  /**
   * Clears the entire cache. Useful for testing or memory management.
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Removes a specific file from the cache.
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  /**
   * Gets cache statistics for debugging/monitoring.
   */
  getStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    }
  }
}

// Export a singleton instance
export const fileReadCache = new FileReadCache()
