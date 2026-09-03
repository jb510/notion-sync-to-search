#!/usr/bin/env node
/**
 * Run the official ntn CLI with a request-scoped Notion workspace binding.
 * The binding comes from page provenance, --workspace, or a single-workspace
 * install. The selected token is mapped to both Notion env conventions only
 * for the child process and is never printed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveTarget } = require('./resolve-live-token.js');
const { _internal: mirrorInternal } = require('./mirror-config.js');

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out('Usage: notion-live.js <config.json> <page-or-parent> [--workspace <key|name|alias>] [--env-file <path>] [--dry-run] [--json] -- <ntn args...>');
  out('');
  out('Example:');
  out('  node scripts/notion-live.js config/notion-search-mirror.json <page-id> --env-file .env -- pages get <page-id> --json');
  out('  node scripts/notion-live.js config/notion-search-mirror.json <new-page-id> --workspace personal --env-file .env -- pages get <new-page-id> --json');
  process.exit(exitCode);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) usage(0);
  const separator = argv.indexOf('--');
  const head = separator >= 0 ? argv.slice(0, separator) : argv;
  const ntnArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  if (head.length < 2) usage(1);

  const options = {
    configPath: path.resolve(head[0]),
    target: head[1],
    workspace: null,
    envFile: null,
    dryRun: false,
    json: false,
    ntnArgs,
  };

  for (let i = 2; i < head.length; i++) {
    if (head[i] === '--env-file' && head[i + 1]) options.envFile = path.resolve(head[++i]);
    else if (head[i] === '--workspace' && head[i + 1]) options.workspace = head[++i];
    else if (head[i] === '--dry-run') options.dryRun = true;
    else if (head[i] === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${head[i]}`);
  }

  if (!options.dryRun && options.ntnArgs.length === 0) {
    throw new Error('Missing ntn arguments after --');
  }
  return options;
}

function loadConfiguredEnv(envFile) {
  if (!envFile) return {};
  if (!fs.existsSync(envFile)) throw new Error(`Environment file not found: ${envFile}`);
  return mirrorInternal.parseEnvContent(fs.readFileSync(envFile, 'utf8'));
}

function route(options) {
  if (!fs.existsSync(options.configPath)) {
    const error = new Error(
      `Managed Notion routing config not found: ${options.configPath}. Ask the user which configured Notion install/workspace to use; do not use a bundled default.`
    );
    error.code = 'NOTION_ROUTE_CONFIG_MISSING';
    throw error;
  }
  const config = JSON.parse(fs.readFileSync(options.configPath, 'utf8'));
  let resolved;
  try {
    resolved = resolveTarget(config, options.configPath, options.target, { workspace: options.workspace });
  } catch (error) {
    const guidance = 'Ask the user which configured Notion workspace and existing page or parent to use; do not fall back to a default token.';
    const wrapped = new Error(
      error.message.includes('Ask the user') ? error.message : `${error.message}. ${guidance}`
    );
    wrapped.code = 'NOTION_ROUTE_AMBIGUOUS';
    throw wrapped;
  }

  const fileEnv = loadConfiguredEnv(options.envFile);
  const token = process.env[resolved.tokenEnv] || fileEnv[resolved.tokenEnv];
  if (!token) {
    const error = new Error(
      `The configured token ${resolved.tokenEnv} for Notion workspace ${resolved.workspaceName} is unavailable. Ask the user which configured Notion workspace to use or to enable that workspace token; do not try another workspace token.`
    );
    error.code = 'NOTION_TOKEN_UNAVAILABLE';
    throw error;
  }

  return { resolved, token };
}

function publicRoute(resolved, ntnArgs) {
  return {
    workspaceName: resolved.workspaceName,
    workspaceKey: resolved.workspaceKey,
    workspaceFolder: resolved.workspaceFolder,
    bindingSource: resolved.bindingSource,
    pageId: resolved.pageId,
    title: resolved.title,
    url: resolved.url,
    tokenEnv: resolved.tokenEnv,
    tokenAvailable: true,
    command: ['ntn', ...ntnArgs],
  };
}

function resolveNtnExecutable() {
  const candidates = [];
  if (process.env.NTN_BIN) candidates.push(process.env.NTN_BIN);
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, 'ntn'));
  }
  candidates.push(
    path.join(os.homedir(), '.npm-global', 'bin', 'ntn'),
    '/opt/homebrew/bin/ntn',
    '/usr/local/bin/ntn',
    '/usr/bin/ntn'
  );

  for (const candidate of [...new Set(candidates)]) {
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch (_) {
      // Continue through the known PATH and install locations.
    }
  }
  return 'ntn';
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { resolved, token } = route(options);
  const summary = publicRoute(resolved, options.ntnArgs);

  if (options.dryRun) {
    console.log(options.json ? JSON.stringify(summary, null, 2) : `Notion route: ${summary.workspaceName} via ${summary.tokenEnv}`);
    return 0;
  }

  console.error(`Notion route: ${summary.workspaceName} via ${summary.tokenEnv}`);
  const env = {
    ...process.env,
    NOTION_API_VERSION: process.env.NOTION_API_VERSION || process.env.NOTION_VERSION || '2026-03-11',
  };
  // Keep other workspace credentials out of the child process. The selected
  // token is the only Notion credential the live command should be able to use.
  for (const key of Object.keys(env)) {
    if (/^NOTION_API_(?:KEY|TOKEN)(?:_|$)/.test(key)) delete env[key];
  }
  env[resolved.tokenEnv] = token;
  env.NOTION_API_KEY = token;
  env.NOTION_API_TOKEN = token;
  const ntnExecutable = resolveNtnExecutable();
  const child = spawnSync(ntnExecutable, options.ntnArgs, { env, stdio: 'inherit' });
  if (child.error) {
    const error = new Error(
      `The routed Notion workspace ${summary.workspaceName} could not run ntn (${child.error.message}). Use the managed direct Notion API path with ${summary.tokenEnv}; do not choose another workspace token.`
    );
    error.code = 'NOTION_LIVE_COMMAND_UNAVAILABLE';
    throw error;
  }
  return child.status ?? 1;
}

if (require.main === module) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = error.code === 'NOTION_ROUTE_AMBIGUOUS' ? 2 : 1;
  }
} else {
module.exports = { parseArgs, route, publicRoute, run };
}
