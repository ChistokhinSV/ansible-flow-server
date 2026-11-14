// The container's health check (AFS-35): /healthz of the server in this container, over HTTPS
// with its own certificate (self-signed at first start, so not checked here: this is the server's
// own address), or plain HTTP behind a proxy (AFS_TLS=off).
import { request as http } from 'node:http';
import { request as https } from 'node:https';

const tls = (process.env.AFS_TLS ?? 'on').toLowerCase() !== 'off';
const port = Number(process.env.AFS_PORT ?? (tls ? 8443 : 8080));
const ask = tls ? https : http;
const req = ask(
  { host: '127.0.0.1', port, path: '/healthz', timeout: 4000, rejectUnauthorized: false },
  (reply) => process.exit(reply.statusCode === 200 ? 0 : 1),
);
req.on('error', () => process.exit(1));
req.on('timeout', () => req.destroy(new Error('timeout')));
req.end();
