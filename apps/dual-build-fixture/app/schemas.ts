import { defineEntrySchema } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

// Deliberately one field, one entry type -- this fixture exists to catch
// build-shape regressions (withCanopy pageExtensions, deployedAs), not to
// exercise the schema system.
export const homeSchema = defineEntrySchema([
  { name: 'message', type: 'string', label: 'Message', isTitle: true },
] as const)

export const entrySchemaRegistry = createEntrySchemaRegistry({ homeSchema })
