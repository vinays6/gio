import sys
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from mcp import StdioServerParameters
from mcp.client.session_group import SseServerParameters, StreamableHttpParameters

from app.mcp_client import _build_server_params, _resolve_env_placeholders, _sanitize_schema


class McpClientSchemaTest(unittest.TestCase):
    def test_sanitize_schema_drops_additional_properties_and_defs(self):
        schema = {
            "type": "object",
            "properties": {
                "message": {"type": "string"},
                "metadata": {
                    "type": "object",
                    "properties": {"channel": {"type": "string"}},
                    "additionalProperties": False,
                },
            },
            "required": ["message"],
            "additionalProperties": False,
            "$defs": {"unused": {"type": "string"}},
        }

        sanitized = _sanitize_schema(schema)

        self.assertEqual(sanitized["type"], "object")
        self.assertEqual(sanitized["required"], ["message"])
        self.assertNotIn("additionalProperties", sanitized)
        self.assertNotIn("$defs", sanitized)
        self.assertNotIn(
            "additionalProperties", sanitized["properties"]["metadata"]
        )

    def test_build_server_params_for_stdio_config(self):
        params = _build_server_params(
            {
                "command": "python",
                "args": ["-m", "app.mcp_tools_server"],
                "env": {"FOO": "bar"},
            }
        )

        self.assertIsInstance(params, StdioServerParameters)
        self.assertEqual(params.args, ["-m", "app.mcp_tools_server"])
        self.assertEqual(params.env, {"FOO": "bar"})

    def test_build_server_params_for_streamable_http_url_config(self):
        params = _build_server_params(
            {
                "url": "https://mcp.context7.com/mcp",
            }
        )

        self.assertIsInstance(params, StreamableHttpParameters)
        self.assertEqual(params.url, "https://mcp.context7.com/mcp")
        self.assertEqual(params.timeout, timedelta(seconds=30))
        self.assertEqual(params.sse_read_timeout, timedelta(seconds=300))

    def test_build_server_params_accepts_type_alias_for_http_transport(self):
        params = _build_server_params(
            {
                "type": "http",
                "url": "https://mcp.browserbase.com/mcp",
            }
        )

        self.assertIsInstance(params, StreamableHttpParameters)
        self.assertEqual(params.url, "https://mcp.browserbase.com/mcp")

    def test_build_server_params_for_sse_url_config(self):
        params = _build_server_params(
            {
                "url": "https://example.com/sse",
                "transport": "sse",
                "headers": {"Authorization": "Bearer token"},
                "timeout": 12,
                "sse_read_timeout": 120,
            }
        )

        self.assertIsInstance(params, SseServerParameters)
        self.assertEqual(params.url, "https://example.com/sse")
        self.assertEqual(params.headers, {"Authorization": "Bearer token"})
        self.assertEqual(params.timeout, 12)
        self.assertEqual(params.sse_read_timeout, 120)

    def test_build_server_params_for_websocket_url_config(self):
        params = _build_server_params(
            {
                "url": "wss://example.com/mcp",
                "transport": "websocket",
            }
        )

        self.assertEqual(params, ("websocket", "wss://example.com/mcp"))

    def test_resolve_env_placeholders_in_nested_config(self):
        with patch.dict("os.environ", {"BROWSERBASE_API_KEY": "secret123"}, clear=False):
            resolved = _resolve_env_placeholders(
                {
                    "url": "https://mcp.browserbase.com/mcp?browserbaseApiKey=${BROWSERBASE_API_KEY}",
                    "headers": {"X-Test": "${BROWSERBASE_API_KEY}"},
                    "args": ["--token", "${BROWSERBASE_API_KEY}"],
                }
            )

        self.assertEqual(
            resolved["url"],
            "https://mcp.browserbase.com/mcp?browserbaseApiKey=secret123",
        )
        self.assertEqual(resolved["headers"]["X-Test"], "secret123")
        self.assertEqual(resolved["args"], ["--token", "secret123"])


if __name__ == "__main__":
    unittest.main()
