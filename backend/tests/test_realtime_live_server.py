import asyncio
import base64
import json
import os
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import websockets

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.realtime_server import start_realtime_server


class _FakeFunctionCall:
    def __init__(self, *, name: str, call_id: str, args: dict):
        self.name = name
        self.id = call_id
        self.args = args


class _FakeToolCall:
    def __init__(self, function_calls):
        self.function_calls = function_calls


class _FakeLiveMessage:
    def __init__(self, *, data=None, text=None, tool_call=None):
        self.data = data
        self.text = text
        self.tool_call = tool_call


_TURN_END = object()


class _FakeLiveSession:
    def __init__(self):
        self._queue: asyncio.Queue[_FakeLiveMessage] = asyncio.Queue()
        self.tool_responses = []
        self.realtime_audio = []
        self.client_turns = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def receive(self):
        while True:
            item = await self._queue.get()
            if item is _TURN_END:
                return
            yield item

    async def send_realtime_input(self, audio):
        self.realtime_audio.append(audio)

    async def send_client_content(self, turns, turn_complete):
        self.client_turns.append((turns, turn_complete))
        parts = list(getattr(turns, "parts", []) or [])
        text_parts = [part.text for part in parts if getattr(part, "text", None)]
        joined_text = " ".join(text_parts)
        if "draft" in joined_text.lower():
            await self._queue.put(
                _FakeLiveMessage(
                    tool_call=_FakeToolCall(
                        [
                            _FakeFunctionCall(
                                name="saveToClipboard",
                                call_id="clip-1",
                                args={"content": "Drafted message"},
                            )
                        ]
                    )
                )
            )
            await self._queue.put(_TURN_END)

    async def send_tool_response(self, function_responses):
        self.tool_responses.extend(function_responses)
        await self._queue.put(_FakeLiveMessage(text="Draft ready."))
        await self._queue.put(_FakeLiveMessage(data=b"\x01\x02\x03\x04"))
        await self._queue.put(_TURN_END)


class _FakeLiveConnector:
    def __init__(self, session: _FakeLiveSession):
        self._session = session
        self.last_config = None
        self.last_model = None

    def connect(self, *, model, config):
        self.last_model = model
        self.last_config = config
        return self._session


class _FakeGeminiClient:
    def __init__(self, session: _FakeLiveSession):
        self.connector = _FakeLiveConnector(session)
        self.aio = type(
            "Aio",
            (),
            {"live": self.connector},
        )()


class _FakeAggregatedMCP:
    def __init__(self):
        self.function_declarations = [
            {
                "name": "discord__send_message",
                "description": "Send a Discord message",
                "parameters": {"type": "object", "properties": {}},
            }
        ]
        self.connected = False

    async def connect(self):
        self.connected = True

    async def call_prefixed(self, prefixed_name, arguments):
        return {"tool": prefixed_name, "arguments": arguments}

    async def aclose(self):
        self.connected = False


class RealtimeLiveServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ["START_REALTIME_WS_SERVER"] = "false"
        os.environ["ALLOW_ANONYMOUS_GEMINI"] = "true"
        self._fake_session = _FakeLiveSession()
        self._patchers = [
            patch(
                "app.realtime_server.gemini_client",
                return_value=_FakeGeminiClient(self._fake_session),
            ),
            patch("app.realtime_server.AggregatedMCP", _FakeAggregatedMCP),
        ]
        for patcher in self._patchers:
            patcher.start()

        with socket.socket() as temp_socket:
            temp_socket.bind(("127.0.0.1", 0))
            self._port = temp_socket.getsockname()[1]

        self._server = await start_realtime_server("127.0.0.1", self._port)

    async def asyncTearDown(self):
        for patcher in reversed(self._patchers):
            patcher.stop()
        self._server.close()
        await self._server.wait_closed()

    async def test_native_live_server_streams_ready_tool_call_and_audio(self):
        uri = f"ws://127.0.0.1:{self._port}/api/live"
        async with websockets.connect(uri, open_timeout=5, close_timeout=1) as ws:
            ready_message = json.loads(await ws.recv())
            self.assertEqual(ready_message["type"], "ready")
            self.assertIn("saveToClipboard", ready_message["tools"])
            self.assertIn("discord__send_message", ready_message["tools"])

            await ws.send(
                json.dumps({"type": "text", "text": "Please draft a quick update"})
            )

            tool_call_message = json.loads(await ws.recv())
            self.assertEqual(tool_call_message["type"], "tool_call")
            self.assertEqual(tool_call_message["name"], "saveToClipboard")
            self.assertEqual(
                tool_call_message["args"]["content"], "Drafted message"
            )

            await ws.send(
                json.dumps(
                    {
                        "type": "tool_result",
                        "id": tool_call_message["id"],
                        "response": {"output": {"success": True}},
                    }
                )
            )

            transcript_message = json.loads(await ws.recv())
            self.assertEqual(transcript_message["type"], "transcript")
            self.assertEqual(transcript_message["text"], "Draft ready.")

            audio_message = json.loads(await ws.recv())
            self.assertEqual(audio_message["type"], "audio")
            self.assertEqual(
                audio_message["data"], base64.b64encode(b"\x01\x02\x03\x04").decode("ascii")
            )

            await ws.send(
                json.dumps({"type": "text", "text": "Please draft another quick update"})
            )

            second_tool_call = json.loads(await ws.recv())
            self.assertEqual(second_tool_call["type"], "tool_call")
            self.assertEqual(second_tool_call["name"], "saveToClipboard")


if __name__ == "__main__":
    unittest.main()
