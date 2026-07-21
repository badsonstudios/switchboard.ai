// Loopback static server for the packaged renderer (E8). dockview's pop-out
// refuses file:// ("popout URL must be same-origin http(s)"), so in production
// we serve the built renderer over http://127.0.0.1:<port> instead of
// loadFile. It serves ONLY our own bundle from the renderer dist dir, binds to
// loopback, and has no state-changing endpoints — static assets any local
// process could already read off disk.
import http from 'http';
import fs from 'fs';
import path from 'path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticServer {
  origin: string; // e.g. http://127.0.0.1:53411
  close: () => void;
}

/** Serve `root` over loopback; resolves with the bound origin. */
export function startStaticServer(root: string): Promise<StaticServer> {
  const server = http.createServer((req, res) => {
    // only loopback Host is served (defense-in-depth; it's static anyway)
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403);
      return void res.end();
    }
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const resolved = path.resolve(root, rel);
    // never escape the renderer dist dir
    if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
      res.writeHead(403);
      return void res.end();
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404);
        return void res.end();
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // don't let the server keep the process alive after the window closes
      // (otherwise the app can linger as a zombie on quit)
      server.unref();
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => {
          server.closeAllConnections?.(); // drop keep-alive sockets holding it open
          server.close();
        },
      });
    });
  });
}
