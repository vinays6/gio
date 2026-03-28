"""Aggregate MCP stdio servers into prefixed tool names for Gemini Live."""

from __future__ import annotations

import json
import logging
import sys
from contextlib import AsyncExitStack
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import CallToolResult

from .db_session import BACKEND_ROOT

log = logging.getLogger(__name__)

_SCHEMA_KEYS = {
    "type",
    "description",
    "enum",
    "format",
    "items",
    "properties",
    "required",
    "nullable",
    "anyOf",
}


def _serialize_tool_result(result: CallToolResult) -> dict[str, Any]:
    lines: list[str] = []
    for block in result.content or []:
        if hasattr(block, "text"):
            lines.append(block.text)
    return {
        "text": "\n".join(lines).strip(),
        "structured": result.structuredContent,
        "isError": result.isError,
    }


def _sanitize_schema(schema: Any) -> dict[str, Any]:
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}

    sanitized: dict[str, Any] = {}
    for key in _SCHEMA_KEYS:
        if key not in schema:
            continue

        value = schema[key]
        if key == "properties" and isinstance(value, dict):
            sanitized[key] = {
                prop_name: _sanitize_schema(prop_schema)
                for prop_name, prop_schema in value.items()
                if isinstance(prop_schema, dict)
            }
        elif key == "items" and isinstance(value, dict):
            sanitized[key] = _sanitize_schema(value)
        elif key == "anyOf" and isinstance(value, list):
            sanitized[key] = [
                _sanitize_schema(option) for option in value if isinstance(option, dict)
            ]
        else:
            sanitized[key] = value

    if "type" in sanitized and isinstance(sanitized["type"], str):
        sanitized["type"] = sanitized["type"].lower()

    if sanitized.get("type") == "object":
        sanitized.setdefault("properties", {})

    return sanitized or {"type": "object", "properties": {}}


class AggregatedMCP:
    def __init__(self):
        self._stack: AsyncExitStack | None = None
        self._routes: dict[str, tuple[ClientSession, str]] = {}
        self.function_declarations: list[dict[str, Any]] = []

    async def connect(self) -> None:
        config_path = BACKEND_ROOT / "mcp_config.json"
        if not config_path.is_file():
            log.warning("mcp_config.json missing at %s - MCP tools disabled", config_path)
            return

        raw = json.loads(config_path.read_text(encoding="utf-8"))
        servers = raw.get("mcpServers") or {}
        self._stack = AsyncExitStack()
        await self._stack.__aenter__()

        for server_id, cfg in servers.items():
            command = cfg.get("command")
            args = cfg.get("args") or []
            env = cfg.get("env")
            if not command:
                continue
            if command in {"python", "python3"}:
                command = sys.executable

            params = StdioServerParameters(command=command, args=args, env=env)
            read, write = await self._stack.enter_async_context(stdio_client(params))
            session = await self._stack.enter_async_context(ClientSession(read, write))
            await session.initialize()

            listed = await session.list_tools()
            for tool in listed.tools:
                prefixed_name = f"{server_id}__{tool.name}"
                self._routes[prefixed_name] = (session, tool.name)

                declaration: dict[str, Any] = {
                    "name": prefixed_name,
                    "description": tool.description or tool.name,
                }
                declaration["parameters"] = _sanitize_schema(tool.inputSchema or {})
                self.function_declarations.append(declaration)

    async def call_prefixed(
        self, prefixed_name: str, arguments: dict[str, Any] | None
    ) -> dict[str, Any]:
        route = self._routes.get(prefixed_name)
        if not route:
            return {"error": f"unknown tool {prefixed_name!r}"}
        session, original_name = route
        result = await session.call_tool(original_name, arguments or {})
        return _serialize_tool_result(result)

    async def aclose(self) -> None:
        if self._stack is not None:
            await self._stack.aclose()
            self._stack = None
        self._routes.clear()
        self.function_declarations.clear()
