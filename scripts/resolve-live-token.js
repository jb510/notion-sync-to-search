#!/usr/bin/env node
/**
 * Resolve which configured Notion token env var owns a mirrored page.
 *
 * This is for live Notion edits after a search hit comes from the local
 * read-only mirror. It maps page IDs/URLs/mirrored markdown paths back to the
 * workspace config and prints the token env var to use for Notion API writes.
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
  console.log('Usage: resolve-live-token.js <config.json> <page-id|notion-url|mirror-file> [--env-file <path>] [--json] [--shell]');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/resolve-live-token.js config/notion-search-mirror.json 374bb4fe98878022a1b0c4e26975c46a');
  console.log('  node scripts/resolve-live-token.js config/notion-search-mirror.json "notion-sync-read-only/Personal/Page.md" --shell');
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
    shell: false,
  };

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--env-file' && args[i + 1]) options.envFile = args[++i];
    else if (args[i] === '--shell') options.shell = true;
    else if (args[i] === '--json') {
      // handled by hasJsonFlag()
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  return options;
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

function workspaceEntries(config) {
  if (Array.isArray(config.workspaces) && config.workspaces.length > 0) {
    return config.workspaces.map((workspace, index) => ({
      index,
      name: workspace.name || workspace.outFolder || workspace.workspaceFolder || `workspace-${index + 1}`,
      tokenEnv: workspace.tokenEnv || 'NOTION_API_KEY',
      folder: workspace.outFolder || workspace.workspaceFolder || workspace.name || null,
      raw: workspace,
    }));
  }

  return [{
    index: 0,
    name: config.name || config.outFolder || config.workspaceFolder || 'default',
    tokenEnv: config.tokenEnv || 'NOTION_API_KEY',
    folder: config.outFolder || config.workspaceFolder || config.name || null,
    raw: config,
  }];
}

function manifestPathFor(outDir, workspace) {
  if (!workspace.folder || workspace.folder === 'none') return path.join(outDir, MANIFEST_FILE);
  return path.join(outDir, workspace.folder, MANIFEST_FILE);
}

function looksLikePath(target) {
  return target.includes('/') || target.includes('\\') || target.endsWith('.md');
}

function extractPageId(target) {
  const raw = String(target || '').trim();
  if (!raw) return null;

  const uuid = raw.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (uuid) return normalizeId(uuid[0]);

  const compact = raw.match(/[0-9a-fA-F]{32}/);
  if (compact) return normalizeId(compact[0]);

  return null;
}

function parseFrontmatterPageId(markdownPath) {
  if (!fs.existsSync(markdownPath) || !fs.lstatSync(markdownPath).isFile()) return null;
  const body = fs.readFileSync(markdownPath, 'utf8').slice(0, 4096);
  const match = body.match(/^notion_page_id:\s*["']?([^"'\n]+)["']?/m);
  return match ? normalizeId(match[1].trim()) : null;
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

function findByPageId(outDir, workspaces, pageId) {
  for (const workspace of workspaces) {
    const manifestPath = manifestPathFor(outDir, workspace);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    const entry = manifest.pages?.[pageId];
    if (entry) {
      return { workspace, manifestPath, entry };
    }
  }
  return null;
}

function findByPath(outDir, workspaces, targetPath) {
  const absoluteTarget = path.resolve(targetPath);
  for (const workspace of workspaces) {
    const manifestPath = manifestPathFor(outDir, workspace);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    for (const entry of Object.values(manifest.pages || {})) {
      const paths = [];
      if (entry.path) paths.push(entry.path);
      if (entry.relativePath) paths.push(entry.relativePath);
      for (const file of entry.files || []) {
        if (file.path) paths.push(file.path);
        if (file.relativePath) paths.push(file.relativePath);
      }
      for (const candidate of paths) {
        const absoluteCandidate = path.resolve(outDir, workspace.folder && workspace.folder !== 'none' ? workspace.folder : '', candidate.replace(/^notion-sync-read-only[\\/]/, '').replace(new RegExp(`^${escapeRegExp(workspace.folder || '')}[\\\\/]`), ''));
        if (absoluteCandidate === absoluteTarget || path.resolve(candidate) === absoluteTarget) {
          return { workspace, manifestPath, entry };
        }
      }
    }
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveTarget(config, configPath, target) {
  const outDir = resolveOutDir(config, configPath);
  const workspaces = workspaceEntries(config);

  let pageId = extractPageId(target);
  if (!pageId && looksLikePath(target)) {
    pageId = parseFrontmatterPageId(path.resolve(target));
  }

  let match = pageId ? findByPageId(outDir, workspaces, pageId) : null;
  if (!match && looksLikePath(target)) match = findByPath(outDir, workspaces, target);
  if (!match) {
    throw new Error(`No mirrored page matched target: ${target}`);
  }

  return {
    pageId: match.entry.pageId || pageId,
    title: match.entry.title || '',
    url: match.entry.url || '',
    tokenEnv: match.workspace.tokenEnv,
    workspaceName: match.workspace.name,
    workspaceFolder: match.workspace.folder,
    manifestPath: match.manifestPath,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const configPath = resolveConfigPath(options.configPath);
    const config = readJson(configPath);
    const result = resolveTarget(config, configPath, options.target);
    const envPresence = {
      ...Object.fromEntries(Object.keys(process.env).map(key => [key, true])),
      ...loadEnvPresence(options.envFile),
    };
    result.tokenAvailable = Boolean(envPresence[result.tokenEnv]);

    if (hasJsonFlag()) {
      console.log(JSON.stringify(result, null, 2));
    } else if (options.shell) {
      console.log(`export NOTION_API_TOKEN="${'${'}${result.tokenEnv}${'}'}"`);
      console.log(`export NOTION_API_KEY="${'${'}${result.tokenEnv}${'}'}"`);
    } else {
      console.log(`Workspace: ${result.workspaceName}`);
      console.log(`Folder: ${result.workspaceFolder || '(root)'}`);
      console.log(`Page: ${result.title || result.pageId}`);
      console.log(`Token env: ${result.tokenEnv}${result.tokenAvailable ? '' : ' (not currently loaded)'}`);
      console.log('For ntn/curl live writes, use this token as NOTION_API_TOKEN or Authorization: Bearer.');
    }
  } catch (error) {
    if (hasJsonFlag()) console.log(JSON.stringify({ error: error.message }, null, 2));
    else console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { resolveTarget, extractPageId, workspaceEntries };
}
