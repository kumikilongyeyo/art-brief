// Serves dist-a or dist-b under /art-brief/; GET /__switch?to=b flips it. Used by the update-flow test.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.argv[2] || 4180);
const root = process.argv[3];
let current = 'a';
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__switch') {
    current = url.searchParams.get('to') === 'b' ? 'b' : 'a';
    res.end(current);
    return;
  }
  if (!url.pathname.startsWith('/art-brief/')) {
    res.writeHead(404).end();
    return;
  }
  let rel = normalize(url.pathname.slice('/art-brief/'.length)).replace(/^(\.\.[/\\])+/, '');
  if (!rel || rel === '.' || rel.endsWith('/')) rel = (rel === '.' ? '' : rel) + 'index.html';
  try {
    const body = await readFile(join(root, `dist-${current}`, rel));
    res.writeHead(200, { 'content-type': types[extname(rel)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`switch server on ${port}`));
