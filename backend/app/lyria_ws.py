"""Lyria realtime music websocket proxy."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import queue
import threading
from typing import Any

from flask import session
from flask_sock import Sock
from google.genai import types
from simple_websocket import ConnectionClosed

from .gemini_constants import LYRIA_MODEL
from .util_gemini import anonymous_gemini_access_enabled, gemini_client

log = logging.getLogger(__name__)

_CLOSE_SENTINEL = object()


def _normalize_music_generation_config_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = {key: value for key, value in payload.items() if value is not None}
    for old_name, new_name in (
        ("musicGenerationMode", "music_generation_mode"),
        ("onlyBassAndDrums", "only_bass_and_drums"),
    ):
        if old_name in normalized:
            normalized[new_name] = normalized.pop(old_name)
    return normalized


def register_lyria_ws(sock: Sock) -> None:
    @sock.route("/api/lyria")
    def _lyria(ws: Any) -> None:
        log.info("Accepted websocket connection for /api/lyria")
        if not session.get("user") and not anonymous_gemini_access_enabled():
            ws.send(json.dumps({"type": "error", "message": "Login required"}))
            ws.close()
            return

        ws.send(
            json.dumps(
                {"type": "socket_opened", "message": "backend websocket connected"}
            )
        )

        incoming_messages: queue.Queue[dict[str, Any] | None] = queue.Queue()
        outgoing_messages: queue.Queue[dict[str, Any] | object] = queue.Queue()
        stop_event = threading.Event()

        worker = threading.Thread(
            target=_run_lyria_session,
            args=(incoming_messages, outgoing_messages, stop_event),
            daemon=True,
            name="lyria-session-worker",
        )
        worker.start()

        try:
            startup_complete = False
            while True:
                try:
                    if startup_complete:
                        outbound = outgoing_messages.get_nowait()
                    else:
                        outbound = outgoing_messages.get(timeout=5)
                except queue.Empty:
                    outbound = None

                if outbound is _CLOSE_SENTINEL:
                    break
                if outbound is not None:
                    ws.send(json.dumps(outbound, ensure_ascii=False, separators=(",", ":")))
                    if isinstance(outbound, dict) and outbound.get("type") in {"ready", "error"}:
                        startup_complete = True
                    continue

                if stop_event.is_set() and outgoing_messages.empty():
                    break

                if not startup_complete:
                    continue

                try:
                    raw_message = ws.receive(timeout=0.05)
                except ConnectionClosed:
                    break

                if raw_message is None:
                    continue
                if isinstance(raw_message, bytes):
                    raw_message = raw_message.decode("utf-8")
                incoming_messages.put(json.loads(raw_message))
        finally:
            stop_event.set()
            incoming_messages.put(None)
            worker.join(timeout=2)
            try:
                ws.close()
            except Exception:
                pass


def _run_lyria_session(
    incoming_messages: "queue.Queue[dict[str, Any] | None]",
    outgoing_messages: "queue.Queue[dict[str, Any] | object]",
    stop_event: threading.Event,
) -> None:
    asyncio.run(_serve_lyria(incoming_messages, outgoing_messages, stop_event))


async def _next_incoming_message(
    incoming_messages: "queue.Queue[dict[str, Any] | None]",
    stop_event: threading.Event,
) -> dict[str, Any] | None:
    while not stop_event.is_set():
        try:
            return incoming_messages.get(timeout=0.1)
        except queue.Empty:
            await asyncio.sleep(0)
    return None


async def _serve_lyria(
    incoming_messages: "queue.Queue[dict[str, Any] | None]",
    outgoing_messages: "queue.Queue[dict[str, Any] | object]",
    stop_event: threading.Event,
) -> None:
    log.info("Starting backend Lyria session")
    try:
        client = gemini_client()
    except RuntimeError as exc:
        outgoing_messages.put({"type": "error", "message": str(exc)})
        outgoing_messages.put(_CLOSE_SENTINEL)
        return

    async def pump_music(music_session: Any) -> None:
        try:
            async for msg in music_session.receive():
                if stop_event.is_set():
                    break
                if msg.setup_complete:
                    outgoing_messages.put({"type": "ready"})
                server_content = msg.server_content
                if server_content and server_content.audio_chunks:
                    for chunk in server_content.audio_chunks:
                        if chunk.data:
                            outgoing_messages.put(
                                {
                                    "type": "audio",
                                    "mimeType": chunk.mime_type
                                    or "audio/pcm;rate=48000",
                                    "data": base64.b64encode(chunk.data).decode("ascii"),
                                }
                            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("pump_music")
            outgoing_messages.put(
                {"type": "error", "message": str(exc) or "lyria stream failed"}
            )

    async def pump_client(music_session: Any) -> None:
        try:
            while not stop_event.is_set():
                data = await _next_incoming_message(incoming_messages, stop_event)
                if data is None:
                    break

                message_type = data.get("type")
                log.info("Lyria client message: %s", message_type)

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
                    outgoing_messages.put({"type": "pong"})
                elif message_type == "close":
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("pump_client lyria")
            raise

    try:
        async with client.aio.live.music.connect(model=LYRIA_MODEL) as music_session:
            music_task = asyncio.create_task(pump_music(music_session))
            client_task = asyncio.create_task(pump_client(music_session))
            done, pending = await asyncio.wait(
                [music_task, client_task], return_when=asyncio.FIRST_EXCEPTION
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc:
                    raise exc
    except Exception as exc:
        log.exception("lyria session failed")
        outgoing_messages.put({"type": "error", "message": str(exc) or "lyria failed"})
    finally:
        stop_event.set()
        outgoing_messages.put(_CLOSE_SENTINEL)
