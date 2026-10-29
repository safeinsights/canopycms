import { describe, expect, it } from 'vitest'
import { MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT } from './editor-routing'
// Test-only import across the package boundary, as in cms-deploy.test.ts: the constructs
// cannot import `canopycms`, but this suite can, so the two halves of one rule are a red
// test on drift. The module is dependency-free.
import {
  GATEWAY_MARGIN_MS,
  GATEWAY_MAX_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from '../../../canopycms/src/api/request-deadline'

describe('the editor client deadline vs the CloudFront origin read timeout cap', () => {
  it("the client's gateway limit is the longest origin read timeout the constructs accept", () => {
    expect(GATEWAY_MAX_TIMEOUT_MS).toBe(MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds() * 1000)
  })

  it('the standard deadline sits a margin above that limit, and long above standard', () => {
    expect(REQUEST_TIMEOUT_MS.standard).toBe(GATEWAY_MAX_TIMEOUT_MS + GATEWAY_MARGIN_MS)
    expect(REQUEST_TIMEOUT_MS.standard).toBeGreaterThan(
      MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds() * 1000,
    )
    expect(REQUEST_TIMEOUT_MS.long).toBeGreaterThan(REQUEST_TIMEOUT_MS.standard)
  })
})
