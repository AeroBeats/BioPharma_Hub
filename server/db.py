"""Database engine / session management."""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from config import Config
from models import Base

_connect_args = {}
if Config.IS_SQLITE:
    _connect_args["check_same_thread"] = False

engine = create_engine(Config.DATABASE_URL, future=True, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def init_db() -> None:
    """Create all tables if they do not exist (idempotent)."""
    Base.metadata.create_all(engine)
