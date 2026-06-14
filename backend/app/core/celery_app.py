from celery import Celery
from celery.signals import worker_process_init
from app.core.config import settings

# Create Celery app instance
celery_app = Celery(
    "worker",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["app.tasks.worker"]
)

# Optional configuration
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
)


@worker_process_init.connect
def init_worker(**kwargs):
    """Initialize DB pool in each Celery worker process."""
    import asyncio as _asyncio
    from app.core.database import init_pool
    loop = _asyncio.get_event_loop()
    loop.run_until_complete(init_pool())
