'use client'

import React from 'react'

import { Card, SimpleGrid, Skeleton, Stack } from '@mantine/core'

import { CARD_THUMBNAIL_HEIGHT, GRID_COLUMNS, type MediaDensity } from './media-library-view'

const SKELETON_COUNT = 8

/** Placeholder shaped like the layout it stands in for, so nothing shifts when assets arrive. */
export const MediaLibrarySkeleton: React.FC<{ density: MediaDensity }> = ({ density }) => {
  const items = Array.from({ length: SKELETON_COUNT }, (_, index) => index)

  if (density === 'list') {
    return (
      <Stack gap={4} data-testid="media-library-loading" aria-busy="true">
        {items.map((index) => (
          <Skeleton key={index} height={54} radius="md" />
        ))}
      </Stack>
    )
  }

  const thumbnailHeight = CARD_THUMBNAIL_HEIGHT[density]
  return (
    <SimpleGrid
      cols={GRID_COLUMNS[density]}
      spacing="sm"
      data-testid="media-library-loading"
      aria-busy="true"
    >
      {items.map((index) => (
        <Card key={index} withBorder radius="md" padding="xs">
          <Card.Section>
            <Skeleton height={thumbnailHeight} radius={0} />
          </Card.Section>
          <Skeleton height={12} width="70%" mt={8} />
          {density === 'grid' && <Skeleton height={10} width="40%" mt={6} />}
        </Card>
      ))}
    </SimpleGrid>
  )
}
