#!/bin/sh
# Stops and removes the secret provider lab (containers, network, volumes). Keeps ./out (the
# generated keys and certificates) unless "purge".
cd "$(dirname "$0")"
LAB_HOST="${LAB_HOST:-127.0.0.1}" CONJUR_DATA_KEY=x docker compose down -v
[ "$1" = purge ] && rm -rf out
true
