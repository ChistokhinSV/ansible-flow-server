// AFS-143: the user guide. Pages link the guide page that is about them; the Help page lists them
// all. AFS-155: the server shows the guide of its own version at /help/guide/<page> (the pages
// carry it, guidePage.tsx), so it is there without internet and says what this server does.

export const GUIDE = '/help/guide/';

/** Where the guide's sources are published, for what is not part of the guide. */
export const SOURCES = 'https://github.com/ChistokhinSV/ansible-flow-server';

/** The address of a guide page (`runs.md`, `people-and-sign-in.md#access-tokens`). */
export const guide = (page = 'README.md') => `${GUIDE}${page}`;

/** The guide's pages, as the Help page lists them. */
export const GUIDE_PAGES: { title: string; page: string; about: string }[][] = [
  [
    {
      title: 'Your first flow',
      page: 'first-flow.md',
      about: 'A flow made in the pages: steps, wires, what happens when a step fails, save, launch',
    },
    {
      title: 'Your first project',
      page: 'first-project.md',
      about: 'A workspace, a project from a sample, a launch and an approval, in 15 minutes',
    },
    {
      title: 'The web pages',
      page: 'web-pages.md',
      about: 'Home, the canvas, editing flows and files in the pages, the flow library',
    },
    {
      title: 'Workspaces and projects',
      page: 'workspaces-and-projects.md',
      about: 'Where flows live, and working on a project with git',
    },
  ],
  [
    {
      title: 'Launch configurations',
      page: 'launch-configurations.md',
      about: 'A flow with its inputs, inventory, credentials and image: what Launch runs',
    },
    {
      title: 'Runs',
      page: 'runs.md',
      about: 'The queue, a run on the canvas, its hosts and output, stop and run again',
    },
    {
      title: 'Actions',
      page: 'actions.md',
      about: 'A short form to run an approved thing, for people who do not read flows',
    },
    {
      title: 'Approvals',
      page: 'approvals.md',
      about: 'A run waits at an approval step until someone allowed decides',
    },
    { title: 'Schedules', page: 'schedules.md', about: 'Launch a configuration at set times' },
    {
      title: 'Execution environments',
      page: 'environments.md',
      about: 'The images runs use, built from a list of collections',
    },
    {
      title: 'Credentials',
      page: 'credentials.md',
      about: 'SSH keys, passwords, vault passwords and tokens, kept encrypted',
    },
    {
      title: 'Notifications',
      page: 'notifications.md',
      about: 'Email and webhooks: who is told of what',
    },
    {
      title: 'Event streaming',
      page: 'event-streaming.md',
      about: 'Audit entries and runs to syslog (a SIEM) and OpenTelemetry',
    },
  ],
  [
    {
      title: 'People, groups and sign-in',
      page: 'people-and-sign-in.md',
      about: 'Users, groups, access levels, tokens, OIDC and LDAP',
    },
    {
      title: 'Secret providers',
      page: 'secret-providers.md',
      about: 'Credentials that read their secrets from Vault, CyberArk or AWS when a run starts',
    },
    {
      title: 'HTTPS and the certificate',
      page: 'certificates.md',
      about: "The server's certificate, and trusting a self-signed one",
    },
    {
      title: 'The audit log',
      page: 'audit.md',
      about: 'Who did what and when, filtered and exported',
    },
    { title: 'Configuration', page: 'configuration.md', about: 'Every setting of the server' },
    {
      title: 'Operations',
      page: 'operations.md',
      about: 'Metrics, health checks, backup and restore, upgrades',
    },
  ],
  [
    {
      title: 'The API and agents (MCP)',
      page: 'api-and-mcp.md',
      about: 'The REST API, access tokens, and the MCP endpoint for agents',
    },
    {
      title: 'Ansible collection',
      page: 'collection.md',
      about: "Launch and follow runs, keep the server's objects as code",
    },
  ],
];
