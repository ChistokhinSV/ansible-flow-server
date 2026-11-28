FROM rsyslog/rsyslog:2026-10
# The upstream image has no TLS driver; the Adiscon PPA it already uses carries the matching one.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends rsyslog-openssl && rm -rf /var/lib/apt/lists/*
COPY rsyslog.conf /etc/rsyslog.conf
USER 101
ENTRYPOINT ["rsyslogd", "-n", "-f", "/etc/rsyslog.conf"]
