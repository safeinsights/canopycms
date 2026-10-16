import { randomBytes } from 'node:crypto'

import { canopyLog } from './logger'

const defaultSink = (line: string): void => canopyLog(line)
let sink = defaultSink

/**
 * Replace where step lines go; no argument restores `canopyLog`. The test
 * setup silences them, since nearly every suite provisions a workspace.
 * @internal Exported for tests.
 */
export function setProvisionLogSink(next?: (line: string) => void): void {
  sink = next ?? defaultSink
}

/**
 * Per-step timing for one workspace provisioning, printed unconditionally
 * (never behind `CANOPYCMS_DEBUG`). A request killed mid-step, such as a Lambda
 * at its timeout, never reaches its own error handling, so each step prints a
 * `start` line and a `done` line: the last line in the log names the step that
 * was running.
 *
 * Lines read `[canopy] provision id=<id> dir=<dir> step=<step> start|done ms=<n>|failed ms=<n>`,
 * then one `outcome=<outcome> total=<ms> <step>=<ms> …` summary.
 */
export class ProvisionLog {
  readonly id = randomBytes(3).toString('hex')
  private readonly startedAt = Date.now()
  private readonly durations: string[] = []
  private readonly prefix: string

  constructor(dir: string) {
    this.prefix = `[canopy] provision id=${this.id} dir=${dir}`
  }

  async step<T>(name: string, run: () => Promise<T>): Promise<T> {
    sink(`${this.prefix} step=${name} start`)
    const stepStartedAt = Date.now()
    let state = 'failed'
    try {
      const result = await run()
      state = 'done'
      return result
    } finally {
      const ms = Date.now() - stepStartedAt
      this.durations.push(`${name}=${ms}`)
      sink(`${this.prefix} step=${name} ${state} ms=${ms}`)
    }
  }

  finish(outcome: string): void {
    const total = Date.now() - this.startedAt
    sink(`${this.prefix} outcome=${outcome} total=${total} ${this.durations.join(' ')}`.trim())
  }
}
