// AFS-141: the kinds of thing the audit log records, for the page's About filter. Shared by the
// page and a test, so a kind the server records is never missing from the filter.
/**
 * What an action is about, for the filter: the part of its name before the dot, in words.
 * AFS-141: every kind the server records (test/unit/audit.test.ts holds it to routes.ts).
 */
export const AUDIT_KINDS: Record<string, string> = {
  session: 'sign-in and sign-out',
  user: 'people',
  group: 'groups',
  token: 'access tokens',
  grant: 'access grants',
  workspace: 'workspaces',
  project: 'projects',
  draft: 'flow drafts',
  git: 'git pushes',
  credential: 'credentials',
  'launch-config': 'launch configurations',
  schedule: 'schedules',
  environment: 'environments',
  run: 'runs',
  approval: 'approvals',
  'dev-bundle': 'designer uploads',
  notification: 'notifications',
  certificate: 'server certificate',
  'sign-in': 'sign-in settings',
  'oidc-provider': 'sign-in providers',
  'ldap-directory': 'directories',
  'master-key': 'master key',
  audit: 'audit log exports',
};
