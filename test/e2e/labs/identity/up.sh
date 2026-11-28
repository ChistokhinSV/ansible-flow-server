#!/bin/sh
# Starts the identity lab on a Docker host (the GNS3 VM): Keycloak (OIDC, https :18843) and
# OpenLDAP (ldaps :10636, StartTLS :10389), with the fictional people of realm.json and people.ldif.
#   LAB_HOST=<the host's address> AFS_URLS="<server address> [<another>]" sh up.sh
# AFS_URLS are the servers' public addresses (https://host:port, as the browser opens them): the
# Keycloak client accepts their OIDC callbacks. Generated in ./out, never committed:
#   certs/ca.pem          the lab CA; a server trusts it with AFS_CA_FILE
#   people.txt            login:password of sam.reyes, nora.lind, lee.okafor (same in both)
#   oidc-client-secret    the secret of Keycloak client "afs"
#   ldap-admin-password   cn=admin,dc=example,dc=net
#   keycloak-admin-password  Keycloak's admin console (user admin)
# Run again at any time: it keeps what out/ has and starts what is stopped.
set -e
cd "$(dirname "$0")"
: "${LAB_HOST:?set LAB_HOST to the address the lab's ports are published on}"
: "${AFS_URLS:?set AFS_URLS to the server addresses that sign in with this lab}"
export LAB_HOST
mkdir -p out/certs out/ldap-certs out/realm
secret() { [ -s "out/$1" ] || openssl rand -base64 18 | tr -d '/+=' > "out/$1"; cat "out/$1"; }

# --- One CA for both servers' certificates (Keycloak and OpenLDAP), for LAB_HOST and their names.
if [ ! -f out/certs/server.pem ]; then
  (
    cd out/certs
    openssl req -x509 -newkey rsa:3072 -nodes -days 365 -keyout ca.key -out ca.pem -subj "/CN=afs lab identity CA" 2>/dev/null
    openssl req -newkey rsa:3072 -nodes -keyout server.key -out server.csr -subj "/CN=afs-lab-identity" 2>/dev/null
    printf 'subjectAltName=IP:%s,DNS:afs-lab-keycloak,DNS:afs-lab-openldap,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' "$LAB_HOST" > server.ext
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 365 -out server.pem -extfile server.ext 2>/dev/null
    rm -f server.csr server.ext ca.srl
    # Keycloak runs as uid 1000: a lab key, readable.
    chmod 644 ca.pem server.pem server.key
  )
fi
# The OpenLDAP image makes the copies its own (owner and mode): copy once.
[ -f out/ldap-certs/server.pem ] || cp out/certs/ca.pem out/certs/server.pem out/certs/server.key out/ldap-certs/

# --- The people's passwords, the client secret, the admin passwords.
PW_SAM=$(secret pw-sam); PW_NORA=$(secret pw-nora); PW_LEE=$(secret pw-lee)
printf 'sam.reyes:%s\nnora.lind:%s\nlee.okafor:%s\n' "$PW_SAM" "$PW_NORA" "$PW_LEE" > out/people.txt
CLIENT_SECRET=$(secret oidc-client-secret)
LDAP_ADMIN_PASSWORD=$(secret ldap-admin-password); export LDAP_ADMIN_PASSWORD
KEYCLOAK_ADMIN_PASSWORD=$(secret keycloak-admin-password); export KEYCLOAK_ADMIN_PASSWORD
URIS=""
for u in $AFS_URLS; do URIS="$URIS${URIS:+, }\"${u%/}/api/v1/auth/oidc/*\""; done
sed -e "s|@@PW_SAM@@|$PW_SAM|; s|@@PW_NORA@@|$PW_NORA|; s|@@PW_LEE@@|$PW_LEE|" \
  -e "s|@@CLIENT_SECRET@@|$CLIENT_SECRET|; s|\"@@REDIRECT_URIS@@\"|$URIS|" realm.json > out/realm/afs-lab.json
sed -e "s|@@PW_SAM@@|$PW_SAM|; s|@@PW_NORA@@|$PW_NORA|; s|@@PW_LEE@@|$PW_LEE|" people.ldif > out/people.ldif
chmod 600 out/people.txt out/pw-* out/*-secret out/*-password
chmod 644 out/realm/afs-lab.json

docker compose up -d "$@"

# --- OpenLDAP: the people and groups, once (ldapadd -c goes on past entries that exist).
# On a first start the image runs slapd once to set itself up and stops it: wait for the real one.
for i in $(seq 60); do
  docker logs afs-lab-openldap 2>&1 | grep -q "slapd starting" &&
    docker exec afs-lab-openldap ldapsearch -x -H ldap://localhost -b dc=example,dc=net -D cn=admin,dc=example,dc=net \
    -w "$LDAP_ADMIN_PASSWORD" -s base >/dev/null 2>&1 && break
  sleep 2
done
docker cp out/people.ldif afs-lab-openldap:/tmp/people.ldif
docker exec afs-lab-openldap ldapadd -c -x -H ldap://localhost -D cn=admin,dc=example,dc=net -w "$LDAP_ADMIN_PASSWORD" \
  -f /tmp/people.ldif >/dev/null 2>&1 || true

# --- Keycloak: wait for the realm's OIDC discovery.
for i in $(seq 90); do
  curl -sf --cacert out/certs/ca.pem "https://$LAB_HOST:18843/realms/afs-lab/.well-known/openid-configuration" >/dev/null && break
  sleep 2
done
curl -sf --cacert out/certs/ca.pem "https://$LAB_HOST:18843/realms/afs-lab/.well-known/openid-configuration" >/dev/null ||
  { echo "Keycloak does not answer for realm afs-lab: see docker logs afs-lab-keycloak" >&2; exit 1; }
docker exec afs-lab-openldap ldapsearch -x -H ldap://localhost -b ou=people,dc=example,dc=net -D cn=admin,dc=example,dc=net \
  -w "$LDAP_ADMIN_PASSWORD" "(uid=sam.reyes)" uid | grep -q "uid: sam.reyes" ||
  { echo "OpenLDAP does not hold the people of people.ldif" >&2; exit 1; }
echo "identity lab up on $LAB_HOST: Keycloak https://$LAB_HOST:18843/realms/afs-lab, LDAP ldaps://$LAB_HOST:10636 (StartTLS :10389)"
