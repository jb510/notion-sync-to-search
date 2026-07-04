#!/usr/bin/env node
/**
 * Resolve local mirror hits back to live Notion provenance.
 *
 * The target can be a Notion page ID/URL, a mirrored markdown path, or search
 * text. Output includes the live Notion URL and token env to use for writes.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeId,
  resolveSafePath,
  stripTokenArg,
  hasJsonFlag,
} = require('./notion-utils.js');

const MANIFEST_FILE = '.notion-search-mirror.json';

function usage(exitCode = 0) {
  console.log('Usage: provenance.js <config.json> <page-id|notion-url|mirror-file|search text> [--env-file <path>] [--limit <n>] [--json]');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/provenance.js config/notion-search-mirror.json "OPEN CLAW MAIN BRAIN"');
  console.log('  node scripts/provenance.js config/notion-search-mirror.json notion-sync-read-only/Walden/Page.md --json');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = stripTokenArg(argv);
  if (args.includes('--help') || args.includes('-h')) usage(0);
  if (args.length < 2) usage(1);
  const options = {
    configPath: args[0],
    target: args[1],
    envFile: null,
    limit: 10,
  };
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--env-file' && args[i + 1]) options.envFile = args[++i];
    else if (args[i] === '--limit' && args[i + 1]) options.limit = parsePositiveInt(args[++i], 10, 100);
    else if (args[i] === '--json') {
      // handled by hasJsonFlag()
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  return options;
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveConfigPath(configPath) {
  if (path.isAbsolute(configPath)) return configPath;
  return resolveSafePath(configPath, { mode: 'read' });
}

function resolveOutDir(config, configPath) {
  const outDir = config.outDir || 'notion-sync-read-only';
  if (path.isAbsolute(outDir)) return path.resolve(outDir);
  return path.resolve(path.dirname(configPath), outDir);
}

function workspaceEntries(config, outDir) {
  if (Array.isArray(config.workspaces) && config.workspaces.length > 0) {
    return config.workspaces.map((workspace, index) => ({
      name: workspace.name || workspace.outFolder || workspace.workspaceFolder || `workspace-${index + 1}`,
      folder: workspace.outFolder || workspace.workspaceFolder || workspace.name || null,
      tokenEnv: workspace.tokenEnv || 'NOTION_API_KEY',
    }));
  }

  const configured = config.outFolder || config.workspaceFolder || config.name || null;
  const discovered = discoverManifestFolders(outDir);
  if ((configured === 'auto' || !configured) && discovered.length > 0) {
    return discovered.map(folder => ({
      name: folder || config.name || 'default',
      folder,
      tokenEnv: config.tokenEnv || 'NOTION_API_KEY',
    }));
  }

  return [{
    name: config.name || configured || 'default',
    folder: configured && configured !== 'auto' && configured !== 'none' ? configured : null,
    tokenEnv: config.tokenEnv || 'NOTION_API_KEY',
  }];
}

function discoverManifestFolders(outDir) {
  const folders = [];
  if (fs.existsSync(path.join(outDir, MANIFEST_FILE))) folders.push(null);
  if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) return folders;
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(outDir, entry.name, MANIFEST_FILE))) folders.push(entry.name);
  }
  return folders;
}

function manifestPathFor(outDir, workspace) {
  return workspace.folder ? path.join(outDir, workspace.folder, MANIFEST_FILE) : path.join(outDir, MANIFEST_FILE);
}

function extractPageId(value) {
  const raw = String(value || '');
  const uuid = raw.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (uuid) return normalizeId(uuid[0]);
  const compact = raw.match(/[0-9a-fA-F]{32}/);
  return compact ? normalizeId(compact[0]) : null;
}

function parseFrontmatter(markdownPath) {
  if (!fs.existsSync(markdownPath) || !fs.lstatSync(markdownPath).isFile()) return {};
  const body = fs.readFileSync(markdownPath, 'utf8').slice(0, 8192);
  const match = body.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const parsed = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
    parsed[key] = value;
  }
  return parsed;
}

function loadEnvPresence(envFile) {
  const presence = {};
  if (!envFile) return presence;
  const resolved = path.isAbsolute(envFile) ? envFile : path.resolve(envFile);
  if (!fs.existsSync(resolved)) return presence;
  for (const rawLine of fs.readFileSync(resolved, 'utf8').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) presence[key] = value.length > 0;
  }
  return presence;
}

function candidatePaths(outDir, workspace, entry) {
  const paths = [];
  const base = workspace.folder ? path.join(outDir, workspace.folder) : outDir;
  if (entry.relativePath) paths.push(path.join(base, entry.relativePath));
  if (entry.path) paths.push(path.resolve(entry.path));
  for (const file of entry.files || []) {
    if (file.relativePath) paths.push(path.join(base, file.relativePath));
    if (file.path) paths.push(path.resolve(file.path));
  }
  return [...new Set(paths)];
}

function scoreEntry(entry, workspace, outDir, target, targetPageId) {
  if (targetPageId && normalizeId(entry.pageId || '') === targetPageId) return 100;
  const lower = String(target).toLowerCase();
  const haystack = [
    entry.title,
    entry.url,
    entry.pageId,
    entry.relativePath,
    entry.path,
    workspace.name,
    workspace.folder,
    ...(entry.files || []).flatMap(file => [file.relativePath, file.path]),
  ].filter(Boolean).join('\n').toLowerCase();
  let score = haystack.includes(lower) ? 50 : 0;
  const targetPath = path.resolve(target);
  if (candidatePaths(outDir, workspace, entry).some(candidate => path.resolve(candidate) === targetPath)) score = Math.max(score, 90);
  return score;
}

function entryToResult(entry, workspace, manifestPath, outDir, envPresence) {
  const files = candidatePaths(outDir, workspace, entry);
  let frontmatter = {};
  for (const file of files) {
    frontmatter = parseFrontmatter(file);
    if (Object.keys(frontmatter).length > 0) break;
  }
  return {
    pageId: entry.pageId || frontmatter.notion_page_id || '',
    title: entry.title || frontmatter.title || '',
    url: entry.url || frontmatter.notion_url || '',
    notionLastEditedTime: entry.notionLastEditedTime || frontmatter.notion_last_edited_time || '',
    mirroredAt: entry.mirroredAt || frontmatter.mirrored_at || '',
    workspaceName: workspace.name,
    workspaceFolder: workspace.folder,
    tokenEnv: workspace.tokenEnv,
    tokenAvailable: Boolean(envPresence[workspace.tokenEnv]),
    manifestPath,
    primaryPath: files[0] || '',
    files,
    receipt: {
      action: 'searched',
      page: entry.title || frontmatter.title || entry.pageId || '',
      link: entry.url || frontmatter.notion_url || '',
    },
  };
}

function resolveProvenance(config, configPath, target, options = {}) {
  const outDir = resolveOutDir(config, configPath);
  const workspaces = workspaceEntries(config, outDir);
  const targetPageId = extractPageId(target);
  const envPresence = {
    ...Object.fromEntries(Object.keys(process.env).map(key => [key, true])),
    ...loadEnvPresence(options.envFile),
  };
  const matches = [];

  for (const workspace of workspaces) {
    const manifestPath = manifestPathFor(outDir, workspace);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    for (const entry of Object.values(manifest.pages || {})) {
      const score = scoreEntry(entry, workspace, outDir, target, targetPageId);
      if (score <= 0) continue;
      matches.push({
        score,
        ...entryToResult(entry, workspace, manifestPath, outDir, envPresence),
      });
    }
  }

  matches.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));
  return {
    target,
    matchCount: matches.length,
    matches: matches.slice(0, options.limit || 10),
  };
}

function formatResult(result) {
  const lines = [`Provenance matches: ${result.matchCount}`];
  for (const item of result.matches) {
    lines.push('');
    lines.push(`Page: ${item.title || item.pageId}`);
    lines.push(`Workspace: ${item.workspaceName}${item.workspaceFolder ? ` (${item.workspaceFolder})` : ''}`);
    lines.push(`Link: ${item.url || '(missing)'}`);
    lines.push(`Token env: ${item.tokenEnv}${item.tokenAvailable ? '' : ' (not currently loaded)'}`);
    lines.push(`Last edited: ${item.notionLastEditedTime || '(unknown)'}`);
    lines.push(`Mirror file: ${item.primaryPath || '(missing)'}`);
    lines.push('Notion receipt:');
    lines.push('- Action: searched');
    lines.push(`- Page: ${item.title || item.pageId}`);
    lines.push(`- Link: ${item.url || '(missing)'}`);
  }
  if (result.matchCount === 0) lines.push('No mirrored page matched the target.');
  return lines.join('\n');
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const configPath = resolveConfigPath(options.configPath);
    const config = readJson(configPath);
    const result = resolveProvenance(config, configPath, options.target, options);
    if (hasJsonFlag()) console.log(JSON.stringify(result, null, 2));
    else console.log(formatResult(result));
    if (result.matchCount === 0) process.exitCode = 1;
  } catch (error) {
    if (hasJsonFlag()) console.log(JSON.stringify({ error: error.message }, null, 2));
    else console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { resolveProvenance, _internal: { workspaceEntries, extractPageId } };
