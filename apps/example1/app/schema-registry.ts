import { postSchema, authorSchema, docSchema, homeSchema } from './schemas'

export const schemaRegistry = {
  postSchema,
  authorSchema,
  docSchema,
  homeSchema,
} as const

export type SchemaRegistryKey = keyof typeof schemaRegistry
