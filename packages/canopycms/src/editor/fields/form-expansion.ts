import { createContext } from 'react'

/**
 * A form-wide "Expand all" or "Collapse all". `seq` grows with each press, so pressing the same
 * one twice still counts; a list applies only presses made while it is mounted.
 */
export interface FormExpansionCommand {
  seq: number
  expanded: boolean
}

export const FormExpansionContext = createContext<FormExpansionCommand | undefined>(undefined)
