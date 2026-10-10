import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A local stand-in for GitHub's smart-HTTP git endpoint that checks the credential. */
export interface HttpsGitServer {
  /** `https://127.0.0.1:<port>`. */
  readonly origin: string
  /** The URL of the bare repository `<projectRoot>/<name>`. */
  url(name: string): string
  /** The tokens it accepts, as GitHub does: the password of a basic credential. */
  readonly acceptedTokens: Set<string>
  /** The `Authorization` header of every request, `undefined` where there was none. */
  readonly authorizations: (string | undefined)[]
  close(): Promise<void>
}

/**
 * Serve the bare repositories under `projectRoot` over HTTPS through `git http-backend`, refusing
 * with a 401 any request whose `Authorization` is not `basic` for an accepted token. The
 * certificate is self-signed and made with `openssl` in `workDir`; git trusts it only where the
 * test sets `GIT_SSL_NO_VERIFY`, which the worker's network env passes through.
 */
export async function startHttpsGitServer(
  projectRoot: string,
  workDir: string,
): Promise<HttpsGitServer> {
  const keyPath = path.join(workDir, 'key.pem')
  const certPath = path.join(workDir, 'cert.pem')
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
  ])
  const acceptedTokens = new Set<string>()
  const authorizations: (string | undefined)[] = []

  const accepts = (header: string | undefined): boolean => {
    const match = /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? '')
    if (!match) return false
    const decoded = Buffer.from(match[1], 'base64').toString()
    const colon = decoded.indexOf(':')
    return colon > 0 && acceptedTokens.has(decoded.slice(colon + 1))
  }

  const server = https.createServer(
    { key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) },
    (req, res) => {
      authorizations.push(req.headers.authorization)
      if (!accepts(req.headers.authorization)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'https://127.0.0.1')
      let pathInfo: string
      try {
        pathInfo = decodeURIComponent(url.pathname)
      } catch {
        pathInfo = '..'
      }
      if (pathInfo.split('/').includes('..')) {
        res.writeHead(400)
        res.end()
        return
      }
      const backend = spawn('git', ['http-backend'], {
        env: {
          PATH: process.env.PATH ?? '',
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          // Any authenticated user may push, as http-backend allows only with one set.
          REMOTE_USER: 'x-access-token',
          REMOTE_ADDR: '127.0.0.1',
          REQUEST_METHOD: req.method ?? 'GET',
          PATH_INFO: pathInfo,
          QUERY_STRING: url.search.replace(/^\?/, ''),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
          GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
        },
      })
      const chunks: Buffer[] = []
      backend.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      backend.on('close', () => {
        const output = Buffer.concat(chunks)
        const end = output.indexOf('\r\n\r\n')
        const headerText = output.subarray(0, end).toString()
        let status = 200
        const headers: Record<string, string> = {}
        for (const line of headerText.split('\r\n')) {
          const colon = line.indexOf(':')
          const name = line.slice(0, colon).trim()
          const value = line.slice(colon + 1).trim()
          if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
          else if (name) headers[name] = value
        }
        res.writeHead(status, headers)
        res.end(output.subarray(end + 4))
      })
      // A backend that exits before reading the body must fail the request, not the test run.
      backend.stdin.on('error', () => undefined)
      backend.on('error', () => {
        res.writeHead(500)
        res.end()
      })
      req.pipe(backend.stdin)
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    url: (name) => `${origin}/${name}`,
    acceptedTokens,
    authorizations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
