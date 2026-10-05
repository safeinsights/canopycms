import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Next ships every client module that a page's server code imports, whether or not it renders
 * it. The server entrypoints are imported by every adopter page that reads content, so one
 * runtime import of a `'use client'` module from them puts the editor in every public page.
 * `apps/dual-build-fixture` catches that in a full build; this catches it in the unit suite.
 */

const SRC = path.dirname(new URL(import.meta.url).pathname)
const SERVER_ENTRIES = ['index.ts', 'config.ts']

const resolveLocal = (from: string, specifier: string): string | undefined => {
  const base = path.resolve(path.dirname(from), specifier)
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((file) => existsSync(file))
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

const isUseClient = (file: string): boolean =>
  /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(readFileSync(file, 'utf8'))

/** Every client boundary reachable at runtime from the server entrypoints, as `importer -> target`. */
const clientImports = (): string[] => {
  const found: string[] = []
  const seen = new Set<string>()
  const queue = SERVER_ENTRIES.map((entry) => path.join(SRC, entry))
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of runtimeSpecifiers(file)) {
      const importer = path.relative(SRC, file)
      if (specifier.startsWith('.')) {
        const target = resolveLocal(file, specifier)
        if (!target) continue
        if (isUseClient(target)) found.push(`${importer} -> ${path.relative(SRC, target)}`)
        else queue.push(target)
      } else if (/\/client$/.test(specifier)) {
        found.push(`${importer} -> ${specifier}`)
      }
    }
  }
  return found
}

describe('canopycms-next server entrypoints', () => {
  it("import no 'use client' module or client entrypoint at runtime", () => {
    expect(clientImports()).toEqual([])
  })

  it('reach the preview page, so the check above covers it', () => {
    const reached = new Set<string>()
    const queue = SERVER_ENTRIES.map((entry) => path.join(SRC, entry))
    while (queue.length > 0) {
      const file = queue.shift()!
      if (reached.has(file)) continue
      reached.add(file)
      for (const specifier of runtimeSpecifiers(file)) {
        const target = specifier.startsWith('.') ? resolveLocal(file, specifier) : undefined
        if (target) queue.push(target)
      }
    }
    expect([...reached].map((file) => path.relative(SRC, file))).toEqual(
      expect.arrayContaining(['context-wrapper.ts', 'preview-page.tsx']),
    )
  })
})
