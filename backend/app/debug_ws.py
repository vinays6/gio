"""Simple websocket debug endpoints for browser transport checks."""

from __future__ import annotations

import json
import logging
from typing import Any

from flask_sock import Sock
from simple_websocket import ConnectionClosed

log = logging.getLogger(__name__)


def register_debug_ws(sock: Sock) -> None:
    @sock.route("/api/debug/ws")
    def _debug_ws(ws: Any) -> None:
        log.info("Accepted websocket connection for /api/debug/ws")
        ws.send(json.dumps({"type": "debug_ready", "message": "debug websocket connected"}))
        try:
            while True:
                message = ws.receive()
                if message is None:
                    continue
                if isinstance(message, bytes):
                    message = message.decode("utf-8")
                ws.send(
                    json.dumps(
                        {
                            "type": "debug_echo",
                            "message": message,
                        }
                    )
                )
        except ConnectionClosed:
            pass
        finally:
            try:
                ws.close()
            except Exception:
                pass
