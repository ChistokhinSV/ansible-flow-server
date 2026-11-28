#!/bin/sh
# Stops and removes the identity lab (containers, network, volumes: Keycloak and OpenLDAP start
# from realm.json and people.ldif again). Keeps ./out (certificates, passwords) unless "purge".
cd "$(dirname "$0")"
LAB_HOST="${LAB_HOST:-127.0.0.1}" LDAP_ADMIN_PASSWORD=x KEYCLOAK_ADMIN_PASSWORD=x docker compose down -v
if [ "$1" = purge ]; then
  # out/ldap-certs belongs to the OpenLDAP image's user: removed from a container.
  [ -d out/ldap-certs ] && docker run --rm --entrypoint rm -v "$PWD/out:/o" osixia/openldap:1.5.0 -rf /o/ldap-certs
  rm -rf out
fi
true
