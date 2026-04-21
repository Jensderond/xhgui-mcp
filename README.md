# xhgui-mcp

MCP server that gives AI agents structured, pre-summarized access to [XHGui](https://github.com/perftools/xhgui) profiling data.

Two tools today:

- `list_runs` — recent runs, with filters (url, url_contains, method, time range, min wall).
- `get_run_summary` — one call returns totals + top-N by inclusive / self time + optional hotspot matches for a given run.

Status: pre-release. Design notes in `docs/design.md`.

## Environment variables

| Var | Required | Example |
|---|---|---|
| `XHGUI_BACKEND` | yes | `pdo` |
| `XHGUI_PDO_DSN` | if `pdo` | `mysql://db:db@127.0.0.1:32789/xhgui` |
| `XHGUI_HOTSPOT_PATTERNS` | no | `ElementQuery::one,Container::build,renderTemplate` (CSV of symbol substrings) |

Only the PDO backend (MySQL/MariaDB) is implemented today. MongoDB support is planned.

## Install

### Local (no npm publish)

    git clone <this repo> xhgui-mcp
    cd xhgui-mcp
    npm install
    npm run build
    npm link

After `npm link`, `xhgui-mcp` is on your npm global bin and `npx xhgui-mcp` resolves it.

### After publish (future)

    npx -y xhgui-mcp

## Use with Claude Code

```bash
claude mcp add --transport stdio xhgui \
  -e XHGUI_BACKEND=pdo \
  -e XHGUI_PDO_DSN="mysql://db:db@127.0.0.1:32789/xhgui" \
  -e XHGUI_HOTSPOT_PATTERNS="ElementQuery::one,ElementQuery::all,internalExecute,getAttribute,Container::build,renderTemplate" \
  -- npx -y xhgui-mcp
```

Equivalent `.mcp.json`:

```json
{
  "mcpServers": {
    "xhgui": {
      "command": "npx",
      "args": ["-y", "xhgui-mcp"],
      "env": {
        "XHGUI_BACKEND": "pdo",
        "XHGUI_PDO_DSN": "mysql://db:db@127.0.0.1:32789/xhgui",
        "XHGUI_HOTSPOT_PATTERNS": "ElementQuery::one,ElementQuery::all,internalExecute,getAttribute,Container::build,renderTemplate"
      }
    }
  }
}
```

## Use with ddev

The MCP doesn't know about ddev — point the DSN at ddev's host-mapped DB port.

    ddev describe | grep -i mariadb
    # db:3306 -> 127.0.0.1:32789

Use that host-side port in `XHGUI_PDO_DSN`. Note: the port reshuffles on `ddev restart`, so update the DSN if calls start returning connection errors.

## Development

    npm run dev      # tsc --watch
    npm run build    # one-shot build + chmod +x dist/server.js
    npm start        # node dist/server.js

## License

MIT.
