# API Reference

Technical reference for the scripts in `notion-sync-to-search`.

## Token Resolution

All scripts require a Notion integration token in the environment:

```bash
export NOTION_API_KEY="ntn_..."
```

Credentials are never accepted as positional arguments, file paths, or stdin.

The scripts use Notion API version `2026-03-11` by default. Override with `NOTION_VERSION` only if an install needs to pin an older API version temporarily.
Requests time out after 30 seconds.
Network access is limited to `https://api.notion.com`.

## JSON Output

All scripts support `--json`.

- Success output is JSON.
- Errors are emitted as `{ "error": "..." }`.
- Progress logs are suppressed from stdout in JSON mode.

## Read-only Mirror Scripts

### `mirror-page.js`

Pull one Notion page into a local read-only markdown mirror.

```bash
node scripts/mirror-page.js <page-id> [--out-dir <dir>] [--path <relative-path>] [--json]
```

Default output directory:

```text
notion-sync-read-only/
```

Output files include frontmatter:

```yaml
---
source: notion
mirror_mode: read_only
notion_page_id: "..."
notion_url: "..."
notion_last_edited_time: "..."
mirrored_at: "..."
---
```

The script also updates:

```text
notion-sync-read-only/.notion-search-mirror.json
```

### `mirror-config.js`

Refresh the local Notion knowledge-base mirror.

```bash
node scripts/mirror-config.js config/notion-search-mirror.json [--dry-run] [--status] [--doctor] [--json]
```

Config shape:

```json
{
  "outDir": "notion-sync-read-only",
  "workspaceFolder": "auto",
  "sync": {
    "intervalMinutes": 60
  },
  "report": {
    "retentionRuns": 250,
    "outputFile": ""
  },
  "limits": {
    "maxPages": 5000,
    "maxBlocksPerPage": 20000,
    "maxMarkdownBytesPerPage": 5242880,
    "maxRunMinutes": 60
  },
  "searchIndex": {
    "freshnessFile": ""
  },
  "syncScope": "integration-visible-workspace",
  "workspace": {
    "query": "",
    "pathPrefix": "",
    "limit": 5000
  },
  "pages": [],
  "databases": []
}
```

Database entries may include Notion API `filter` and `sorts` payloads.

`syncScope` controls the source scope:

- `integration-visible-workspace` is the normal knowledge-base mode. It mirrors every page returned by Notion search for the integration.
- `selected` is an advanced narrowing mode. It mirrors only configured `pages[]` and `databases[]`.

`workspaceFolder` controls the folder under `outDir`:

- `"auto"` uses the Notion integration bot's workspace name.
- A string overrides the folder name.
- `"none"` disables workspace subfolders.

### Config Population

The config file is operator-maintained. OpenClaw can create or edit it from natural-language instructions, but the mirror script itself does not rewrite `config/notion-search-mirror.json`.

In `integration-visible-workspace` mode:

- Leave `pages[]` and `databases[]` empty unless you intentionally want explicit extra entries.
- The script calls Notion search at runtime and mirrors pages visible to the integration.
- The generated `.notion-search-mirror.json` manifest records what was mirrored during the run.

In `selected` mode:

- Add entries to `pages[]` for individual Notion pages.
- Add entries to `databases[]` for Notion databases/data sources.
- The script mirrors exactly those configured page entries plus the pages returned by configured database queries.

`pages[]` entry:

```json
{
  "pageId": "YOUR_NOTION_PAGE_ID",
  "path": "Runbooks/Postgres.md"
}
```

- `pageId`: Notion page ID from the URL or `search-notion.js`.
- `path`: optional output path under `outDir`. If omitted, the page title is used.

`databases[]` entry:

```json
{
  "databaseId": "YOUR_NOTION_DATABASE_ID",
  "pathPrefix": "PRDs",
  "limit": 100
}
```

- `databaseId`: Notion database/data source ID from the URL or `search-notion.js`.
- `pathPrefix`: optional folder under `outDir`.
- `limit`: maximum database pages to mirror.
- `filter` and `sorts`: optional Notion API query payloads.

Discovery helpers:

```bash
node scripts/search-notion.js "postgres runbook" --filter page
node scripts/search-notion.js "prd" --filter database
node scripts/get-database-schema.js <database-id>
```

Default integration-visible workspace config:

```json
{
  "outDir": "notion-sync-read-only",
  "workspaceFolder": "auto",
  "sync": {
    "intervalMinutes": 60
  },
  "syncScope": "integration-visible-workspace",
  "workspace": {
    "query": "",
    "pathPrefix": "",
    "limit": 5000
  },
  "pages": [],
  "databases": []
}
```

