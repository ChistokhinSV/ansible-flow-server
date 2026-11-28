#!/bin/sh
# Stops and removes the event streaming lab; keeps certs/ and out/ unless "purge".
cd "$(dirname "$0")"
docker rm -f spike-s10-rsyslog spike-s10-otel spike-s10-jaeger >/dev/null 2>&1
docker network rm spike-s10 >/dev/null 2>&1
[ "$1" = purge ] && rm -rf certs out && docker rmi spike-s10-rsyslog:2026-10 >/dev/null 2>&1
true
