/**
 * The loader's success path, against real sharp. The failure path (a module
 * that cannot load) lives in transform.sharp-unavailable.test.ts, which has to
 * mock 'sharp' for the whole file.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { loadSharp } from './sharp-loader'

describe('loadSharp', () => {
  it("resolves to sharp's callable constructor, not the module namespace", async () => {
    const loaded = await loadSharp()

    expect(loaded).toBe(sharp)
    const meta = await loaded({
      create: { width: 2, height: 3, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()
      .then((buf) => loaded(buf).metadata())
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 2, height: 3 })
  })

  it('loads once: repeated calls share one promise', () => {
    expect(loadSharp()).toBe(loadSharp())
  })
})
