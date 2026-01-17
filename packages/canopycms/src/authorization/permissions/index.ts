/**
 * Permissions module exports
 */

export { PermissionsFileSchema, createDefaultPermissionsFile, type PermissionsFile } from './schema'
export {
  loadPermissionsFile,
  loadPathPermissions,
  savePathPermissions,
  ensurePermissionsFile,
} from './loader'
