"""Gemini Live websocket: voice in/out plus a simple tool-executing agent loop."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

from flask import session
from flask_sock import Sock
from google.genai import types

from .gemini_constants import CLIPBOARD_TOOL_DECLARATION, GIO_MODEL, GIO_SYSTEM_PROMPT
from .mcp_client import AggregatedMCP
from .util_gemini import (
    anonymous_gemini_access_enabled,
    build_live_system_instruction,
    gemini_client,
)

log = logging.getLogger(__name__)

CLIPBOARD_TOOL_NAME = "saveToClipboard"


async def _ws_send_json(
    ws: Any, send_lock: asyncio.Lock, payload: dict[str, Any]
) -> None:
    async with send_lock:
        await asyncio.to_thread(
            ws.send, json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        )


async def _ws_receive_json(ws: Any) -> dict[str, Any]:
    raw = await asyncio.to_thread(ws.receive)
    if raw is None:
        raise ConnectionError("websocket closed")
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    return json.loads(raw)


def register_live_ws(sock: Sock) -> None:
    @sock.route("/api/live")
    def _live(ws: Any) -> None:
        log.info("Accepted websocket connection for /api/live")
        if not session.get("user") and not anonymous_gemini_access_enabled():
            ws.send(json.dumps({"type": "error", "message": "Login required"}))
            ws.close()
            return

        asyncio.run(_serve_live(ws))


async def _serve_live(ws: Any) -> None:
    send_lock = asyncio.Lock()
    try:
        client = gemini_client()
    except RuntimeError as exc:
        await _ws_send_json(ws, send_lock, {"type": "error", "message": str(exc)})
        return

    mcp_agg = AggregatedMCP()
    try:
        await mcp_agg.connect()
    except Exception:
        log.exception("MCP connect failed")

    function_declarations: list[dict[str, Any]] = [
        CLIPBOARD_TOOL_DECLARATION,
        *mcp_agg.function_declarations,
    ]
    config: dict[str, Any] = {
        "response_modalities": ["AUDIO"],
        "system_instruction": build_live_system_instruction(GIO_SYSTEM_PROMPT),
        "tools": [{"function_declarations": function_declarations}],
    }
    pending_clipboard: dict[str, asyncio.Future] = {}

    async def execute_tool(name: str, fid: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == CLIPBOARD_TOOL_NAME:
            future: asyncio.Future = asyncio.get_running_loop().create_future()
            pending_clipboard[fid] = future
            await _ws_send_json(
                ws,
                send_lock,
                {"type": "tool_call", "id": fid, "name": name, "args": args},
            )
            try:
                return await asyncio.wait_for(future, timeout=120)
            except asyncio.TimeoutError:
                return {"output": {"success": False, "error": "timeout"}}
            finally:
                pending_clipboard.pop(fid, None)

        return {"result": await mcp_agg.call_prefixed(name, args)}

    async def handle_tool_call(sess: Any, msg: types.LiveServerMessage) -> None:
        tool_call = msg.tool_call
        if not tool_call or not tool_call.function_calls:
            return

        for function_call in tool_call.function_calls:
            name = function_call.name or ""
            fid = function_call.id or ""
            if not fid:
                log.warning("tool call missing id for %s", name)
                continue

            tool_result = await execute_tool(name, fid, dict(function_call.args or {}))
            await sess.send_tool_response(
                function_responses=[
                    types.FunctionResponse(name=name, id=fid, response=tool_result)
                ]
            )

    async def pump_gemini(sess: Any) -> None:
        try:
            async for msg in sess.receive():
                if msg.tool_call:
                    await handle_tool_call(sess, msg)
                if msg.data:
                    await _ws_send_json(
                        ws,
                        send_lock,
                        {
                            "type": "audio",
                            "mimeType": "audio/pcm;rate=24000",
                            "data": base64.b64encode(msg.data).decode("ascii"),
                        },
                    )
                if msg.text:
                    await _ws_send_json(
                        ws, send_lock, {"type": "transcript", "text": msg.text}
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("pump_gemini")
            try:
                await _ws_send_json(
                    ws,
                    send_lock,
                    {"type": "error", "message": str(exc) or "live session failed"},
                )
            except Exception:
                pass

    async def pump_client(sess: Any) -> None:
        try:
            while True:
                data = await _ws_receive_json(ws)
                message_type = data.get("type")

                if message_type == "audio":
                    audio_b64 = data.get("data") or ""
                    mime_type = data.get("mimeType") or "audio/pcm;rate=16000"
                    pcm = base64.b64decode(audio_b64)
                    await sess.send_realtime_input(
                        audio=types.Blob(data=pcm, mime_type=mime_type)
                    )
                elif message_type == "image":
                    image_b64 = data.get("data") or ""
                    mime_type = data.get("mimeType") or "image/jpeg"
                    text = data.get("text") or ""
                    await sess.send_client_content(
                        turns=types.Content(
                            role="user",
                            parts=[
                                types.Part(
                                    inline_data=types.Blob(
                                        data=base64.b64decode(image_b64),
                                        mime_type=mime_type,
                                    )
                                ),
                                types.Part(text=text),
                            ],
                        ),
                        turn_complete=False,
                    )
                elif message_type == "text":
                    text = (data.get("text") or "").strip()
                    if text:
                        await sess.send_client_content(
                            turns=types.Content(
                                role="user", parts=[types.Part(text=text)]
                            ),
                            turn_complete=True,
                        )
                elif message_type == "tool_result":
                    fid = data.get("id") or ""
                    future = pending_clipboard.get(fid)
                    if future and not future.done():
                        future.set_result(
                            data.get("response") or {"output": {"success": True}}
                        )
                elif message_type == "ping":
                    await _ws_send_json(ws, send_lock, {"type": "pong"})
                elif message_type == "close":
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("pump_client")
            raise

    try:
        async with client.aio.live.connect(model=GIO_MODEL, config=config) as sess:
            await _ws_send_json(
                ws,
                send_lock,
                {
                    "type": "ready",
                    "tools": [decl["name"] for decl in function_declarations],
                },
            )
            gemini_task = asyncio.create_task(pump_gemini(sess))
            client_task = asyncio.create_task(pump_client(sess))
            done, pending = await asyncio.wait(
                [gemini_task, client_task], return_when=asyncio.FIRST_EXCEPTION
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc:
                    raise exc
    finally:
        await mcp_agg.aclose()
        try:
            async with send_lock:
                await asyncio.to_thread(ws.close)
        except Exception:
            pass
