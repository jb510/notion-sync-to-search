#!/usr/bin/env node
/**
 * Lint OpenClaw search paths against notion-sync-to-search workspace privacy.
 *
 * This is intentionally read-only. It does not know every install's policy, but
 * it catches the main foot-gun: a multi-workspace mirror indexed as one root.
 */

const fs = require('fs');
const path = require('path');
const {
  resolveSafePath,
  stripTokenArg,
  hasJsonFlag,
} = require('./notion-utils.js');

function usage(exitCode = 0) {
  console.log('Usage: privacy-lint.js <notion-config.json> [--openclaw-config <openclaw.json>] [--strict] [--json]');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/privacy-lint.js ~/.openclaw/config/notion-search-mirror.json --openclaw-config ~/.openclaw/openclaw.json');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = stripTokenArg(argv);
  if (args.includes('--help') || args.includes('-h')) usage(0);
  if (args.length < 1) usage(1);
  const options = {
    configPath: args[0],
    openclawConfig: null,
    strict: false,
  };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--openclaw-config' && args[i + 1]) options.openclawConfig = args[++i];
    else if (args[i] === '--strict') options.strict = true;
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
      name: workspace.name || workspace.outFolder || workspace.workspaceFolder || `workspace-${index + 1}`,
      folder: workspace.outFolder || workspace.workspaceFolder || workspace.name || null,
      tokenEnv: workspace.tokenEnv || 'NOTION_API_KEY',
      sensitive: Boolean(workspace.private || workspace.personal || workspace.sensitive)
        || /personal|private|workflow/i.test(`${workspace.name || ''} ${workspace.outFolder || ''} ${workspace.workspaceFolder || ''}`)
        || (workspace.tokenEnv && workspace.tokenEnv !== 'NOTION_API_KEY'),
    }));
  }

  return [{
    name: config.name || config.outFolder || config.workspaceFolder || 'default',
    folder: config.outFolder || config.workspaceFolder || null,
    tokenEnv: config.tokenEnv || 'NOTION_API_KEY',
    sensitive: Boolean(config.private || config.personal || config.sensitive),
  }];
}

function defaultOpenClawConfigPath(notionConfigPath) {
  const dir = path.dirname(notionConfigPath);
  const stateCandidate = path.resolve(dir, '..', 'openclaw.json');
  if (fs.existsSync(stateCandidate)) return stateCandidate;
  return null;
}

function collectSearchPaths(value, trail = []) {
  const paths = [];
  if (!value || typeof value !== 'object') return paths;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === 'string') {
        paths.push({ path: value[i], trail: [...trail, String(i)].join('.') });
      } else {
        paths.push(...collectSearchPaths(value[i], [...trail, String(i)]));
      }
    }
    return paths;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextTrail = [...trail, key];
    if (Array.isArray(child) && /paths?|extraPaths|include|roots?/i.test(key)) {
      for (let i = 0; i < child.length; i++) {
        if (typeof child[i] === 'string') paths.push({ path: child[i], trail: [...nextTrail, String(i)].join('.') });
      }
    }
    if (/memory|search|qmd|knowledge|paths?|agents|defaults|workspaces/i.test(key)) {
      paths.push(...collectSearchPaths(child, nextTrail));
    }
  }
  return paths;
}

function normalizeCandidatePath(candidate, baseDir) {
  if (path.isAbsolute(candidate)) return path.resolve(candidate);
  return path.resolve(baseDir, candidate);
}

