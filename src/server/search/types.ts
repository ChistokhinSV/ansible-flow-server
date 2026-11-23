// What a search finds (AFS-69). Types only, so the web application uses them without the server.

export type SearchKind =
  | 'workspace'
  | 'project'
  | 'flow'
  | 'launch-config'
  // AFS-207: an action one may run.
  | 'action'
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
  /** AFS-139: when it happened (a run: when it was made), shown in the viewer's time zone. */
  at?: string;
}
