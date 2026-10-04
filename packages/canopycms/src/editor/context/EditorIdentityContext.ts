'use client'

import { createContext, useContext } from 'react'
import type { UserContext } from '../BranchManager'

/**
 * The identity `EditorAuthGate` resolved for the editor below it. Present only inside the gate;
 * `useUserContext` reads it so the editor shares the gate's one `whoami` instead of issuing its
 * own.
 */
export interface EditorIdentity {
  /** The server-accepted identity; the gate mounts the editor only once it has one. */
  user: UserContext
}

export const EditorIdentityContext = createContext<EditorIdentity | null>(null)

/** The gate's resolved identity, or null outside an `EditorAuthGate`. */
export function useEditorIdentity(): EditorIdentity | null {
  return useContext(EditorIdentityContext)
}
