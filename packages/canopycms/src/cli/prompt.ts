/** Stdin prompts for the CLI commands; `stdinEnded` says why they share one module. */

import { createInterface } from 'node:readline'

/**
 * Whether stdin has already delivered end-of-input to an earlier prompt.
 * `process.stdin` can only end ONCE, and a `readline` interface created after
 * it has ended never emits `'line'` or `'close'`, so a per-prompt interface
 * is a footgun once a command has two prompts — even when the first WAS
 * answered, since readline flushes a pending partial line as a final `'line'`
 * event before `'close'`, so "text then EOF" answers normally while the
 * stream also ends in that same moment. The flag records whether the STREAM
 * ended, not whether THIS prompt got an answer.
 * `readableEnded` is checked unconditionally in the `'close'` handler
 * below, before the `answered` branch: gating it on `!answered` would miss
 * the case above and leave the next prompt's readline on an already-ended
 * stream that never emits, so node would exit 0 silently with no cleanup. Our
 * OWN `rl.close()` also fires `'close'` but leaves `readableEnded` false,
 * keeping the two cases apart. Every prompt below consults this first; no
 * other readline interface on `process.stdin` may exist anywhere in the CLI.
 */
let stdinEnded = false

function readLineOnce(prompt: string): Promise<string | null> {
  if (stdinEnded) {
    // Already at EOF: answer immediately rather than waiting for input that can
    // never arrive.
    console.log(prompt)
    return Promise.resolve(null)
  }
  const rl = createInterface({ input: process.stdin, terminal: false })
  return new Promise((resolve) => {
    console.log(prompt)
    let answered = false
    rl.once('line', (line) => {
      answered = true
      rl.close()
      resolve(line)
    })
    rl.once('close', () => {
      // Checked FIRST and unconditionally (see `stdinEnded` above): `'close'`
      // fires both for our own `rl.close()` and for the stream actually
      // ending, and by the time it fires here the input has already finished
      // emitting `'end'`, so `readableEnded` is reliable to read now.
      if (process.stdin.readableEnded) {
        stdinEnded = true
      }
      if (answered) return
      stdinEnded = true
      resolve(null)
    })
  })
}

/** Wait for the operator to continue. Returns at once if stdin has ended. */
export async function pressEnter(prompt: string): Promise<void> {
  await readLineOnce(prompt)
}

/** Read one line from the operator. `null` when stdin ended instead. */
export async function askLine(prompt: string): Promise<string | null> {
  const line = await readLineOnce(prompt)
  return line === null ? null : line.trim()
}

/** Reset between tests. Not used by the command itself. */
export function resetStdinStateForTesting(): void {
  stdinEnded = false
}
