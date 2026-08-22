# Whole-System Backup — End-User Accessibility Design Considerations

## 1. Problem / Context

- Backups exist in two unrelated systems:
  1. **Per-user backups** (Settings page): tar.gz export/import per account — fully in UI.
  2. **Whole-system backups** (backup sidecar, `ae83052`): encrypted Wal-G base + WAL-PITR + nightly GPG-encrypted `pg_dump` + images tarball + manifest, stored under `system_backups/` on the `backup_data` volume.
- Whole-system backups are **CLI-only** and **never leave the host** — no off-site copy, no UI, no alerting, and the decryption key lives in `keys/.backup_key` right next to the archives.
- Key fact discovered: **the backend already mounts `backup_data:/app/backups`** → `system_backups/` is already reachable from inside the backend container (read + write where needed). No new mounts required for list/download/trigger.

## 2. Store layout (today)

```
backup_data → /backups/system_backups/
  wal/        Wal-G physical base backups + continuous WAL (PITR capability)
  dumps/      nightly pg_dump → GPG-AES256 (custom format)
  images/     image_data + review_batch volumes → zstd tar → GPG-AES256
  keys/       .backup_key — AUTO-GENERATED on first sidecar boot (hext of 32)
  manifests/  JSON {stamp, alembic_version, walg_backup, walg_start_lsn,
                   dump_sha256, dump_size, images_archive, images_sha256,
                   images_size, complete}
```

- Cron (backup sidecar): `full.sh` nightly 02:00, `verify.sh` weekly Sun 04:00. Retention: `BACKUP_RETAIN_FULL` (7 bases), `BACKUP_RETAIN_DUMPS` (14 dumps+images+manifests).
- Encryption: Wal-G = libsodium key-file AES-256; dumps/images = GPG symmetric AES256 (`--passphrase-file keys/.backup_key`).

## 3. Proposed feature set (v1)

### 3.1 Admin download (frontend → backend)

- New admin API (all `Depends(require_admin)` — exists in `backend/app/api/auth.py:121`):
  - `GET /admin/system-backups/status` — last full success, staleness, store size, counts per artifact type, next cron.
  - `GET /admin/system-backups/manifests` — list manifest-paired runs (timestamp, sizes, hashes, alembic version, completeness).
  - `GET /admin/system-backups/artifacts/{type}/{name}` — stream encrypted file (whitelist against store listing; **no path traversal**) with `Content-Disposition: attachment`.
  - `POST /admin/system-backups/trigger` — run `full.sh` on demand.
- Frontend: new **"System Backup"** tab in AdminPage; per-artifact download buttons (blob pattern already used by `backupApi.downloadBackup`); copy-to-clipboard for the external-storage pick-up command.

### 3.2 Encryption key management

- **Proposed:** optional `BACKUP_ENCRYPTION_KEY` in `.env`; sidecar entrypoint:
  - if unset → keep auto-generating into `keys/.backup_key` (backward compatible);
  - if set and no existing key → write key file (`chmod 640`, postgres UID);
  - if set and existing key differs → **refuse to start** (data-loss hazard) with clear log;
  - endpoints may expose whether the key is `.env`-managed vs server-only.
- Hard rule to document+enforce: **never change the key after the first backup** — old archives become undecryptable. Rotation = v2 (re-encrypt all artifacts).
- UI: "Export encryption key" (download `.backup_key`), with a strong warning that losing it = losing the backups. The admin keeps the key on separate media from the archives (no single-file ship-with-key by default).

### 3.3 Restore via frontend

- **Logical restore (supported v1):** decrypt chosen `*.dump.gpg` + replay into the live DB:
  - executor: backend image gains `postgresql-client` + `gnupg` (only if in-app executor chosen);
  - flow: maintenance flag (block writes) → safety pre-restore dump (same pipeline) → `pg_restore --clean --if-exists --single-transaction` → image tarball replay into `image_data` → `image_sha256` reconciliation (reuse per-user import logic) → exit maintenance;
  - progress via existing ops-table/listener pattern (async, redis-backed progress rows);
  - version handling: dump newer than app code → **block**; older → backend auto-migrates on boot.
- **Physical/PITR restore (v2 or CLI-only):** requires `pgdata` volume swap behind compose + scratch container (`ops/restore/restore.sh`); UI shows the exact commands and a drill guide rather than executing.

### 3.4 Existing-DB semantics ("DB always exists on build")

- Postgres creates `POSTGRES_DB` only when `pgdata` is empty at first initdb — the live DB is the **restore target by name**.
- Restore is a **replace-in-place** operation:
  - terminate app connections + maintenance flag before;
  - `pg_restore --clean --if-exists --single-transaction` (atomic — crash leaves old data intact);
  - refuse restore while nightly `full.sh`/verify is running (lock file in store);
  - pre-restore snapshot is mandatory and automatic (and counted in retention).

## 4. Gap list (things beyond the obvious that must be handled)

1. **No failure alerting** — a failed `full.sh` only writes a log line; no one sees it. Add last-success heartbeat → admin dashboard banner + staleness surfaced in `/health`.
2. **Key loss = permanent data loss** — addressed via .env override + separate key export (3.2), but must be explained in UI copy.
3. **All-on-one-disk** — `backup_data` on same host disk as `pgdata`; unbounded growth can fill the disk and kill the app (per-user path already guards with `_check_disk_space`). Add store-size surfacing + admin warning threshold.
4. **No off-host copy** — export bundle + documented rsync/restic path; optional rclone push is a v2.
5. **Restore atomicity / crash-safety** — `--single-transaction`; op row created before work starts; explicit failure transitions.
6. **Version mismatch UX** — old→"auto-migrate on boot", new→blocked, equal→no-op.
7. **Image consistency** — DB rows reference `image_sha256`; missing files after restore must be flagged (reuse existing reconcile from backup import path).
8. **Audit trail** — every list/download/restore/key-export logged (audit table exists).
9. **API hardening** — admin-only; artifact names whitelisted; no symlink/`..` escapes; ETag/last-modified for large files; response streaming (files are GB-scale).
10. **Backend image growth** — `postgresql-client` + `gnupg` ≈ 50–100MB; only acceptable if the in-app executor is chosen.
11. **Concurrency** — restore vs nightly job, restore vs per-user backup export/import, double-click protection on trigger.
12. **Testing** — pytest with mocked subprocess for restore service; compose-level manual drill per runbook; verify.sh stays weekly.

## 5. Open decisions (need answers before implementation)

- D1: **Restore executor** — backend in-app (`postgresql-client`+`gnupg`, no new services) vs backup-sidecar HTTP API (has all binaries+key; enables physical restore later).
- D2: **Key model** — optional `.env` override (`BACKUP_ENCRYPTION_KEY`) vs server-only key with separate download.
- D3: **Restore scope v1** — logical-only via UI (PITR stays CLI with commands shown) vs full PITR in UI (requires docker-socket exposure — not recommended).
- D4: **Download presentation** — per-artifact + key export vs single auto-bundle (key shipped inside) vs both.
