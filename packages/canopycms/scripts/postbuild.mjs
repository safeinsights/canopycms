import { rm, cp, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// Copy template files — rm first to prevent nested dirs on repeated builds
await rm(resolve(root, 'dist/cli/template-files'), { recursive: true, force: true })
await cp(resolve(root, 'src/cli/template-files'), resolve(root, 'dist/cli/template-files'), {
  recursive: true,
})

// Replace tsx shebang with node in the compiled binary so it runs without tsx installed
const binPath = resolve(root, 'dist/cli/init.js')
const src = await readFile(binPath, 'utf8')
const replaced = src.replace('#!/usr/bin/env tsx\n', '#!/usr/bin/env node\n')
if (replaced === src) {
  throw new Error(
    'postbuild: shebang replacement failed — dist/cli/init.js missing expected #!/usr/bin/env tsx',
  )
}
await writeFile(binPath, replaced)
