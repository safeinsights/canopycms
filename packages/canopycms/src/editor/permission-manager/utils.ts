/**
 * Utility functions for PermissionManager
 */

import type { CanopyConfig } from '../../config'
import { flattenSchema } from '../../config'
import type { TreeNode, ContentNode, PathPermission } from './types'
import type { EditorCollection } from '../Editor'

/**
 * Search utility: Find a tree node by exact path match (recursive search).
 * Used to locate nodes when updating permissions.
 *
 * @param node - Root node to start searching from
 * @param path - The exact path to search for
 * @returns The matching TreeNode or null if not found
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
 * Transforms API/editor collections into permission tree nodes.
 *
 * Handles the case where buildEditorCollections returns a structure with the content root
 * as a top-level collection. Avoids double-wrapping by detecting when a collection IS the
 * content root itself and processing its children directly.
 *
 * @param collections - Array of EditorCollection from API or buildEditorCollections
 * @param contentRoot - The content root path (e.g., "content")
 * @param parentPath - Optional parent path for recursive calls
 * @returns Array of TreeNode for the permission tree
 */
export function convertCollectionsToTreeNodes(
  collections: EditorCollection[],
  contentRoot: string,
  parentPath?: string,
): TreeNode[] {
  // Special case: If we're at the top level (no parentPath) and the collections array
  // contains exactly one item that IS the content root itself, skip creating a duplicate
  // node for it and just process its children directly.
  if (!parentPath && collections.length === 1 && collections[0].path === contentRoot) {
    const rootCollection = collections[0]
    return rootCollection.children
      ? convertCollectionsToTreeNodes(rootCollection.children, contentRoot, contentRoot)
      : []
  }

  const nodes: TreeNode[] = []

  for (const collection of collections) {
    // Build the full path - use collection.path directly since it already includes
    // the content root prefix from buildEditorCollections
    const fullPath = collection.path

    const node: TreeNode = {
      path: fullPath,
      name: collection.label || collection.name,
      type: collection.type === 'collection' ? 'folder' : 'file',
      children: [],
    }

    // Recursively process nested collections
    if (collection.children) {
      node.children = convertCollectionsToTreeNodes(collection.children, contentRoot, fullPath)
    }

    nodes.push(node)
  }

  return nodes
}

/**
 * Merges filesystem content into schema tree for files not defined in the schema.
 *
 * Used to add files that exist in the filesystem but aren't explicitly defined in
 * the schema (e.g., entries created manually via the filesystem). Only adds files,
 * not folders - folders are expected to come from the schema.
 *
 * @param schemaNode - TreeNode from schema to merge into (mutated)
 * @param contentNode - Actual filesystem content tree from API
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
 * Main entry point: Creates permission tree root node and delegates to collection
 * or schema-based building.
 *
 * Has two modes:
 * 1. Collections-based (when collections provided): Uses API/editor collections
 * 2. Schema-based (fallback): Flattens schema and builds hierarchy from parentPath relationships
 *
 * @param schema - CanopyConfig schema (optional)
 * @param contentTree - Actual filesystem content from API (optional)
 * @param contentRoot - The content root path, defaults to "content"
 * @param collections - Optional EditorCollection[] from API
 * @returns Root TreeNode for the permission tree
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

  // Flatten schema to get all collections and entry types
  const flatSchema = flattenSchema(schema, contentRoot)

  // Create a map of path -> TreeNode for fast lookup
  const nodeMap = new Map<string, TreeNode>()
  nodeMap.set(contentRoot, root)

  // First pass: Create all nodes (skip content root since we already have it)
  flatSchema.forEach((item) => {
    // Skip the content root itself - we already created it as the root node
    if (item.logicalPath === contentRoot) {
      return
    }

    const pathSegments = item.logicalPath.split('/').filter(Boolean)
    const displayName = pathSegments[pathSegments.length - 1] || item.name

    const node: TreeNode = {
      path: item.logicalPath,
      name: displayName,
      type: item.type === 'collection' ? 'folder' : 'file',
      children: [],
    }

    nodeMap.set(item.logicalPath, node)
  })

  // Second pass: Build hierarchy using parentPath
  flatSchema.forEach((item) => {
    // Skip the content root itself
    if (item.logicalPath === contentRoot) {
      return
    }

    const node = nodeMap.get(item.logicalPath)
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
 * Decorates tree with permission data (direct + inherited).
 *
 * Recursively walks the tree and attaches permission information to each node:
 * - directPermission: Exact match for this path (or path/** for folders)
 * - inheritedPermission: Nearest parent's folder wildcard permission (if no direct permission)
 *
 * @param node - TreeNode to annotate
 * @param permissions - Array of PathPermission from API
 * @returns Annotated TreeNode with permission data
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
