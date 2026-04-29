---
name: notion-sync-to-search
description: Use Notion as an auxiliary OpenClaw knowledge base by mirroring integration-visible Notion pages into local read-only markdown for QMD/Lossless search while keeping Notion as the source of truth. Use when Notion content should be searchable locally, when refreshing the read-only Notion search mirror, or when tracing a local search hit back to the live Notion page before editing.
homepage: https://github.com/jb510/notion-sync-to-search
repository: https://github.com/jb510/notion-sync-to-search
license: MIT-0
metadata:
  clawdis:
    requires:
      env: [NOTION_API_KEY]
      bins: [node]
    stateDirs: [memory]
---

# Notion Sync To Search

Mirror Notion content into local markdown so OpenClaw/QMD can use Notion as an auxiliary searchable knowledge base without treating local files as the source of truth.

This skill exists because Notion is good as a canonical workspace, but local OpenClaw search works best over local text. The mirror gives agents fast semantic/local search over Notion-derived knowledge while preserving a hard boundary: all edits go back to Notion.

## Core Policy

1. **Notion is authoritative.**
2. **The local mirror is read-only cache.**
3. **Never edit mirrored markdown as the final source.**
4. **Use mirrored markdown only for search, recall, citation, and page discovery.**
5. **When a search hit comes from the mirror, use its frontmatter to identify the live Notion page and edit Notion directly.**
6. **Refresh the mirror after Notion edits so local search catches up.**

The standard mirror folder is:

```text
knowledge/notion-sync-read-only/
```

The folder name is intentional. Humans and agents should treat files inside it as generated cache.

## What This Skill Is For

- Pulling Notion pages into local markdown for search.
- Optionally mirroring every page the Notion integration can see, with explicit limits.
- Walking nested page blocks so searchable text inside toggles, lists, callouts, child pages, media captions, and tables is included.
- Preserving Notion page IDs, URLs, and timestamps in frontmatter.
- Keeping a local manifest of mirrored pages.
- Generating collision-resistant filenames for bulk mirrors by including a short Notion page ID.
- Letting QMD/Lossless search Notion-derived knowledge as normal local markdown.
- Routing edits back to the live Notion page.

## What This Skill Is Not For

- Realtime sync.
- Two-way sync.
- Editing local markdown and pushing it back to Notion automatically.
- Creating a second source of truth.
- Secretly crawling Notion pages that are not shared with the integration.

If you need to create or edit Notion content, use the bundled `notion` skill or direct Notion API tools. After editing Notion, refresh this mirror.

## Required Metadata

Every mirrored file must include frontmatter like this:

```yaml
---
source: notion
mirror_mode: read_only
notion_page_id: "3133f788-993c-8137-b51c-db4f312e9500"
notion_url: "https://www.notion.so/..."
notion_last_edited_time: "2026-04-29T12:00:00.000Z"
mirrored_at: "2026-04-29T12:05:00.000Z"
---
```

If that metadata is missing, do not assume a local markdown file can be safely mapped back to Notion.

## Setup

Provide a Notion integration token using one of:

```bash
export NOTION_API_KEY="ntn_..."
echo "ntn_..." > ~/.notion-token && chmod 600 ~/.notion-token
```

Share target Notion pages/databases with that integration in Notion.

## Mirror One Page

From an OpenClaw workspace:

```bash
node {baseDir}/scripts/mirror-page.js <notion-page-id>
```

Default output:

```text
knowledge/notion-sync-read-only/<page-title>.md
```

Custom output directory:

```bash
node {baseDir}/scripts/mirror-page.js <page-id> --out-dir "knowledge/notion-sync-read-only"
```

Custom relative path:

```bash
node {baseDir}/scripts/mirror-page.js <page-id> --path "05 Research Library/Topic.md"
```

The custom path is still placed under `knowledge/notion-sync-read-only/` unless `--out-dir` is changed.

## Mirror A Configured Knowledge Base

Create a config file:

```json
{
  "outDir": "knowledge/notion-sync-read-only",
  "workspace": {
    "enabled": false,
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

Then run:

```bash
node {baseDir}/scripts/mirror-config.js config/notion-search-mirror.json
```

Use database/workspace mirroring carefully. It mirrors only pages the integration can see. It does not bypass Notion sharing or permissions.

Bulk-generated database/workspace file names include a short Notion page ID suffix, for example:

```text
Workspace/Project Notes - 3133f788.md
```

That avoids overwriting unrelated Notion pages with the same title and keeps search hits easy to map back to their source.

## Whole Workspace Mirroring

This skill can mirror every page returned by Notion search for the configured integration:

```json
{
  "outDir": "knowledge/notion-sync-read-only",
  "workspace": {
    "enabled": true,
    "query": "",
    "pathPrefix": "Workspace",
    "limit": 500
  }
}
```

This is not enabled by default because "whole workspace" means "everything this Notion integration can see and the Notion search API returns," not necessarily every private page in the human user's Notion account. Notion's search endpoint is also not designed as a guaranteed exhaustive export API. It can pull stale, irrelevant, or duplicate pages into local search, and it can miss pages while indexes catch up. Prefer explicit pages/databases for curated knowledge bases; use workspace mirroring when the integration is intentionally scoped to the knowledge base you want indexed.

## Search Workflow

1. Search QMD/Lossless as usual.
2. If a result is under `notion-sync-read-only/`, read its frontmatter.
3. Use `notion_page_id` to fetch the current Notion page.
4. Edit Notion directly.
5. Refresh the mirror.

Do not patch the mirrored markdown file as the final edit.

## Organization Policy

This skill does not know each user's Notion taxonomy. Before creating or moving Notion pages, read local policy from the install or agent workspace, such as:

- `AGENTS.md`
- `TOOLS.md`
- `NOTION_POLICY.md`
- relevant memory files

Good local policy should define:

- canonical Notion root page or database
- approved buckets/folders
- where inbox/uncategorized material goes
- duplicate-check requirements
- what receipt to return after saving

For example, an install may say: "Do not invent top-level folders; use the existing Knowledge Base Root and route into existing buckets."

## QMD / Memory Search

The mirror folder should be included in OpenClaw/QMD searchable paths. Example shape:

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "includeDefaultMemory": true,
      "paths": [
        "knowledge/notion-sync-read-only"
      ]
    }
  }
}
```

Use the correct absolute or workspace-relative path for each install.

## Safety Rules

- Do not run local-to-Notion sync from this skill.
- Do not run a realtime sync daemon from this skill.
- Do not edit files under `notion-sync-read-only/` except by rerunning mirror scripts.
- If a mirrored file and Notion disagree, trust Notion.
- If frontmatter does not identify a Notion page, treat the local file as untrusted cache.
