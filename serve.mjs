/*
 * serve.mjs - serves Reach at http://localhost:8732
 *
 * The page loads its code as ES modules, which browsers refuse from file://,
 * so it needs this tiny server. Run it with: npm start
 */
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT) || 8732;
const root = path.resolve(import.meta.dirname, 'src');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json'
};

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, rel === '/' ? 'index.html' : rel);

  // stay inside the build folder
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
}).listen(PORT, () => {
  console.log('http://localhost:' + PORT + '   (ctrl+c to stop)');
});
