import React from 'react'

import { Button } from '@mantine/core'

import type { ItemExpansion } from './item-expansion'

/** One button for a collapsible list: "Collapse all" once every row is open, else "Expand all". */
export const ExpandAllButton: React.FC<{ expansion: ItemExpansion }> = ({ expansion }) => (
  <Button
    variant="subtle"
    color="gray"
    c="dimmed"
    size="compact-xs"
    onClick={() => expansion.setAll(!expansion.allExpanded)}
    data-testid="list-expand-all"
  >
    {expansion.allExpanded ? 'Collapse all' : 'Expand all'}
  </Button>
)
