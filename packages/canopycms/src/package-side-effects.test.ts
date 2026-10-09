/**
 * `package.json`'s `sideEffects` array names the modules whose evaluation does something. Bundlers
 * drop any other module whose exports go unused, which is what keeps
 * `import { assetUrl } from 'canopycms'` from dragging the root barrel's zod config schemas into a
 * client bundle.
 *
 * A module belongs in the list when evaluating it has an effect that something depends on even if
 * nobody uses its exports: a stylesheet import (`editor/theme.tsx`), a top-level run (the
 * `cli/cli.ts` bin), or test-runner registration (`expect.extend`, a top-level `beforeEach`).
 * List each shipped module twice, as `./src/<path>` for workspace consumers (whose dev `exports`
 * resolve to src) and `./dist/<path>.js` for the published tarball.
 *
 * The last test below enforces the list. It parses every src module the `tsconfig.build.json`
 * program reaches, plus the listed src-only ones, and requires the modules with a top-level
 * statement that runs code to be exactly the listed ones: an expression, `if`/`try`/loop, a bare
 * `import './x'`, `import x = require()`, a non-ambient namespace, `using`, a non-trivial
 * `export default`, or a class with a decorator, static block, static field initializer, computed
 * key or computed `extends`. So a new registration, global getter or polyfill fails until its
 * module is listed. A call inside a `const` initializer is not counted: it constructs a value, and
 * a module that holds one is kept whenever the value is used. Write an import-time effect as a
 * statement, never as `const _ = install()`.
 *
 * What is deliberately absent:
 * - `defineEndpoint` pushes into `ROUTE_REGISTRY` from a `const` initializer, but its one reader,
 *   `getAllRoutes()`, is called only by `scripts/generate-client.ts`, unbundled under tsx with
 *   explicit imports. `http/router.ts` mounts routes from `buildCanopyRoutes()` in
 *   `api/routes.ts`, whose named imports keep every route module, never from the registry.
 * - `config/schemas/field.ts` assigns its own module-local holder at top level; nothing outside
 *   the module reads it, so the scan allows that one statement.
 * - The vitest setup files `tsconfig.build.json` excludes are loaded by path, never imported.
 */
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function declaredSideEffects(): Promise<string[]> {
  const pkg: unknown = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
  const value =
    typeof pkg === 'object' && pkg !== null && 'sideEffects' in pkg ? pkg.sideEffects : undefined
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
    throw new Error('package.json must declare sideEffects as an array of paths')
  }
  return value
}

describe('root entry tree-shaking', () => {
  let consumerDir: string

  beforeAll(async () => {
    consumerDir = await mkdtemp(path.join(tmpdir(), 'canopy-side-effects-'))
    await mkdir(path.join(consumerDir, 'node_modules'))
    await symlink(packageDir, path.join(consumerDir, 'node_modules', 'canopycms'))
  })

  afterAll(async () => {
    await rm(consumerDir, { recursive: true, force: true })
  })

  it('bundles assetUrl from the package root without zod or the config schemas', async () => {
    const result = await build({
      stdin: {
        contents:
          "import { assetUrl } from 'canopycms'\nconsole.log(assetUrl({ src: '/x.png' }))\n",
        resolveDir: consumerDir,
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      metafile: true,
      logLevel: 'silent',
      absWorkingDir: consumerDir,
    })
    const [output] = Object.values(result.metafile.outputs)
    const kept = Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([file]) => path.resolve(consumerDir, file))
    const configDir = path.join(packageDir, 'src', 'config') + path.sep

    expect(kept).toContain(path.join(packageDir, 'src', 'assets', 'asset-url.ts'))
    expect(kept.filter((file) => file.includes(`${path.sep}zod${path.sep}`))).toEqual([])
    expect(kept.filter((file) => file.startsWith(configDir))).toEqual([])
  })
})

