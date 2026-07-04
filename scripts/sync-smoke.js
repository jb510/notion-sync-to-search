#!/usr/bin/env node
/**
 * Stateful Notion sync freshness smoke test.
 *
 * It alerts only on transitions:
 * - first stale finding after a healthy period
 * - first recovery after a stale period
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  resolveSafePath,
  stripTokenArg,
  hasJsonFlag,
} = require('./notion-utils.js');

const MANIFEST_FILE = '.notion-search-mirror.json';

function usage(exitCode = 0) {
  console.log('Usage: sync-smoke.js <config.json> [--max-age-hours 24] [--state-file <path>] [--main-channel <name>] [--post-command <cmd>] [--json]');
  console.log('');
  console.log('The optional --post-command runs only on stale/recovered transitions with NOTION_SYNC_ALERT_MESSAGE set.');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = stripTokenArg(argv);
  if (args.includes('--help') || args.includes('-h')) usage(0);
  if (args.length < 1) usage(1);
  const options = {
    configPath: args[0],
    maxAgeHours: 24,
    maxAgeSetByCli: false,
    stateFile: null,
    mainChannel: 'main',
    mainChannelSetByCli: false,
    postCommand: null,
    postCommandSetByCli: false,
  };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--max-age-hours' && args[i + 1]) {
      options.maxAgeHours = parsePositiveNumber(args[++i], 24);
      options.maxAgeSetByCli = true;
    }
    else if (args[i] === '--state-file' && args[i + 1]) options.stateFile = args[++i];
    else if (args[i] === '--main-channel' && args[i + 1]) {
      options.mainChannel = args[++i];
      options.mainChannelSetByCli = true;
    }
    else if (args[i] === '--post-command' && args[i + 1]) {
      options.postCommand = args[++i];
      options.postCommandSetByCli = true;
    }
    else if (args[i] === '--json') {
      // handled by hasJsonFlag()
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  return options;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function configuredFolders(config, outDir) {
  if (Array.isArray(config.workspaces) && config.workspaces.length > 0) {
    return config.workspaces
      .map(workspace => workspace.outFolder || workspace.workspaceFolder || workspace.name || null)
      .filter(folder => folder && folder !== 'auto' && folder !== 'none');
  }
  const folder = config.outFolder || config.workspaceFolder || null;
  if (folder && folder !== 'auto' && folder !== 'none') return [folder];
  return discoverManifestFolders(outDir);
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

function manifestSummaries(config, configPath) {
  const outDir = resolveOutDir(config, configPath);
  const folders = configuredFolders(config, outDir);
  const candidates = folders.length > 0 ? folders : [null];
  return candidates.map(folder => {
    const manifestPath = folder ? path.join(outDir, folder, MANIFEST_FILE) : path.join(outDir, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      return {
        workspaceFolder: folder || '',
        manifestPath,
        missing: true,
        lastCompletedAt: null,
        failed: true,
        errors: 1,
      };
    }
    const manifest = readJson(manifestPath);
    const lastRun = manifest.lastRun || {};
    const lastCompletedAt = lastRun.completedAt || lastRun.startedAt || null;
    return {
      workspaceFolder: folder || manifest.workspace?.folder || '',
      manifestPath,
      pageCount: Object.keys(manifest.pages || {}).length,
      lastCompletedAt,
      failed: Boolean(lastRun.failed || lastRun.errors > 0),
      errors: lastRun.errors || 0,
      refreshed: lastRun.refreshed || 0,
      skipped: lastRun.skipped || 0,
      pruned: lastRun.pruned || 0,
    };
  });
}

function defaultStateFile(config, configPath) {
  const outDir = resolveOutDir(config, configPath);
  return path.join(outDir, '.notion-sync-smoke-state.json');
}

function loadState(stateFile) {
  try {
    return readJson(stateFile);
  } catch (_) {
    return { status: 'unknown' };
  }
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, stateFile);
}

function evaluateFreshness(config, configPath, options = {}) {
  const nowMs = Date.now();
  const maxAgeMs = options.maxAgeHours * 60 * 60 * 1000;
  const summaries = manifestSummaries(config, configPath).map(summary => {
    const completedMs = Date.parse(summary.lastCompletedAt || '');
    const ageMs = Number.isFinite(completedMs) ? nowMs - completedMs : Infinity;
    return {
      ...summary,
      ageHours: Number.isFinite(ageMs) ? ageMs / (60 * 60 * 1000) : null,
      stale: summary.missing || summary.failed || !Number.isFinite(completedMs) || ageMs > maxAgeMs,
    };
  });
  return {
    now: new Date(nowMs).toISOString(),
    maxAgeHours: options.maxAgeHours,
    ok: summaries.length > 0 && summaries.every(summary => !summary.stale),
    summaries,
  };
}

function formatWhen(value) {
  return value || 'never';
}

function buildMessage(evaluation, transition, mainChannel) {
  const stale = evaluation.summaries.filter(summary => summary.stale);
  const fresh = evaluation.summaries.filter(summary => !summary.stale);
  if (transition === 'stale') {
    const lines = [
      `Notion sync is stale for ${stale.length} workspace mirror${stale.length === 1 ? '' : 's'} and may no longer be searchable with current Notion changes.`,
      `Channel: ${mainChannel}`,
      `Threshold: no successful sync within ${evaluation.maxAgeHours} hours.`,
      `Checked at: ${evaluation.now}`,
      'Stale mirrors:',
    ];
    for (const item of stale) {
      lines.push(`- ${item.workspaceFolder || '(root)'}: last completed ${formatWhen(item.lastCompletedAt)}, pages=${item.pageCount ?? 0}, errors=${item.errors ?? 0}, manifest=${item.manifestPath}`);
    }
    if (fresh.length > 0) {
      lines.push('Still healthy:');
      for (const item of fresh) lines.push(`- ${item.workspaceFolder || '(root)'}: last completed ${formatWhen(item.lastCompletedAt)}`);
    }
    lines.push('Action: run "sync notion now" or check the scheduler/logs for notion-sync-to-search.');
    return lines.join('\n');
  }

  const lines = [
    'Notion sync has recovered. The local Notion mirror is fresh again.',
    `Channel: ${mainChannel}`,
    `Checked at: ${evaluation.now}`,
    'Healthy mirrors:',
  ];
  for (const item of evaluation.summaries) {
    lines.push(`- ${item.workspaceFolder || '(root)'}: last completed ${formatWhen(item.lastCompletedAt)}, pages=${item.pageCount ?? 0}, refreshed=${item.refreshed ?? 0}, skipped=${item.skipped ?? 0}, pruned=${item.pruned ?? 0}`);
  }
  return lines.join('\n');
}

function maybePost(command, message) {
  if (!command) return;
  childProcess.execFileSync('/bin/sh', ['-lc', command], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NOTION_SYNC_ALERT_MESSAGE: message,
    },
  });
}

function runSmoke(config, configPath, options) {
  const effectiveOptions = {
    ...options,
    maxAgeHours: options.maxAgeSetByCli ? options.maxAgeHours : parsePositiveNumber(config.smoke?.maxAgeHours, options.maxAgeHours),
    mainChannel: options.mainChannelSetByCli ? options.mainChannel : (config.smoke?.mainChannel || options.mainChannel),
    postCommand: options.postCommandSetByCli ? options.postCommand : (config.smoke?.postCommand || options.postCommand),
  };
  const stateFile = resolveSafePath(options.stateFile || defaultStateFile(config, configPath), { mode: 'write' });
  const previous = loadState(stateFile);
  const evaluation = evaluateFreshness(config, configPath, effectiveOptions);
  const currentStatus = evaluation.ok ? 'healthy' : 'stale';
  const transition = previous.status !== currentStatus
    ? (currentStatus === 'healthy' ? 'recovered' : 'stale')
    : null;
  const message = transition ? buildMessage(evaluation, transition, effectiveOptions.mainChannel) : '';
  const state = {
    status: currentStatus,
    updatedAt: evaluation.now,
    lastTransition: transition || previous.lastTransition || null,
    lastAlertAt: transition ? evaluation.now : previous.lastAlertAt || null,
    summaries: evaluation.summaries.map(summary => ({
      workspaceFolder: summary.workspaceFolder,
      manifestPath: summary.manifestPath,
      lastCompletedAt: summary.lastCompletedAt,
      stale: summary.stale,
    })),
  };
  saveState(stateFile, state);
  if (transition) maybePost(effectiveOptions.postCommand, message);
  return {
    ...evaluation,
    stateFile,
    previousStatus: previous.status || 'unknown',
    currentStatus,
    transition,
    message,
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const configPath = resolveConfigPath(options.configPath);
    const config = readJson(configPath);
    const result = runSmoke(config, configPath, options);
    if (hasJsonFlag()) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.transition) {
      console.log(result.message);
    } else {
      console.log(`Notion sync smoke: ${result.currentStatus}; no alert transition.`);
    }
    if (!result.ok) process.exitCode = 2;
  } catch (error) {
    if (hasJsonFlag()) console.log(JSON.stringify({ error: error.message }, null, 2));
    else console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { runSmoke, evaluateFreshness, _internal: { manifestSummaries, buildMessage } };
