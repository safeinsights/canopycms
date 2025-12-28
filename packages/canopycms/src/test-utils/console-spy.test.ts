import { describe, it, expect } from 'vitest'
import { mockConsole } from './console-spy.js'

describe('mockConsole', () => {
  it('captures console.warn', () => {
    const consoleSpy = mockConsole()
    console.warn('test warning message')
    console.error('test error message')
    console.log('All captured:', JSON.stringify(consoleSpy.all()))
    expect(consoleSpy).toHaveWarned('test warning')
    expect(consoleSpy).toHaveErrored('test error')
    consoleSpy.restore()
  })
})
