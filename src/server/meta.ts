// What this server is and which flows it reads. Clients (the VS Code extension, the web page, an
// agent) compare it with what they were built for before they talk to the server (AFS-25):
//   - `api`: the REST API's version; a client made for another refuses to go on;
//   - `designer.formats`: the flow formats the server reads; a flow in another is not run;
//   - `features`: what a client may rely on; a client offers what the server has.
import { CURRENT_FORMAT } from '@ansible-flow/core/flow/format';
import designerPackage from '@ansible-flow/core/package.json' with { type: 'json' };
import serverPackage from '../../package.json' with { type: 'json' };

/**
 * The version of the designer the web pages are built with (@ansible-flow/designer, bundled into
 * dist/web), stamped by the build (scripts/build.mjs) and by the test configuration.
 */
declare const __AFS_DESIGNER_BUNDLE__: string | undefined;

export const API_VERSION = 'v1';

/** What a client may rely on, by name; a name is only ever added. */
export const FEATURES = [
  'git',
  'launch-configs',
  'runs',
  'run-events',
  'approvals',
  'notifications',
  'workspace-tokens',
  'mcp',
] as const;

export interface ServerMeta {
  name: string;
  /** This server's version. */
  version: string;
  designer: {
    /** The version of the Ansible Flow Designer packages this server is built on. */
    version: string;
    /** The newest flow format it reads. */
    format: number;
    /** Every flow format it reads. */
    formats: number[];
    /** The designer's canvas the web pages carry. */
    bundle?: string;
  };
  features: string[];
}

export function serverMeta(): ServerMeta {
  const bundle = typeof __AFS_DESIGNER_BUNDLE__ === 'string' ? __AFS_DESIGNER_BUNDLE__ : undefined;
  return {
    name: 'Ansible Flow Server',
    version: serverPackage.version,
    designer: {
      version: designerPackage.version,
      format: CURRENT_FORMAT,
      formats: Array.from({ length: CURRENT_FORMAT }, (_, i) => i + 1),
      ...(bundle ? { bundle } : {}),
    },
    features: [...FEATURES],
  };
}
