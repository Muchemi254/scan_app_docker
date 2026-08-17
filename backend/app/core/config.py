"""
Application configuration and settings.

Everything operationally tunable is read from the environment — in Docker the
repo-root `.env` file is the single source of truth (docker-compose passes the
values through). Inline defaults here are only safe fallbacks so the code runs
in a bare local-dev environment without a .env file.
"""

from pydantic_settings import BaseSettings
from typing import List, Optional
import os


def _env_bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _split_list(raw: str) -> List[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


class Settings(BaseSettings):
    # API
    API_V1_STR: str = os.getenv("API_V1_STR", "/api/v1")
    API_TITLE: str = os.getenv("API_TITLE", "Scan App API")
    API_VERSION: str = os.getenv("API_VERSION", "1.0.0")

    # Server
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = _env_int("PORT", 8000)
    RELOAD: bool = _env_bool("RELOAD", "false")

    # CORS / allowed hosts — parsed from comma-separated env strings
    # (kept as str fields so pydantic-settings doesn't JSON-decode them).
    BACKEND_CORS_ORIGINS: str = os.getenv(
        "BACKEND_CORS_ORIGINS",
        "http://localhost:8081,http://localhost:5173,http://localhost:80",
    )
    ALLOWED_HOSTS: str = os.getenv("ALLOWED_HOSTS", "*")

    @property
    def cors_origins_list(self) -> List[str]:
        return _split_list(self.BACKEND_CORS_ORIGINS)

    @property
    def allowed_hosts_list(self) -> List[str]:
        return _split_list(self.ALLOWED_HOSTS)

    # Firebase (legacy — only used when AUTH_MODE=firebase)
    FIREBASE_CREDENTIALS_PATH: str = os.getenv(
        "FIREBASE_CREDENTIALS_PATH",
        "/app/firebaseservice.json",  # Default for the Docker image
    )

    # Redis
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")

    # PostgreSQL
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql://scanapp:scanapp_dev@localhost:5432/scanapp",
    )
    DATABASE_POOL_MIN: int = _env_int("DATABASE_POOL_MIN", 2)
    DATABASE_POOL_MAX: int = _env_int("DATABASE_POOL_MAX", 20)

    # Storage
    IMAGE_STORAGE_DIR: str = os.getenv(
        "IMAGE_STORAGE_DIR",
        os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
            "data",
            "images",
        ),
    )
    BACKUP_STORAGE_DIR: str = os.getenv("BACKUP_STORAGE_DIR", "/app/backups")
    MAX_UPLOAD_SIZE: int = _env_int("MAX_UPLOAD_SIZE", 10 * 1024 * 1024)  # 10 MB

    # Background cleanup of deleted users' data (rows + files). Runs on a
    # timer in the app lifetime so deleting a user never blocks on I/O.
    DATA_CLEANUP_INTERVAL_SECONDS: int = _env_int(
        "DATA_CLEANUP_INTERVAL_SECONDS", 300
    )
    # Watchdog: user-delete ops still "running" after this long are marked
    # failed (the background purge died without reporting — see ops_service).
    OP_STALE_AFTER_SECONDS: int = _env_int(
        "OP_STALE_AFTER_SECONDS", 600
    )  # 5 min
    # Don't treat files younger than this as orphans (protects in-flight writes).
    ORPHANED_FILE_MIN_AGE_SECONDS: float = _env_int(
        "ORPHANED_FILE_MIN_AGE_SECONDS", 10 * 60
    )  # 10 min
    # `_scan_*` / `_batch_*` / `_import_*` / `_preview_*` temp dirs older than
    # this are considered abandoned and removed.
    TEMP_DIR_MAX_AGE_SECONDS: float = _env_int(
        "TEMP_DIR_MAX_AGE_SECONDS", 6 * 60 * 60
    )  # 6 h
    # Orphan receipt-image file removal is destructive and has historically
    # mis-classified live files as orphans. It is OFF by default: the sweep
    # still reports candidates but never unlinks them. Turn on only after the
    # reference model is known-good. (`ENABLE_ORPHAN_IMAGE_FILE_DELETE=true`)
    ENABLE_ORPHAN_IMAGE_FILE_DELETE: bool = (
        os.getenv("ENABLE_ORPHAN_IMAGE_FILE_DELETE", "false").strip().lower() == "true"
    )
    # Fire the per-user background purge right after a delete (fire-and-forget,
    # so the delete response never blocks). The periodic sweep is the fallback.
    SCHEDULE_DELETE_CLEANUP: bool = (
        os.getenv("SCHEDULE_DELETE_CLEANUP", "true").lower() in ("1", "true", "yes")
    )

    # Backup storage limits — per-user quota + retention. These are the
    # fallback defaults; admins can override them at runtime via
    # app_settings (see backup API / Admin UI).
    BACKUP_MAX_BYTES_PER_USER: int = _env_int(
        "BACKUP_MAX_BYTES_PER_USER", 5 * 1024 * 1024 * 1024
    )  # 5 GB
    BACKUP_MAX_COUNT_PER_USER: int = _env_int("BACKUP_MAX_COUNT_PER_USER", 3)
    # Refuse writing a backup when less than this much free disk remains.
    BACKUP_MIN_FREE_BYTES: int = _env_int(
        "BACKUP_MIN_FREE_BYTES", 512 * 1024 * 1024
    )  # 512 MB

    # AI
    GEMINI_API_KEY: Optional[str] = os.getenv("GEMINI_API_KEY")

    # Security
    SECRET_KEY: str = os.getenv("SECRET_KEY", "change-me-in-production")
    ALGORITHM: str = os.getenv("ALGORITHM", "HS256")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = _env_int("ACCESS_TOKEN_EXPIRE_MINUTES", 30)

    # Auth mode: "local" (Postgres users + local JWT, fully offline) or
    # "firebase" (Firebase Auth ID tokens, requires internet — legacy).
    AUTH_MODE: str = os.getenv("AUTH_MODE", "local")
    JWT_EXPIRE_DAYS: int = _env_int("JWT_EXPIRE_DAYS", 30)
    # Bootstrap admin (local mode only) — created on first startup.
    ADMIN_EMAIL: Optional[str] = os.getenv("ADMIN_EMAIL")
    ADMIN_PASSWORD: Optional[str] = os.getenv("ADMIN_PASSWORD")

    # SQLite review batch DB (transitional — migrating to PostgreSQL)
    REVIEW_BATCH_DB_PATH: str = os.getenv("REVIEW_BATCH_DB_PATH", "")

    # Features
    ENABLE_DOCS: bool = _env_bool("ENABLE_DOCS", "true")  # Swagger UI
    USE_POSTGRES: bool = _env_bool("USE_POSTGRES", "false")  # PG vs Firestore

    # Logging
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO").upper()

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()