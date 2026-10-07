#!/usr/bin/env python3
"""Minimal stdio MCP server for isolated H-T2 evidence (one echo tool).

Speaks just enough JSON-RPC 2.0 over stdio for pi to list and call a tool:
initialize → tools/list → tools/call. No deps, no network.
"""
import json
import sys


def send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    method = req.get("method", "")
    rid = req.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "dummy", "version": "1.0.0"}}})
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        send({
            "jsonrpc": "2.0",
            "id": rid,
            "result": {"tools": [{
                "name": "echo_search",
                "description": "Echo a query back (dummy MCP tool for display evidence)",
                "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            }]},
        })
    elif method == "tools/call":
        args = (req.get("params") or {}).get("arguments", {})
        send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": f"dummy echo: {args.get('query', '')}"}]}})
    elif rid is not None:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown method {method}"}})
