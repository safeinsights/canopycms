import { canopyLog } from './logger'

const defaultSink = (line: string): void => canopyLog(line)
let sink = defaultSink

/**
 * Replace where access-change lines go; no argument restores `canopyLog`. The test setup silences
 * them, as it does provisioning lines. A leaf module, so the setup file loads nothing a test mocks.
 * @internal Exported for tests.
 */
export function setBranchAccessLogSink(next?: (line: string) => void): void {
  sink = next ?? defaultSink
}

/** One line per change to a branch's access list, printed unconditionally (api/branch-access.ts). */
export function logBranchAccessChange(entry: Record<string, unknown>): void {
  sink(JSON.stringify({ event: 'branch-access', ...entry }))
}
