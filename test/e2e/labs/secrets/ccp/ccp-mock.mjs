// Mock of CyberArk Central Credential Provider (CCP) REST, enough for the secret-provider tests.
// GET /AIMWebService/api/Accounts?AppID=&Safe=&Folder=&Object=  ->  { Content, UserName, ... }
// Client-certificate auth like an IIS-hosted CCP: no or unknown client cert -> 403.
// Error bodies follow CCP's shape ({ ErrorCode, ErrorMsg }); codes are approximations.
// /AIMWebService/api/Accounts?...&Object=slow never answers (response timeout test).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const dir = new URL('.', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir));
const ACCOUNTS = {
  'LAB-NET/Root/lab-switch-01': {
    Content: 'lab-switch-password-1',
    UserName: 'netops',
    Address: 'sw-edge-01.example.net',
    Database: '',
    PolicyID: 'NetworkDevice',
    Folder: 'Root',
    Name: 'lab-switch-01',
    PasswordChangeInProcess: 'False',
  },
};
const APPS = { 'afs-spike': ['LAB-NET'] };

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

createServer(
  {
    key: read('server.key'),
    cert: read('server.pem'),
    ca: read('ca.pem'),
    requestCert: true,
    rejectUnauthorized: false,
  },
  (req, res) => {
    const url = new URL(req.url, 'https://ccp');
    console.log(
      new Date().toISOString(),
      req.method,
      url.pathname,
      'client cert ok:',
      req.socket.authorized,
    );
    if (url.pathname.toLowerCase() !== '/aimwebservice/api/accounts')
      return send(res, 404, { ErrorCode: 'NOTFOUND', ErrorMsg: 'No such page' });
    if (!req.socket.authorized)
      return send(res, 403, {
        ErrorCode: 'APPAP306E',
        ErrorMsg: 'Failed to authenticate application: client certificate required',
      });
    const q = Object.fromEntries([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    if (q.object === 'slow') return; // never answers
    const safes = APPS[q.appid];
    if (!safes || !safes.includes(q.safe))
      return send(res, 403, {
        ErrorCode: 'APPAP282E',
        ErrorMsg: `Application [${q.appid}] is not authorized to access Safe [${q.safe}]`,
      });
    const acc = ACCOUNTS[`${q.safe}/${q.folder ?? 'Root'}/${q.object}`];
    if (!acc)
      return send(res, 404, {
        ErrorCode: 'APPAP004E',
        ErrorMsg: `Password object matching query [Safe=${q.safe};Folder=${q.folder ?? 'Root'};Object=${q.object}] was not found (Diagnostic Info: 5)`,
      });
    send(res, 200, acc);
  },
).listen(Number(process.env.CCP_PORT ?? 8443), () => console.log('CCP mock listening'));
