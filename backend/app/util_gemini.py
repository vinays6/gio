import base64
import binascii
import os
import re
from typing import Any

from google import genai

DATA_URL_RE = re.compile(
    r"^data:(?P<mime>[-\w.+/]+);base64,(?P<data>[A-Za-z0-9+/=\s]+)$"
)


def gemini_api_key() -> str:
    key = (
        os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
    ).strip()
    if not key:
        raise RuntimeError("Set GEMINI_API_KEY or GOOGLE_API_KEY in the environment.")
    return key


def gemini_client(*, api_version: str = "v1alpha") -> genai.Client:
    return genai.Client(
        api_key=gemini_api_key(),
        http_options={"api_version": api_version},
    )


def parse_data_url(
    data_url: str, *, default_mime_type: str = "application/octet-stream"
) -> tuple[str, bytes]:
    match = DATA_URL_RE.match((data_url or "").strip())
    if not match:
        raise ValueError("Expected a base64 data URL.")

    mime_type = match.group("mime") or default_mime_type
    try:
        payload = base64.b64decode(match.group("data"), validate=True)
    except binascii.Error as exc:
        raise ValueError("Invalid base64 payload.") from exc
    return mime_type, payload


def anonymous_gemini_access_enabled() -> bool:
    return os.getenv("ALLOW_ANONYMOUS_GEMINI", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def build_live_system_instruction(base_instruction: str) -> dict[str, Any]:
    return {
        "parts": [
            {
                "text": (
                    f"{base_instruction}\n\n"
                    "When a tool is the best way to help the user, call the tool with "
                    "structured arguments instead of asking the user to do it manually."
                )
            }
        ]
    }
