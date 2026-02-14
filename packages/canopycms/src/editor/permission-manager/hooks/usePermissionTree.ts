/**
 * Hook for managing permission tree state and operations
 */

import { useState, useMemo, useEffect, useCallback } from 'react'
import type { RootCollectionConfig } from '../../../config'
import type { TreeNode, ContentNode, PathPermission, PermissionLevel, PermissionTarget } from '../types'
import type { EditorCollection } from '../../Editor'
import { buildTree, annotateTreeWithPermissions, findTreeNode } from '../utils'

export interface UsePermissionTreeOptions {
  schema?: RootCollectionConfig
  collections?: EditorCollection[]
  contentRoot?: string
  permissions: PathPermission[]
  contentTree?: ContentNode
}

export interface UsePermissionTreeResult {
  /** The annotated tree with permissions */
  annotatedTree: TreeNode
  /** Expanded node paths */
  expandedNodes: Set<string>
  /** Currently selected node path */
  selectedNode: string | null
  /** Local permission state (may differ from saved) */
  localPermissions: PathPermission[]
  /** Whether there are unsaved changes */
  isDirty: boolean
  /** Toggle a node's expanded state */
  toggleNode: (path: string) => void
  /** Expand all nodes */
  expandAll: () => void
  /** Collapse all nodes */
  collapseAll: () => void
  /** Select a node */
  selectNode: (path: string | null) => void
  /** Update permission for a node */
  updateNodePermission: (nodePath: string, level: PermissionLevel, updates: Partial<PermissionTarget>) => void
  /** Reset local permissions to saved state */
  resetPermissions: () => void
  /** Set dirty state */
  setIsDirty: (dirty: boolean) => void
  /** Set local permissions directly (for after save) */
  setLocalPermissions: React.Dispatch<React.SetStateAction<PathPermission[]>>
}

export function usePermissionTree({
  schema,
  collections,
  contentRoot = 'content',
  permissions,
  contentTree,
}: UsePermissionTreeOptions): UsePermissionTreeResult {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set([contentRoot]))
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [localPermissions, setLocalPermissions] = useState<PathPermission[]>(permissions)
  const [isDirty, setIsDirty] = useState(false)

  // Build tree from schema (or collections) + contentTree
  const tree = useMemo(
    () => buildTree(schema, contentTree, contentRoot, collections),
    [schema, collections, contentTree, contentRoot]
  )

  // Annotate tree with permissions
  const annotatedTree = useMemo(
    () => annotateTreeWithPermissions(tree, localPermissions),
    [tree, localPermissions]
  )

  // Reset local state when permissions change externally
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
        const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath

        const existingIndex = newPermissions.findIndex((p) => p.path === permissionPath)

        if (existingIndex >= 0) {
          // Update existing permission for this level
          const existing = newPermissions[existingIndex]
          const updatedLevel: PermissionTarget = {
            ...existing[level],
            ...updates,
          }

          // Clean up empty arrays
          if (updatedLevel.allowedUsers?.length === 0) delete updatedLevel.allowedUsers
          if (updatedLevel.allowedGroups?.length === 0) delete updatedLevel.allowedGroups

          // If level target is empty, remove it
          if (!updatedLevel.allowedUsers && !updatedLevel.allowedGroups) {
            newPermissions[existingIndex] = { ...existing, [level]: undefined }
          } else {
            newPermissions[existingIndex] = { ...existing, [level]: updatedLevel }
          }

          // If all levels are empty, remove the permission entirely
          const perm = newPermissions[existingIndex]
          if (!perm.read && !perm.edit && !perm.review) {
            newPermissions.splice(existingIndex, 1)
          }
        } else {
          // Add new permission
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
    [annotatedTree]
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
