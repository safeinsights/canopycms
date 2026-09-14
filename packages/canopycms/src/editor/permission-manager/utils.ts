import type { TreeNode, ContentNode, PathPermission } from './types'
import type { EditorCollection } from '../Editor'

/**
 * Search utility: Find a tree node by exact path match (recursive search).
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
 * Skips wrapping when `collections` is a single item that IS the content root
 * itself (as `buildEditorCollections` returns), processing its children
 * directly instead of double-nesting.
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
  if (!parentPath && collections.length === 1 && collections[0].path === contentRoot) {
    const rootCollection = collections[0]
    return rootCollection.children
      ? convertCollectionsToTreeNodes(rootCollection.children, contentRoot, contentRoot)
      : []
  }

  const nodes: TreeNode[] = []

  for (const collection of collections) {
    // Build the logical path - use collection.path directly since it already includes
    // the content root prefix from buildEditorCollections
    const logicalPath = collection.path

    const node: TreeNode = {
      path: logicalPath,
      name: collection.label || collection.name,
      type: collection.type === 'collection' ? 'folder' : 'file',
      children: [],
    }

    if (collection.children) {
      node.children = convertCollectionsToTreeNodes(collection.children, contentRoot, logicalPath)
    }

    nodes.push(node)
  }

  return nodes
}

/**
 * Merges filesystem content into the schema tree.
 *
 * Adds files that exist in the filesystem but aren't defined in the schema
 * (e.g., entries created manually), never folders — folders are expected to
 * come from the schema.
 *
 * @param schemaNode - TreeNode from schema to merge into (mutated)
 * @param contentNode - Actual filesystem content tree from API
 */
export function mergeContentTree(schemaNode: TreeNode, contentNode: ContentNode): void {
  contentNode.children?.forEach((child) => {
    const existing = schemaNode.children.find((n) => n.name === child.name)
    if (existing) {
      if (child.type === 'folder' && child.children) {
        mergeContentTree(existing, child)
      }
    } else if (child.type === 'file') {
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
 * Build tree structure from EditorCollections.
 *
 * @param contentTree - Actual filesystem content from API (optional)
 * @param contentRoot - The content root path, defaults to "content"
 * @param collections - Optional EditorCollection[] from API
 * @returns Root TreeNode for the permission tree
 */
export function buildTree(
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

  if (collections && collections.length > 0) {
    root.children = convertCollectionsToTreeNodes(collections, contentRoot)

    if (contentTree) {
      mergeContentTree(root, contentTree)
    }
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

  const directPerm = permissions.find((p) => p.path === folderPath || p.path === node.path)

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
