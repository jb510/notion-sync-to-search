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
knowledge/notion-sync-read-only/
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
knowledge/notion-sync-read-only/.notion-search-mirror.json
```

### `mirror-config.js`

Pull configured pages and database query results.

```bash
node scripts/mirror-config.js config/notion-search-mirror.json [--json]
```

Config shape:

```json
{
  "outDir": "knowledge/notion-sync-read-only",
  "syncScope": "selected",
  "workspace": {
    "query": "",
    "pathPrefix": "Workspace",
    "limit": 500
  },
  "pages": [
    {
      "pageId": "3133f788-993c-8137-b51c-db4f312e9500",
      "path": "00 Index/OpenClaw Knowledge Base Root.md"
    }
  ],
  "databases": [
    {
      "databaseId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "pathPrefix": "05 Research Library",
      "limit": 100
    }
  ]
}
```

Database entries may include Notion API `filter` and `sorts` payloads.

`syncScope` controls the source scope:

- `selected` mirrors only configured `pages[]` and `databases[]`.
- `integration-visible-workspace` mirrors every page returned by Notion search for the integration.

To mirror the integration-visible workspace:

```json
{
  "outDir": "knowledge/notion-sync-read-only",
  "syncScope": "integration-visible-workspace",
  "workspace": {
    "query": "",
    "pathPrefix": "Workspace",
    "limit": 500
  },
  "pages": [],
  "databases": []
}
```

This is permission-scoped and bounded by `workspace.limit`. Legacy configs with `workspace.enabled: true` are still accepted when `syncScope` is not present.

Generated database/workspace paths include a short page ID suffix, such as `Workspace/Topic - 3133f788.md`, so duplicate titles do not overwrite unrelated pages. Explicit `pages[].path` values are respected exactly.

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

### `notion-to-md.js`

Lower-level page export. Prefer `mirror-page.js` for search mirrors because it adds source frontmatter and updates the manifest.

```bash
node scripts/notion-to-md.js <page-id> [output-file] [--json]
```

The shared exporter walks nested child blocks and converts common searchable block types, including headings, paragraphs, lists, todos, toggles, code, quotes, callouts, child page/database titles, links, external media URLs, media captions, and table rows. It does not mirror Notion-hosted signed file URLs.

## Path Safety

Scripts that write files refuse to write outside the current working directory and refuse to write through symlinks.

## Non-goals

This skill intentionally does not include:

- realtime sync
- two-way sync
- local markdown to Notion push
- automatic Notion writes from mirror files

Use the bundled `notion` skill or direct Notion API tools for Notion edits, then refresh this search mirror.
