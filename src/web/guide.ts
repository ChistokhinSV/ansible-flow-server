// AFS-143: the user guide. Pages link the guide page that is about them; the Help page lists them
// all. AFS-155: the server shows the guide of its own version at /help/guide/<page> (the pages
// carry it, guidePage.tsx), so it is there without internet and says what this server does.
// AFS-279: ordered around what people do first: edit flows, import playbooks, run playbooks.

export const GUIDE = '/help/guide/';

/** Where the guide's sources are published, for what is not part of the guide. */
export const SOURCES = 'https://github.com/ChistokhinSV/ansible-flow-server';

/** Ansible Flow Designer, the VS Code extension and flow engine this server shares its canvas with. */
export const DESIGNER = 'https://github.com/ChistokhinSV/ansible-flow-designer';

/** The address of a guide page (`runs.md`, `people-and-sign-in.md#access-tokens`). */
export const guide = (page = 'README.md') => `${GUIDE}${page}`;

export const GUIDE_GROUPS = [
  'Edit, import and run',
  'Projects and workflows',
  'Administration and setup',
  'API and automation',
] as const;

/** The guide's pages, as the Help page lists them. */
export const GUIDE_PAGES: { title: string; page: string; about: string }[][] = [
  [
    {
      title: 'Edit flows',
      page: 'edit-flows.md',
      about:
        'Build and edit flows on the canvas or in VS Code with Ansible Flow Designer; shared drafts, save and library',
    },
    {
      title: 'Import playbooks',
      page: 'import-playbooks.md',
      about:
        'Turn existing Ansible playbooks, roles, Git repositories and AWX templates into flows',
    },
    {
      title: 'Run playbooks',
      page: 'runs.md',
      about:
        'Set up a launch configuration (Check or Real), watch hosts and output on the canvas, stop and re-run failed hosts',
    },
    {
      title: 'Debug a run',
      page: 'debugging.md',
      about:
        'Pause at steps or failures, inspect host variables, watch expressions, evaluate Jinja and retry a step',
    },
  ],
  [
    {
      title: 'Workspaces, projects and Git',
      page: 'workspaces-and-projects.md',
      about:
        'Hosted and mirrored Git repositories, editing project files, commit history and branches',
    },
    {
      title: 'Execution environments',
      page: 'environments.md',
      about: 'Container images for runs, built from Ansible collections or pulled from a registry',
    },
    {
      title: 'Credentials',
      page: 'credentials.md',
      about: 'SSH keys, passwords, vault passwords and tokens, kept encrypted',
    },
    {
      title: 'Approvals',
      page: 'approvals.md',
      about: 'Approval gates that pause real runs until someone allowed decides',
    },
    {
      title: 'Actions',
      page: 'actions.md',
      about: 'Short self-service forms and NetBox or Zabbix links for running approved tasks',
    },
    {
      title: 'Schedules',
      page: 'schedules.md',
      about: 'Launch a configuration on a cron or at a set time',
    },
    {
      title: 'Inbox and navigation',
      page: 'inbox-and-navigation.md',
      about: 'Home inbox, cross-workspace views, search, shortcuts and themes',
    },
  ],
  [
    {
      title: 'Install and first setup',
      page: 'install.md',
      about: 'Docker Compose, Linux service, first administrator setup and designer compatibility',
    },
    {
      title: 'People, groups and access',
      page: 'people-and-sign-in.md',
      about: 'Access levels, workspace matrix, tokens, service accounts, OIDC and LDAP',
    },
    {
      title: 'Secret providers',
      page: 'secret-providers.md',
      about: 'Read credentials at run start from Vault, CyberArk or AWS Secrets Manager',
    },
    {
      title: 'HTTPS and the certificate',
      page: 'certificates.md',
      about: 'Request, install, replace or roll back TLS certificates, or run behind a proxy',
    },
    {
      title: 'Notifications',
      page: 'notifications.md',
      about: 'Email and signed webhooks for approvals, runs and server alerts',
    },
    {
      title: 'Event streaming',
      page: 'event-streaming.md',
      about: 'Stream audit entries and runs to syslog (SIEM) and OpenTelemetry',
    },
    {
      title: 'The audit log',
      page: 'audit.md',
      about: 'Who did what and when, filtered by day and exported as CSV or JSON',
    },
    {
      title: 'Configuration',
      page: 'configuration.md',
      about: 'Every AFS_* setting from the environment or .env',
    },
    {
      title: 'Operations',
      page: 'operations.md',
      about: 'Health checks, Prometheus metrics, backup and restore, upgrades',
    },
  ],
  [
    {
      title: 'REST API and agents (MCP)',
      page: 'api-and-mcp.md',
      about: 'OpenAPI, Test Request, access tokens and the MCP endpoint for AI agents',
    },
    {
      title: 'Ansible collection',
      page: 'collection.md',
      about: 'Launch and follow runs from playbooks, and keep server resources as code',
    },
  ],
];
