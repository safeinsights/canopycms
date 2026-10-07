/**
 * A release job bundles its own tool from `canopycms/server`, so everything it needs to build a
 * store, materialize and gate on the report must be exported there.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  AssetRefsError,
  collectAssetRefs,
  createAssetStore,
  InvalidOutputPrefixError,
  MATERIALIZE_REPORT_SCHEMA_VERSION,
  materializeAssets,
  readAssetRefsFile,
  SharpUnavailableError,
  type AssetRefsFile,
  type AssetStore,
  type CreateOnlyResult,
  type MaterializeOptions,
  type MaterializeReport,
  type MaterializeResult,
  type MaterializeTarget,
} from './server'

describe('canopycms/server release-tooling exports', () => {
  it('exports the materialize and refs entry points', () => {
    expect(materializeAssets).toBeTypeOf('function')
    expect(collectAssetRefs).toBeTypeOf('function')
    expect(readAssetRefsFile).toBeTypeOf('function')
    expect(createAssetStore).toBeTypeOf('function')
    expect(new SharpUnavailableError(new Error('x'))).toBeInstanceOf(Error)
    expect(new AssetRefsError([])).toBeInstanceOf(Error)
    expect(new InvalidOutputPrefixError('assets/', 'x')).toBeInstanceOf(Error)
    expect(MATERIALIZE_REPORT_SCHEMA_VERSION).toBe(1)
  })

  it('types a report a release tool can gate on', () => {
    expectTypeOf<MaterializeReport['schemaVersion']>().toEqualTypeOf<1>()
    expectTypeOf<MaterializeReport['summary']['copied']>().toBeNumber()
    expectTypeOf<MaterializeResult['status']>().toEqualTypeOf<
      'existed' | 'created' | 'copied' | 'failed'
    >()
    expectTypeOf<MaterializeOptions['targets']>().toEqualTypeOf<readonly MaterializeTarget[]>()
    expectTypeOf<MaterializeOptions['outputPrefix']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<MaterializeReport['outputPrefix']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<AssetRefsFile['transforms'][number]>().toMatchTypeOf<MaterializeTarget>()
    expectTypeOf<MaterializeOptions['store']>().toEqualTypeOf<AssetStore>()
    expectTypeOf<ReturnType<typeof createAssetStore>>().toEqualTypeOf<AssetStore | undefined>()
    expectTypeOf<CreateOnlyResult>().toEqualTypeOf<'created' | 'already-exists'>()
  })
})
