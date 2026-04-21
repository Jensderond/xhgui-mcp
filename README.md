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

## Using with Claude Code (MSN-specific example)

Add to your Claude Code MCP config (e.g. `~/.claude/settings.json` under `mcpServers`, or the project-scoped `.mcp.json`):

    {
      "mcpServers": {
        "xhgui": {
          "command": "node",
          "args": ["/Users/jens/Sites/msn-website/xhgui-mcp/dist/server.js"],
          "env": {
            "XHGUI_BACKEND": "pdo",
            "XHGUI_PDO_DSN": "mysql://db:db@127.0.0.1:32785/xhgui",
            "XHGUI_HOTSPOT_PATTERNS": "ElementQuery::one,ElementQuery::all,internalExecute,getAttribute,Container::build,renderTemplate"
          }
        }
      }
    }

Find the mapped MariaDB port with `ddev describe` in the MSN project directory. The port changes when ddev is restarted, so update the DSN if calls start failing.
