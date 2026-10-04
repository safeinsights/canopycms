import { useState, useMemo, useEffect, useCallback } from 'react'
import type {
  TreeNode,
  ContentNode,
  PathPermission,
  PermissionLevel,
  PermissionTarget,
} from '../types'
import type { EditorCollection } from '../../Editor'
import { buildTree, annotateTreeWithPermissions, findTreeNode } from '../utils'
import { parsePermissionPath } from '../../../authorization/validation'

export interface UsePermissionTreeOptions {
  collections?: EditorCollection[]
  contentRoot?: string
  permissions: PathPermission[]
  contentTree?: ContentNode
}

export interface UsePermissionTreeResult {
  annotatedTree: TreeNode
  expandedNodes: Set<string>
  selectedNode: string | null
  /** Local permission state (may differ from saved) */
  localPermissions: PathPermission[]
  isDirty: boolean
  toggleNode: (path: string) => void
  expandAll: () => void
  collapseAll: () => void
  selectNode: (path: string | null) => void
  updateNodePermission: (
    nodePath: string,
    level: PermissionLevel,
    updates: Partial<PermissionTarget>,
  ) => void
  resetPermissions: () => void
  setIsDirty: (dirty: boolean) => void
  /** Set local permissions directly (for after save) */
  setLocalPermissions: React.Dispatch<React.SetStateAction<PathPermission[]>>
}

export function usePermissionTree({
  collections,
  contentRoot = 'content',
  permissions,
  contentTree,
}: UsePermissionTreeOptions): UsePermissionTreeResult {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set([contentRoot]))
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [localPermissions, setLocalPermissions] = useState<PathPermission[]>(permissions)
  const [isDirty, setIsDirty] = useState(false)

  const tree = useMemo(
    () => buildTree(contentTree, contentRoot, collections),
    [collections, contentTree, contentRoot],
  )

  const annotatedTree = useMemo(
    () => annotateTreeWithPermissions(tree, localPermissions),
    [tree, localPermissions],
  )

  useEffect(() => {
    setLocalPermissions(permissions)
    setIsDirty(false)
  }, [permissions])

  const toggleNode = useCallback((path: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    const allPaths = new Set<string>()
    const collectPaths = (node: TreeNode) => {
      if (node.type === 'folder') {
        allPaths.add(node.path)
      }
      node.children.forEach(collectPaths)
    }
    collectPaths(annotatedTree)
    setExpandedNodes(allPaths)
  }, [annotatedTree])

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set())
  }, [])

  const selectNode = useCallback((path: string | null) => {
    setSelectedNode(path)
  }, [])

  const updateNodePermission = useCallback(
    (nodePath: string, level: PermissionLevel, updates: Partial<PermissionTarget>) => {
      setLocalPermissions((prev) => {
        const newPermissions = [...prev]

        // Find the tree node to determine correct path pattern
        const treeNode = findTreeNode(annotatedTree, nodePath)
        const rawPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
        const parsed = parsePermissionPath(rawPath)
        if (!parsed.ok) {
          console.warn(`Invalid permission path skipped: ${rawPath} — ${parsed.error}`)
          return prev
        }
        const permissionPath = parsed.path

        const existingIndex = newPermissions.findIndex((p) => p.path === permissionPath)

        if (existingIndex >= 0) {
          const existing = newPermissions[existingIndex]
          const updatedLevel: PermissionTarget = {
            ...existing[level],
            ...updates,
          }

          if (updatedLevel.allowedUsers?.length === 0) delete updatedLevel.allowedUsers
          if (updatedLevel.allowedGroups?.length === 0) delete updatedLevel.allowedGroups

          if (!updatedLevel.allowedUsers && !updatedLevel.allowedGroups) {
            newPermissions[existingIndex] = { ...existing, [level]: undefined }
          } else {
            newPermissions[existingIndex] = {
              ...existing,
              [level]: updatedLevel,
            }
          }

          const perm = newPermissions[existingIndex]
          if (!perm.read && !perm.edit && !perm.review) {
            newPermissions.splice(existingIndex, 1)
          }
        } else {
          if (updates.allowedUsers?.length || updates.allowedGroups?.length) {
            newPermissions.push({
              path: permissionPath,
              [level]: updates,
            })
          }
        }

        return newPermissions
      })
      setIsDirty(true)
    },
    [annotatedTree],
  )

  const resetPermissions = useCallback(() => {
    setLocalPermissions(permissions)
    setIsDirty(false)
    setSelectedNode(null)
  }, [permissions])

  return {
    annotatedTree,
    expandedNodes,
    selectedNode,
    localPermissions,
    isDirty,
    toggleNode,
    expandAll,
    collapseAll,
    selectNode,
    updateNodePermission,
    resetPermissions,
    setIsDirty,
    setLocalPermissions,
  }
}
