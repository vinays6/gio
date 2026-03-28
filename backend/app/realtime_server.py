"""Dedicated realtime websocket server for Gemini streaming endpoints."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
from http.cookies import SimpleCookie
from typing import Any

from flask.sessions import SecureCookieSessionInterface
from google.genai import types
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .gemini_constants import (
    CLIPBOARD_TOOL_DECLARATION,
    GIO_MODEL,
    GIO_SYSTEM_PROMPT,
    LYRIA_MODEL,
)
from .google_user_docs import (
    create_calendar_event_for_user,
    create_google_doc_for_user,
    send_gmail_for_user,
)
from .mcp_client import AggregatedMCP
from .user_preferences import update_music_preferences_for_user
from .util_gemini import (
    anonymous_gemini_access_enabled,
    build_live_system_instruction,
    gemini_client,
)

log = logging.getLogger(__name__)

_server_lock = threading.Lock()
_server_thread: threading.Thread | None = None
CLIPBOARD_TOOL_NAME = "saveToClipboard"


def _normalize_music_generation_config_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = {key: value for key, value in payload.items() if value is not None}
    for old_name, new_name in (
        ("musicGenerationMode", "music_generation_mode"),
        ("onlyBassAndDrums", "only_bass_and_drums"),
    ):
        if old_name in normalized:
            normalized[new_name] = normalized.pop(old_name)
    return normalized


async def _send_json(connection: ServerConnection, payload: dict[str, Any]) -> None:
    await connection.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


class _SessionApp:
    secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-key-change-in-prod")
    config = {
        "SECRET_KEY_FALLBACKS": [],
    }


def _load_flask_session(headers: Any) -> dict[str, Any]:
    cookie_header = headers.get("Cookie", "")
    if not cookie_header:
        return {}

    cookie_name = os.getenv("SESSION_COOKIE_NAME", "session")
    parsed = SimpleCookie()
    parsed.load(cookie_header)
    morsel = parsed.get(cookie_name)
    if morsel is None:
        return {}

    serializer = SecureCookieSessionInterface().get_signing_serializer(_SessionApp())
    if serializer is None:
        return {}

    try:
        data = serializer.loads(morsel.value)
    except Exception:
        return {}

    return data if isinstance(data, dict) else {}


def _request_has_agent_access(headers: Any) -> bool:
    if anonymous_gemini_access_enabled():
        return True
    return bool(_load_flask_session(headers).get("user"))


async def _handle_lyria(connection: ServerConnection) -> None:
    log.info("Accepted realtime websocket connection for %s", connection.request.path)
    await _send_json(
        connection,
        {"type": "socket_opened", "message": "realtime websocket connected"},
    )

    try:
        client = gemini_client()
    except RuntimeError as exc:
        await _send_json(connection, {"type": "error", "message": str(exc)})
        return

    ready_sent = False

    async def pump_music(music_session: Any) -> None:
        nonlocal ready_sent
        async for msg in music_session.receive():
            if msg.setup_complete and not ready_sent:
                await _send_json(connection, {"type": "ready"})
                ready_sent = True
            server_content = msg.server_content
            if server_content and server_content.audio_chunks:
                for chunk in server_content.audio_chunks:
                    if chunk.data:
                        await _send_json(
                            connection,
                            {
                                "type": "audio",
                                "mimeType": chunk.mime_type or "audio/pcm;rate=48000",
                                "data": base64.b64encode(chunk.data).decode("ascii"),
                            },
                        )

    async def pump_client(music_session: Any) -> None:
        async for raw_message in connection:
            if isinstance(raw_message, bytes):
                raw_message = raw_message.decode("utf-8")
            data = json.loads(raw_message)
            message_type = data.get("type")
            log.info("Realtime Lyria client message: %s", message_type)

            if message_type == "set_weighted_prompts":
                prompts = data.get("weightedPrompts") or []
                weighted_prompts = [
                    types.WeightedPrompt(
                        text=prompt["text"], weight=prompt.get("weight", 1.0)
                    )
                    for prompt in prompts
                ]
                await music_session.set_weighted_prompts(prompts=weighted_prompts)
            elif message_type == "set_music_generation_config":
                raw_config = data.get("musicGenerationConfig") or {}
                config = types.LiveMusicGenerationConfig.model_validate(
                    _normalize_music_generation_config_payload(raw_config)
                )
                await music_session.set_music_generation_config(config=config)
            elif message_type == "play":
                await music_session.play()
            elif message_type == "pause":
                await music_session.pause()
            elif message_type == "reset_context":
                await music_session.reset_context()
            elif message_type == "ping":
                await _send_json(connection, {"type": "pong"})
            elif message_type == "close":
                break

    try:
        async with client.aio.live.music.connect(model=LYRIA_MODEL) as music_session:
            if not ready_sent:
                await _send_json(connection, {"type": "ready"})
                ready_sent = True
            music_task = asyncio.create_task(pump_music(music_session))
            client_task = asyncio.create_task(pump_client(music_session))
            done, pending = await asyncio.wait(
                [music_task, client_task], return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                if task.cancelled():
                    continue
                exc = task.exception()
                if exc:
                    raise exc
    except ConnectionClosed:
        pass
    except Exception as exc:
        log.exception("Realtime Lyria session failed")
        try:
            await _send_json(connection, {"type": "error", "message": str(exc)})
        except Exception:
            pass


async def _handle_live(connection: ServerConnection) -> None:
    log.info("Accepted realtime websocket connection for %s", connection.request.path)
    session_data = _load_flask_session(connection.request.headers)
    if not (anonymous_gemini_access_enabled() or session_data.get("user")):
        await _send_json(connection, {"type": "error", "message": "Login required"})
        return
    auth_user_id = session_data.get("user")

    try:
        client = gemini_client()
    except RuntimeError as exc:
        await _send_json(connection, {"type": "error", "message": str(exc)})
        return

    mcp_agg = AggregatedMCP()
    try:
        await mcp_agg.connect()
    except Exception:
        log.exception("Realtime MCP connect failed")

    function_declarations: list[dict[str, Any]] = [
        CLIPBOARD_TOOL_DECLARATION,
        *mcp_agg.function_declarations,
    ]
    config: dict[str, Any] = {
        "response_modalities": ["AUDIO"],
        "system_instruction": build_live_system_instruction(GIO_SYSTEM_PROMPT),
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "tools": [{"function_declarations": function_declarations}],
    }
    pending_clipboard: dict[str, asyncio.Future] = {}
    client_timezone: str | None = None

    async def execute_tool(name: str, fid: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == CLIPBOARD_TOOL_NAME:
            future: asyncio.Future = asyncio.get_running_loop().create_future()
            pending_clipboard[fid] = future
            await _send_json(
                connection,
                {"type": "tool_call", "id": fid, "name": name, "args": args},
            )
            try:
                return await asyncio.wait_for(future, timeout=120)
            except asyncio.TimeoutError:
                return {"output": {"success": False, "error": "timeout"}}
            finally:
                pending_clipboard.pop(fid, None)

        if name == "builtin__create_google_doc":
            if not auth_user_id:
                tool_payload = {
                    "text": "Google Docs requires a signed-in user with Google OAuth access.",
                    "isError": True,
                }
            else:
                tool_payload = await asyncio.to_thread(
                    create_google_doc_for_user,
                    int(auth_user_id),
                    str(args.get("title") or "").strip(),
                    str(args.get("body") or "").strip(),
                    (
                        str(args.get("share_with")).strip()
                        if args.get("share_with") is not None
                        else None
                    ),
                )
            tool_text = (tool_payload.get("text") or "").strip()
            log_level = logging.WARNING if tool_payload.get("isError") else logging.INFO
            log.log(log_level, "Tool %s completed: %s", name, tool_text or tool_payload)
            await _send_json(
                connection,
                {
                    "type": "tool_result_debug",
                    "name": name,
                    "ok": not bool(tool_payload.get("isError")),
                    "message": tool_text or json.dumps(tool_payload, ensure_ascii=False),
                },
            )
            return {"result": tool_payload}

        if name == "builtin__send_email":
            if not auth_user_id:
                tool_payload = {
                    "text": "Email requires a signed-in user with Google OAuth access.",
                    "isError": True,
                }
            else:
                tool_payload = await asyncio.to_thread(
                    send_gmail_for_user,
                    int(auth_user_id),
                    str(args.get("to") or "").strip(),
                    str(args.get("subject") or "").strip(),
                    str(args.get("body") or "").strip(),
                )
            tool_text = (tool_payload.get("text") or "").strip()
            log_level = logging.WARNING if tool_payload.get("isError") else logging.INFO
            log.log(log_level, "Tool %s completed: %s", name, tool_text or tool_payload)
            await _send_json(
                connection,
                {
                    "type": "tool_result_debug",
                    "name": name,
                    "ok": not bool(tool_payload.get("isError")),
                    "message": tool_text or json.dumps(tool_payload, ensure_ascii=False),
                },
            )
            return {"result": tool_payload}

        if name == "builtin__create_google_calendar_event":
            if not auth_user_id:
                tool_payload = {
                    "text": "Google Calendar requires a signed-in user with Google OAuth access.",
                    "isError": True,
                }
            else:
                tool_payload = await asyncio.to_thread(
                    create_calendar_event_for_user,
                    int(auth_user_id),
                    str(args.get("title") or "").strip(),
                    str(args.get("start_iso") or "").strip(),
                    str(args.get("end_iso") or "").strip(),
                    (
                        str(args.get("description")).strip()
                        if args.get("description") is not None
                        else None
                    ),
                    (
                        str(args.get("location")).strip()
                        if args.get("location") is not None
                        else None
                    ),
                    (
                        str(args.get("timezone_name")).strip()
                        if args.get("timezone_name") is not None
                        else None
                    ),
                    client_timezone,
                )
            tool_text = (tool_payload.get("text") or "").strip()
            log_level = logging.WARNING if tool_payload.get("isError") else logging.INFO
            log.log(log_level, "Tool %s completed: %s", name, tool_text or tool_payload)
            await _send_json(
                connection,
                {
                    "type": "tool_result_debug",
                    "name": name,
                    "ok": not bool(tool_payload.get("isError")),
                    "message": tool_text or json.dumps(tool_payload, ensure_ascii=False),
                },
            )
            return {"result": tool_payload}

        if name == "builtin__update_music_preferences":
            if not auth_user_id:
                tool_payload = {
                    "text": "Updating music preferences requires a signed-in user.",
                    "isError": True,
                }
            else:
                tool_payload = await asyncio.to_thread(
                    update_music_preferences_for_user,
                    int(auth_user_id),
                    str(args.get("preferences") or "").strip(),
                )
            tool_text = (tool_payload.get("text") or "").strip()
            log_level = logging.WARNING if tool_payload.get("isError") else logging.INFO
            log.log(log_level, "Tool %s completed: %s", name, tool_text or tool_payload)
            await _send_json(
                connection,
                {
                    "type": "tool_result_debug",
                    "name": name,
                    "ok": not bool(tool_payload.get("isError")),
                    "message": tool_text or json.dumps(tool_payload, ensure_ascii=False),
                },
            )
            if not bool(tool_payload.get("isError")) and tool_payload.get("preferences"):
                await _send_json(
                    connection,
                    {
                        "type": "preferences_updated",
                        "preferences": str(tool_payload["preferences"]),
                    },
                )
            return {"result": tool_payload}

        if name == "builtin__update_music_generation":
            allowed_keys = {
                "prompt",
                "bpm",
                "use_inferred_bpm",
                "density",
                "use_inferred_density",
                "brightness",
                "use_inferred_brightness",
                "vocals_enabled",
                "only_bass_and_drums",
            }
            patch_payload = {
                key: value for key, value in args.items() if key in allowed_keys and value is not None
            }
            if not patch_payload:
                tool_payload = {
                    "text": "No music generation changes were provided.",
                    "isError": True,
                }
            else:
                await _send_json(
                    connection,
                    {
                        "type": "music_generation_updated",
                        "patch": patch_payload,
                    },
                )
                tool_payload = {
                    "text": "Updated the music generation controls.",
                    "isError": False,
                }
            tool_text = (tool_payload.get("text") or "").strip()
            log_level = logging.WARNING if tool_payload.get("isError") else logging.INFO
            log.log(log_level, "Tool %s completed: %s", name, tool_text or tool_payload)
            await _send_json(
                connection,
                {
                    "type": "tool_result_debug",
                    "name": name,
                    "ok": not bool(tool_payload.get("isError")),
                    "message": tool_text or json.dumps(tool_payload, ensure_ascii=False),
                },
            )
            return {"result": tool_payload}

        tool_payload = await mcp_agg.call_prefixed(name, args)
        tool_text = (tool_payload.get("text") or "").strip()
        tool_is_error = bool(tool_payload.get("isError")) or (
            "failed:" in tool_text.lower()
            or "not configured" in tool_text.lower()
            or "does not have permission" in tool_text.lower()
            or "permission" in tool_text.lower()
        )
        log_level = logging.WARNING if tool_is_error else logging.INFO
        log.log(log_level, "Tool %s completed: %s", name, tool_text or tool_payload)
        await _send_json(
            connection,
            {
                "type": "tool_result_debug",
                "name": name,
                "ok": not tool_is_error,
                "message": tool_text or json.dumps(tool_payload, ensure_ascii=False),
            },
        )
        return {"result": tool_payload}

    async def handle_tool_call(sess: Any, msg: Any) -> None:
        tool_call = getattr(msg, "tool_call", None)
        if not tool_call or not tool_call.function_calls:
            return

        for function_call in tool_call.function_calls:
            name = function_call.name or ""
            fid = function_call.id or ""
            if not fid:
                log.warning("Realtime tool call missing id for %s", name)
                continue

            tool_result = await execute_tool(name, fid, dict(function_call.args or {}))
            await sess.send_tool_response(
                function_responses=[
                    types.FunctionResponse(name=name, id=fid, response=tool_result)
                ]
            )

    async def pump_gemini(sess: Any) -> None:
        while True:
            async for msg in sess.receive():
                if getattr(msg, "tool_call", None):
                    await handle_tool_call(sess, msg)
                if getattr(msg, "data", None):
                    await _send_json(
                        connection,
                        {
                            "type": "audio",
                            "mimeType": "audio/pcm;rate=24000",
                            "data": base64.b64encode(msg.data).decode("ascii"),
                        },
                    )
                if getattr(msg, "text", None):
                    await _send_json(connection, {"type": "transcript", "text": msg.text})
                server_content = getattr(msg, "server_content", None)
                input_transcription = (
                    getattr(server_content, "input_transcription", None)
                    if server_content
                    else None
                )
                if input_transcription and getattr(input_transcription, "text", None):
                    await _send_json(
                        connection,
                        {
                            "type": "input_transcript",
                            "text": input_transcription.text,
                        },
                    )
                output_transcription = (
                    getattr(server_content, "output_transcription", None)
                    if server_content
                    else None
                )
                if output_transcription and getattr(output_transcription, "text", None):
                    await _send_json(
                        connection,
                        {
                            "type": "output_transcript",
                            "text": output_transcription.text,
                        },
                    )

    async def pump_client(sess: Any) -> None:
        nonlocal client_timezone
        async for raw_message in connection:
            if isinstance(raw_message, bytes):
                raw_message = raw_message.decode("utf-8")
            data = json.loads(raw_message)
            message_type = data.get("type")
            log.info("Realtime Gio client message: %s", message_type)

            if message_type == "audio":
                audio_b64 = data.get("data") or ""
                mime_type = data.get("mimeType") or "audio/pcm;rate=16000"
                pcm = base64.b64decode(audio_b64)
                await sess.send_realtime_input(
                    audio=types.Blob(data=pcm, mime_type=mime_type)
                )
            elif message_type == "text":
                text = (data.get("text") or "").strip()
                if text:
                    await sess.send_client_content(
                        turns=types.Content(role="user", parts=[types.Part(text=text)]),
                        turn_complete=True,
                    )
            elif message_type == "client_context":
                proposed_timezone = (data.get("timeZone") or "").strip()
                if proposed_timezone:
                    client_timezone = proposed_timezone
            elif message_type == "tool_result":
                fid = data.get("id") or ""
                future = pending_clipboard.get(fid)
                if future and not future.done():
                    future.set_result(
                        data.get("response") or {"output": {"success": True}}
                    )
            elif message_type == "ping":
                await _send_json(connection, {"type": "pong"})
            elif message_type == "close":
                break

    try:
        async with client.aio.live.connect(model=GIO_MODEL, config=config) as sess:
            await _send_json(
                connection,
                {
                    "type": "ready",
                    "tools": [decl["name"] for decl in function_declarations],
                },
            )
            gemini_task = asyncio.create_task(pump_gemini(sess))
            client_task = asyncio.create_task(pump_client(sess))
            done, pending = await asyncio.wait(
                [gemini_task, client_task], return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                if task.cancelled():
                    continue
                exc = task.exception()
                if exc:
                    raise exc
    except ConnectionClosed:
        pass
    except Exception as exc:
        log.exception("Realtime Gio session failed")
        try:
            await _send_json(
                connection, {"type": "error", "message": str(exc) or "live session failed"}
            )
        except Exception:
            pass
    finally:
        await mcp_agg.aclose()


async def _route_connection(connection: ServerConnection) -> None:
    path = connection.request.path
    if path == "/api/lyria":
        await _handle_lyria(connection)
        return
    if path == "/api/live":
        await _handle_live(connection)
        return

    await _send_json(connection, {"type": "error", "message": f"Unknown realtime path: {path}"})
    await connection.close()


async def start_realtime_server(host: str, port: int):
    return await serve(
        _route_connection,
        host,
        port,
        compression=None,
        ping_interval=20,
        ping_timeout=20,
        max_size=2**20,
    )


def _run_realtime_server(host: str, port: int) -> None:
    async def _main():
        server = await start_realtime_server(host, port)
        log.info("Realtime websocket server listening on ws://%s:%s", host, port)
        await server.serve_forever()

    try:
        asyncio.run(_main())
    except OSError as exc:
        log.warning(
            "Realtime websocket server could not bind to ws://%s:%s: %s",
            host,
            port,
            exc,
        )


def ensure_realtime_server_started() -> None:
    if os.getenv("START_REALTIME_WS_SERVER", "true").strip().lower() in {"0", "false", "no"}:
        return

    global _server_thread
    with _server_lock:
        if _server_thread and _server_thread.is_alive():
            return

        host = os.getenv("REALTIME_WS_HOST", "127.0.0.1")
        port = int(os.getenv("REALTIME_WS_PORT", "5001"))
        _server_thread = threading.Thread(
            target=_run_realtime_server,
            args=(host, port),
            daemon=True,
            name="realtime-ws-server",
        )
        _server_thread.start()
