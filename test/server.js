// Minimal static file server for local viewing and the browser tests; no dependencies.
//   node test/server.js [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_PORT = 8000;
const HTTP = { ok: 200, badRequest: 400, forbidden: 403, notFound: 404 };
const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.mp4', 'video/mp4'],
  ['.json', 'application/json'],
]);

/** Start the server; resolves with the bound port (0 picks a free one). */
export function serve(port = DEFAULT_PORT) {
  const server = createServer(async (request, response) => {
    let path;
    try {
      path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(HTTP.badRequest).end('bad request');
      return;
    }
    const file = normalize(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      response.writeHead(HTTP.forbidden).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(HTTP.ok, {
        'content-type': TYPES.get(extname(file)) ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(HTTP.notFound).end('not found');
    }
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await serve(Number(process.argv[2] ?? process.env.PORT ?? DEFAULT_PORT));
  console.log(`Ondine House at http://localhost:${port}/`);
}