describe('sideEffects declaration', () => {
  it('names only files that exist, each shipped one under both src and dist', async () => {
    const declared = await declaredSideEffects()
    expect(declared.length).toBeGreaterThan(0)

    for (const entry of declared) {
      const src = entry.match(/^\.\/src\/(.+)\.tsx?$/)
      const dist = entry.match(/^\.\/dist\/(.+)\.js$/)
      expect(src ?? dist, `${entry} must be ./src/<path>.ts(x) or ./dist/<path>.js`).toBeTruthy()

      if (src) {
        expect(existsSync(path.join(packageDir, entry)), `${entry} does not exist`).toBe(true)
        // test-utils never ships: tsconfig.build.json excludes it.
        if (!entry.startsWith('./src/test-utils/')) {
          expect(declared, `${entry} ships, so its dist twin must be listed`).toContain(
            `./dist/${src[1]}.js`,
          )
        }
      } else if (dist) {
        const twins = [`./src/${dist[1]}.ts`, `./src/${dist[1]}.tsx`]
        const twin = twins.find((candidate) => declared.includes(candidate))
        expect(twin, `${entry} must have its src twin listed`).toBeDefined()
      }
    }
  })

  it('lists exactly the modules with top-level statements that run code', async () => {
    const declared = await declaredSideEffects()
    const listedSrc = declared.filter((entry) => entry.startsWith('./src/'))
    const compiled = compiledSourceFiles()
    expect(compiled.map((file) => file.fileName)).toContain(path.join(srcDir, 'index.ts'))

    const sourceFiles = new Map(compiled.map((file) => [path.resolve(file.fileName), file]))
    for (const entry of listedSrc) {
      const file = path.join(packageDir, entry)
      if (!sourceFiles.has(file)) sourceFiles.set(file, parse(file, await readFile(file, 'utf8')))
    }

    const effectful: Record<string, string[]> = {}
    for (const [file, sourceFile] of sourceFiles) {
      const key = `./${path.relative(packageDir, file).split(path.sep).join('/')}`
      const allowed = MODULE_LOCAL_EFFECTS[key] ?? []
      const effects = sourceFile.statements
        .filter(runsCode)
        .map((statement) => statement.getText(sourceFile).split('\n')[0].trim())
        .filter((statement) => !allowed.includes(statement))
      if (effects.length > 0) effectful[key] = effects
    }

    expect(Object.keys(effectful).sort(), JSON.stringify(effectful, null, 2)).toEqual(
      [...listedSrc].sort(),
    )
  })
})

const srcDir = path.join(packageDir, 'src')

/** Top-level statements a module may run without anything outside it ever observing them. */
const MODULE_LOCAL_EFFECTS: Record<string, string[]> = {
  './src/config/schemas/field.ts': ['fieldHolder[0] = fieldSchema'],
}

/** Every src module the `tsconfig.build.json` program reaches, so every module tsc emits to dist. */
function compiledSourceFiles(): ts.SourceFile[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(packageDir, 'tsconfig.build.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    },
  )
  if (!parsed) throw new Error('tsconfig.build.json did not parse')
  expect(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
  return ts
    .createProgram(parsed.fileNames, parsed.options)
    .getSourceFiles()
    .filter((file) => path.resolve(file.fileName).startsWith(srcDir + path.sep))
    .filter((file) => !file.isDeclarationFile)
}

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
}

function runsCode(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement)) return statement.importClause === undefined
  // A string-literal statement is a directive (`'use client'`) or a no-op.
  if (ts.isExpressionStatement(statement)) return !ts.isStringLiteral(statement.expression)
  if (ts.isClassDeclaration(statement)) return classRunsCode(statement)
  if (ts.isExportAssignment(statement)) return !isInertExpression(statement.expression)
  if (ts.isImportEqualsDeclaration(statement)) {
    return ts.isExternalModuleReference(statement.moduleReference)
  }
  if (ts.isModuleDeclaration(statement)) {
    const ambient = ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Ambient
    return statement.body !== undefined && !ambient
  }
  if (ts.isVariableStatement(statement)) {
    // `using` disposes at module teardown. Any other initializer constructs a value the module
    // is kept for whenever that value is used.
    return (statement.declarationList.flags & ts.NodeFlags.Using) !== 0
  }
  return !(
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isEmptyStatement(statement)
  )
}

function classRunsCode(declaration: ts.ClassDeclaration): boolean {
  const heritageRuns = (declaration.heritageClauses ?? []).some((clause) =>
    clause.types.some(
      (type) => clause.token === ts.SyntaxKind.ExtendsKeyword && !isEntityName(type.expression),
    ),
  )
  const memberRuns = declaration.members.some(
    (member) =>
      ts.isClassStaticBlockDeclaration(member) ||
      (ts.canHaveDecorators(member) && (ts.getDecorators(member)?.length ?? 0) > 0) ||
      (member.name !== undefined && ts.isComputedPropertyName(member.name)) ||
      (ts.isPropertyDeclaration(member) &&
        member.initializer !== undefined &&
        (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0),
  )
  return heritageRuns || memberRuns || (ts.getDecorators(declaration)?.length ?? 0) > 0
}

function isEntityName(expression: ts.Expression): boolean {
  return (
    ts.isIdentifier(expression) ||
    (ts.isPropertyAccessExpression(expression) && isEntityName(expression.expression))
  )
}

function isInertExpression(expression: ts.Expression): boolean {
  return (
    ts.isIdentifier(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isClassExpression(expression) ||
    ts.isLiteralExpression(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  )
}
