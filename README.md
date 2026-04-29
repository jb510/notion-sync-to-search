# Notion Sync To Search

OpenClaw skill for mirroring selected Notion pages into a local read-only markdown knowledge base so QMD/Lossless can search them.

## Why this exists

Notion is a good source of truth, but live API search is not a great full-text knowledge-base search layer for OpenClaw. This skill pulls selected Notion pages into local markdown so normal OpenClaw memory/search tools can find them.

The local files are cache, not canonical content.

## Policy

- Notion is source of truth.
- Local markdown lives under `knowledge/Notion Read-only/`.
- Local markdown is read-only cache for search.
- Edits go to Notion directly.
- Refresh the mirror after edits.

## Quick start

```bash
export NOTION_API_KEY="ntn_..."
node scripts/mirror-page.js <page-id>
```

Or mirror a configured set:

```bash
cp config/notion-search-mirror.example.json config/notion-search-mirror.json
node scripts/mirror-config.js config/notion-search-mirror.json
```

## OpenClaw/QMD

Add the mirror folder to QMD searchable paths for each install:

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "includeDefaultMemory": true,
      "paths": ["knowledge/Notion Read-only"]
    }
  }
}
```

Use the correct absolute/workspace-relative path for your OpenClaw install.

## Included scripts

- `scripts/mirror-page.js` - pull one Notion page into read-only markdown with frontmatter
- `scripts/mirror-config.js` - pull configured pages/databases
- `scripts/search-notion.js` - live Notion title/object search
- `scripts/query-database.js` - query a Notion database/data source
- `scripts/get-database-schema.js` - inspect database schema
- `scripts/notion-to-md.js` - lower-level page-to-markdown export

This repo intentionally does not include realtime or two-way sync.

