"""Synchronous SQLAlchemy session for Quart async routes (via asyncio.to_thread)."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

BACKEND_ROOT = Path(__file__).resolve().parent.parent
INSTANCE_DIR = BACKEND_ROOT / "instance"
INSTANCE_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = f"sqlite:///{INSTANCE_DIR / 'users.db'}"


class Base(DeclarativeBase):
    pass


engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(engine, class_=Session, expire_on_commit=False)


@contextmanager
def session_scope():
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()
