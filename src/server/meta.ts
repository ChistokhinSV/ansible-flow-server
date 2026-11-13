// What this server is and which flows it reads. Clients (the VS Code extension, the web page)
// compare it with what they were built for before they talk to the server.
import { CURRENT_FORMAT } from '@ansible-flow/core/flow/format';
import designerPackage from '@ansible-flow/core/package.json' with { type: 'json' };
import serverPackage from '../../package.json' with { type: 'json' };

export interface ServerMeta {
  name: string;
  /** This server's version. */
  version: string;
  designer: {
    /** The version of the Ansible Flow Designer packages this server is built on. */
    version: string;
    /** The newest flow format it reads; older formats are read too. */
    format: number;
  };
}

export function serverMeta(): ServerMeta {
  return {
    name: 'Ansible Flow Server',
    version: serverPackage.version,
    designer: { version: designerPackage.version, format: CURRENT_FORMAT },
  };
}
