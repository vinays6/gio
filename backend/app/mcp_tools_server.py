"""Built-in MCP server: email, Discord, and Google Docs actions."""

from __future__ import annotations

import logging
import os
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("music-agent-builtin")
log = logging.getLogger(__name__)


@mcp.tool()
def send_email(to: str, subject: str, body: str) -> str:
    """Send email with the authenticated user's Gmail account via the Gmail API."""
    return (
        "This tool is handled by the live backend using the authenticated user's "
        "Google OAuth session."
    )


@mcp.tool()
def send_discord_message(message: str, username: str | None = None) -> str:
    """Post a message to Discord via incoming webhook. Set DISCORD_WEBHOOK_URL."""
    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if not webhook_url:
        return "Discord not configured: set DISCORD_WEBHOOK_URL to an incoming webhook URL."

    payload: dict[str, str] = {"content": message[:2000]}
    if username:
        payload["username"] = username[:80]

    with httpx.Client(timeout=30) as client:
        response = client.post(webhook_url, json=payload)
        response.raise_for_status()

    return "Posted the message to Discord."


@mcp.tool()
def create_google_doc(
    title: str, body: str, share_with: str | None = None
) -> str:
    """Create a Google Doc using a service account via GOOGLE_APPLICATION_CREDENTIALS."""
    key_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if not key_path:
        return (
            "Google Docs not configured: set GOOGLE_APPLICATION_CREDENTIALS to a "
            f"service account JSON. Draft stayed local for {title!r}."
        )

    credential_file = Path(key_path)
    if not credential_file.is_file():
        return (
            "Google Docs not configured: GOOGLE_APPLICATION_CREDENTIALS does not "
            f"point to a valid file ({key_path})."
        )

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError:
        return (
            "Google Docs dependencies are missing in the backend environment. "
            "Install requirements.txt so google-api-python-client and google-auth are available."
        )

    scopes = [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive.file",
    ]
    try:
        credentials = service_account.Credentials.from_service_account_file(
            key_path, scopes=scopes
        )
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
            body={"requests": [{"insertText": {"location": {"index": 1}, "text": body}}]},
        ).execute()

        if share_with:
            drive_service.permissions().create(
                fileId=document_id,
                body={"type": "user", "role": "writer", "emailAddress": share_with},
                sendNotificationEmail=False,
            ).execute()
    except Exception as exc:
        log.exception("Google Docs creation failed for title=%r share_with=%r", title, share_with)
        return f"Google Docs creation failed: {exc}"

    return (
        f"Created Google Doc {title!r}: "
        f"https://docs.google.com/document/d/{document_id}/edit"
    )


def main():
    mcp.run()


if __name__ == "__main__":
    main()
