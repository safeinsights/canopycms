'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { AssetRecord } from '../../api'
import { getErrorMessage } from '../../utils/error'
import { useApiClient } from '../context'

const PAGE_SIZE = 40

interface AssetLibraryError {
  message: string
  /** True when page 1 failed: nothing is loaded, and retrying starts over. */
  firstPage: boolean
}

export interface UseAssetLibraryResult {
  assets: AssetRecord[]
  /** Page 1 is in; the library is renderable even while later pages load. */
  firstPageLoaded: boolean
  /** Every page is in. */
  complete: boolean
  error: AssetLibraryError | null
  /** Resumes from the page that failed; starts over when page 1 failed or the listing moved. */
  retry: () => void
  /** Puts an uploaded asset in the list; the one already loaded under its hash is replaced. */
  prepend: (asset: AssetRecord) => void
  /** Drops a deleted asset, including from a page still on its way. */
  remove: (hash32: string) => void
}

/** Appends the incoming assets not already present; the first copy of a hash wins. */
function mergeAssets(
  existing: readonly AssetRecord[],
  incoming: readonly AssetRecord[],
  removed: ReadonlySet<string>,
): AssetRecord[] {
  const seen = new Set(existing.map((asset) => asset.hash32))
  const added: AssetRecord[] = []
  for (const asset of incoming) {
    if (seen.has(asset.hash32) || removed.has(asset.hash32)) continue
    seen.add(asset.hash32)
    added.push(asset)
  }
  return added.length === 0 ? [...existing] : [...existing, ...added]
}

/**
 * Loads the whole library in the background while `opened`: page 1 first, then each following
 * page in turn, so search and sort see every asset. Closing (or unmounting) stops the walk, and
 * reopening starts again from page 1.
 *
 * Finalize dedups content, so a re-uploaded file comes back as an existing record that may also
 * arrive in a later page; assets are merged by `hash32`.
 */
export function useAssetLibrary(opened: boolean): UseAssetLibraryResult {
  const client = useApiClient()
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [firstPageLoaded, setFirstPageLoaded] = useState(false)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState<AssetLibraryError | null>(null)

  // A response whose runId is no longer current belongs to a closed opening or a superseded
  // walk, and is dropped.
  const generation = useRef(0)
  // Cursors already requested; a server that returns one twice would otherwise loop forever.
  const requested = useRef(new Set<string>())
  const removed = useRef(new Set<string>())
  const failedCursor = useRef<string | undefined>(undefined)
  // Set when the listing moved mid-walk: Retry walks again from page 1, keeping what is shown.
  const restartFromTop = useRef(false)

  const walk = useCallback(
    async (startCursor: string | undefined, runId: number) => {
      let cursor = startCursor
      for (;;) {
        if (cursor !== undefined) requested.current.add(cursor)
        let page: { assets: AssetRecord[]; nextCursor?: string } | undefined
        let message = ''
        try {
          const result = await client.assets.list(
            cursor === undefined
              ? { limit: String(PAGE_SIZE) }
              : { cursor, limit: String(PAGE_SIZE) },
          )
          if (result.ok && result.data) page = result.data
          else message = result.error || 'The server did not return the list.'
        } catch (err) {
          message = getErrorMessage(err)
        }
        if (runId !== generation.current) return

        if (!page) {
          failedCursor.current = cursor
          if (cursor !== undefined) requested.current.delete(cursor)
          setError({ message, firstPage: cursor === undefined })
          return
        }

        const incoming = page.assets
        setAssets((prev) => mergeAssets(prev, incoming, removed.current))
        if (cursor === undefined) setFirstPageLoaded(true)

        const next = page.nextCursor
        if (!next) {
          setComplete(true)
          return
        }
        // A cursor seen before means the listing moved under the walk (the local store restarts
        // from page 1 when its anchor asset is deleted), so pages may be missing: never report
        // that as complete. Retry starts over.
        if (requested.current.has(next)) {
          failedCursor.current = undefined
          restartFromTop.current = true
          setError({ message: 'The library changed while it was loading.', firstPage: false })
          return
        }
        cursor = next
      }
    },
    [client],
  )

  const start = useCallback(() => {
    generation.current += 1
    requested.current = new Set()
    removed.current = new Set()
    failedCursor.current = undefined
    restartFromTop.current = false
    setAssets([])
    setFirstPageLoaded(false)
    setComplete(false)
    setError(null)
    void walk(undefined, generation.current)
  }, [walk])

  useEffect(() => {
    if (!opened) return
    start()
    return () => {
      generation.current += 1
    }
    // Restart only when the drawer/modal (re)opens, not when `start`'s identity changes.
  }, [opened])

  const retry = useCallback(() => {
    const cursor = failedCursor.current
    if (cursor === undefined && !restartFromTop.current) {
      start()
      return
    }
    if (restartFromTop.current) {
      restartFromTop.current = false
      requested.current = new Set()
    }
    generation.current += 1
    setError(null)
    void walk(cursor, generation.current)
  }, [start, walk])

  const prepend = useCallback((asset: AssetRecord) => {
    removed.current.delete(asset.hash32)
    setAssets((prev) => [asset, ...prev.filter((existing) => existing.hash32 !== asset.hash32)])
  }, [])

  const remove = useCallback((hash32: string) => {
    removed.current.add(hash32)
    setAssets((prev) => prev.filter((existing) => existing.hash32 !== hash32))
  }, [])

  return { assets, firstPageLoaded, complete, error, retry, prepend, remove }
}
