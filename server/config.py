"""Application configuration loaded from environment / .env file."""
import os
from pathlib import Path

try:  # optional in production if env vars are set directly
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:  # pragma: no cover
    pass

BASE_DIR = Path(__file__).resolve().parent


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if url:
        return url
    backend = os.environ.get("DB_BACKEND", "sqlite").strip().lower()
    if backend in ("postgres", "postgresql", "pg"):
        user = os.environ.get("PG_USER", "biopharma")
        pw = os.environ.get("PG_PASSWORD", "")
        host = os.environ.get("PG_HOST", "127.0.0.1")
        port = os.environ.get("PG_PORT", "5432")
        db = os.environ.get("PG_DB", "biopharma_hub")
        auth = f"{user}:{pw}@" if pw else f"{user}@"
        return f"postgresql+psycopg://{auth}{host}:{port}/{db}"
    sqlite_path = os.environ.get("SQLITE_PATH", str(BASE_DIR / "dev.db"))
    return f"sqlite:///{sqlite_path}"


def _origins() -> list:
    raw = os.environ.get(
        "ALLOWED_ORIGINS",
        "https://aerobeats.github.io,http://localhost:8099,http://127.0.0.1:8099",
    )
    return [o.strip() for o in raw.split(",") if o.strip()]


class Config:
    DATABASE_URL = _database_url()
    JWT_SECRET = os.environ.get("JWT_SECRET", "dev-insecure-change-me")
    JWT_ALGORITHM = "HS256"
    JWT_EXPIRES_DAYS = int(os.environ.get("JWT_EXPIRES_DAYS", "7"))
    ALLOWED_ORIGINS = _origins()
    IS_SQLITE = _database_url().startswith("sqlite")
