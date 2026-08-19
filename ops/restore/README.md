# System Backup & Recovery — Runbook

Two layers of backups exist:

- **Per-user data export** (existing, untouched) — `backups` table + tar.gz; a user
  carries their own receipts/images. Logical, single-tenant, manually triggered.
- **Whole-system backup** (this directory) — encrypted Wal-G physical backup +
  continuous WAL (PITR) + nightly logical `pg_dump` + images volumes, all in ONE
  nightly process (`full.sh`), with a combined manifest. Automatic, admin-operated,
  covers the entire cluster.

## The mechanism (industry standard)

| Layer | Tool | Runs | Restores |
|---|---|---|---|
| Physical base backup + PITR | Wal-G (`backup-push` / `wal-fetch`) | nightly full job | full cluster, to any point in time |
| Continuous WAL archiving | `archive_command=wal-g wal-push %p` | every WAL switch | RPO ≈ seconds |
| Logical dump (portability/selective) | `pg_dump --format=custom`, GPG-AES256 | nightly full job | whole DB or chosen tables; cross-version |
| Images + review-batch volumes | `tar`→`zstd`→GPG-AES256 | nightly full job | files, reconciled by `image_sha256` |
| Restore verification | scratch restore + `pg_restore` + archive integrity | weekly Sun 04:00 | proves dumps and image archives are restorable |

The nightly `full.sh` is a SINGLE process: it only reports COMPLETE when *every*
step (Wal-G base, pg_dump, images tarball, combined manifest, retention) succeeded.
DB and images share one timestamp and one manifest (`manifests/<stamp>.json` with
fields `alembic_version`, `walg_start_lsn`, `dump_sha256`, `images_archive`,
`images_sha256`, `complete`), so a restore pair is always consistent by construction.

Store on the `backup_data` volume under `system_backups/` (encrypted):
`wal/` (Wal-G store), `dumps/` (GPG-encrypted), `images/` (GPG-encrypted
tarballs), `keys/` (auto-generated AES-256 key, chmod 640), `manifests/` (JSON
with `alembic_version`, Wal-G LSN, checksums).

## Security

- **Encryption**: Wal-G archives use AES-256 via libsodium key file; dumps AND
  image tarballs use GPG symmetric AES256 with the same store key. Key is
  auto-generated at first sidecar boot and stored only in the `keys/` volume
  (never in Git, never in `docker inspect` env).
- Stores and key are owned by the postgres UID; sidecar runs Wal-G as root.
- 3-2-1: currently one local encrypted copy. To reach 2 media/1 off-site, copy
  `system_backups/` (e.g. `rsync`/`restic`) to external storage and/or a second
  host — the format is self-contained (holds its own WAL + base).

## Retention

- `BACKUP_RETAIN_FULL` (default 7) full Wal-G base backups; their WAL pruned with them.
- `BACKUP_RETAIN_DUMPS` (default 14) encrypted dumps + matching image tarballs + manifests.

## Migration-state handling (since last backup)

Every `manifests/*.json` records the DB's `alembic_version`, so a restore knows
how far back the data is relative to the current app code:

- **Restored data older than app code** → harmless. On promotion the backend
  (which runs migrations at boot, `RUN_MIGRATIONS=true`) applies forward
  migrations `alembic upgrade head` automatically. Forward-only = safe.
- **Restored data newer than app code** → the restore script blocks/prompts;
  do NOT point the app at it until the code is upgraded. Downgrades are unsafe.
- **Equal** → no migration action.

## Take a backup (automatic, but here's the manual form)

```bash
# everything on schedule (crond inside the backup sidecar)
docker compose logs -f backup

# run the full job right now, on demand (DB + images in one process)
docker compose exec backup /opt/backup/full.sh
docker compose exec backup /opt/backup/verify.sh

# images-only archival exists for ad-hoc media refreshes
docker compose exec backup /opt/backup/images.sh

# inspect the catalog
docker compose exec backup wal-g backup-list
docker compose exec backup find /backups/system_backups -maxdepth 2 -type f | sort
```

## Restore (drill it before you need it)

```bash
cd ops/restore
./restore.sh --latest                     # newest base backup
./restore.sh --latest --time '2026-08-17 21:05:00 UTC'   # point-in-time
./restore.sh --backup base_00000001...    # a specific backup
```

What it does (never touches live data):
1. Creates a **fresh** volume + container `scan-app-restore` on a scratch port.
2. `wal-g backup-fetch` the chosen base, writes `postgresql.auto.conf`
   (`restore_command = 'wal-g wal-fetch %f %p'`) + `recovery.signal`, and —
   with `--time` — a `recovery_target_time`, then replays WAL (PITR).
3. Waits for recovery, reports table count + `alembic_version` vs repo head.
4. Prints explicit promotion steps and cleanup.

**Promotion (manual, deliberate):** stop backend/worker/postgres → swap the
compose `postgres` to use the restored volume (or re-point) → start → backend
auto-applies forward migrations → restore the images tarball (decrypt, e.g.
`gpg -d images-<stamp>.tar.zst.gpg | zstd -d | tar -xC /system-raw`) and
reconcile by `image_sha256` → re-run verification.

**PITR timing note:** a `--time` target must lie before the WAL captured by the
oldest still-open segment — the tail of recent activity (the last ~segment) is
only archived once its segment fills or is switched, so seconds-accurate recovery
is for anything older than the current open WAL segment.

**Avoiding conflicts:** restore-to-scratch-first means the live database is
never at risk. Promote only after you validate; on mismatch, discard the scratch
volume and restore again rather than overwriting the live cluster.

## Trouble

- `archive_command` failures appear in postgres logs as `archive command failed`;
  the server retries `.ready` segments automatically, so a late store is healed
  once writable. Confirm with: `select archived_count from pg_stat_archiver;`
- Backup failures are written to the sidecar log and its stdout
  (`docker compose logs backup`) with a FAILED line.
