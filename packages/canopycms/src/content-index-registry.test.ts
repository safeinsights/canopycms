import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  registerContentIndexForInvalidation,
  invalidateContentIndexesForRoot,
} from './content-index-registry'

// Registry state is module-global (a plain `Map`), so every test below uses a unique
// fake absolute root (no filesystem access involved — `path.resolve()` just normalizes
// the string) to stay isolated from every other test.
function makeTarget() {
  return { invalidateIndex: vi.fn() }
}

describe('content-index-registry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('invalidateContentIndexesForRoot', () => {
    it('invalidates a target registered at the exact root', () => {
      const root = '/registry-test/exact-root'
      const target = makeTarget()
      registerContentIndexForInvalidation(root, target)

      invalidateContentIndexesForRoot(root)

      expect(target.invalidateIndex).toHaveBeenCalledTimes(1)
    })

    it('invalidates a store registered under a subdirectory of an ancestor root', () => {
      const ancestor = '/registry-test/subdir-ancestor'
      const nested = '/registry-test/subdir-ancestor/b/clone'
      const target = makeTarget()
      registerContentIndexForInvalidation(nested, target)

      invalidateContentIndexesForRoot(ancestor)

      expect(target.invalidateIndex).toHaveBeenCalledTimes(1)
    })

    it('does not invalidate a store whose root only shares a string prefix, not a path boundary', () => {
      // Locks in the `path.sep` boundary check: "repo-other" must not be treated as a
      // descendant of "repo" just because it starts with the same characters.
      const target = makeTarget()
      registerContentIndexForInvalidation('/registry-test/repo-other', target)

      invalidateContentIndexesForRoot('/registry-test/repo')

      expect(target.invalidateIndex).not.toHaveBeenCalled()
    })

    it('invalidates every store registered under the same root', () => {
      const root = '/registry-test/multi-store'
      const targetA = makeTarget()
      const targetB = makeTarget()
      registerContentIndexForInvalidation(root, targetA)
      registerContentIndexForInvalidation(root, targetB)

      invalidateContentIndexesForRoot(root)

      expect(targetA.invalidateIndex).toHaveBeenCalledTimes(1)
      expect(targetB.invalidateIndex).toHaveBeenCalledTimes(1)
    })

    it('leaves a store under an unrelated root untouched', () => {
      const target = makeTarget()
      registerContentIndexForInvalidation('/registry-test/unrelated-a', target)

      invalidateContentIndexesForRoot('/registry-test/unrelated-b')

      expect(target.invalidateIndex).not.toHaveBeenCalled()
    })
  })

  describe('dead WeakRef pruning (deterministic, no GC required)', () => {
    // registerContentIndexForInvalidation calls `new WeakRef(target)` via a bare
    // reference to the global `WeakRef`, resolved at call time rather than captured at
    // module load. That means stubbing the global *before* calling
    // registerContentIndexForInvalidation is enough to control what refs report on
    // `.deref()` for the already-loaded module under test — no module reimport needed
    // here (contrast with the FinalizationRegistry test below, which does need one).
    class FakeWeakRef<T extends object> {
      static deadTargets = new Set<object>()
      static refsByTarget = new Map<object, FakeWeakRef<object>>()

      derefCallCount = 0

      constructor(private readonly target: T) {
        FakeWeakRef.refsByTarget.set(target, this as unknown as FakeWeakRef<object>)
      }

      deref(): T | undefined {
        this.derefCallCount++
        return FakeWeakRef.deadTargets.has(this.target) ? undefined : this.target
      }
    }

    afterEach(() => {
      FakeWeakRef.deadTargets.clear()
      FakeWeakRef.refsByTarget.clear()
    })

    it('skips a dead ref, still invalidates a live sibling, and never derefs the pruned ref again', () => {
      vi.stubGlobal('WeakRef', FakeWeakRef)

      const root = '/registry-test/dead-ref'
      const deadTarget = makeTarget()
      const liveTarget = makeTarget()
      registerContentIndexForInvalidation(root, deadTarget)
      registerContentIndexForInvalidation(root, liveTarget)

      // Flip the flag: this target's WeakRef now reports as garbage-collected.
      FakeWeakRef.deadTargets.add(deadTarget)

      invalidateContentIndexesForRoot(root)

      expect(deadTarget.invalidateIndex).not.toHaveBeenCalled()
      expect(liveTarget.invalidateIndex).toHaveBeenCalledTimes(1)

      const deadRef = FakeWeakRef.refsByTarget.get(deadTarget)
      expect(deadRef?.derefCallCount).toBe(1)

      // A second invalidation must not deref the already-pruned ref again -- proving it
      // was removed from the registry's Set (not merely skipped-and-left-in-place).
      invalidateContentIndexesForRoot(root)

      expect(deadRef?.derefCallCount).toBe(1)
      expect(liveTarget.invalidateIndex).toHaveBeenCalledTimes(2)
    })
  })

  describe('FinalizationRegistry-driven pruning (simulated GC)', () => {
    // The production module captures the *global* FinalizationRegistry constructor at
    // module-load time (`const finalization = new FinalizationRegistry(cb)`), unlike
    // WeakRef above which is looked up fresh on every call. To control what the
    // finalizer callback does -- normally fired by the engine's GC on its own schedule,
    // which we cannot trigger deterministically in a test -- we stub the global with a
    // fake constructor *and* force the module to be freshly re-evaluated via
    // vi.resetModules() + a dynamic import, so the fresh module instance wires up our
    // fake instead of the real FinalizationRegistry. The fake's `register()` records the
    // heldValue (the real `{ rootKey, ref }` the production code passes) so the test can
    // invoke the exact same callback/heldValue pair the engine would, simulating "the GC
    // decided to collect this target" without any actual garbage collection.
    it('drops a ref from the registry when the finalizer callback fires', async () => {
      type HeldValue = { rootKey: string; ref: WeakRef<{ invalidateIndex(): void }> }
      let capturedCallback: ((heldValue: HeldValue) => void) | undefined
      let capturedHeldValue: HeldValue | undefined

      class FakeFinalizationRegistry<T> {
        constructor(cb: (heldValue: T) => void) {
          capturedCallback = cb as unknown as (heldValue: HeldValue) => void
        }
        register(_target: object, heldValue: T): void {
          capturedHeldValue = heldValue as unknown as HeldValue
        }
        unregister(): boolean {
          return true
        }
      }

      vi.stubGlobal('FinalizationRegistry', FakeFinalizationRegistry)
      vi.resetModules()

      try {
        const fresh = await import('./content-index-registry')
        const root = '/registry-test/finalization-registry'
        const target = makeTarget()
        fresh.registerContentIndexForInvalidation(root, target)

        expect(capturedCallback).toBeDefined()
        expect(capturedHeldValue).toBeDefined()

        // Simulate the engine deciding to collect `target`: fire the finalizer by hand.
        capturedCallback?.(capturedHeldValue as HeldValue)

        // The ref should now be pruned from the registry's Set for this root, so
        // invalidating the root must not reach the (simulated-collected) target.
        fresh.invalidateContentIndexesForRoot(root)
        expect(target.invalidateIndex).not.toHaveBeenCalled()
      } finally {
        vi.resetModules()
      }
    })
  })
})
