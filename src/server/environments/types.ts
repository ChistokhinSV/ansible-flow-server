// What an execution environment looks like to the API and the pages (AFS-32). Types only, so the
// web application uses them without the server's code.

/** A collection an environment asks for: a version (`8.7.1`), a range (`>=8.0.0,<9`) or `latest`. */
export interface CollectionWant {
  name: string;
  version: string;
}

export interface EnvironmentSpec {
  /** The Python image the environment starts from. */
  baseImage: string;
  /** ansible-core as `2.19` (the newest 2.19.x) or `2.19.3`. */
  ansibleCore: string;
  collections: CollectionWant[];
  /** pip requirements, one per line as pip reads them. */
  python: string[];
  /** Debian packages. */
  system: string[];
  /** Extra certificate authorities (PEM) the image trusts: for a private Galaxy, pip index, hosts. */
  caCertificates?: string;
}

export type EnvironmentKind = 'spec' | 'image';
export type BuildState = 'queued' | 'building' | 'done' | 'failed';

/** What a built image holds, read from it after the build. */
export interface ImageCatalog {
  ansibleCore: string;
  /** Installed collections, name to version. */
  collections: Record<string, string>;
}

export interface EnvironmentBuild {
  id: string;
  environment: string;
  number: number;
  state: BuildState;
  /** The image's name: `afs-ee/<workspace>-<environment>:<hash>`. */
  image?: string;
  /** The versions the build resolved and installed. */
  lock?: { baseImage: string; ansibleCore: string; collections: Record<string, string> };
  catalog?: ImageCatalog;
  error?: string;
  /** The image was removed from the engine to make room (newer builds were kept). */
  pruned: boolean;
  by: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface Environment {
  id: string;
  workspace: string;
  name: string;
  description?: string;
  kind: EnvironmentKind;
  /** For a registered image: its name, as the engine pulls it. */
  image?: string;
  spec?: EnvironmentSpec;
  /** How many built images are kept on the engine; older ones are removed. */
  keep: number;
  /** The image a launch gets now: the newest good build's, or the registered image. */
  current?: string;
  /** The newest build, whatever its state. */
  latest?: EnvironmentBuild;
  /** What the image a launch gets holds (from its build, or read from a registered image). */
  catalog?: ImageCatalog;
  /** Launch configurations that run in it. */
  usedBy: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentInput {
  name: string;
  description?: string | null;
  kind: EnvironmentKind;
  image?: string;
  spec?: EnvironmentSpec;
  keep?: number;
}
