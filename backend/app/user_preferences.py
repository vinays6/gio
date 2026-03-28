"""Helpers for updating app user preferences from realtime tools."""

from __future__ import annotations

from .db_session import session_scope
from .models import User


def update_music_preferences_for_user(user_id: int, preferences: str) -> dict[str, object]:
    cleaned = (preferences or "").strip()
    if not cleaned:
        return {
            "text": "Music preferences cannot be empty.",
            "isError": True,
        }

    with session_scope() as db_session:
        user = db_session.get(User, user_id)
        if not user:
            return {
                "text": "Could not find the signed-in user for this preference update.",
                "isError": True,
            }
        user.preferences = cleaned

    return {
        "text": f"Updated music preferences to: {cleaned}",
        "isError": False,
        "preferences": cleaned,
    }
