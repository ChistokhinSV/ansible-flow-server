#!/bin/sh
# Starts the event streaming lab on a Docker host (the GNS3 VM): rsyslog (UDP and TCP 10514, TLS
# 6514), an OpenTelemetry collector (gRPC 4317, HTTP 4318) and Jaeger (UI 16686).
#   LAB_HOST=<the host's address> sh up.sh
# What arrives is written to ./out/rsyslog (raw.log, parsed.jsonl) and ./out/otel (logs.jsonl,
# traces.jsonl). The TLS CA the server's destination needs is ./certs/ca.pem (made here, never
# committed).
set -e
cd "$(dirname "$0")"
: "${LAB_HOST:?set LAB_HOST to the address the server sends to}"
mkdir -p certs out/rsyslog out/otel
if [ ! -f certs/ca.pem ]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 365 -subj "/CN=afs lab streaming CA" -keyout certs/ca.key -out certs/ca.pem 2>/dev/null
  openssl req -newkey rsa:3072 -nodes -subj "/CN=spike-s10-rsyslog" -keyout certs/server.key -out certs/server.csr 2>/dev/null
  printf "subjectAltName=DNS:spike-s10-rsyslog,DNS:localhost,IP:%s,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" "$LAB_HOST" > certs/ext.cnf
  openssl x509 -req -in certs/server.csr -CA certs/ca.pem -CAkey certs/ca.key -CAcreateserial -days 365 -extfile certs/ext.cnf -out certs/server.pem 2>/dev/null
  rm -f certs/server.csr certs/ext.cnf certs/ca.srl
  chmod 644 certs/*
fi
chmod 777 out/rsyslog out/otel
docker network inspect spike-s10 >/dev/null 2>&1 || docker network create spike-s10 >/dev/null
docker build -q -t spike-s10-rsyslog:2026-10 rsyslog >/dev/null
docker rm -f spike-s10-rsyslog spike-s10-otel spike-s10-jaeger >/dev/null 2>&1 || true
docker run -d --name spike-s10-jaeger --network spike-s10 -p 16686:16686 jaegertracing/jaeger:2.23.0 >/dev/null
docker run -d --name spike-s10-rsyslog --network spike-s10 -p 10514:10514/udp -p 10514:10514/tcp -p 6514:6514 \
  -v "$PWD/certs:/certs:ro" -v "$PWD/out/rsyslog:/out" spike-s10-rsyslog:2026-10 >/dev/null
docker run -d --name spike-s10-otel --network spike-s10 -p 4317:4317 -p 4318:4318 \
  -v "$PWD/otel/config.yaml:/etc/otelcol-contrib/config.yaml:ro" -v "$PWD/out/otel:/out" \
  otel/opentelemetry-collector-contrib:0.165.0 >/dev/null
docker ps --filter name=spike-s10 --format '{{.Names}} {{.Status}}'
echo "streaming lab up on $LAB_HOST: syslog TLS :6514, TCP/UDP :10514; OTLP HTTP :4318; Jaeger :16686"
