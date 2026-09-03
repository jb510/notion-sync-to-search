#!/usr/bin/env node
/**
 * Resolve a request-scoped Notion workspace binding.
 *
 * A binding can come from mirrored page provenance, an explicit workspace
 * selector, or the only configured workspace. It names the workspace and the
 * token env var without printing the token itself.
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
  console.log('Usage: resolve-live-token.js <config.json> <page-id|notion-url|mirror-file> [--workspace <key|name|alias>] [--env-file <path>] [--json] [--shell]');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/resolve-live-token.js config/notion-search-mirror.json 374bb4fe98878022a1b0c4e26975c46a');
  console.log('  node scripts/resolve-live-token.js config/notion-search-mirror.json "notion-sync-read-only/Personal/Page.md" --shell');
  console.log('  node scripts/resolve-live-token.js config/notion-search-mirror.json <new-page-id> --workspace personal --json');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = stripTokenArg(argv);
  if (args.includes('--help') || args.includes('-h')) usage(0);
  if (args.length < 2) usage(1);

  const options = {
    configPath: args[0],
    target: args[1],
    workspace: null,
    envFile: null,
    shell: false,
  };

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--env-file' && args[i + 1]) options.envFile = args[++i];
    else if (args[i] === '--workspace' && args[i + 1]) options.workspace = args[++i];
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

function workspaceEntries(config, outDir) {
  if (Array.isArray(config.workspaces) && config.workspaces.length > 0) {
    return config.workspaces.map((workspace, index) => workspaceEntry(workspace, index));
  }

  // A single-token config with workspaceFolder: "auto" writes one manifest
  // per integration-visible Notion workspace name. Discover those folders so
  // an existing page can still be routed to the one configured token. Older
  // installs also omit workspaceFolder entirely, so treat that shape the same
  // way when manifests already exist.
  const configured = config.outFolder || config.workspaceFolder || config.name || null;
  const discovered = discoverManifestFolders(outDir);
  if ((configured === 'auto' || !configured) && discovered.length > 0) {
    return discovered.map((folder, index) => workspaceEntry({ ...config, name: folder || config.name, outFolder: folder }, index));
  }

  return [workspaceEntry(config, 0)];
}

function workspaceEntry(workspace, index) {
  const name = workspace.name || workspace.outFolder || workspace.workspaceFolder || `workspace-${index + 1}`;
  const key = workspace.key || normalizeSelector(name) || `workspace-${index + 1}`;
  const aliases = Array.isArray(workspace.aliases)
    ? workspace.aliases.map(value => String(value).trim()).filter(Boolean)
    : [];
  return {
    index,
    key,
    name,
    aliases,
    tokenEnv: workspace.tokenEnv || 'NOTION_API_KEY',
    folder: workspace.outFolder || workspace.workspaceFolder || workspace.name || null,
    raw: workspace,
  };
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

function normalizeSelector(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function workspaceSelectors(workspace) {
  return [
    workspace.key,
    workspace.name,
    workspace.folder,
    workspace.tokenEnv,
    ...workspace.aliases,
  ].filter(Boolean).map(normalizeSelector);
}

function resolveWorkspaceSelector(workspaces, selector) {
  const normalized = normalizeSelector(selector);
  const matches = workspaces.filter(workspace => workspaceSelectors(workspace).includes(normalized));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && new Set(matches.map(workspace => workspace.tokenEnv)).size === 1) {
    return matches[0];
  }
  const choices = workspaces.map(workspace => `${workspace.name} (${workspace.key})`).join(', ');
  if (matches.length > 1) {
    throw new Error(`Notion workspace selector "${selector}" is ambiguous. Configured workspaces: ${choices}. Ask the user which configured Notion workspace to use.`);
  }
  throw new Error(`No configured Notion workspace matched "${selector}". Configured workspaces: ${choices}. Ask the user which configured Notion workspace to use.`);
}

function bindingResult(workspace, match, pageId, bindingSource) {
  return {
    bindingVersion: 1,
    bindingSource,
    workspaceKey: workspace.key,
    workspaceName: workspace.name,
    workspaceAliases: workspace.aliases,
    workspaceFolder: workspace.folder,
    tokenEnv: workspace.tokenEnv,
    pageId: match?.entry?.pageId || pageId || '',
    title: match?.entry?.title || '',
    url: match?.entry?.url || '',
    manifestPath: match?.manifestPath || '',
  };
}

function resolveBinding(config, configPath, target, options = {}) {
  const outDir = resolveOutDir(config, configPath);
  const workspaces = workspaceEntries(config, outDir);
  const selectedWorkspace = options.workspace
    ? resolveWorkspaceSelector(workspaces, options.workspace)
    : null;

  let pageId = extractPageId(target);
  if (!pageId && looksLikePath(target)) {
    pageId = parseFrontmatterPageId(path.resolve(target));
  }

  let match = pageId ? findByPageId(outDir, workspaces, pageId) : null;
  if (!match && looksLikePath(target)) match = findByPath(outDir, workspaces, target);
  if (match && selectedWorkspace && match.workspace.index !== selectedWorkspace.index) {
    throw new Error(
      `Notion binding conflict: target belongs to ${match.workspace.name} (${match.workspace.key}), not ${selectedWorkspace.name} (${selectedWorkspace.key}). Ask the user which workspace/page they intend; do not switch tokens silently.`
    );
  }
  if (match) return bindingResult(match.workspace, match, pageId, 'page-provenance');
  if (selectedWorkspace) return bindingResult(selectedWorkspace, null, pageId, 'explicit-workspace');
  const uniqueTokenEnvs = new Set(workspaces.map(workspace => workspace.tokenEnv));
  // A legacy single-workspace install can contain more than one historical
  // manifest folder after a workspace rename. One configured tokenEnv still
  // means one Notion identity, so unknown/new pages do not require a prompt.
  if (workspaces.length === 1 || uniqueTokenEnvs.size === 1) {
    return bindingResult(workspaces[0], null, pageId, 'single-workspace');
  }

  const choices = workspaces.map(workspace => `${workspace.name} (${workspace.key})`).join(', ');
  throw new Error(
    `No mirrored page matched target: ${target}. Workspace selection is required. Configured workspaces: ${choices}. Ask the user which configured Notion workspace to use; do not fall back to a default token or refuse the request as out of scope.`
  );
}

function resolveTarget(config, configPath, target, options = {}) {
  return resolveBinding(config, configPath, target, options);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const configPath = resolveConfigPath(options.configPath);
    const config = readJson(configPath);
    const result = resolveBinding(config, configPath, options.target, { workspace: options.workspace });
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
      console.log(`Workspace key: ${result.workspaceKey}`);
      console.log(`Binding source: ${result.bindingSource}`);
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
  module.exports = {
    resolveBinding,
    resolveTarget,
    resolveWorkspaceSelector,
    extractPageId,
    workspaceEntries,
    _internal: { normalizeSelector, workspaceSelectors },
  };
}
