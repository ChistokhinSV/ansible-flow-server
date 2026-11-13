// A mail server for tests: it speaks just enough SMTP for nodemailer to hand it a message, keeps
// what it was given, and can refuse a recipient the way a real server does (550).
import { createServer, type Server } from 'node:net';

export interface Received {
  from: string;
  to: string[];
  data: string;
}

export interface TestSmtp {
  port: number;
  received: Received[];
  /** Recipients answered 550 at RCPT. */
  refuse: Set<string>;
  close(): Promise<void>;
}

export async function testSmtp(): Promise<TestSmtp> {
  const received: Received[] = [];
  const refuse = new Set<string>();
  const server: Server = createServer((socket) => {
    let buffer = '';
    let inData = false;
    let mail: Received = { from: '', to: [], data: '' };
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 mail.test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mail.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(mail);
          mail = { from: '', to: [], data: '' };
          say('250 2.0.0 queued');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          say('250-mail.test');
          say('250 8BITMIME');
        } else if (verb === 'HELO') say('250 mail.test');
        else if (verb === 'MAIL') {
          mail.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          say('250 2.1.0 ok');
        } else if (verb === 'RCPT') {
          const to = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (refuse.has(to)) say('550 5.1.1 no such mailbox');
          else {
            mail.to.push(to);
            say('250 2.1.5 ok');
          }
        } else if (verb === 'DATA') {
          inData = true;
          say('354 go ahead');
        } else if (verb === 'RSET') {
          mail = { from: '', to: [], data: '' };
          say('250 ok');
        } else if (verb === 'QUIT') {
          say('221 bye');
          socket.end();
        } else say('250 ok');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    received,
    refuse,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
