"""
Application configuration and settings.
Supports environment-based configuration for easy deployment.
"""

from pydantic_settings import BaseSettings
from typing import Optional
import os


class Settings(BaseSettings):
    """
    App settings loaded from environment variables.

    Structure:
    - API settings (version, host, cors)
    - Firebase settings (uses service account JSON file)
    - Gemini API settings
    - Security settings
    """

    # API Settings
    API_V1_STR: str = "/api/v1"
    API_TITLE: str = "Scan App API"
    API_VERSION: str = "1.0.0"

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    RELOAD: bool = False

    # CORS
    BACKEND_CORS_ORIGINS: list[str] = [
        "http://localhost:8081",
        "http://localhost:5173",
        "http://localhost:80",
    ]
    ALLOWED_HOSTS: list[str] = ["localhost", "127.0.0.1", "backend", "100.80.223.105", "192.168.0.103"]

    # Firebase Settings
    # Path to Firebase service account JSON file
    # Can be set via FIREBASE_CREDENTIALS_PATH env var
    # Defaults to /app/firebaseservice.json (Docker) or ./firebaseservice.json (local dev)
    FIREBASE_CREDENTIALS_PATH: str = os.getenv(
        "FIREBASE_CREDENTIALS_PATH",
        "/app/firebaseservice.json"  # Default Docker path
    )

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_PASSWORD: str = os.getenv("REDIS_PASSWORD", "")

    # PostgreSQL
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql://scanapp:scanapp_dev@localhost:5432/scanapp",
    )
    DATABASE_POOL_MIN: int = 2
    DATABASE_POOL_MAX: int = 20

    # Image storage
    IMAGE_STORAGE_DIR: str = os.getenv(
        "IMAGE_STORAGE_DIR",
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data", "images"),
    )

    # Backup storage
    BACKUP_STORAGE_DIR: str = os.getenv("BACKUP_STORAGE_DIR", "/app/backups")

    # Gemini API
    GEMINI_API_KEY: str

    # Security
    SECRET_KEY: str = "change-me-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30

    # Upload limits
    MAX_UPLOAD_SIZE: int = 10 * 1024 * 1024  # 10 MB per file

    # SQLite database for review batch tracking (transitional — migrating to PostgreSQL)
    REVIEW_BATCH_DB_PATH: str = os.getenv("REVIEW_BATCH_DB_PATH", "")

    # Features
    ENABLE_DOCS: bool = True  # Swagger UI
    USE_POSTGRES: bool = os.getenv("USE_POSTGRES", "false").lower() == "true"  # toggle PG vs Firestore

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
