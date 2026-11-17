// A plain static server over the repository root, for the guides.
//
// They have no back end — three HTML files, a stylesheet and a PNG — so
// this serves the repository exactly as Netlify publishes it, including
// the /get rewrite, which is the URL on the printed card.
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8908);
const TYPES = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8', '.png':'image/png',
  '.svg':'image/svg+xml', '.json':'application/json', '.jpg':'image/jpeg' };

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  // The one rule from _redirects that these pages depend on.
  if (p === '/get' || p === '/GET') p = '/welcome.html';
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain',
                       'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log('guides mock on ' + PORT));
