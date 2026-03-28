import os

from dotenv import load_dotenv
from flask import Flask
from flask_cors import CORS
from flask_sock import Sock

load_dotenv()

from .debug_ws import register_debug_ws
from .google_user_docs import ensure_google_oauth_columns
from .live_ws import register_live_ws
from .lyria_ws import register_lyria_ws
from .models import db
from .realtime_server import ensure_realtime_server_started
from .routes import api_bp

sock = Sock()


def create_app():
    app = Flask(__name__, instance_relative_config=True)
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///users.db"
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["SECRET_KEY"] = os.getenv(
        "FLASK_SECRET_KEY", "dev-secret-key-change-in-prod"
    )
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = os.getenv(
        "SESSION_COOKIE_SAMESITE", "Lax"
    )
    app.config["SESSION_COOKIE_SECURE"] = (
        os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
    )
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")

    db.init_app(app)
    sock.init_app(app)
    CORS(
        app,
        supports_credentials=True,
        origins=[frontend_url, "http://127.0.0.1:5173", "http://localhost:5173"],
    )

    with app.app_context():
        db.create_all()
        ensure_google_oauth_columns()

    app.register_blueprint(api_bp)
    register_debug_ws(sock)
    register_live_ws(sock)
    register_lyria_ws(sock)
    ensure_realtime_server_started()

    return app
