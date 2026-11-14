// What the server certificate looks like to its readers: the API, the pages and the commands.
// Types only, so the web application can use them without the server's code.

export interface CertificateInfo {
  /** `CN=flows.example.net, O=Example` */
  subject: string;
  issuer: string;
  /** The names it is good for: DNS names and IP addresses. */
  names: string[];
  notBefore: string;
  notAfter: string;
  /** Whole days until it expires; negative once it has. */
  daysLeft: number;
  selfSigned: boolean;
  /** SHA-256 of the certificate, as browsers show it. */
  fingerprint: string;
  /** Certificates that follow it in the file: its chain. */
  chain: number;
}

export type CertificateSource = 'self-signed' | 'installed';

export interface CertificateState {
  tls: 'on' | 'off';
  current?: { source: CertificateSource; info: CertificateInfo };
  previous?: CertificateInfo;
  /** A request waits for its signed certificate. */
  request?: string;
  host?: string;
  defaultNames: string[];
}
