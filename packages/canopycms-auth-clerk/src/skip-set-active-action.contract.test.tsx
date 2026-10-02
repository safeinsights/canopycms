// @vitest-environment jsdom
import React, { type ComponentType, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

// The subject is Clerk's real app-router provider, loaded from its own dist (inlined, see
// vitest.config.ts). Only its collaborators are replaced, by absolute path because
// `canopycms-auth-clerk` depends on none of them directly.
const target = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module')
  const { dirname, join } = await import('node:path')
  const { existsSync, readFileSync } = await import('node:fs')

  const packageDir = (from: string, name: string): string => {
    const isPackage = (dir: string): boolean => {
      const file = join(dir, 'package.json')
      return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name
    }
    let dir = dirname(createRequire(from).resolve(name))
    while (!isPackage(dir)) {
      if (dirname(dir) === dir) throw new Error(`no ${name} package above its entry`)
      dir = dirname(dir)
    }
    return dir
  }

  const clerkDir = packageDir(import.meta.url, '@clerk/nextjs')
  const fromClerk = createRequire(join(clerkDir, 'package.json'))
  const reactDir = packageDir(join(clerkDir, 'package.json'), '@clerk/react')
  const reactPkg: { exports: Record<string, { import: { default: string } }> } = JSON.parse(
    readFileSync(join(reactDir, 'package.json'), 'utf8'),
  )

  // What `invalidateCacheAction` does behind CloudFront OAC: rejects. The provider does
  // `void action().then(...)`, so the derived promise is observed here to keep it from being
  // reported as an unhandled rejection of the run.
  const invalidateCacheAction = vi.fn((): Promise<void> => {
    const rejected = Promise.reject<void>(new Error('403'))
    const then = rejected.then.bind(rejected)
    rejected.then = ((...args: Parameters<Promise<void>['then']>) => {
      const derived = then(...args)
      derived.catch(() => undefined)
      return derived
    }) as Promise<void>['then']
    return rejected
  })

  return {
    invalidateCacheAction,
    provider: join(clerkDir, 'dist/esm/app-router/client/ClerkProvider.js'),
    actions: join(clerkDir, 'dist/esm/app-router/server-actions.js'),
    telemetry: join(clerkDir, 'dist/esm/utils/router-telemetry.js'),
    navigation: fromClerk.resolve('next/navigation'),
    reactInternal: join(reactDir, reactPkg.exports['./internal'].import.default),
  }
})

vi.mock(target.navigation, () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))
vi.mock(target.actions, () => ({ invalidateCacheAction: target.invalidateCacheAction }))
vi.mock(target.reactInternal, () => ({
  InternalClerkProvider: ({ children }: { children?: ReactNode }) => children,
}))
vi.mock(target.telemetry, () => ({ RouterTelemetry: () => null }))

import { useSkipClerkSetActiveAction } from './skip-set-active-action'

interface ProviderProps {
  publishableKey: string
  __internal_scriptsSlot: ReactNode
  children?: ReactNode
}
const loaded: unknown = await import(/* @vite-ignore */ target.provider)
const ClientClerkProvider: ComponentType<ProviderProps> = (() => {
  if (
    typeof loaded !== 'object' ||
    loaded === null ||
    !('ClientClerkProvider' in loaded) ||
    typeof loaded.ClientClerkProvider !== 'function'
  ) {
    throw new Error('@clerk/nextjs no longer exports ClientClerkProvider from its app-router dir')
  }
  return loaded.ClientClerkProvider as ComponentType<ProviderProps>
})()

const INTERNAL = '__internal_onBeforeSetActive'
const slots = window as unknown as Record<string, unknown>

type Hook = (intent?: string) => Promise<unknown>
const isHook = (value: unknown): value is Hook => typeof value === 'function'

function Holder() {
  useSkipClerkSetActiveAction()
  return null
}

function mount(children?: ReactNode) {
  return render(
    <ClientClerkProvider
      publishableKey="pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"
      __internal_scriptsSlot={<></>}
    >
      {children}
    </ClientClerkProvider>,
  )
}

/** The hook Clerk's `setActive` awaits before activating a session. */
async function beforeSetActive(): Promise<Hook> {
  await act(async () => {})
  const hook = slots[INTERNAL]
  if (!isHook(hook)) throw new Error(`${INTERNAL} is not a function`)
  return hook
}

/** True when the promise resolves; a hung one loses the race to the sentinel timer. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  const winner = await Promise.race([
    promise.then(() => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ])
  return winner === 'settled'
}

afterEach(() => {
  cleanup()
  delete slots[INTERNAL]
  delete slots.__internal_onAfterSetActive
  target.invalidateCacheAction.mockClear()
})

describe("useSkipClerkSetActiveAction against Clerk's real provider", () => {
  it('Clerk hangs on a rejected Server Action: the failure this hook exists for', async () => {
    mount(<span />)

    const hook = await beforeSetActive()
    expect(target.invalidateCacheAction).not.toHaveBeenCalled()
    expect(await settles(hook(undefined))).toBe(false)
    expect(target.invalidateCacheAction).toHaveBeenCalledTimes(1)
  })

  it('resolves without running the Server Action, and gives Clerk its hook back on unmount', async () => {
    const { unmount } = mount(<Holder />)

    const hook = await beforeSetActive()
    expect(await settles(hook(undefined))).toBe(true)
    expect(target.invalidateCacheAction).not.toHaveBeenCalled()

    unmount()
    const restored = await beforeSetActive()
    expect(restored).not.toBe(hook)
    void restored(undefined)
    expect(target.invalidateCacheAction).toHaveBeenCalledTimes(1)
  })
})
