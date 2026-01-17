/**
 * Utility functions for PermissionManager
 */

import type { CanopyConfig } from '../../config'
import { flattenSchema } from '../../config'
import type { TreeNode, ContentNode, PathPermission } from './types'
import type { EditorCollection } from '../Editor'

/**
 * Find a tree node by path (recursive search)
 */
export function findTreeNode(node: TreeNode, path: string): TreeNode | null {
  if (node.path === path) return node
  for (const child of node.children) {
    const found = findTreeNode(child, path)
    if (found) return found
  }
  return null
}

/**
 * Convert EditorCollection[] to TreeNode structure
 */
export function convertCollectionsToTreeNodes(
  collections: EditorCollection[],
  contentRoot: string,
  parentPath?: string,
): TreeNode[] {
  const nodes: TreeNode[] = []

  for (const collection of collections) {
    const fullPath = parentPath
      ? `${parentPath}/${collection.name}`
      : `${contentRoot}/${collection.name}`

    const node: TreeNode = {
      path: fullPath,
      name: collection.label || collection.name,
      type: collection.type === 'collection' ? 'folder' : 'file',
      children: [],
    }

    // Recursively convert children
    if (collection.children) {
      node.children = convertCollectionsToTreeNodes(collection.children, contentRoot, fullPath)
    }

    nodes.push(node)
  }

  return nodes
}

/**
 * Merge actual content tree into schema tree
 */
export function mergeContentTree(schemaNode: TreeNode, contentNode: ContentNode): void {
  contentNode.children?.forEach((child) => {
    const existing = schemaNode.children.find((n) => n.name === child.name)
    if (existing) {
      // If this is a folder/collection that exists in schema, recursively merge its children
      if (child.type === 'folder' && child.children) {
        mergeContentTree(existing, child)
      }
    } else if (child.type === 'file') {
      // Add file not in schema (e.g., entry created via filesystem)
      schemaNode.children.push({
        path: child.path,
        name: child.name,
        type: child.type,
        children: [],
      })
    }
  })
}

/**
 * Build tree from schema and optional contentTree
 */
export function buildTree(
  schema: CanopyConfig['schema'] | undefined,
  contentTree: ContentNode | undefined,
  contentRoot = 'content',
  collections?: EditorCollection[],
): TreeNode {
  const root: TreeNode = {
    path: contentRoot,
    name: contentRoot,
    type: 'folder',
    children: [],
  }

  // If collections are provided (from API), use them instead of schema
  if (collections && collections.length > 0) {
    root.children = convertCollectionsToTreeNodes(collections, contentRoot)

    // Merge contentTree if provided
    if (contentTree) {
      mergeContentTree(root, contentTree)
    }

    return root
  }

  // Handle undefined schema gracefully
  if (!schema) {
    return root
  }

  // Flatten schema to get all collections and singletons
  const flatSchema = flattenSchema(schema, contentRoot)

  // Create a map of path -> TreeNode for fast lookup
  const nodeMap = new Map<string, TreeNode>()
  nodeMap.set(contentRoot, root)

  // First pass: Create all nodes
  flatSchema.forEach((item) => {
    const pathSegments = item.fullPath.split('/').filter(Boolean)
    const displayName = pathSegments[pathSegments.length - 1] || item.name

    const node: TreeNode = {
      path: item.fullPath,
      name: displayName,
      type: item.type === 'collection' ? 'folder' : 'file',
      children: [],
    }

    nodeMap.set(item.fullPath, node)
  })

  // Second pass: Build hierarchy using parentPath
  flatSchema.forEach((item) => {
    const node = nodeMap.get(item.fullPath)
    if (!node) return

    // Determine parent path (or use root if no parent)
    const parentPath = item.parentPath || contentRoot
    const parentNode = nodeMap.get(parentPath)

    if (parentNode) {
      parentNode.children.push(node)
    } else {
      // Fallback: add to root if parent not found
      root.children.push(node)
    }
  })

  // Merge contentTree if provided (for actual files not in schema)
  if (contentTree) {
    mergeContentTree(root, contentTree)
  }

  return root
}

/**
 * Annotate tree with permissions (direct and inherited)
 */
export function annotateTreeWithPermissions(
  node: TreeNode,
  permissions: PathPermission[],
): TreeNode {
  const folderPath = node.type === 'folder' ? `${node.path}/**` : node.path

  // Find direct permission
  const directPerm = permissions.find((p) => p.path === folderPath || p.path === node.path)

  // Find inherited permission from parent
  let inheritedPerm: PathPermission | undefined
  const pathParts = node.path.split('/')
  for (let i = pathParts.length - 1; i >= 0; i--) {
    const parentPath = pathParts.slice(0, i + 1).join('/')
    const parentFolderPath = `${parentPath}/**`
    const parentPerm = permissions.find((p) => p.path === parentFolderPath)
    if (parentPerm) {
      inheritedPerm = parentPerm
      break
    }
  }

  return {
    ...node,
    directPermission: directPerm,
    inheritedPermission: !directPerm ? inheritedPerm : undefined,
    children: node.children.map((child) => annotateTreeWithPermissions(child, permissions)),
  }
}
