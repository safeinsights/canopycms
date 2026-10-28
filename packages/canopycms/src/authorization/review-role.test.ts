import { describe, expect, it } from 'vitest'
import { RESERVED_GROUPS } from './helpers'
import { isReviewerOfOthersReview, reviewRoleOf, type ReviewedBranch } from './review-role'

const branch = (overrides: Partial<ReviewedBranch> = {}): ReviewedBranch => ({
  status: 'submitted',
  createdBy: 'maker',
  users: ['maker'],
  ...overrides,
})
const reviewer = { userId: 'rita', groups: [RESERVED_GROUPS.REVIEWERS] }

describe('reviewRoleOf', () => {
  it.each(['submitted', 'approved'])('is reviewing for a reviewer of a %s branch', (status) => {
    expect(reviewRoleOf(branch({ status }), reviewer)).toBe('reviewing')
  })

  it('is reviewing-closed when only the pull request is closed', () => {
    expect(reviewRoleOf(branch({ pullRequestState: 'closed' }), reviewer)).toBe('reviewing-closed')
  })

  it.each<[string, ReviewedBranch, { userId: string; groups?: string[] } | undefined]>([
    ['no user', branch(), undefined],
    ['an editor', branch(), { userId: 'pat', groups: [] }],
    ['the creator', branch({ createdBy: 'rita' }), reviewer],
    ['someone on the access list', branch({ users: ['maker', 'rita'] }), reviewer],
    ['a member of an access-list group', branch({ groups: [RESERVED_GROUPS.REVIEWERS] }), reviewer],
    ['the protected base branch', branch({ isProtected: true }), reviewer],
    ['a branch still being edited', branch({ status: 'editing' }), reviewer],
    [
      'a closed pull request on a branch the reviewer made',
      branch({ createdBy: 'rita', pullRequestState: 'closed' }),
      reviewer,
    ],
    [
      'a closed pull request on the protected base branch',
      branch({ isProtected: true, pullRequestState: 'closed' }),
      reviewer,
    ],
  ])('is none for %s', (_who, b, user) => {
    expect(reviewRoleOf(b, user)).toBe('none')
  })

  it('leaves isReviewerOfOthersReview true only for reviewing', () => {
    expect(isReviewerOfOthersReview(branch(), reviewer)).toBe(true)
    expect(isReviewerOfOthersReview(branch({ pullRequestState: 'closed' }), reviewer)).toBe(false)
  })
})
