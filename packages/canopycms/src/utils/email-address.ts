const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Whether `text`, trimmed, reads as one whole email address: no spaces, one `@`, a dot in the
 * domain. Letters of any script pass (`rené@example.fr`), as sign-in providers hold such
 * addresses. The finder, the access change and create bodies, and the editor's picker share this
 * one test, so an address the finder answers is one an add accepts.
 */
export const isEmailAddress = (text: string): boolean => EMAIL_ADDRESS.test(text.trim())
