import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FieldConfig } from '../../config'
import type { PreviewMarks } from '../PreviewFrame'
import { findInexactMarks, type InexactMark } from '../preview-marks'

const NO_MARKS: InexactMark[] = []

/**
 * What the framed page reports of its marks while highlighting is on, kept for the `src` that
 * said so: whether it marks nothing, and which marks name no field of the entry. Each such mark
 * is a console warning once per page, since the toggle's note only counts them. Marks are
 * checked against the draft as it was when they were reported, which is what the page rendered,
 * not the draft since: a block whose template just changed would otherwise flag its old marks.
 */
export function usePreviewMarks({
  src,
  highlightEnabled,
  fields,
  data,
}: {
  src: string | undefined
  highlightEnabled: boolean
  fields: readonly FieldConfig[]
  data: unknown
}) {
  const [marks, setMarks] = useState<(PreviewMarks & { src: string; data: unknown }) | null>(null)
  const current = highlightEnabled && marks !== null && marks.src === src ? marks : null
  const latestData = useRef(data)
  useEffect(() => {
    latestData.current = data
  })

  const inexactMarks = useMemo(
    () => (current?.paths ? findInexactMarks(fields, current.data, current.paths) : NO_MARKS),
    [current?.paths, current?.data, fields],
  )

  const warned = useRef(new Set<string>())
  useEffect(() => {
    for (const { path, nearest } of inexactMarks) {
      const key = JSON.stringify([src, path])
      if (warned.current.has(key)) continue
      warned.current.add(key)
      console.warn(
        `[canopycms] The preview marks "${path}", which names no field of this entry` +
          (nearest ? `; its nearest field is "${nearest}".` : '.'),
      )
    }
  }, [inexactMarks, src])

  const onMarks = useCallback(
    (reported: PreviewMarks) => setMarks({ ...reported, src: src ?? '', data: latestData.current }),
    [src],
  )
  const clearMarks = useCallback(() => setMarks(null), [])

  return { onMarks, clearMarks, marksNothing: current?.count === 0, inexactMarks }
}
