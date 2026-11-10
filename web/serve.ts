// Serves the web map: web/ as the site, out/ as data/, and the MapKit JS
// token from APPLE_MAPKIT_TOKEN.
//
//   node --env-file=.env web/serve.ts   (or npm run web)

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.PORT ?? 8080)
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' }

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  if (path === '/token') {
    const token = process.env.APPLE_MAPKIT_TOKEN
    res.writeHead(token ? 200 : 500, { 'content-type': 'text/plain' })
    return res.end(token ?? 'APPLE_MAPKIT_TOKEN is not set')
  }
  const file = path.startsWith('/data/') ? join(root, 'out', path.slice(6)) : join(root, 'web', path === '/' ? 'index.html' : path)
  if (!normalize(file).startsWith(root)) return res.writeHead(403).end()
  try {
    const body = await readFile(file)
    // No caching, so a rebuild or code change shows on reload
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('Not found')
  }
}).listen(port, () => console.log(`Map at http://localhost:${port}`))