This is permission-scoped and bounded by `workspace.limit`.

Generated database/workspace paths include a short page ID suffix, such as `Topic - short-page-id.md`, so duplicate titles do not overwrite unrelated pages. Explicit `pages[].path` values are respected exactly.

### `install-scheduler.js`

Print or install launchd/systemd/cron scheduler entries for recurring mirror refresh.

```bash
node scripts/install-scheduler.js [--config config/notion-search-mirror.json] [--every 60] [--report] [--days 7] [--mode print|install] [--json]
```

- `--mode print` is the default. It prints scheduler files and activation commands.
- `--mode install` writes scheduler files for launchd on macOS or systemd user timers on Linux.
- Without `--every`, the helper reads `sync.intervalMinutes` from config.
- `--report` schedules a report command instead of a sync command.
- The scheduler helper does not store `NOTION_API_KEY`; configure that secret in the scheduler runtime environment.
- The scheduled task runs `mirror-config.js`.

### Refresh

Refresh is scheduled pull by default. Notion does not push full page content into this skill; each refresh asks Notion what the integration can see, then pulls current page content into the local read-only mirror.

Manual refresh is available for debugging and immediate catch-up:

```bash
node scripts/mirror-config.js config/notion-search-mirror.json
```

Effects:

- Discovers configured pages/databases, or the integration-visible workspace when `syncScope` is `integration-visible-workspace`.
- Re-fetches only new/changed pages unless `--full` is used.
- Writes refreshed markdown files under the resolved workspace folder.
- Updates the workspace folder's `.notion-search-mirror.json`.
- Leaves `config/notion-search-mirror.json` unchanged.

Pruning defaults to safe mode:

```bash
node scripts/mirror-config.js config/notion-search-mirror.json --prune safe
node scripts/mirror-config.js config/notion-search-mirror.json --prune off
node scripts/mirror-config.js config/notion-search-mirror.json --prune force
```

`safe` skips pruning when discovery is incomplete because a limit was reached. `force` prunes anyway.

Report recent sync activity without syncing:

```bash
node scripts/mirror-config.js config/notion-search-mirror.json --report --days 7
node scripts/mirror-config.js config/notion-search-mirror.json --status
node scripts/mirror-config.js config/notion-search-mirror.json --doctor
```

Reports include failures and pruned pages recorded in the manifest run history. They are local-only and discover existing workspace manifests under `outDir`; use `--workspace-folder <name>` to select one workspace folder.

Run history retention defaults to 250 runs. Configure with `report.retentionRuns`.

`--dry-run` discovers what would refresh or prune without writing markdown, updating manifests, or deleting files.

`limits` bounds page count, page block count, markdown bytes per page, and run duration.

`searchIndex.freshnessFile` enables a simple local freshness check by comparing a search backend marker file mtime to the last completed mirror run.

Multiple workspace configs can be supplied with `workspaces[]`; each entry may set `workspaceFolder`, `tokenEnv`, `pages`, `databases`, and other per-workspace overrides. When `tokenEnv` is set, that environment variable must be present for that workspace. Workspaces without `tokenEnv` use `NOTION_API_KEY`.

The OpenClaw memory/search backend is responsible for indexing the changed local markdown. If search looks stale after resync, refresh/reindex/restart the active memory/search backend for that install.

For normal operation, keep the generated host scheduler enabled.

## Live Notion Read Helpers

### `search-notion.js`

Search Notion by the official Notion search endpoint.

```bash
node scripts/search-notion.js "<query>" [--filter page|database] [--limit 10] [--json]
```

Use this for page/database discovery, not as the only full-text knowledge-base search layer.

### `query-database.js`

Query a Notion database/data source.

```bash
node scripts/query-database.js <database-id> [--filter <json>] [--sort <json>] [--limit 10] [--json]
```

Example filter:

```json
{"property": "Status", "select": {"equals": "Complete"}}
```

Example sort:

```json
[{"property": "Date", "direction": "descending"}]
```

### `get-database-schema.js`

Inspect a database schema.

```bash
node scripts/get-database-schema.js <database-id> [--json]
```

`mirror-page.js` is the only single-page export path. It walks nested child blocks, converts common searchable block types to markdown, adds source frontmatter, and updates the mirror manifest.

## Path Safety

Mirror scripts that write files refuse to write outside the current working directory and refuse to write through symlinks. `install-scheduler.js --mode install` explicitly writes host scheduler files.

## Non-goals

This skill intentionally does not include:

- realtime sync
- two-way sync
- local markdown to Notion push
- automatic Notion writes from mirror files

Use the bundled `notion` skill or direct Notion API tools for Notion edits. Scheduled refresh will pull Notion changes into the search mirror.
