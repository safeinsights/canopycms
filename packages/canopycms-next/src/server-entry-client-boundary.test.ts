import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Next ships every client module that a page's server code imports, whether or not it renders
 * it. The server entrypoints are imported by every adopter page that reads content, so one
 * runtime import of a `'use client'` module from them puts the editor in every public page.
 * `apps/dual-build-fixture` catches that in a full build; this catches it in the unit suite.
 *
 * The walk follows relative imports and `canopycms` entrypoints (through that package's
 * `exports`), and fails closed on a relative or `canopycms` specifier it cannot resolve.
 */

const SRC = path.dirname(new URL(import.meta.url).pathname)
const PACKAGES = path.resolve(SRC, '../..')
const SERVER_ENTRIES = ['index.ts', 'config.ts'].map((entry) => path.join(SRC, entry))
const CANOPYCMS = path.join(PACKAGES, 'canopycms')
const canopycmsExports = JSON.parse(readFileSync(path.join(CANOPYCMS, 'package.json'), 'utf8'))
  .exports as Record<string, string>

const resolveFile = (base: string): string | undefined => {
  const stem = base.replace(/\.(?:m?js|jsx)$/, '')
  return [
    stem,
    `${stem}.ts`,
    `${stem}.tsx`,
    path.join(stem, 'index.ts'),
    path.join(stem, 'index.tsx'),
  ].find((file) => /\.tsx?$/.test(file) && existsSync(file))
}

type Resolution = { file: string } | { unresolved: true } | { external: true }

const resolveSpecifier = (from: string, specifier: string): Resolution => {
  if (specifier.startsWith('.')) {
    const file = resolveFile(path.resolve(path.dirname(from), specifier))
    return file ? { file } : { unresolved: true }
  }
  if (specifier === 'canopycms' || specifier.startsWith('canopycms/')) {
    const target = canopycmsExports[`.${specifier.slice('canopycms'.length)}`]
    const file = target ? resolveFile(path.join(CANOPYCMS, target)) : undefined
    return file ? { file } : { unresolved: true }
  }
  return { external: true }
}

const isTypeOnlyClause = (node: ts.ImportDeclaration | ts.ExportDeclaration): boolean => {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    if (!clause) return false
    if (clause.isTypeOnly) return true
    const bindings = clause.namedBindings
    return (
      !clause.name &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    )
  }
  if (node.isTypeOnly) return true
  const clause = node.exportClause
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  )
}

/** Specifiers a file imports at runtime: type-only imports and exports are erased. */
const runtimeSpecifiers = (file: string): string[] => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !isTypeOnlyClause(node)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

/** A `'use client'` directive anywhere in the prologue, after comments or other directives. */
const isUseClient = (file: string): boolean =>
  /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|(['"])use [a-z]+\1;?)*(['"])use client\2/.test(
    readFileSync(file, 'utf8'),
  )

const walk = () => {
  const problems: string[] = []
  const reached = new Set<string>()
  const queue = [...SERVER_ENTRIES]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (reached.has(file)) continue
    reached.add(file)
    const importer = path.relative(PACKAGES, file)
    for (const specifier of runtimeSpecifiers(file)) {
      const resolution = resolveSpecifier(file, specifier)
      if ('unresolved' in resolution) {
        problems.push(`${importer} -> UNRESOLVED ${specifier}`)
      } else if ('file' in resolution) {
        if (isUseClient(resolution.file)) {
          problems.push(`${importer} -> ${path.relative(PACKAGES, resolution.file)}`)
        } else {
          queue.push(resolution.file)
        }
      } else if (/\/client$/.test(specifier)) {
        problems.push(`${importer} -> ${specifier}`)
      }
    }
  }
  return { problems, reached: [...reached].map((file) => path.relative(PACKAGES, file)) }
}

describe('canopycms-next server entrypoints', () => {
  it("import no 'use client' module or client entrypoint at runtime", () => {
    expect(walk().problems).toEqual([])
  })

  it('reach the preview page and canopycms, so the check above covers them', () => {
    expect(walk().reached).toEqual(
      expect.arrayContaining([
        'canopycms-next/src/context-wrapper.ts',
        'canopycms-next/src/preview-page.tsx',
        'canopycms/src/server.ts',
      ]),
    )
  })
})
