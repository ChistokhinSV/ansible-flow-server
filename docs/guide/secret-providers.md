# Secret providers

[The guide](README.md)

A credential can keep its secret here, encrypted with the master key (see
[Credentials](credentials.md)), or **take it from a secret provider** your organisation already
runs. The server then reads the value when a run starts, uses it for that run only, and never
writes it anywhere.

| Kind                | Signs in with                                      | A reference names                                                             |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| HashiCorp Vault     | AppRole (role id and secret id), or a token        | KV version 2: mount, path, field, version                                     |
| CyberArk Conjur     | A host and its API key                             | A variable                                                                    |
| CyberArk CCP        | An application id (AppID) and a client certificate | Safe, folder, object, field (`Content` by default)                            |
| AWS Secrets Manager | An access key (and a session token if it has one)  | A secret's name or ARN; a key of a JSON secret, or all of it; a version stage |

## Add a provider

**Administration › Secret providers › Add a provider**. Administrators only.

1. Choose the kind and give it a name (people see it in the credential form and in a run's
   output) and a key (credentials name it by its key).
2. Its address: `https://vault.example.net:8200`. For AWS, the region (`eu-central-1`); the
   address is only for an endpoint other than the region's, such as a VPC endpoint.
3. **Certificate authority**: only when the provider's certificate is not from an authority the
   server already trusts (the system's, and `AFS_CA_FILE`). It is trusted for this provider only.
4. Its own settings and its secret part:
   - Vault: **Sign in with** AppRole or a token; the AppRole mount (`approle`, asked only for
     AppRole), a namespace (Enterprise), the KV mount references read by default (`secret`).
     Changing a provider from AppRole to a token asks for the token at once; the role id, secret
     id and AppRole mount are not kept.
   - Conjur: the account and the host's login (`host/afs`), and the host's API key.
   - CCP: the application id and, when CCP checks the client, the client certificate and its key.
   - AWS: the access key id and secret access key. Assuming a role is not offered yet.

   The secret part is sealed with the master key and never shown again. **Replace** sends a new
   one; rotating the master key reseals it with the rest.
5. **Workspaces that may use it**: only credentials of those workspaces may read from it.

**Test the provider** signs in (Vault, Conjur, AWS) or reaches it with the client certificate
(CCP). Give a reference too and it reads that secret; the value is never shown. The parts a read
needs (for Vault the path and the field) are labelled plainly, the rest "(optional)". A certificate the
server does not trust is said in words that fit: with no authority given, add its authority to the
provider; with one given, that authority does not sign the provider's certificate.

**Change** opens the provider's form above the list, headed with its name ("Change Lab Vault").
For CCP, the field for the client certificate's key opens once a certificate is given.

A provider cannot be removed, change its key, or close a workspace while a credential reads from
it: the refusal names that credential.

## Take a credential's secret from a provider

On a workspace's **Credentials**, an administrator adding or changing a credential chooses, for
each secret part (a password, a private key, a token, a variable's value), **Stored here** or
**From a secret provider**. The form offers the providers open to the workspace.

![A credential's password from a secret provider](images/secret-ref.png)

- Name the provider and where the secret is: for Vault the path (`network/switches`, without
  the mount and `data/`) and the field (`password`). A path written as Vault's API path
  (`secret/data/network/switches`) is refused by Vault; the answer then says to leave the mount
  and `data/` out.
- **Test read** reads it now and says whether it could: "Read OK at 14:02 (value not shown)".
- Saved, the credential holds the reference, not the value.
- **Stored here** and back to **From a secret provider** gives the reference back as it was.
- Changing a credential, a reference is changed as it is; **Replace the secret stored here** is
  about the parts kept on the server only, and is not offered when every part comes from a
  provider. "Kept encrypted on the server" shows only when a part is kept here.

Who sees what:

- The workspace's administrators (read and write on it) see where each part is read from:
  `password from Corp Vault (network/switches#password)`.
- Others see which provider only: `password from Corp Vault`.

## When a run reads them

- Once, when the run really starts: after its approval, or at its schedule's time; not when it is
  asked for. A run that waits at an approval reads again when it goes on.
- Each provider is signed in to once per run. A Vault token the run got with AppRole is revoked
  when the run ends.
- A read that fails ends the run **failed before any container starts**, with words that name the
  credential, the provider and what went wrong, never the path:

  ```text
  Cannot read the credential "Lab switches" (password): HashiCorp Vault refused the read (403): "Corp Vault" may not read this secret
  Cannot read the credential "Lab switches" (password): AWS Secrets Manager "Lab AWS" has no such secret (ResourceNotFoundException)
  ```

  Conjur answers the same for a variable that is not there and one it may not read:
  `CyberArk Conjur "conjur-prod" has no such variable, or this server may not read it (404)`. The
  provider's own message, which names the path, goes only to the server's log.
- Values read are hidden from the run's output and from its events, like stored secrets. A JSON
  secret is hidden whole and value by value.
- The run's output says where each part came from:
  `Credential: login "Lab switches" as netops, password from HashiCorp Vault "Corp Vault"`.
- Every read is in the audit log as `secret-provider.read`, with the run (or, for the launch
  form's inventory, what it was read for), the credential and how it went; tests are
  `secret-provider.test` and `credential.test-read`. A change of a provider lists only the parts
  that changed (`settings`, `name`, `key`, `workspaces`, `secret`); a refused add names the
  provider it was adding. A test that could not
  sign in or read is a _failed_ entry with why (`outcome`: `unreachable`, `auth`, `denied`,
  `not_found`, `tls`, ...); a reference the form got wrong is _refused_.

A project's git credential and an inventory that needs a run's variables read the same way, once
per use. The launch form reads the inventory's groups with only the configuration's environment
variables credentials and its container registry sign-in: a machine password a provider refuses
does not hide the groups (a run of it then fails and says why). When the groups cannot be read,
the form says why under the field.

## The API

| Address (under `/api/v1`)          | Does                                                   | Who            |
| ---------------------------------- | ------------------------------------------------------ | -------------- |
| `/admin/secret-providers`          | List; add                                              | administrators |
| `/admin/secret-providers/:id`      | One (with the credentials that use it); change; remove | administrators |
| `/admin/secret-providers/:id/test` | Sign in; with `ref`, read it too (never the value)     | administrators |
| `/workspaces/:id/secret-providers` | The providers open to the workspace                    | administrators |
| `/workspaces/:id/secret-refs/test` | Test read of a reference                               | administrators |

A credential takes parts from providers with `refs`, by part name:

```sh
curl ... -X POST https://flows.example.net:8443/api/v1/workspaces/network/credentials \
  -d '{"name":"Lab switches","kind":"login","fields":{"username":"netops"},"secret":{},
       "refs":{"password":{"provider":"corp-vault","path":"network/switches","field":"password"}}}'
```

| Kind     | Parts of a reference                  |
| -------- | ------------------------------------- |
| `vault`  | `mount`, `path`, `field`, `version`   |
| `conjur` | `variable`                            |
| `ccp`    | `safe`, `folder`, `object`, `field`   |
| `aws`    | `secretId`, `jsonKey`, `versionStage` |

`PATCH /credentials/:id` with `refs` replaces them whole; `"refs": null` drops them (store the
parts then, with `secret`).
