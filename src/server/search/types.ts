// What a search finds (AFS-69). Types only, so the web application uses them without the server.

export type SearchKind =
  | 'workspace'
  | 'project'
  | 'flow'
  | 'launch-config'
  | 'run'
  | 'environment'
  | 'user'
  | 'group';

export interface SearchHit {
  kind: SearchKind;
  title: string;
  /** Where it is, in a line: workspace/project, file, state. */
  detail: string;
  /** The page it opens. */
  to: string;
}
