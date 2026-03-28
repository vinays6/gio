import asyncio
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


class _FakeChunk:
    def __init__(self, data: bytes, mime_type: str = "audio/pcm;rate=48000"):
        self.data = data
        self.mime_type = mime_type


class _FakeServerContent:
    def __init__(self, audio_chunks=None):
        self.audio_chunks = audio_chunks or []


class _FakeServerMessage:
    def __init__(self, *, setup_complete: bool = False, audio_chunks=None):
        self.setup_complete = setup_complete
        self.server_content = _FakeServerContent(audio_chunks)


class _FakeMusicSession:
    def __init__(self, *, emit_setup_complete: bool = True):
        self._queue: asyncio.Queue[_FakeServerMessage] = asyncio.Queue()
        self.play_called = False
        self._emit_setup_complete = emit_setup_complete

    async def __aenter__(self):
        if self._emit_setup_complete:
            await self._queue.put(_FakeServerMessage(setup_complete=True))
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def receive(self):
        while True:
            yield await self._queue.get()

    async def set_weighted_prompts(self, prompts):
        return None

    async def set_music_generation_config(self, config):
        return None

    async def play(self):
        self.play_called = True
        await self._queue.put(
            _FakeServerMessage(audio_chunks=[_FakeChunk(b"\x01\x02\x03\x04")])
        )

    async def pause(self):
        return None

    async def reset_context(self):
        return None


class _FakeMusicConnector:
    def __init__(self, session: _FakeMusicSession):
        self._session = session

    def connect(self, **_kwargs):
        return self._session


class _FakeGeminiClient:
    def __init__(self, session: _FakeMusicSession):
        self.aio = type(
            "Aio",
            (),
            {"live": type("Live", (), {"music": _FakeMusicConnector(session)})()},
        )()


class RealtimeLyriaServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ["START_REALTIME_WS_SERVER"] = "false"
        self._fake_session = _FakeMusicSession()
        self._patcher = patch(
            "app.realtime_server.gemini_client",
            return_value=_FakeGeminiClient(self._fake_session),
        )
        self._patcher.start()

        with socket.socket() as temp_socket:
            temp_socket.bind(("127.0.0.1", 0))
            self._port = temp_socket.getsockname()[1]

        self._server = await start_realtime_server("127.0.0.1", self._port)

    async def asyncTearDown(self):
        self._patcher.stop()
        self._server.close()
        await self._server.wait_closed()

    async def test_native_realtime_server_streams_ready_and_audio(self):
        uri = f"ws://127.0.0.1:{self._port}/api/lyria"
        async with websockets.connect(uri, open_timeout=5, close_timeout=1) as ws:
            first_message = json.loads(await ws.recv())
            self.assertEqual(first_message["type"], "socket_opened")

            ready_message = json.loads(await ws.recv())
            self.assertEqual(ready_message["type"], "ready")

            await ws.send(json.dumps({"type": "play"}))
            audio_message = json.loads(await ws.recv())
            self.assertEqual(audio_message["type"], "audio")
            self.assertEqual(audio_message["data"], "AQIDBA==")

        self.assertTrue(self._fake_session.play_called)

    async def test_server_sends_ready_without_waiting_for_setup_complete(self):
        self._server.close()
        await self._server.wait_closed()
        self._patcher.stop()

        self._fake_session = _FakeMusicSession(emit_setup_complete=False)
        self._patcher = patch(
            "app.realtime_server.gemini_client",
            return_value=_FakeGeminiClient(self._fake_session),
        )
        self._patcher.start()
        self._server = await start_realtime_server("127.0.0.1", self._port)

        uri = f"ws://127.0.0.1:{self._port}/api/lyria"
        async with websockets.connect(uri, open_timeout=5, close_timeout=1) as ws:
            first_message = json.loads(await ws.recv())
            self.assertEqual(first_message["type"], "socket_opened")

            ready_message = json.loads(await ws.recv())
            self.assertEqual(ready_message["type"], "ready")
