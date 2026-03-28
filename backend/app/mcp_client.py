"""Aggregate MCP stdio servers into prefixed tool names for Gemini Live."""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from contextlib import AsyncExitStack
from datetime import timedelta
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client
from mcp.client.websocket import websocket_client
from mcp.client.session_group import SseServerParameters, StreamableHttpParameters
from mcp.shared._httpx_utils import create_mcp_http_client
from mcp.types import CallToolResult

from .db_session import BACKEND_ROOT

log = logging.getLogger(__name__)
_ENV_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)\}")

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


def _seconds_to_timedelta(value: Any, default_seconds: float) -> timedelta:
    if isinstance(value, timedelta):
        return value
    if isinstance(value, (int, float)):
        return timedelta(seconds=float(value))
    return timedelta(seconds=default_seconds)


def _resolve_env_placeholders(value: Any) -> Any:
    if isinstance(value, str):
        return _ENV_PATTERN.sub(lambda match: os.getenv(match.group(1), ""), value)
    if isinstance(value, list):
        return [_resolve_env_placeholders(item) for item in value]
    if isinstance(value, dict):
        return {key: _resolve_env_placeholders(item) for key, item in value.items()}
    return value


def _build_server_params(cfg: dict[str, Any]) -> (
    StdioServerParameters | SseServerParameters | StreamableHttpParameters | tuple[str, str]
):
    cfg = _resolve_env_placeholders(cfg)
    command = cfg.get("command")
    if command:
        args = cfg.get("args") or []
        env = cfg.get("env")
        if command in {"python", "python3"}:
            command = sys.executable
        return StdioServerParameters(command=command, args=args, env=env)

    url = cfg.get("url")
    if not url:
        raise ValueError("MCP server config must provide either 'command' or 'url'")

    transport = str(cfg.get("transport") or cfg.get("type") or "streamable-http").lower()
    headers = cfg.get("headers")

    if transport == "sse":
        timeout_value = cfg.get("timeout")
        sse_read_timeout_value = cfg.get("sse_read_timeout")
        timeout = float(timeout_value) if isinstance(timeout_value, (int, float)) else 5.0
        sse_read_timeout = (
            float(sse_read_timeout_value)
            if isinstance(sse_read_timeout_value, (int, float))
            else 60.0 * 5
        )
        return SseServerParameters(
            url=url,
            headers=headers,
            timeout=timeout,
            sse_read_timeout=sse_read_timeout,
        )

    if transport in {"streamable-http", "http", "https"}:
        return StreamableHttpParameters(
            url=url,
            headers=headers,
            timeout=_seconds_to_timedelta(cfg.get("timeout"), 30.0),
            sse_read_timeout=_seconds_to_timedelta(cfg.get("sse_read_timeout"), 60.0 * 5),
            terminate_on_close=bool(cfg.get("terminate_on_close", True)),
        )

    if transport in {"websocket", "ws", "wss"}:
        return ("websocket", url)

    raise ValueError(f"Unsupported MCP transport {transport!r}")


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
            try:
                server_params = _build_server_params(cfg)
            except ValueError as exc:
                log.warning("Skipping MCP server %s: %s", server_id, exc)
                continue

            if isinstance(server_params, StdioServerParameters):
                read, write = await self._stack.enter_async_context(stdio_client(server_params))
            elif isinstance(server_params, SseServerParameters):
                read, write = await self._stack.enter_async_context(
                    sse_client(
                        url=server_params.url,
                        headers=server_params.headers,
                        timeout=server_params.timeout,
                        sse_read_timeout=server_params.sse_read_timeout,
                    )
                )
            elif isinstance(server_params, StreamableHttpParameters):
                httpx_client = create_mcp_http_client(
                    headers=server_params.headers,
                    timeout=server_params.timeout.total_seconds(),
                )
                httpx_client = await self._stack.enter_async_context(httpx_client)
                read, write, _ = await self._stack.enter_async_context(
                    streamable_http_client(
                        url=server_params.url,
                        http_client=httpx_client,
                        terminate_on_close=server_params.terminate_on_close,
                    )
                )
            else:
                _transport, websocket_url = server_params
                read, write = await self._stack.enter_async_context(
                    websocket_client(websocket_url)
                )

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
