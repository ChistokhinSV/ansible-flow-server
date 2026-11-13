// The certificate commands, for whoever administers the machine the server runs on:
//   cert show                         the certificate in use, the one before it, a waiting request
//   cert request <name> [<name>…]     make a key and a request for a certificate authority
//        [--org <organization>] [--out <file>]
//   cert install <certificate.pem>    install a signed certificate (its chain may follow it in
//        [--key <key.pem>]            the file); without --key it answers the waiting request, or
//                                     renews for the key in use
//   cert self-signed [<name>…]        replace the certificate with a new self-signed one
//   cert rollback                     go back to the certificate that was in use before
//   cert history                      every change made to the certificate
// They work on the files in the data folder. A running server sees the change and serves the new
// certificate to new connections; it need not be restarted.
import { readFileSync, writeFileSync } from 'node:fs';
import { type Config, publicHost } from '../config';
import { certificateStore, selfSignedNames } from '../serve';
import type { CertificateInfo } from './certificates';
import { CertificateRefused } from './store';

const BY = { by: 'cli' };

function lines(title: string, info: CertificateInfo, source?: string): string[] {
  const left =
    info.daysLeft < 0 ? `expired ${-info.daysLeft} days ago` : `${info.daysLeft} days left`;
  return [
    title,
    `  Subject      ${info.subject}`,
    `  Names        ${info.names.join(', ') || '(none)'}`,
    `  Issuer       ${info.selfSigned ? 'itself (self-signed)' : info.issuer}`,
    `  Valid        ${info.notBefore} to ${info.notAfter} (${left})`,
    `  Fingerprint  ${info.fingerprint}`,
    ...(info.chain
      ? [`  Chain        ${info.chain} more certificate${info.chain === 1 ? '' : 's'}`]
      : []),
    ...(source ? [`  Source       ${source}`] : []),
  ];
}

/** Takes `--name value` out of the arguments. */
function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

/** Runs a `cert` command; resolves with the process's exit code. */
export async function certCommand(
  config: Config,
  args: string[],
  print: (line: string) => void = console.log,
): Promise<number> {
  const store = certificateStore(config);
  const [command, ...rest] = args;
  try {
    switch (command) {
      case 'show': {
        const current = store.current();
        if (!current) {
          print('No certificate yet: the server makes a self-signed one when it first starts.');
        } else {
          for (const line of lines('Certificate in use', current.info, current.source)) print(line);
        }
        const previous = store.previous();
        if (previous) for (const line of lines('Before it (cert rollback)', previous)) print(line);
        if (store.pendingRequest())
          print('A request waits for its signed certificate (cert install <certificate.pem>).');
        if (config.tls === 'off')
          print('AFS_TLS is off: the server speaks plain HTTP and does not use a certificate.');
        return 0;
      }
      case 'request': {
        const organization = option(rest, '--org');
        const out = option(rest, '--out');
        if (rest.length === 0) {
          print('Name what the certificate is for: cert request flows.example.net [more names]');
          return 2;
        }
        const request = await store.request({ names: rest, organization }, BY);
        if (out) {
          writeFileSync(out, request);
          print(`The request is in ${out}. Its key stays with the server.`);
        } else {
          print(request.trimEnd());
        }
        print('Have a certificate authority sign it, then: cert install <certificate.pem>');
        return 0;
      }
      case 'install': {
        const keyFile = option(rest, '--key');
        const [file] = rest;
        if (!file) {
          print('Name the certificate file: cert install <certificate.pem> [--key <key.pem>]');
          return 2;
        }
        const stored = store.install(readFileSync(file, 'utf8'), {
          ...(keyFile ? { key: readFileSync(keyFile, 'utf8') } : {}),
          host: publicHost(config),
          ...BY,
        });
        for (const line of lines('Installed', stored.info)) print(line);
        print('A running server serves it to new connections from now on.');
        return 0;
      }
      case 'self-signed': {
        const stored = await store.selfSigned(rest.length ? rest : selfSignedNames(config), BY);
        for (const line of lines('New self-signed certificate', stored.info)) print(line);
        return 0;
      }
      case 'rollback': {
        const stored = store.rollback(BY);
        for (const line of lines('Back in use', stored.info, stored.source)) print(line);
        return 0;
      }
      case 'history': {
        for (const entry of store.history())
          print(
            [entry.at, entry.action, `by ${entry.by}`, entry.subject, entry.fingerprint]
              .filter(Boolean)
              .join('  '),
          );
        return 0;
      }
      default:
        print(
          'Use: cert show | request <names> | install <file> [--key <file>] | self-signed | rollback | history',
        );
        return 2;
    }
  } catch (e) {
    print(e instanceof CertificateRefused ? e.message : `cert ${command}: ${(e as Error).message}`);
    return 1;
  }
}