function lintPrivacy(notionConfig, notionConfigPath, options = {}) {
  const outDir = resolveOutDir(notionConfig, notionConfigPath);
  const workspaces = workspaceEntries(notionConfig);
  const findings = [];
  const openclawConfigPath = options.openclawConfig
    ? resolveConfigPath(options.openclawConfig)
    : defaultOpenClawConfigPath(notionConfigPath);
  const openclawConfig = openclawConfigPath && fs.existsSync(openclawConfigPath) ? readJson(openclawConfigPath) : null;
  const stateDir = openclawConfigPath ? path.dirname(openclawConfigPath) : path.dirname(notionConfigPath);
  const searchPaths = dedupeSearchPaths(openclawConfig ? collectSearchPaths(openclawConfig) : []);
  const resolvedSearchPaths = searchPaths.map(item => ({
    ...item,
    resolved: normalizeCandidatePath(item.path, stateDir),
  }));
  const workspaceFolders = workspaces
    .map(workspace => workspace.folder)
    .filter(folder => folder && folder !== 'auto' && folder !== 'none');
  const sensitiveWorkspaces = workspaces.filter(workspace => workspace.sensitive);

  if (!openclawConfig) {
    findings.push({
      severity: 'warn',
      code: 'openclaw-config-missing',
      message: 'OpenClaw config was not found; search-path privacy could not be verified.',
    });
  }

  if (workspaces.length > 1 && sensitiveWorkspaces.length > 0) {
    for (const item of resolvedSearchPaths) {
      const pointsAtRoot = item.resolved === outDir;
      const pointsInsideRoot = item.resolved.startsWith(outDir + path.sep);
      const pointsAtWorkspace = workspaceFolders.some(folder => item.resolved === path.join(outDir, folder));
      if (pointsAtRoot || (pointsInsideRoot && !pointsAtWorkspace)) {
        findings.push({
          severity: options.strict ? 'error' : 'warn',
          code: 'multi-workspace-root-search-path',
          path: item.path,
          trail: item.trail,
          message: `Search path can include multiple Notion workspaces, including sensitive/personal mirrors. Point privacy-sensitive agents at explicit workspace folders such as ${workspaceFolders.map(folder => path.join(outDir, folder)).join(', ')}.`,
        });
      }
    }
  }

  for (const workspace of workspaces) {
    if (!workspace.folder || workspace.folder === 'auto') {
      findings.push({
        severity: 'warn',
        code: 'ambiguous-workspace-folder',
        workspace: workspace.name,
        message: 'Workspace folder is auto/implicit; set outFolder for clearer privacy boundaries in multi-workspace installs.',
      });
    }
  }

  if (workspaces.length > 1) {
    const folders = new Map();
    for (const workspace of workspaces) {
      const folder = workspace.folder || workspace.name;
      if (folders.has(folder)) {
        findings.push({
          severity: 'error',
          code: 'workspace-folder-collision',
          workspace: workspace.name,
          message: `Workspace output folder collides with ${folders.get(folder)}: ${folder}`,
        });
      }
      folders.set(folder, workspace.name);
    }
  }

  return {
    ok: !findings.some(finding => finding.severity === 'error'),
    outDir,
    openclawConfigPath,
    workspaces,
    searchPaths: resolvedSearchPaths,
    findings,
  };
}

function dedupeSearchPaths(searchPaths) {
  const seen = new Set();
  return searchPaths.filter(item => {
    const key = `${item.trail}\0${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatReport(report) {
  const lines = [
    `Privacy lint: ${report.ok ? 'ok' : 'problems found'}`,
    `Mirror root: ${report.outDir}`,
    `OpenClaw config: ${report.openclawConfigPath || '(not found)'}`,
    `Workspaces: ${report.workspaces.map(workspace => `${workspace.name}${workspace.sensitive ? ' [sensitive]' : ''}`).join(', ')}`,
  ];
  if (report.searchPaths.length > 0) {
    lines.push('Search paths:');
    for (const item of report.searchPaths) lines.push(`- ${item.path} (${item.trail})`);
  }
  if (report.findings.length > 0) {
    lines.push('Findings:');
    for (const finding of report.findings) {
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`);
    }
  }
  return lines.join('\n');
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const configPath = resolveConfigPath(options.configPath);
    const config = readJson(configPath);
    const report = lintPrivacy(config, configPath, options);
    if (hasJsonFlag()) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    if (hasJsonFlag()) console.log(JSON.stringify({ error: error.message }, null, 2));
    else console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { lintPrivacy, _internal: { collectSearchPaths, workspaceEntries } };
