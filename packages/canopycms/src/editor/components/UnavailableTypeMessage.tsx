'use client'

import { Code } from '@mantine/core'

import { unavailableTypeMessageParts } from '../unavailable-entry-type'

export interface UnavailableTypeMessageProps {
  /** Registry keys the unavailable entry types name. */
  schemaRefs: readonly string[]
}

/** The shared "this editor version doesn't know this content type" text, refs in a code style. */
export function UnavailableTypeMessage({ schemaRefs }: UnavailableTypeMessageProps) {
  const { before, after } = unavailableTypeMessageParts(schemaRefs)
  return (
    <>
      {before}
      {schemaRefs.map((ref, i) => (
        <span key={ref}>
          {i > 0 && ', '}
          <Code>{ref}</Code>
        </span>
      ))}
      {after}
    </>
  )
}
