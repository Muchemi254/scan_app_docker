# PostgreSQL 16 with Wal-G for system backups (WAL archiving + PITR).
#
# The stock postgres:16-alpine image is augmented with the Wal-G binary so the
# server itself can archive WAL segments (archive_command → wal-g wal-push) to
# the encrypted backup store mounted at /backups.  No app code is touched.
#
# NOTE: the official Wal-G release binary is built for glibc (Ubuntu 22.04), so
# this must stay on the Debian-based `postgres:16` image (not -alpine) or the
# loader won't be found at runtime.
FROM postgres:16

ARG WALG_VERSION=v3.0.8

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL -o /tmp/wal-g.tar.gz \
       "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-amd64.tar.gz" \
    && tar -xzf /tmp/wal-g.tar.gz -C /usr/local/bin \
    && rm /tmp/wal-g.tar.gz \
    && mv /usr/local/bin/wal-g-pg-22.04-amd64 /usr/local/bin/wal-g \
    && chmod +x /usr/local/bin/wal-g \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*
