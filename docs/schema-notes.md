# MSN xhgui schema notes

Captured 2026-04-21 from the MSN ddev environment.

## Connection

- Container: `ddev-msn-db` (MySQL 8.0 per `ddev describe`).
- Host-mapped DSN: `mysql://db:db@127.0.0.1:32785/xhgui` (port via `ddev describe`; `root/root` also works).
- From inside ddev: `mysql -u db -pdb xhgui` against `db:3306`.

## `xhgui` database

Two tables: `results` (profile runs), `watches` (user-configured watches in the XHGui UI — not relevant to the MCP). The MCP only reads `results`.

## `results` table

| Column             | Type            | Purpose                                                      |
|--------------------|-----------------|--------------------------------------------------------------|
| `id`               | `char(24)` PK   | Run id (hex string, same id the XHGui UI uses in URLs).      |
| `profile`          | `longtext`      | JSON blob with the full per-edge call map. See shape below.  |
| `url`              | `text`          | Request URL (path + query).                                  |
| `SERVER`           | `text` (JSON)   | The `$_SERVER` array, JSON-encoded. `REQUEST_METHOD` lives here. |
| `GET`              | `text` (JSON)   | `$_GET` dump. Not used by MCP.                               |
| `ENV`              | `text` (JSON)   | `$_ENV` dump. Not used by MCP.                               |
| `simple_url`       | `text`          | URL with query string stripped (xhgui's normalized form).    |
| `request_ts`       | `int`           | Unix seconds.                                                |
| `request_ts_micro` | `decimal(15,4)` | Unix seconds with sub-second precision. Not used by MCP.     |
| `request_date`     | `date`          | Day of request. Not used by MCP.                             |
| `main_wt`          | `int`           | Request total wall time (µs).                                |
| `main_ct`          | `int`           | Root call count (always 1 for `main()`).                     |
| `main_cpu`         | `int`           | Request total CPU time (µs).                                 |
| `main_mu`          | `int`           | Request memory usage (bytes).                                |
| `main_pmu`         | `int`           | Request peak memory usage (bytes).                           |

`SERVER` is stored as `text`, not `JSON` type, but the content is valid JSON and `JSON_EXTRACT` / `JSON_UNQUOTE` work against it on both MySQL 8 and MariaDB.

## Profile JSON shape

Stored in column `profile`. Object keyed by edge strings; values are `{ct, wt, cpu, mu, pmu}`. Trimmed sample from a real run:

```json
{
  "main()==>Xhgui\\Profiler\\Profiler::registerShutdownHandler": {
    "ct": 1, "wt": 1, "cpu": 0, "mu": 1432, "pmu": 0
  },
  "ComposerAutoloaderInit...::getLoader==>ComposerAutoloaderInit...::loadClassLoader": {
    "ct": 1, "wt": 9, "cpu": 386, "mu": 664, "pmu": 408
  },
  ...
}
```

- Edge separator is literally `==>` (three characters: `=`, `=`, `>`).
- The root entry is keyed `main()` (no `==>`).
- PHP namespace backslashes are escaped (`\\`) in the raw JSON; after `JSON.parse` they're single backslashes.
- Numbers are integers in µs (time) or bytes (memory).

## Verification against the Task 7 assumptions

All matches:
- Table `results` ✅
- Primary key `id` ✅
- Columns `url`, `SERVER`, `request_ts`, `main_wt`, `main_cpu` ✅
- Method nested in `SERVER.REQUEST_METHOD` ✅
- `JSON_EXTRACT(\`SERVER\`, '$.REQUEST_METHOD')` returns the expected string ✅

For Task 9:
- Columns `main_mu`, `main_pmu`, `profile` ✅
- `profile` is stored as JSON text (not a native JSON column), so the driver returns a string — Task 9's `typeof profileRaw === "string"` branch is the one that runs. ✅

## Divergences from the design spec

None blocking. Two minor notes:

- The spec anticipates `request_ts` as `int/bigint`; MSN's is `int`. Still fits `request_ts * 1000` into JS number range for any realistic request date — no change needed.
- `SERVER` is a JSON-encoded `text` column, not a `JSON` type column. `JSON_EXTRACT` works regardless.
