"""WSGI entry point for gunicorn: `gunicorn wsgi:app`."""
from app import app  # noqa: F401

if __name__ == "__main__":
    app.run()
