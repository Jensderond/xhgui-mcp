# xhgui-mcp

MCP server for querying XHGui profiling data.

## Status

Pre-release. See `docs/design.md`.

## Environment variables

| Var | Required | Example |
|---|---|---|
| `XHGUI_BACKEND` | yes | `pdo` |
| `XHGUI_PDO_DSN` | if pdo | `mysql://db:db@127.0.0.1:32789/xhgui` |
| `XHGUI_HOTSPOT_PATTERNS` | no | `ElementQuery::one,Container::build` |

## Running

    npm install
    npm run build
    XHGUI_BACKEND=pdo XHGUI_PDO_DSN=... node dist/server.js
