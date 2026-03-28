"""Create Google Docs with the signed-in user's OAuth token."""

from __future__ import annotations

import base64
from datetime import datetime
import logging
from email.mime.text import MIMEText
from typing import Any

from sqlalchemy import text

from .db_session import session_scope
from .models import User

log = logging.getLogger(__name__)

GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
GOOGLE_USER_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/gmail.send",
]


def _normalize_scope(scope_value: Any) -> str:
    if isinstance(scope_value, str):
        return " ".join(part for part in scope_value.split() if part)
    if isinstance(scope_value, list):
        return " ".join(str(part).strip() for part in scope_value if str(part).strip())
    return ""


def ensure_google_oauth_columns() -> None:
    table_name = User.__table__.name
    required_columns = {
        "google_access_token": "TEXT",
        "google_refresh_token": "TEXT",
        "google_token_expiry": "INTEGER",
        "google_token_scope": "TEXT",
    }

    with session_scope() as db_session:
        existing = {
            row[1]
            for row in db_session.execute(text(f"PRAGMA table_info({table_name})"))
        }
        for column_name, column_type in required_columns.items():
            if column_name in existing:
                continue
            db_session.execute(
                text(
                    f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}"
                )
            )


def store_google_oauth_token(user_id: int, token: dict[str, Any]) -> None:
    access_token = (token.get("access_token") or token.get("token") or "").strip()
    refresh_token = (token.get("refresh_token") or "").strip() or None
    expires_at = token.get("expires_at")
    try:
        expires_at_int = int(expires_at) if expires_at is not None else None
    except (TypeError, ValueError):
        expires_at_int = None
    scope_text = _normalize_scope(token.get("scope"))

    if not access_token:
        return

    with session_scope() as db_session:
        user = db_session.get(User, user_id)
        if not user:
            return
        user.google_access_token = access_token
        if refresh_token:
            user.google_refresh_token = refresh_token
        user.google_token_expiry = expires_at_int
        if scope_text:
            user.google_token_scope = scope_text


def create_google_doc_for_user(
    user_id: int, title: str, body: str, share_with: str | None = None
) -> dict[str, Any]:
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
    except ImportError:
        return {
            "text": (
                "Google Docs dependencies are missing in the backend environment. "
                "Install requirements.txt so google-api-python-client and google-auth are available."
            ),
            "isError": True,
        }

    with session_scope() as db_session:
        user = db_session.get(User, user_id)
        if not user or not user.google_access_token:
            return {
                "text": (
                    "Google Docs is not connected for this user. Sign in again with Google "
                    "to grant Docs access."
                ),
                "isError": True,
            }

        scopes = (
            user.google_token_scope.split()
            if user.google_token_scope
            else list(GOOGLE_USER_SCOPES)
        )
        required_scopes = {
            "https://www.googleapis.com/auth/documents",
            "https://www.googleapis.com/auth/drive.file",
        }
        if not required_scopes.issubset(set(scopes)):
            return {
                "text": (
                    "Google Docs access has not been granted for this user yet. "
                    "Sign out and sign in again to grant Docs and Drive permissions."
                ),
                "isError": True,
            }

        import os

        credentials = Credentials(
            token=user.google_access_token,
            refresh_token=user.google_refresh_token,
            token_uri=GOOGLE_TOKEN_URI,
            client_id=os.getenv("GOOGLE_CLIENT_ID"),
            client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
            scopes=scopes,
            expiry=(
                datetime.utcfromtimestamp(user.google_token_expiry)
                if user.google_token_expiry
                else None
            ),
        )

        try:
            if not credentials.valid:
                if credentials.refresh_token:
                    credentials.refresh(Request())
                    user.google_access_token = credentials.token
                    if credentials.refresh_token:
                        user.google_refresh_token = credentials.refresh_token
                    if credentials.expiry:
                        user.google_token_expiry = int(credentials.expiry.timestamp())
                    if credentials.scopes:
                        user.google_token_scope = " ".join(credentials.scopes)
                else:
                    return {
                        "text": (
                            "Google Docs access expired for this user. Sign in again with Google "
                            "to refresh permissions."
                        ),
                        "isError": True,
                    }

            docs_service = build(
                "docs", "v1", credentials=credentials, cache_discovery=False
            )
            drive_service = build(
                "drive", "v3", credentials=credentials, cache_discovery=False
            )

            created = docs_service.documents().create(body={"title": title}).execute()
            document_id = created["documentId"]
            docs_service.documents().batchUpdate(
                documentId=document_id,
                body={
                    "requests": [
                        {"insertText": {"location": {"index": 1}, "text": body}}
                    ]
                },
            ).execute()

            if share_with:
                drive_service.permissions().create(
                    fileId=document_id,
                    body={"type": "user", "role": "writer", "emailAddress": share_with},
                    sendNotificationEmail=False,
                ).execute()
        except HttpError as exc:
            log.exception(
                "User Google Docs creation failed for user_id=%s title=%r",
                user_id,
                title,
            )
            return {
                "text": f"Google Docs creation failed: {exc}",
                "isError": True,
            }
        except Exception as exc:
            log.exception(
                "Unexpected user Google Docs creation failure for user_id=%s title=%r",
                user_id,
                title,
            )
            return {
                "text": f"Google Docs creation failed: {exc}",
                "isError": True,
            }

    return {
        "text": f"Created Google Doc {title!r}: https://docs.google.com/document/d/{document_id}/edit",
        "isError": False,
    }


