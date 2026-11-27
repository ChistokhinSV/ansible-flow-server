# Secret providers

[The guide](README.md)

Instead of storing secrets on the server, workspace [credentials](credentials.md) can reference
secrets held in an external vault. The server fetches each secret **only when a run starts** (or
resumes after an approval), masks it everywhere in output and the [debugger](debugging.md), and
never writes the value to the database.

| Provider                | Authentication                                         | Secret reference fields                                                       |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **HashiCorp Vault**     | AppRole (role ID + secret ID) or token                 | KV v2 `mount`, `path` (without mount or `data/`), `field`, optional `version` |
| **CyberArk Conjur**     | Host login (`host/afs`) and API key                    | `variable`                                                                    |
| **CyberArk CCP**        | Application ID (`AppID`) and optional mTLS cert/key    | `safe`, `folder`, `object`, `field` (`Content` default)                       |
| **AWS Secrets Manager** | Access key ID, secret key (and optional session token) | `secretId` (name or ARN), optional `jsonKey` and `versionStage`               |

## 1. Configure a provider

Administrators add providers under **Govern › Server › Secret providers** (`/admin/secret-providers`):

1. Pick the provider kind, display name, key, address (or AWS region), and optional custom CA
   certificate.
2. Enter the provider's authentication credentials (sealed with the master key) and select which
   **workspaces** are allowed to reference it.
3. Click **Test the provider** (optionally supplying a test reference) to verify connectivity and
   read permissions without exposing the secret value.

## 2. Reference secrets in a workspace credential

![Referencing an external secret provider on a workspace credential](images/secret-ref.png)

Under **Build › Credentials**, choose **From a secret provider** on any secret field (password, SSH
private key, token, or environment variable):

- Select an allowed provider, enter the secret's path/field, and click **Test read** (_Read OK —
  value not shown_).
- Workspace administrators (`rw`) see the provider and reference path; other readers see only the
  provider's name.

## Runtime behaviour

- Secrets are resolved once per run right before the container starts (Vault AppRole tokens minted
  for the run are revoked when the run finishes).
- If a secret cannot be read, the run **fails before any container starts** with a clear message
  naming the credential and provider (detailed provider paths stay in the server log only), and
  every read or test is recorded in the [audit log](audit.md) (`secret-provider.read`).
