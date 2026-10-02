// @vitest-environment jsdom
import React, { StrictMode, useLayoutEffect, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

vi.mock('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: vi.fn() }),
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: false,
    getToken: vi.fn(),
    signOut: vi.fn(),
  }),
  SignIn: () => null,
  UserButton: () => null,
}))

import { ClerkSignIn, useClerkAuthConfig, useSkipClerkSetActiveAction } from './client'

const INTERNAL = '__internal_onBeforeSetActive'
const UNSTABLE = '__unstable__onBeforeSetActive'
const slots = window as unknown as Record<string, unknown>

const neverSettles = (): Promise<void> => new Promise<void>(() => undefined)

type Hook = () => Promise<unknown>
const isHook = (value: unknown): value is Hook => typeof value === 'function'

/** What `@clerk/nextjs` does: assigns its hook in a layout effect, which runs after its children's. */
function FakeProvider({ slot = INTERNAL, children }: { slot?: string; children?: ReactNode }) {
  useLayoutEffect(() => {
    slots[slot] = neverSettles
  }, [slot])
  return <>{children}</>
}

function Holder() {
  useSkipClerkSetActiveAction()
  return null
}

function ConfigUser() {
  useClerkAuthConfig()
  return null
}

function Holders({ layout, page }: { layout: boolean; page: boolean }) {
  return (
    <>
      {layout && <Holder />}
      {page && <Holder />}
    </>
  )
}

/** True when calling the slot's hook resolves; a hung hook loses the race to the sentinel timer. */
async function settles(slot: string): Promise<boolean> {
  await act(async () => {})
  const hook = slots[slot]
  if (!isHook(hook)) throw new Error(`${slot} is not a function`)
  const winner = await Promise.race([
    hook().then(() => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ])
  return winner === 'settled'
}

afterEach(() => {
  cleanup()
  delete slots[INTERNAL]
  delete slots[UNSTABLE]
})

describe('useSkipClerkSetActiveAction', () => {
  it.each([INTERNAL, UNSTABLE])('makes %s resolve at once under a provider', async (slot) => {
    render(
      <FakeProvider slot={slot}>
        <Holder />
      </FakeProvider>,
    )

    expect(await settles(slot)).toBe(true)
  })

  it("hangs without the hook, so the other assertions can't pass vacuously", async () => {
    render(<FakeProvider />)

    expect(await settles(INTERNAL)).toBe(false)
  })

  it("restores the provider's hook on unmount", async () => {
    const { unmount } = render(
      <FakeProvider>
        <Holder />
      </FakeProvider>,
    )
    await act(async () => {})
    expect(slots[INTERNAL]).not.toBe(neverSettles)

    unmount()

    expect(slots[INTERNAL]).toBe(neverSettles)
  })

  it('stays neutralized until the last of several holders unmounts, in either order', async () => {
    const tree = (layout: boolean, page: boolean) => (
      <FakeProvider>
        <Holders layout={layout} page={page} />
      </FakeProvider>
    )

    // An adopter's layout-level holder mounts first, the editor page's later.
    const first = render(tree(true, false))
    first.rerender(tree(true, true))
    first.rerender(tree(true, false))
    expect(await settles(INTERNAL)).toBe(true)
    first.rerender(tree(false, false))
    expect(slots[INTERNAL]).toBe(neverSettles)
    first.unmount()

    const second = render(tree(true, false))
    second.rerender(tree(true, true))
    second.rerender(tree(false, true))
    expect(await settles(INTERNAL)).toBe(true)
    second.rerender(tree(false, false))
    expect(slots[INTERNAL]).toBe(neverSettles)
  })

  it('still takes over when an earlier holder mounted before the provider installed its hook', async () => {
    const tree = (withProvider: boolean) => (
      <>
        <Holder />
        {withProvider && (
          <FakeProvider>
            <Holder />
          </FakeProvider>
        )}
      </>
    )
    const { rerender, unmount } = render(tree(false))
    await act(async () => {})
    rerender(tree(true))

    expect(await settles(INTERNAL)).toBe(true)
    unmount()
    expect(slots[INTERNAL]).toBe(neverSettles)
  })

  it('does not clobber a hook installed while held, when it releases', async () => {
    const newer = (): Promise<void> => new Promise<void>(() => undefined)
    const { unmount } = render(
      <FakeProvider>
        <Holder />
      </FakeProvider>,
    )
    await act(async () => {})

    slots[INTERNAL] = newer
    unmount()

    expect(slots[INTERNAL]).toBe(newer)
  })

  it('ends neutralized, and restored after unmount, under StrictMode', async () => {
    const { unmount } = render(
      <StrictMode>
        <FakeProvider>
          <Holder />
        </FakeProvider>
      </StrictMode>,
    )

    expect(await settles(INTERNAL)).toBe(true)
    unmount()
    expect(slots[INTERNAL]).toBe(neverSettles)
  })

  it('leaves both slots alone when no provider installed a hook', async () => {
    const { unmount } = render(<Holder />)
    await act(async () => {})
    expect(slots[INTERNAL]).toBeUndefined()
    expect(slots[UNSTABLE]).toBeUndefined()

    unmount()

    expect(slots[INTERNAL]).toBeUndefined()
    expect(slots[UNSTABLE]).toBeUndefined()
  })

  it('is applied by useClerkAuthConfig()', async () => {
    render(
      <FakeProvider>
        <ConfigUser />
      </FakeProvider>,
    )

    expect(await settles(INTERNAL)).toBe(true)
  })

  it('is applied by <ClerkSignIn>', async () => {
    render(
      <FakeProvider>
        <ClerkSignIn onSignedIn={vi.fn()} sessionRejected={false} />
      </FakeProvider>,
    )

    expect(await settles(INTERNAL)).toBe(true)
  })
})
