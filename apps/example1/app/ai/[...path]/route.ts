import { createAIContentHandler } from 'canopycms/ai'
import config from '../../../canopycms.config'
import { entrySchemaRegistry } from '../../schemas'
import { aiContentConfig } from '../config'

export const GET = createAIContentHandler({
  config: config.server,
  entrySchemaRegistry,
  aiConfig: aiContentConfig,
})
