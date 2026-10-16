/**
 * `text` on one line, every character outside printable ASCII escaped (`\n`, `\t`, `\r`, `\xHH`,
 * `\u{H}`), and `\` doubled so an escape cannot be forged. Bidi controls and zero-width characters
 * are outside printable ASCII too, so a branch name cannot reorder or hide part of a line. Pure,
 * so the editor uses it too, to show a GitHub-sourced name as exactly what it is.
 */
export function escapeForLog(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\') out += '\\\\'
    else if (code >= 0x20 && code <= 0x7e) out += char
    else if (char === '\n') out += '\\n'
    else if (char === '\t') out += '\\t'
    else if (char === '\r') out += '\\r'
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += `\\u{${code.toString(16)}}`
  }
  return out
}
