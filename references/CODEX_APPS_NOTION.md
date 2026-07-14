# Codex Apps Notion Connector

Use this reference when an OpenClaw Codex-runtime agent can see `codex_apps.notion.*` tools, when the connector fails, or when more than one Notion workspace is configured.

## Role

Codex Apps Notion is an optional interactive convenience surface. It can provide useful live search and CRUD tools inside a Codex app-server turn. It is not the backend for scheduled `notion-sync-to-search` jobs and does not replace workspace-specific Notion integration tokens.

Keep these boundaries:

- Deterministic scheduled sync, manifests, pruning, and bulk reconciliation use the skill scripts and configured token environments.
- Local recall and discovery use the read-only mirror first.
- Live CRUD uses a workspace resolved by `provenance.js` or `resolve-live-token.js`.
- The connector may be used only when its authenticated workspace is known to match that resolved workspace.

The runtime tool name may appear as `codex_apps.notion.<operation>`. OpenClaw or Codex catalog diagnostics may call the namespace `codex_apps__notion`.

## Safe Decision Tree

1. Identify the target page/database or ask the user where it belongs.
2. Resolve its workspace, live URL, and token environment from mirror provenance.
3. If Codex Apps Notion is available and verified for that workspace, it may be used for the interactive operation. Verify it by fetching/searching a known anchor page from that workspace and comparing the returned Notion page ID with the ID in the mirror/config.
4. If connector workspace identity is unknown, bypass it and use the resolved API token.
5. If the connector fails, retry once using the resolved direct API path.
6. If the direct API has a transient failure, a connector verified for the same workspace may be used as fallback. If the direct API has an authentication or permission failure, the verified connector may complete the interactive operation, but report the degraded direct path and exact remediation.
7. Return a Notion receipt for success or failure.

Do not retry writes blindly. Before retrying a create operation after an uncertain timeout, search for the intended title/parent or inspect the connector response to avoid duplicate pages.

## Verifying Connector Workspace Identity

A successful connector call, connected user identity, or reported workspace display name does not prove that the connector targets the requested workspace. Different integrations can expose the same display name.

1. Select a stable anchor page ID from the requested workspace's mirror or explicit config.
2. Fetch or search for that exact anchor through Codex Apps Notion.
3. Compare the returned Notion page ID with the expected ID.
4. Treat the connector as verified only when the IDs match.
5. Reverify after connector reauthorization or any connection/workspace change.

If there is no matching anchor, use the workspace-resolved direct API token. Never use a connector verified for one workspace as fallback for another. Deterministic scheduled sync never uses the connector.

## Successful Creates

Resolve the parent page/database workspace and token before issuing a create. Keep that workspace and token environment in the active context.

After the create succeeds:

1. Use the returned page ID and live URL directly in the receipt.
2. Do not run `resolve-live-token.js` or `provenance.js` on the new page immediately afterward.
3. Treat a resolver no-match before mirror refresh as expected, not as a failed write.
4. Run an incremental mirror refresh only when the new page must become locally searchable immediately.
5. For immediate follow-up edits before refresh, reuse the already resolved parent workspace/token and the new page ID.

This avoids the misleading pattern where a successful create is followed by a failed optional resolver call and shown to the user as a Bash/tool warning.

## Stale Skill Paths

The only live skill path is `<state>/skills/notion-sync-to-search`. Deployment backups must live outside `<state>/skills`, preferably under `<state>/archives/skills/notion-sync-to-search/<timestamp>`.

If a tool call references `notion-sync-to-search.bak-*`, `old-*`, or another noncanonical skill directory:

1. Do not continue using that path.
2. Use the canonical skill path for the current operation.
3. Confirm the backup directory is outside the skill discovery root.
4. Start a new OpenClaw session after deployment if the existing session cached the obsolete skill base directory.

Do not delete the only backup. Move it to the archive location after confirming the canonical skill copy is complete.

## Error Classification

### Connector OAuth failure

Common evidence:

```text
oauth_token_invalid_grant
TRIGGER_REAUTHENTICATION
connector UNAUTHORIZED
This app connection requires reauthentication
```

Meaning: the Codex Apps connector link is stale or revoked. It does not prove that the install-scoped Notion API key is invalid.

Action:

1. Resolve the intended workspace.
2. Retry through that workspace's configured API token.
3. If successful, finish the task and say the optional connector was bypassed.
4. Recommend connector reauthentication only if the user wants the connector restored.

User-facing form:

```text
The optional Codex Apps Notion connection has expired, but the install's Notion integration is still available. I completed the request through the configured <workspace> integration. Reconnect the Codex Apps connector only if you want that convenience path restored.
```

### Direct API authentication failure

Common evidence: Notion API `401 unauthorized` or `invalid_token`.

Meaning: the selected workspace token is missing, invalid, or expired.

Action:

1. Report the workspace and token environment name, never its value.
2. Confirm the token environment is present in the install-level `.env`.
3. Run a harmless read such as `GET /v1/users/me` with that token.
4. Replace/reissue only that workspace token if the read fails.

User-facing form:

```text
The configured Notion integration for <workspace> could not authenticate using <TOKEN_ENV>. The connector is not the issue. Verify or replace that workspace's integration token, then retry.
```

### Permission or workspace mismatch

Common evidence: Notion API `403`, `object_not_found`, or a known page that cannot be fetched.

Meaning: the integration may not have the page shared with it, the page may belong to another configured workspace, or the wrong token was selected.

Action:

1. Resolve page provenance again.
2. Try the token assigned to that workspace only.
3. Verify the target page/database is shared with the corresponding Notion integration.
4. Do not fall back to another workspace merely because it is writable.

User-facing form:

```text
The <workspace> integration is authenticated but cannot access <page>. Share that page/database with the <workspace> integration, or tell me if it belongs in another configured workspace.
```

### Mirror miss or stale search

Meaning: the local mirror did not contain the page. This is not an authentication result.

Action:

1. Inspect the relevant workspace manifest timestamp.
2. If stale, run the normal incremental sync for that workspace.
3. If current, perform a live title search with the correct workspace token.
4. If live search finds the page, use it and allow the next sync to refresh the mirror.

### Connector unavailable

Meaning: the active runtime or tool policy did not expose Codex Apps Notion.

Action: use the mirror and direct API path normally. Do not ask the user to enable the connector unless they explicitly want it.

## Failure Receipt

When no safe route succeeds, return:

```text
Notion receipt:
- Action: failed
- Workspace: <workspace or unresolved>
- Page: <title or target>
- Link: <live URL if known>
- Failed surface: Codex Apps connector / direct Notion API / mirror search
- Error: <plain-language category>
- Tried: <brief list of non-destructive attempts>
- Next step: <one exact user/admin action>
```

Avoid raw OAuth payloads, token values, giant logs, and generic reauthentication advice.
