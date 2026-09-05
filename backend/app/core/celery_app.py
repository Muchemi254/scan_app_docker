from celery import Celery
from app.core.config import settings


def _result_backend_url() -> str:
    """Separate broker (0) vs result backend (1) to avoid LRU eviction of queue."""
    import os

    explicit = os.getenv("CELERY_RESULT_BACKEND")
    if explicit:
        return explicit
    # Default: same host as broker but DB 1
    url = settings.REDIS_URL
    if url.rstrip("/").endswith("/0"):
        return url.rsplit("/0", 1)[0] + "/1"
    if "/0" in url:
        return url.replace("/0", "/1", 1)
    return url


# Create Celery app instance
celery_app = Celery(
    "worker",
    broker=settings.REDIS_URL,
    backend=_result_backend_url(),
    include=["app.tasks.worker"]
)

# Optional configuration
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_soft_time_limit=240,
    task_time_limit=300,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    result_expires=3600,
    broker_transport_options={"visibility_timeout": 3600},
)
