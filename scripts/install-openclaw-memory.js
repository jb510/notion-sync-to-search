#!/usr/bin/env node

/**
 * Wire the Notion mirror into OpenClaw memory/search.
 *
 * OpenClaw resolves relative memory extraPaths from each agent workspace. When
 * one shared mirror is synced into the primary workspace, multi-agent installs
 * need each agent workspace to expose the same relative path.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function usage() {
  console.log('Usage: install-openclaw-memory.js [--config <openclaw.json>] [--workspace <path>] [--mirror-path <path>] [--link-agent-workspaces] [--dry-run] [--json]');
  console.log('');
  console.log('Examples:');
  console.log('  install-openclaw-memory.js --config ~/.openclaw/openclaw.json --workspace ~/.openclaw/workspace --mirror-path notion-sync-read-only --link-agent-workspaces');
  console.log('  install-openclaw-memory.js --dry-run --json');
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv) {
  const options = {
    configPath: process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    workspace: process.cwd(),
    mirrorPath: 'notion-sync-read-only',
    linkAgentWorkspaces: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--config' && argv[i + 1]) {
      options.configPath = argv[++i];
    } else if (arg === '--workspace' && argv[i + 1]) {
      options.workspace = argv[++i];
    } else if (arg === '--mirror-path' && argv[i + 1]) {
      options.mirrorPath = argv[++i];
    } else if (arg === '--link-agent-workspaces') {
      options.linkAgentWorkspaces = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  options.configPath = path.resolve(expandHome(options.configPath));
  options.workspace = path.resolve(expandHome(options.workspace));
  options.mirrorPath = options.mirrorPath.trim();
  if (!options.mirrorPath) throw new Error('--mirror-path is required');
  return options;
}

function readJson(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to edit symlinked config file: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeFileAtomic(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  const fd = fs.openSync(tmp, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function ensureExtraPath(config, mirrorPath) {
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.memorySearch = config.agents.defaults.memorySearch || {};
  const existing = config.agents.defaults.memorySearch.extraPaths || [];
  const next = Array.from(new Set(
    [...existing, mirrorPath]
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean),
  ));
  config.agents.defaults.memorySearch.extraPaths = next;
  return next;
}

function agentWorkspaces(config) {
  const workspaces = [];
  for (const agent of config.agents?.list || []) {
    if (!agent || typeof agent !== 'object') continue;
    const workspace = typeof agent.workspace === 'string' ? agent.workspace.trim() : '';
    if (!workspace) continue;
    workspaces.push({ agentId: agent.id || '(unnamed)', workspace: path.resolve(expandHome(workspace)) });
  }
  return workspaces;
}

function isEmptyDirectory(dirPath) {
  try {
    return fs.lstatSync(dirPath).isDirectory() && fs.readdirSync(dirPath).length === 0;
  } catch {
    return false;
  }
}

function sameRealPath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function linkAgentWorkspaces(config, options) {
  if (path.isAbsolute(options.mirrorPath)) {
    return [{ action: 'skipped', reason: 'mirror path is absolute; per-agent relative links are unnecessary' }];
  }

  const sourceMirror = path.resolve(options.workspace, options.mirrorPath);
  if (!fs.existsSync(sourceMirror)) {
    throw new Error(`Source mirror path does not exist: ${sourceMirror}`);
  }

  const results = [];
  for (const entry of agentWorkspaces(config)) {
    const target = path.resolve(entry.workspace, options.mirrorPath);
    if (sameRealPath(target, sourceMirror)) {
      results.push({ agentId: entry.agentId, target, action: 'ok' });
      continue;
    }

    if (fs.existsSync(target) || fs.lstatSync(path.dirname(target), { throwIfNoEntry: false })?.isSymbolicLink()) {
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) {
        results.push({ agentId: entry.agentId, target, action: 'conflict', reason: 'existing symlink points elsewhere' });
      } else if (isEmptyDirectory(target)) {
        if (!options.dryRun) {
          fs.rmdirSync(target);
          fs.symlinkSync(sourceMirror, target, 'dir');
        }
        results.push({ agentId: entry.agentId, target, action: options.dryRun ? 'would-replace-empty-dir' : 'replaced-empty-dir' });
      } else {
        results.push({ agentId: entry.agentId, target, action: 'conflict', reason: 'path exists and is not an empty directory' });
      }
      continue;
    }

    if (!options.dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(sourceMirror, target, 'dir');
    }
    results.push({ agentId: entry.agentId, target, action: options.dryRun ? 'would-link' : 'linked' });
  }
  return results;
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const raw = fs.readFileSync(options.configPath, 'utf8');
  const config = readJson(options.configPath);
  const extraPaths = ensureExtraPath(config, options.mirrorPath);
  const links = options.linkAgentWorkspaces ? linkAgentWorkspaces(config, options) : [];
  let backupPath = null;

  const nextRaw = JSON.stringify(config, null, 2) + '\n';
  if (!options.dryRun && nextRaw !== raw) {
    backupPath = `${options.configPath}.pre-notion-sync-to-search-${timestamp()}`;
    fs.writeFileSync(backupPath, raw, { mode: 0o600 });
    writeFileAtomic(options.configPath, nextRaw);
  }

  const result = {
    configPath: options.configPath,
    workspace: options.workspace,
    mirrorPath: options.mirrorPath,
    extraPaths,
    backupPath,
    dryRun: options.dryRun,
    links,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`OpenClaw config: ${result.configPath}`);
    console.log(`Memory extraPaths: ${result.extraPaths.join(', ')}`);
    if (backupPath) console.log(`Backup: ${backupPath}`);
    for (const link of links) {
      console.log(`${link.agentId}: ${link.action} ${link.target}${link.reason ? ` (${link.reason})` : ''}`);
    }
  }
  return result;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  _internal: {
    agentWorkspaces,
    ensureExtraPath,
    parseArgs,
    run,
  },
};
