import asyncio
import json
import os
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import websockets

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app import create_app


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
    def __init__(self):
        self._queue: asyncio.Queue[_FakeServerMessage] = asyncio.Queue()
        self.prompts = None
        self.config = None
        self.play_called = False

    async def __aenter__(self):
        await self._queue.put(_FakeServerMessage(setup_complete=True))
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def receive(self):
        while True:
            yield await self._queue.get()

    async def set_weighted_prompts(self, prompts):
        self.prompts = prompts

    async def set_music_generation_config(self, config):
        self.config = config

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
            {
                "live": type(
                    "Live",
                    (),
                    {"music": _FakeMusicConnector(session)},
                )()
            },
        )()


class LyriaWebsocketIntegrationTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["ALLOW_ANONYMOUS_GEMINI"] = "true"
        os.environ["START_REALTIME_WS_SERVER"] = "false"

    def setUp(self):
        self._fake_session = _FakeMusicSession()
        self._patcher = patch(
            "app.lyria_ws.gemini_client",
            return_value=_FakeGeminiClient(self._fake_session),
        )
        self._patcher.start()

        with socket.socket() as temp_socket:
            temp_socket.bind(("127.0.0.1", 0))
            self._port = temp_socket.getsockname()[1]

        app = create_app()
        self._server_thread = threading.Thread(
            target=lambda: app.run(
                host="127.0.0.1",
                port=self._port,
                debug=False,
                use_reloader=False,
            ),
            daemon=True,
        )
        self._server_thread.start()
        self._wait_for_server()

    def tearDown(self):
        self._patcher.stop()

    def _wait_for_server(self):
        url = f"http://127.0.0.1:{self._port}/api/user"
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                urllib.request.urlopen(url, timeout=0.2)
            except urllib.error.HTTPError:
                return
            except Exception:
                time.sleep(0.1)
            else:
                return
        self.fail("Timed out waiting for backend test server to start.")

    async def test_frontend_style_client_receives_ready_and_audio(self):
        uri = f"ws://127.0.0.1:{self._port}/api/lyria"
        async with websockets.connect(uri, open_timeout=5, close_timeout=1) as ws:
            first_message = json.loads(await ws.recv())
            self.assertEqual(first_message["type"], "socket_opened")

            ready_message = json.loads(await ws.recv())
            self.assertEqual(ready_message["type"], "ready")

            await ws.send(
                json.dumps(
                    {
                        "type": "set_weighted_prompts",
                        "weightedPrompts": [{"text": "focus techno", "weight": 1}],
                    }
                )
            )
            await ws.send(
                json.dumps(
                    {
                        "type": "set_music_generation_config",
                        "musicGenerationConfig": {
                            "onlyBassAndDrums": False,
                            "musicGenerationMode": "QUALITY",
                        },
                    }
                )
            )
            await ws.send(json.dumps({"type": "play"}))

            audio_message = json.loads(await ws.recv())
            self.assertEqual(audio_message["type"], "audio")
            self.assertEqual(audio_message["mimeType"], "audio/pcm;rate=48000")
            self.assertEqual(audio_message["data"], "AQIDBA==")

            await ws.send(json.dumps({"type": "close"}))

        self.assertTrue(self._fake_session.play_called)
        self.assertIsNotNone(self._fake_session.prompts)
        self.assertIsNotNone(self._fake_session.config)


if __name__ == "__main__":
    unittest.main()
