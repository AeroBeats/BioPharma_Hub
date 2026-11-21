"""Flask application factory for the BioPharma Hub backend."""
from __future__ import annotations

import logging

from flask import Flask, g, jsonify
from flask_cors import CORS
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from config import Config
from db import SessionLocal, init_db

log = logging.getLogger("biopharma_hub")


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["JSON_AS_ASCII"] = False
    app.json.ensure_ascii = False

    CORS(
        app,
        origins=Config.ALLOWED_ORIGINS,
        headers=["Content-Type", "Authorization"],
        methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        max_age=86400,
    )

    init_db()

    @app.before_request
    def _open_session():
        g.db = SessionLocal()

    @app.teardown_appcontext
    def _close_session(exc):
        db = g.pop("db", None)
        if db is not None:
            if exc is not None:
                db.rollback()
            db.close()

    # --- blueprints ---
    from routes.auth import bp as auth_bp
    from routes.orgs import bp as orgs_bp
    from routes.admin import bp as admin_bp
    from routes.inventory import bp as inventory_bp
    app.register_blueprint(auth_bp)
    app.register_blueprint(orgs_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(inventory_bp)

    @app.get("/health")
    def health():
        return jsonify(ok=True, service="biopharma-hub-backend",
                       db="sqlite" if Config.IS_SQLITE else "postgresql")

    @app.get("/")
    def root():
        return jsonify(ok=True, service="biopharma-hub-backend",
                       docs="见 server/README.md")

    # --- error handlers ---
    @app.errorhandler(404)
    def _404(e):
        return jsonify(ok=False, error="not_found"), 404

    @app.errorhandler(405)
    def _405(e):
        return jsonify(ok=False, error="method_not_allowed"), 405

    @app.errorhandler(IntegrityError)
    def _integrity(e):
        g.db.rollback()
        log.warning("IntegrityError: %s", e)
        return jsonify(ok=False, error="数据冲突，请重试"), 409

    @app.errorhandler(SQLAlchemyError)
    def _sqlalchemy(e):
        g.db.rollback()
        log.exception("Database error")
        return jsonify(ok=False, error="数据库错误"), 500

    @app.errorhandler(500)
    def _500(e):
        log.exception("Unhandled error")
        return jsonify(ok=False, error="internal_error"), 500

    return app


app = create_app()


if __name__ == "__main__":
    # Local development server. Production uses gunicorn (see wsgi.py / README).
    logging.basicConfig(level=logging.INFO)
    print(f"* DB backend: {'sqlite' if Config.IS_SQLITE else 'postgresql'}")
    print(f"* CORS origins: {Config.ALLOWED_ORIGINS}")
    app.run(host="127.0.0.1", port=8000, debug=False)