def send_gmail_for_user(user_id: int, to: str, subject: str, body: str) -> dict[str, Any]:
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
    except ImportError:
        return {
            "text": (
                "Gmail dependencies are missing in the backend environment. "
                "Install requirements.txt so google-api-python-client and google-auth are available."
            ),
            "isError": True,
        }

    with session_scope() as db_session:
        user = db_session.get(User, user_id)
        if not user or not user.google_access_token:
            return {
                "text": (
                    "Gmail is not connected for this user. Sign in again with Google "
                    "to grant Gmail access."
                ),
                "isError": True,
            }

        scopes = (
            user.google_token_scope.split()
            if user.google_token_scope
            else list(GOOGLE_USER_SCOPES)
        )
        if "https://www.googleapis.com/auth/gmail.send" not in set(scopes):
            return {
                "text": (
                    "Gmail send access has not been granted for this user yet. "
                    "Sign out and sign in again to grant Gmail permissions."
                ),
                "isError": True,
            }

        import os

        credentials = Credentials(
            token=user.google_access_token,
            refresh_token=user.google_refresh_token,
            token_uri=GOOGLE_TOKEN_URI,
            client_id=os.getenv("GOOGLE_CLIENT_ID"),
            client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
            scopes=scopes,
            expiry=(
                datetime.utcfromtimestamp(user.google_token_expiry)
                if user.google_token_expiry
                else None
            ),
        )

        try:
            if not credentials.valid:
                if credentials.refresh_token:
                    credentials.refresh(Request())
                    user.google_access_token = credentials.token
                    if credentials.refresh_token:
                        user.google_refresh_token = credentials.refresh_token
                    if credentials.expiry:
                        user.google_token_expiry = int(credentials.expiry.timestamp())
                    if credentials.scopes:
                        user.google_token_scope = " ".join(credentials.scopes)
                else:
                    return {
                        "text": (
                            "Gmail access expired for this user. Sign in again with Google "
                            "to refresh permissions."
                        ),
                        "isError": True,
                    }

            gmail_service = build(
                "gmail", "v1", credentials=credentials, cache_discovery=False
            )
            sender = user.email or "me"
            message = MIMEText(body, "plain", "utf-8")
            message["To"] = to
            message["From"] = sender
            message["Subject"] = subject
            raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")

            gmail_service.users().messages().send(
                userId="me",
                body={"raw": raw_message},
            ).execute()
        except HttpError as exc:
            log.exception(
                "User Gmail send failed for user_id=%s to=%r subject=%r",
                user_id,
                to,
                subject,
            )
            return {
                "text": f"Gmail send failed: {exc}",
                "isError": True,
            }
        except Exception as exc:
            log.exception(
                "Unexpected user Gmail send failure for user_id=%s to=%r subject=%r",
                user_id,
                to,
                subject,
            )
            return {
                "text": f"Gmail send failed: {exc}",
                "isError": True,
            }

    return {
        "text": f"Email sent to {to} with subject {subject!r}.",
        "isError": False,
    }
