#!/bin/sh
# Starts the secret provider lab on a Docker host (the GNS3 VM) and seeds fictional secrets.
#   LAB_HOST=<the host's address> sh up.sh
# Writes what the tests need to ./out (generated here, never committed): vault-ca.pem,
# vault-role-id, vault-secret-id, vault-token, conjur-host-key, and in out/ccp-client the CCP
# mock's CA with a client certificate it trusts (ca.pem, client.pem, client.key) and one it does
# not (stranger.pem, stranger.key). Run again at any time: it starts what is stopped and seeds again.
set -e
cd "$(dirname "$0")"
: "${LAB_HOST:?set LAB_HOST to the address the lab's ports are published on}"
export LAB_HOST
mkdir -p out/vault-tls out/ccp out/ccp-client
[ -f out/conjur-data-key ] || openssl rand -base64 32 > out/conjur-data-key
CONJUR_DATA_KEY="$(cat out/conjur-data-key)"
export CONJUR_DATA_KEY

# --- The CCP mock's CA, server certificate and client certificates (once).
if [ ! -f out/ccp-client/client.pem ]; then
  (
    cd out/ccp-client
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout ca.key -out ca.pem -subj "/CN=afs lab CCP CA" 2>/dev/null
    for n in server client; do
      openssl req -newkey rsa:2048 -nodes -keyout $n.key -out $n.csr -subj "/CN=afs-lab-ccp-$n" 2>/dev/null
    done
    printf 'subjectAltName=IP:%s,DNS:spike-s9-ccp,DNS:localhost\nextendedKeyUsage=serverAuth\n' "$LAB_HOST" > server.ext
    printf 'extendedKeyUsage=clientAuth\n' > client.ext
    for n in server client; do
      openssl x509 -req -in $n.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 365 -out $n.pem -extfile $n.ext 2>/dev/null
    done
    # A client certificate from no known CA: the mock must refuse it.
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout stranger.key -out stranger.pem -subj "/CN=stranger" 2>/dev/null
    rm -f ./*.csr ./*.ext ./*.srl
    chmod 644 ./*
  )
fi
cp ccp/ccp-mock.mjs out/ccp/ && cp out/ccp-client/ca.pem out/ccp-client/server.pem out/ccp-client/server.key out/ccp/

# A Vault dev container that was stopped does not start again (it panics): make it anew.
docker compose rm -sf vault >/dev/null 2>&1 || true
docker compose up -d "$@"

# --- Vault: KV v2 at secret/ (dev mode has it), AppRole role afs-spike with a read-only policy.
V="docker exec -i -e VAULT_ADDR=https://127.0.0.1:8200 -e VAULT_CACERT=/vault/tls/vault-ca.pem -e VAULT_TOKEN=spike-s9-root spike-s9-vault vault"
for i in $(seq 30); do $V status >/dev/null 2>&1 && break; sleep 1; done
$V kv put secret/lab/switch password=lab-switch-password-1 username=netops >/dev/null
$V kv put secret/lab/other password=lab-other-password-2 >/dev/null
printf 'path "secret/data/lab/*" { capabilities = ["read"] }\npath "secret/data/lab/other" { capabilities = ["deny"] }\n' | $V policy write afs-read - >/dev/null
$V auth enable approle >/dev/null 2>&1 || true
$V write auth/approle/role/afs-spike token_policies=afs-read token_ttl=10m secret_id_ttl=0 >/dev/null
$V read -field=role_id auth/approle/role/afs-spike/role-id > out/vault-role-id
$V write -f -field=secret_id auth/approle/role/afs-spike/secret-id > out/vault-secret-id
$V token create -policy=afs-read -ttl=24h -field=token > out/vault-token
rm -f out/vault-ca.pem && cp out/vault-tls/vault-ca.pem out/vault-ca.pem

# --- Conjur: account, policy, a value for the variable.
for i in $(seq 60); do docker exec spike-s9-conjur conjurctl wait -r 1 >/dev/null 2>&1 && break; sleep 2; done
if [ ! -s out/conjur-admin-key ]; then
  docker exec spike-s9-conjur conjurctl account create spike 2>/dev/null | sed -n 's/.*API key for admin: //p' > out/conjur-admin-key
fi
C="http://$LAB_HOST:18080"
TOKEN=$(curl -sf -X POST --data-binary "$(cat out/conjur-admin-key)" "$C/authn/spike/admin/authenticate" -H 'Accept-Encoding: base64')
curl -sf -X POST -H "Authorization: Token token=\"$TOKEN\"" --data-binary @conjur-policy.yml "$C/policies/spike/policy/root" > out/conjur-policy-result.json
node_key() { sed -n "s/.*\"spike:host:$1\":{\"id\":\"spike:host:$1\",\"api_key\":\"\([^\"]*\)\".*/\1/p" out/conjur-policy-result.json; }
k=$(node_key afs-spike); [ -n "$k" ] && echo "$k" > out/conjur-host-key
k=$(node_key afs-nobody); [ -n "$k" ] && echo "$k" > out/conjur-nobody-key
curl -sf -X POST -H "Authorization: Token token=\"$TOKEN\"" --data 'lab-switch-password-1' "$C/secrets/spike/variable/lab%2Fswitch-password"
curl -sf -X POST -H "Authorization: Token token=\"$TOKEN\"" --data 'lab-other-password-2' "$C/secrets/spike/variable/lab%2Fother-secret"

# --- LocalStack Secrets Manager: one secret (dummy keys test/test), in both regions the tests use.
if docker ps --format "{{.Names}}" | grep -q spike-s9-localstack; then
  for i in $(seq 60); do curl -sf "http://$LAB_HOST:14566/_localstack/health" >/dev/null 2>&1 && break; sleep 2; done
  for region in us-east-1 eu-central-1; do
    docker exec spike-s9-localstack awslocal --region $region secretsmanager create-secret --name lab/switch \
      --secret-string '{"username":"netops","password":"lab-switch-password-1"}' >/dev/null 2>&1 || true
  done
fi
echo "secret provider lab up on $LAB_HOST: Vault :18200, Conjur :18080, LocalStack :14566, CCP :18443"
