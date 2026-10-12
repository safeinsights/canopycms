import { describe, expect, it } from 'vitest'
import { ApiTimeoutError } from '../api/request-deadline'
import { gatewayPage as pageFromInFront } from './hooks/__test__/test-utils'
import { isGatewayFailure, isUnanswered, UnansweredError } from './unanswered'

describe('unanswered writes', () => {
  it("counts a gateway's 5xx page, and only that, as a gateway failure", async () => {
    expect(isGatewayFailure(await pageFromInFront(504))).toBe(true)
    expect(isGatewayFailure(await pageFromInFront(502))).toBe(true)
    expect(isGatewayFailure(await pageFromInFront(403))).toBe(false)
    expect(isGatewayFailure({ ok: false, status: 503, error: 'Busy, retry' })).toBe(false)
  })

  it('counts a timeout or a gateway failure as unanswered, and nothing else', () => {
    expect(isUnanswered(new ApiTimeoutError('PUT', '/x', 75_000))).toBe(true)
    expect(isUnanswered(new UnansweredError())).toBe(true)
    expect(isUnanswered(new TypeError('Failed to fetch'))).toBe(false)
    expect(isUnanswered(new Error('Forbidden'))).toBe(false)
  })
})
