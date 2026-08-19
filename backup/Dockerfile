# System backup sidecar: Wal-G (physical base + continuous WAL), nightly
# encrypted pg_dump (logical layer), images volume tarballs, manifest with
# alembic version, retention and a weekly restore-into-scratch verification.
#
# Debian-based (postgres:16) so the glibc Wal-G binary runs cleanly and we get
# pg_dump/pg_restore/psql, cron, gnupg, zstd and an unprivileged postgres uid.
FROM postgres:16

ARG WALG_VERSION=v3.0.8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl cron gnupg jq tar zstd \
    && curl -fsSL -o /tmp/wal-g.tar.gz \
       "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-amd64.tar.gz" \
    && tar -xzf /tmp/wal-g.tar.gz -C /usr/local/bin \
    && rm /tmp/wal-g.tar.gz \
    && mv /usr/local/bin/wal-g-pg-22.04-amd64 /usr/local/bin/wal-g \
    && chmod +x /usr/local/bin/wal-g \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/backup /backups

COPY scripts/ /opt/backup/
RUN chmod +x /opt/backup/*.sh

ENTRYPOINT ["/opt/backup/entrypoint.sh"]
CMD ["cron", "-f", "-l", "8"]
