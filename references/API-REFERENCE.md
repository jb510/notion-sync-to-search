# API Reference

Technical reference for the scripts in `notion-sync-to-search`.

## Token Resolution

All scripts require a Notion integration token. Supported sources, in priority order:

1. `--token-file <path>`
2. `--token-stdin`
3. `~/.notion-token`
4. `NOTION_API_KEY`

Credentials are never accepted as bare positional CLI arguments.

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
knowledge/Notion Read-only/
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
knowledge/Notion Read-only/.notion-search-mirror.json
```

### `mirror-config.js`

Pull configured pages and database query results.

```bash
node scripts/mirror-config.js config/notion-search-mirror.json [--json]
```

Config shape:

```json
{
  "outDir": "knowledge/Notion Read-only",
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

## Path Safety

Scripts that write files refuse to write outside the current working directory by default. Use `--allow-unsafe-paths` only when you intentionally need to override that guardrail.

## Non-goals

This skill intentionally does not include:

- realtime sync
- two-way sync
- local markdown to Notion push
- automatic Notion writes from mirror files

Use the bundled `notion` skill or direct Notion API tools for Notion edits, then refresh this search mirror.

