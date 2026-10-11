'use client'

import { useState } from 'react'

import type { AssetRecord } from '../../api'
import { sortAssets, type MediaSort } from './media-library-view'

interface OrderState {
  key: string
  order: string[]
}

/**
 * The assets in display order, which holds still while pages arrive: each new page is sorted and
 * appended after what is already shown, and the whole list is re-sorted only when `sort` changes
 * or loading completes. The list API pages in storage order (hash order on S3), so a live re-sort
 * would move cards under the pointer and a picker click could choose the wrong asset.
 *
 * `pinned` hashes (this opening's uploads, newest first) lead the list whatever the sort.
 */
export function useStableAssetOrder(
  assets: readonly AssetRecord[],
  sort: MediaSort,
  complete: boolean,
  pinned: readonly string[],
): AssetRecord[] {
  const key = `${sort}|${complete}`
  const [state, setState] = useState<OrderState>(() => ({
    key,
    order: sortAssets(assets, sort).map((asset) => asset.hash32),
  }))

  let order = state.order
  if (state.key !== key) {
    order = sortAssets(assets, sort).map((asset) => asset.hash32)
  } else {
    const known = new Set(order)
    const fresh = assets.filter((asset) => !known.has(asset.hash32))
    if (fresh.length > 0) order = [...order, ...sortAssets(fresh, sort).map((a) => a.hash32)]
  }
  // Adjusting state during render rather than in an effect avoids a frame in the old order:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  if (order !== state.order) setState({ key, order })

  const byHash = new Map(assets.map((asset) => [asset.hash32, asset]))
  const pinnedSet = new Set(pinned)
  const lead = pinned.flatMap((hash) => byHash.get(hash) ?? [])
  const rest = order.flatMap((hash) => (pinnedSet.has(hash) ? [] : (byHash.get(hash) ?? [])))
  return [...lead, ...rest]
}
