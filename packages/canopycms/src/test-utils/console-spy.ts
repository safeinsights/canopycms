import { vi, expect } from 'vitest'

type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug'

interface CapturedMessages {
  log: string[]
  warn: string[]
  error: string[]
  info: string[]
  debug: string[]
}

export interface MockConsole {
  /** Restore all original console methods */
  restore: () => void
  /** Get all captured messages by method */
  all: () => CapturedMessages
}

/**
 * Mocks all console methods, capturing messages for assertion.
 * All console output is swallowed (not printed to terminal).
 * Use the custom matchers to assert on captured messages.
 *
 * @example
 * ```ts
 * const consoleSpy = mockConsole()
 * doSomething()
 * expect(consoleSpy).toHaveWarned('deprecated')
 * expect(consoleSpy).toHaveErrored(/token not found/)
 * consoleSpy.restore()
 * ```
 */
export function mockConsole(): MockConsole {
  const captured: CapturedMessages = {
    log: [],
    warn: [],
    error: [],
    info: [],
    debug: [],
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spies: any[] = []

  const methods: ConsoleMethod[] = ['log', 'warn', 'error', 'info', 'debug']

  for (const method of methods) {
    const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const message = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')
      captured[method].push(message)
      // Swallow all output - don't print anything
    })
    spies.push(spy)
  }

  return {
    restore: () => spies.forEach((spy) => spy.mockRestore()),
    all: () => ({ ...captured }),
  }
}

// Custom matchers for cleaner assertions
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<T> {
    toHaveLogged(expected: string | RegExp): void
    toHaveWarned(expected: string | RegExp): void
    toHaveErrored(expected: string | RegExp): void
  }
  interface AsymmetricMatchersContaining {
    toHaveLogged(expected: string | RegExp): void
    toHaveWarned(expected: string | RegExp): void
    toHaveErrored(expected: string | RegExp): void
  }
}

function matchesPattern(messages: string[], pattern: string | RegExp): boolean {
  return messages.some((msg) =>
    typeof pattern === 'string' ? msg.includes(pattern) : pattern.test(msg),
  )
}

function formatMessages(label: string, messages: string[]): string {
  if (messages.length === 0) return ''
  return `${label}:\n${messages.map((m) => `  - "${m}"`).join('\n')}`
}

export const consoleMatchers = {
  toHaveLogged(received: MockConsole, expected: string | RegExp) {
    const all = received.all()
    const pass = matchesPattern(all.log, expected)
    return {
      pass,
      message: () =>
        pass
          ? `Expected console.log NOT to have logged matching ${expected}`
          : `Expected console.log to have logged matching ${expected}\n\n${formatMessages('Received', all.log) || '  (no messages)'}`,
    }
  },
  toHaveWarned(received: MockConsole, expected: string | RegExp) {
    const all = received.all()
    const pass = matchesPattern(all.warn, expected)
    return {
      pass,
      message: () =>
        pass
          ? `Expected console.warn NOT to have warned matching ${expected}`
          : `Expected console.warn to have warned matching ${expected}\n\n${formatMessages('Received', all.warn) || '  (no messages)'}`,
    }
  },
  toHaveErrored(received: MockConsole, expected: string | RegExp) {
    const all = received.all()
    const pass = matchesPattern(all.error, expected)
    return {
      pass,
      message: () =>
        pass
          ? `Expected console.error NOT to have errored matching ${expected}`
          : `Expected console.error to have errored matching ${expected}\n\n${formatMessages('Received', all.error) || '  (no messages)'}`,
    }
  },
}

// Auto-register matchers when this module is imported
expect.extend(consoleMatchers)
