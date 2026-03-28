import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.mcp_client import _sanitize_schema


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


if __name__ == "__main__":
    unittest.main()
