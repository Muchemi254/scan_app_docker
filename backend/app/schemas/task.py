"""
Task progress tracking schemas.

Tracks the status and progress of scanning/processing tasks.
"""

from pydantic import BaseModel
from datetime import datetime
from typing import Optional, Dict, Any
from enum import Enum


class TaskStatus(str, Enum):
    """Task processing status."""
    QUEUED = "queued"          # Waiting to start
    PROCESSING = "processing"  # Currently being processed
    COMPLETED = "completed"    # Successfully completed
    FAILED = "failed"          # Processing failed
    PAUSED = "paused"          # Paused by user


class TaskType(str, Enum):
    """Type of task."""
    SCAN_BATCH = "scan_batch"  # Batch scanning receipts


class TaskProgressUpdate(BaseModel):
    """Update task progress."""
    status: TaskStatus
    current_step: int = 0
    total_steps: int = 0
    percentage: int = 0
    message: str = ""
    error: Optional[str] = None
    completed_items: int = 0


class TaskCreate(BaseModel):
    """Create a new task."""
    task_type: TaskType
    batch_title: str
    total_items: int
    metadata: Dict[str, Any] = {}


class Task(BaseModel):
    """Task model with full details."""
    id: str
    user_id: str
    task_type: TaskType
    batch_title: str
    status: TaskStatus
    total_items: int
    completed_items: int = 0
    current_step: int = 0
    total_steps: int = 0
    percentage: int = 0
    message: str = ""
    error: Optional[str] = None
    metadata: Dict[str, Any] = {}
    created_at: datetime
    updated_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    results: Dict[str, Any] = {}


class TaskList(BaseModel):
    """List of tasks."""
    items: list[Task]
    total: int
    skip: int
    limit: int
