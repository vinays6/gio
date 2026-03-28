import os

from authlib.integrations.base_client.errors import MismatchingStateError
from authlib.integrations.flask_client import OAuth
from flask import Blueprint, jsonify, redirect, request, session
from google.genai import types

from .google_user_docs import GOOGLE_USER_SCOPES, store_google_oauth_token
from .gemini_constants import ANALYSIS_SYSTEM_PROMPT, VISION_MODEL
from .models import User, db
from .util_gemini import (
    anonymous_gemini_access_enabled,
    gemini_client,
    parse_data_url,
)

api_bp = Blueprint("api", __name__)

oauth = OAuth()
google = oauth.register(
    name="google",
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    api_base_url="https://www.googleapis.com/oauth2/v1/",
    client_kwargs={"scope": " ".join(GOOGLE_USER_SCOPES)},
)


@api_bp.record_once
def on_load(state):
    oauth.init_app(state.app)


def _get_user_from_session() -> User | None:
    user_id = session.get("user")
    if not user_id:
        return None
    return db.session.get(User, user_id)


def _require_agent_access() -> bool:
    return bool(session.get("user")) or anonymous_gemini_access_enabled()


def _resolve_music_preferences(explicit_preferences: str | None) -> str | None:
    if explicit_preferences:
        return explicit_preferences.strip() or None

    user = _get_user_from_session()
    if not user or not user.preferences:
        return None
    return user.preferences.strip() or None


@api_bp.route("/login")
def login():
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173/")
    redirect_uri = frontend_url.rstrip("/") + "/authorize"
    return google.authorize_redirect(
        redirect_uri,
        access_type="offline",
        prompt="consent",
        include_granted_scopes="true",
    )


@api_bp.route("/authorize")
def authorize():
    try:
        token = google.authorize_access_token()
    except MismatchingStateError:
        return redirect("/login")
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    resp = google.get("userinfo")
    user_info = resp.json()
    email = user_info["email"]
    user = User.query.filter_by(email=email).first()
    if not user:
        user = User(email=email, name=user_info.get("name"))
        db.session.add(user)
        db.session.commit()
    else:
        user.name = user_info.get("name")
        db.session.commit()

    session["user"] = user.id
    if isinstance(token, dict):
        store_google_oauth_token(user.id, token)
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173/")
    return redirect(frontend_url)


@api_bp.route("/api/user", methods=["GET"])
def get_user():
    user = _get_user_from_session()
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    return jsonify(
        {"email": user.email, "name": user.name, "preferences": user.preferences}
    )


@api_bp.route("/api/user/preferences", methods=["POST"])
def set_preferences():
    user = _get_user_from_session()
    if not user:
        return jsonify({"error": "Not logged in"}), 401

    payload = request.get_json(silent=True) or {}
    user.preferences = payload.get("preferences")
    db.session.commit()
    return jsonify({"success": True, "preferences": user.preferences})


@api_bp.route("/api/analyze-screen", methods=["POST"])
def analyze_screen():
    if not _require_agent_access():
        return jsonify({"error": "Login required"}), 401

    payload = request.get_json(silent=True) or {}
    image_data_url = (payload.get("imageDataUrl") or "").strip()
    current_music_prompt = (payload.get("currentMusicPrompt") or "ambient").strip()
    user_preferences = _resolve_music_preferences(payload.get("userPreferences"))

    if not image_data_url:
        return jsonify({"error": "imageDataUrl is required"}), 400

    try:
        mime_type, image_bytes = parse_data_url(
            image_data_url, default_mime_type="image/jpeg"
        )
        client = gemini_client(api_version="v1alpha")
    except (RuntimeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    system_instruction = ANALYSIS_SYSTEM_PROMPT
    if user_preferences:
        system_instruction = (
            f"{system_instruction}\n\n"
            "USER MUSIC PREFERENCES:\n"
            f'The user prefers: "{user_preferences}". Factor this into any new music descriptor.'
        )

    try:
        response = client.models.generate_content(
            model=VISION_MODEL,
            config=types.GenerateContentConfig(system_instruction=system_instruction),
            contents=types.Content(
                role="user",
                parts=[
                    types.Part(
                        inline_data=types.Blob(data=image_bytes, mime_type=mime_type)
                    ),
                    types.Part(
                        text=(
                            f"Current music: {current_music_prompt}. "
                            "What should the music be?"
                        )
                    ),
                ],
            ),
        )
    except Exception as exc:
        return jsonify({"error": str(exc) or "Gemini analysis failed"}), 502

    raw_response = (response.text or "").strip()
    activity = raw_response
    music_decision = raw_response or "FALSE"

    for line in raw_response.splitlines():
        if line.startswith("ACTIVITY:"):
            activity = line.removeprefix("ACTIVITY:").strip()
        elif line.startswith("MUSIC:"):
            music_decision = line.removeprefix("MUSIC:").strip() or "FALSE"

    return jsonify(
        {
            "activity": activity,
            "musicDecision": music_decision,
            "rawResponse": raw_response,
        }
    )
