// A webhook receiver for the end-to-end suites (AFS-38): it keeps every POST it is sent and gives
// them back on GET /received (newest last); DELETE /received forgets them.
import { createServer } from 'node:http';

const received = [];
createServer((req, res) => {
  if (req.url === '/received' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(received));
    return;
  }
  if (req.url === '/received' && req.method === 'DELETE') {
    received.length = 0;
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    received.push({ at: new Date().toISOString(), path: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(8080, '0.0.0.0');
