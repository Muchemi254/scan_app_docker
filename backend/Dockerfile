# Multi-stage build for FastAPI backend

# Build stage
FROM python:3.11-slim as builder

WORKDIR /app

# Install build dependencies (libpq-dev needed for asyncpg)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Create virtualenv for isolated Python packages
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Dev/test dependencies (pytest). Installed into the same venv so tests can
# run inside the container: docker exec ... python -m pytest tests
COPY requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt

# Runtime stage
FROM python:3.11-slim

WORKDIR /app

# Install runtime dependencies (libpq5 needed for asyncpg at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root app user
RUN useradd --create-home --shell /bin/bash appuser

# Copy virtualenv from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application code
COPY app/ ./app/
COPY alembic.ini .
COPY alembic/ ./alembic/
COPY scripts/ ./scripts/
COPY pytest.ini .
COPY tests/ ./tests/

# Ensure data directories exist and belong to appuser
RUN mkdir -p /app/data /app/data/images /app/backups && chown -R appuser:appuser /app

# Entrypoint script to fix volume permissions at runtime
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

# Copy entrypoint script (runs as root to fix volume permissions, then drops to appuser)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Drop to non-root user (entrypoint runs as root via docker-compose user: root)
USER appuser

# Health check (needs curl, runs as appuser)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Expose port
EXPOSE 8000

# Run application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
