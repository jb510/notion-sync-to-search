# NOTION_POLICY.md Template

Each OpenClaw install can keep its own Notion organization rules in a workspace file such as `NOTION_POLICY.md`.

The shared `notion-sync-to-search` skill should stay generic. Put install-specific taxonomy here.

## Source Of Truth

- Notion is the source of truth.
- Local files under `notion-sync-read-only/` are generated search cache.
- Do not edit the mirror directly.

## Canonical Root

- Root page/database:
- URL:
- Page/database ID:

## Approved Buckets

Use only these top-level buckets unless the user explicitly asks for a new one:

- `00 Inbox`
- `01 ...`
- `02 ...`

## Inbox / Unknown Placement

When placement is unclear:

1. Search for an existing related page or bucket.
2. Ask the user if the destination is ambiguous.
3. If still unclear, place in:

```text
00 Inbox/Needs Classification/
```

## Duplicate Check

Before creating a new Notion page:

1. Search Notion for the proposed title.
2. Search the local mirror for similar titles/content.
3. Update an existing page when that is clearly correct.

## Receipt

After creating or updating Notion content, return:

- Notion title
- Notion URL
- bucket/path
- new vs updated
- mirror refresh status, if refreshed
