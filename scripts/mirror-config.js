#!/usr/bin/env node
/**
 * Mirror configured Notion pages and database results into local read-only
 * markdown for search.
 */

const fs = require('fs');
const path = require('path');
const {
  checkApiKey,
  notionRequest,
  normalizeId,
  stripTokenArg,
  hasJsonFlag,
  log,
  resolveSafePath,
} = require('./notion-utils.js');
const {
  mirrorPage,
  DEFAULT_OUT_DIR,
  MANIFEST_FILE,
  getPage,
  getTitle,
  assertRelativePath,
  isInside,
  loadManifest,
  saveManifest,
} = require('./mirror-page.js');

function usage(exitCode = 0) {
  console.log('Usage: mirror-config.js <config.json> [--full] [--prune safe|force|off] [--report] [--json]');
  console.log('');
  console.log('Options:');
  console.log('  --full      Refetch and rewrite every discovered page, even if last_edited_time is unchanged');
  console.log('  --prune     safe (default), force, or off');
  console.log('  --no-prune  Alias for --prune off');
  console.log('  --report    Print a sync report from the existing manifest without syncing');
  console.log('  --days      Report lookback window in days (default: 7)');
  console.log('  --workspace-folder <name|none>  Select local workspace folder for reports/failure recording');
  console.log('');
  console.log('Config shape:');
  console.log(JSON.stringify({
    outDir: DEFAULT_OUT_DIR,
    workspaceFolder: 'auto',
    sync: { intervalMinutes: 60 },
    syncScope: 'integration-visible-workspace',
    workspace: { query: '', pathPrefix: '', limit: 5000 },
    pages: [],
    databases: [],
  }, null, 2));
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = stripTokenArg(argv);
  if (args.length < 1 || args[0] === '--help' || args[0] === '-h') usage(args[0] ? 0 : 1);

  const options = { configPath: args[0], full: false, pruneMode: 'safe', report: false, reportDays: 7, workspaceFolder: null };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--full' || args[i] === '--force') {
      options.full = true;
    } else if (args[i] === '--report') {
      options.report = true;
    } else if (args[i] === '--prune' && args[i + 1]) {
      options.pruneMode = parsePruneMode(args[++i]);
    } else if (args[i] === '--days' && args[i + 1]) {
      options.reportDays = parseLimit(args[++i], 7, 365);
    } else if (args[i] === '--workspace-folder' && args[i + 1]) {
      options.workspaceFolder = args[++i];
    } else if (args[i] === '--no-prune') {
      options.pruneMode = 'off';
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  return options;
}

function parsePruneMode(value) {
  if (value === 'safe' || value === 'force' || value === 'off') return value;
  throw new Error('--prune must be "safe", "force", or "off"');
}

function readConfig(configPath) {
  const safePath = resolveSafePath(configPath, { mode: 'read' });
  return JSON.parse(fs.readFileSync(safePath, 'utf8'));
}

function sanitizePathSegment(value) {
  return String(value || 'Untitled')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled';
}

function sanitizeRelativePathPrefix(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .map(segment => sanitizePathSegment(segment))
    .filter(Boolean)
    .join(path.sep);
}

function sanitizeFolderName(value) {
  return sanitizePathSegment(value)
    .replace(/^\.+$/, 'Notion Workspace')
    .slice(0, 80) || 'Notion Workspace';
}

function parseLimit(value, defaultValue, maxValue) {
  const parsed = Number.parseInt(value ?? defaultValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return Math.min(parsed, maxValue);
}

function parseRetentionRuns(config) {
  const configured = config?.report?.retentionRuns ?? config?.sync?.retentionRuns;
  return parseLimit(configured, 250, 10000);
}

function shortPageId(pageId) {
  return normalizeId(pageId).replace(/-/g, '').slice(0, 8);
}

function generatedMirrorPath(prefix, title, pageId) {
  const filename = `${sanitizePathSegment(title)} - ${shortPageId(pageId)}.md`;
  return prefix ? path.join(prefix, filename) : filename;
}

function defaultPagePath(page) {
  return `${sanitizePathSegment(titleFromPageResult(page))}.md`;
}

async function getDatabaseQueryTarget(databaseId) {
  const dbInfo = await notionRequest(`/v1/databases/${encodeURIComponent(normalizeId(databaseId))}`, 'GET');
  return dbInfo.data_sources?.[0]?.id || normalizeId(databaseId);
}

async function queryDatabasePages(databaseConfig) {
  const limit = parseLimit(databaseConfig.limit, 100, 10000);
  const targetId = await getDatabaseQueryTarget(databaseConfig.databaseId);
  const pages = [];
  let cursor = null;

  let complete = true;
  do {
    const payload = { page_size: Math.min(limit - pages.length, 100) };
    if (cursor) payload.start_cursor = cursor;
    if (databaseConfig.filter) payload.filter = databaseConfig.filter;
    if (databaseConfig.sorts || databaseConfig.sort) payload.sorts = databaseConfig.sorts || databaseConfig.sort;

    const result = await notionRequest(`/v1/data_sources/${encodeURIComponent(targetId)}/query`, 'POST', payload);
    pages.push(...result.results);
    complete = !(result.has_more && pages.length >= limit);
    cursor = result.has_more && pages.length < limit ? result.next_cursor : null;
  } while (cursor && pages.length < limit);

  return { pages, complete, limit, targetId };
}

async function searchWorkspacePages(workspaceConfig) {
  const limit = parseLimit(workspaceConfig.limit, 5000, 5000);
  const pages = [];
  let cursor = null;

  let complete = true;
  do {
    const payload = {
      page_size: Math.min(limit - pages.length, 100),
      filter: { property: 'object', value: 'page' },
    };
    if (workspaceConfig.query) payload.query = workspaceConfig.query;
    if (cursor) payload.start_cursor = cursor;
    if (workspaceConfig.sort) payload.sort = workspaceConfig.sort;

    const result = await notionRequest('/v1/search', 'POST', payload);
    pages.push(...result.results);
    complete = !(result.has_more && pages.length >= limit);
    cursor = result.has_more && pages.length < limit ? result.next_cursor : null;
  } while (cursor && pages.length < limit);

  return { pages, complete, limit };
}

async function getWorkspaceInfo() {
  try {
    const me = await notionRequest('/v1/users/me', 'GET');
    return {
      workspaceName: me?.bot?.workspace_name || '',
      workspaceId: me?.bot?.workspace_id || '',
      botName: me?.name || '',
      botId: me?.id || '',
    };
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 429) throw error;
    return {
      workspaceName: '',
      workspaceId: '',
      botName: '',
      botId: '',
    };
  }
}

function titleFromPageResult(page) {
  return getTitle(page);
}

function shouldMirrorWorkspace(config) {
  const scope = config.syncScope || 'integration-visible-workspace';
  const validScopes = new Set(['selected', 'integration-visible-workspace']);
  if (!validScopes.has(scope)) {
    throw new Error('syncScope must be "selected" or "integration-visible-workspace"');
  }

  return scope === 'integration-visible-workspace';
}

function manifestEntryFileExists(outDir, entry) {
  if (!entry?.path) return false;
  const filePath = resolveSafePath(entry.path, { mode: 'write' });
  return isInside(outDir, filePath) && fs.existsSync(filePath) && !fs.lstatSync(filePath).isSymbolicLink();
}

function entryMatchesExpectedPath(outDir, existingEntry, expectedRelativePath) {
  if (!existingEntry || !expectedRelativePath) return false;
  if (existingEntry.relativePath) return existingEntry.relativePath === expectedRelativePath;
  const expectedPath = path.relative(process.cwd(), path.join(outDir, expectedRelativePath));
  return existingEntry.path === expectedPath;
}

function isUnchanged(existingEntry, page, outDir, expectedRelativePath) {
  return Boolean(
    existingEntry
    && existingEntry.notionLastEditedTime
    && page.last_edited_time
    && existingEntry.notionLastEditedTime === page.last_edited_time
    && entryMatchesExpectedPath(outDir, existingEntry, expectedRelativePath)
    && manifestEntryFileExists(outDir, existingEntry)
  );
}

function updateSkippedEntry(existingEntry, now) {
  return {
    ...existingEntry,
    lastSeenAt: now,
    lastCheckedAt: now,
    syncStatus: 'skipped_unchanged',
  };
}

function safePruneFile(outDir, entry) {
  if (!entry?.path) return { deleted: false, path: null };
  const filePath = resolveSafePath(entry.path, { mode: 'write' });
  if (!isInside(outDir, filePath)) {
    throw new Error(`Refusing to prune file outside mirror folder: ${entry.path}`);
  }
  if (!fs.existsSync(filePath)) return { deleted: false, path: entry.path };
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to prune symlinked mirror file: ${entry.path}`);
  }
  if (!stat.isFile()) return { deleted: false, path: entry.path };
  fs.unlinkSync(filePath);
  return { deleted: true, path: entry.path };
}

function pushRunHistory(manifest, run, retentionRuns = 250) {
  manifest.runs = Array.isArray(manifest.runs) ? manifest.runs : [];
  manifest.runs.unshift(run);
  manifest.runs = manifest.runs.slice(0, retentionRuns);
}

function summarizeRuns(manifest, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const runs = (Array.isArray(manifest.runs) ? manifest.runs : [])
    .filter(run => Date.parse(run.startedAt || run.completedAt || '') >= cutoff);

  const summary = {
    days,
    runCount: runs.length,
    failedRuns: runs.filter(run => run.failed).length,
    refreshed: runs.reduce((sum, run) => sum + (run.refreshed || 0), 0),
    skipped: runs.reduce((sum, run) => sum + (run.skipped || 0), 0),
    pruned: runs.reduce((sum, run) => sum + (run.pruned || 0), 0),
    runs,
    prunedPages: runs.flatMap(run => (run.prunedPages || []).map(page => ({
      ...page,
      runStartedAt: run.startedAt,
      runCompletedAt: run.completedAt,
    }))),
    errors: runs.filter(run => run.failed || run.errors).map(run => ({
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      error: run.error || '',
      errors: run.errors || 0,
    })),
  };

  return summary;
}

function formatSyncReport(report, manifestPath) {
  const lines = [
    `Notion sync report (${report.days} day${report.days === 1 ? '' : 's'})`,
    `Manifest: ${manifestPath}`,
    `Runs: ${report.runCount}`,
    `Failures: ${report.failedRuns}`,
    `Refreshed: ${report.refreshed}`,
    `Skipped unchanged: ${report.skipped}`,
    `Pruned: ${report.pruned}`,
  ];

  if (report.errors.length > 0) {
    lines.push('', 'Errors:');
    for (const error of report.errors) {
      lines.push(`  - ${error.startedAt || error.completedAt || 'unknown time'}: ${error.error || `${error.errors} error(s)`}`);
    }
  }

  if (report.prunedPages.length > 0) {
    lines.push('', 'Pruned pages:');
    for (const page of report.prunedPages) {
      lines.push(`  - ${page.prunedAt || page.runCompletedAt || 'unknown time'} ${page.title || page.pageId}: ${page.path || ''}`);
    }
  }

  if (report.runCount === 0) {
    lines.push('', 'No sync runs found in this window.');
  }

  return lines.join('\n');
}

function configuredOutDir(config) {
  return config.outDir || DEFAULT_OUT_DIR;
}

function localOutputForWorkspaceFolder(config, workspaceFolder) {
  const baseOutDir = configuredOutDir(config);
  if (workspaceFolder === false || workspaceFolder === null || workspaceFolder === '' || workspaceFolder === 'none') {
    return {
      outDir: baseOutDir,
      baseOutDir,
      workspaceFolder: '',
      workspaceInfo: null,
    };
  }

  const folder = sanitizeFolderName(workspaceFolder);
  return {
    outDir: path.join(baseOutDir, folder),
    baseOutDir,
    workspaceFolder: folder,
    workspaceInfo: null,
  };
}

function discoverManifestDirs(config) {
  const baseOutDir = configuredOutDir(config);
  const workspaceFolder = config.workspaceFolder ?? 'auto';
  const candidates = [];

  if (workspaceFolder && workspaceFolder !== 'auto') {
    candidates.push(localOutputForWorkspaceFolder(config, workspaceFolder));
  } else if (workspaceFolder === false || workspaceFolder === null || workspaceFolder === 'none') {
    candidates.push(localOutputForWorkspaceFolder(config, 'none'));
  }

  const safeBase = resolveSafePath(baseOutDir, { mode: 'write' });
  if (fs.existsSync(path.join(safeBase, MANIFEST_FILE))) {
    candidates.push({
      outDir: baseOutDir,
      baseOutDir,
      workspaceFolder: '',
      workspaceInfo: null,
    });
  }

  if (fs.existsSync(safeBase) && fs.statSync(safeBase).isDirectory()) {
    for (const entry of fs.readdirSync(safeBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = {
        outDir: path.join(baseOutDir, entry.name),
        baseOutDir,
        workspaceFolder: entry.name,
        workspaceInfo: null,
      };
      const safeOutDir = resolveSafePath(candidate.outDir, { mode: 'write' });
      if (fs.existsSync(path.join(safeOutDir, MANIFEST_FILE))) candidates.push(candidate);
    }
  }

  const seen = new Set();
  return candidates.filter(candidate => {
    const safeOutDir = resolveSafePath(candidate.outDir, { mode: 'write' });
    if (seen.has(safeOutDir)) return false;
    seen.add(safeOutDir);
    return true;
  });
}

function resolveLocalReportOutputs(config, options = {}) {
  if (options.workspaceFolder) {
    return [localOutputForWorkspaceFolder(config, options.workspaceFolder)];
  }

  const discovered = discoverManifestDirs(config);
  if (discovered.length > 0) return discovered;

  const workspaceFolder = config.workspaceFolder ?? 'auto';
  if (workspaceFolder && workspaceFolder !== 'auto') {
    return [localOutputForWorkspaceFolder(config, workspaceFolder)];
  }
  if (workspaceFolder === false || workspaceFolder === null || workspaceFolder === 'none') {
    return [localOutputForWorkspaceFolder(config, 'none')];
  }
  return [localOutputForWorkspaceFolder(config, 'Notion Workspace')];
}

function reportForOutput(output, days) {
  const safeOutDir = resolveSafePath(output.outDir, { mode: 'write' });
  const manifest = loadManifest(safeOutDir);
  const manifestFile = path.relative(process.cwd(), path.join(safeOutDir, MANIFEST_FILE));
  return {
    manifestPath: manifestFile,
    outDir: path.relative(process.cwd(), safeOutDir) || '.',
    workspaceFolder: output.workspaceFolder,
    workspaceInfo: output.workspaceInfo,
    ...summarizeRuns(manifest, days),
  };
}

function combineReports(reports, days) {
  if (reports.length === 1) return reports[0];
  const runs = reports.flatMap(report => report.runs || []);
  const prunedPages = reports.flatMap(report => report.prunedPages || []);
  const errors = reports.flatMap(report => report.errors || []);
  return {
    days,
    manifestPath: reports.map(report => report.manifestPath).join(', '),
    outDir: reports.map(report => report.outDir).join(', '),
    workspaceFolder: 'multiple',
    workspaceInfo: null,
    runCount: runs.length,
    failedRuns: runs.filter(run => run.failed).length,
    refreshed: runs.reduce((sum, run) => sum + (run.refreshed || 0), 0),
    skipped: runs.reduce((sum, run) => sum + (run.skipped || 0), 0),
    pruned: runs.reduce((sum, run) => sum + (run.pruned || 0), 0),
    runs,
    prunedPages,
    errors,
    reports,
  };
}

function syncReport(config, options = {}) {
  const days = options.reportDays || 7;
  const outputs = resolveLocalReportOutputs(config, options);
  return combineReports(outputs.map(output => reportForOutput(output, days)), days);
}

function resolveFailureOutput(config, options = {}) {
  if (options.workspaceFolder) return localOutputForWorkspaceFolder(config, options.workspaceFolder);

  const discovered = discoverManifestDirs(config);
  if (discovered.length === 1) return discovered[0];

  const workspaceFolder = config.workspaceFolder ?? 'auto';
  if (workspaceFolder && workspaceFolder !== 'auto') return localOutputForWorkspaceFolder(config, workspaceFolder);
  if (workspaceFolder === false || workspaceFolder === null || workspaceFolder === 'none') {
    return localOutputForWorkspaceFolder(config, 'none');
  }
  return null;
}

async function recordSyncFailure(config, options, error) {
  let output = resolveFailureOutput(config, options);
  if (!output) {
    try {
      output = await resolveMirrorOutDir(config);
    } catch (_) {
      output = localOutputForWorkspaceFolder(config, 'Notion Workspace');
    }
  }

  const safeOutDir = resolveSafePath(output.outDir, { mode: 'write' });
  fs.mkdirSync(safeOutDir, { recursive: true });
  const manifest = loadManifest(safeOutDir);
  const now = new Date().toISOString();
  const run = {
    startedAt: now,
    completedAt: now,
    failed: true,
    error: error.message,
    workspaceFolder: output.workspaceFolder,
    workspaceName: output.workspaceInfo?.workspaceName || '',
    workspaceId: output.workspaceInfo?.workspaceId || '',
    full: Boolean(options.full),
    pruneMode: options.pruneMode || 'safe',
    discoveryComplete: false,
    seen: 0,
    refreshed: 0,
    skipped: 0,
    pruned: 0,
    errors: 1,
    prunedPages: [],
  };
  manifest.lastRun = run;
  pushRunHistory(manifest, run, parseRetentionRuns(config));
  saveManifest(safeOutDir, manifest);
}

async function resolveMirrorOutDir(config) {
  const baseOutDir = configuredOutDir(config);
  const workspaceFolder = config.workspaceFolder ?? 'auto';

  if (workspaceFolder === false || workspaceFolder === null || workspaceFolder === 'none') {
    return {
      outDir: baseOutDir,
      baseOutDir,
      workspaceFolder: '',
      workspaceInfo: null,
    };
  }

  if (workspaceFolder && workspaceFolder !== 'auto') {
    const folder = sanitizeFolderName(workspaceFolder);
    return {
      outDir: path.join(baseOutDir, folder),
      baseOutDir,
      workspaceFolder: folder,
      workspaceInfo: null,
    };
  }

  const workspaceInfo = await getWorkspaceInfo();
  const folder = sanitizeFolderName(workspaceInfo.workspaceName || workspaceInfo.botName || 'Notion Workspace');
  return {
    outDir: path.join(baseOutDir, folder),
    baseOutDir,
    workspaceFolder: folder,
    workspaceInfo,
  };
}

async function processCandidate(candidate, context) {
  const { outDir, manifest, full, now, results, seenPageIds } = context;
  const pageId = normalizeId(candidate.page.id || candidate.pageId);
  const expectedRelativePath = candidate.relativePath || defaultPagePath(candidate.page);
  assertRelativePath(expectedRelativePath);
  seenPageIds.add(pageId);

  const existing = manifest.pages?.[pageId];
  if (!full && isUnchanged(existing, candidate.page, outDir, expectedRelativePath)) {
    const skippedEntry = updateSkippedEntry(existing, now);
    skippedEntry.relativePath = expectedRelativePath;
    manifest.pages[pageId] = skippedEntry;
    results.skipped.push(skippedEntry);
    return;
  }

  const entry = await mirrorPage({
    pageId,
    page: candidate.page,
    outDir: candidate.outDir,
    relativePath: expectedRelativePath,
    manifest,
    previousEntry: existing,
    lastSeenAt: now,
    lastCheckedAt: now,
    saveManifest: false,
  });
  results.refreshed.push(entry);
}

async function mirrorConfig(config, options = {}) {
  const output = await resolveMirrorOutDir(config);
  const outDir = output.outDir;
  const safeOutDir = resolveSafePath(outDir, { mode: 'write' });
  fs.mkdirSync(safeOutDir, { recursive: true });

  const manifest = loadManifest(safeOutDir);
  const retentionRuns = parseRetentionRuns(config);
  const now = new Date().toISOString();
  const run = {
    startedAt: now,
    completedAt: null,
    workspaceFolder: output.workspaceFolder,
    workspaceName: output.workspaceInfo?.workspaceName || '',
    workspaceId: output.workspaceInfo?.workspaceId || '',
    full: Boolean(options.full),
    pruneMode: options.pruneMode || 'safe',
    pruneAttempted: false,
    pruneSkippedReason: '',
    discoveryComplete: true,
    seen: 0,
    refreshed: 0,
    skipped: 0,
    pruned: 0,
    errors: 0,
  };
  const results = {
    refreshed: [],
    skipped: [],
    pruned: [],
    manifestPath: path.relative(process.cwd(), path.join(safeOutDir, '.notion-search-mirror.json')),
    outDir: path.relative(process.cwd(), safeOutDir) || '.',
    baseOutDir: output.baseOutDir,
    workspaceFolder: output.workspaceFolder,
    workspaceInfo: output.workspaceInfo,
    full: run.full,
    pruneMode: run.pruneMode,
    discovery: [],
  };
  const seenPageIds = new Set();
  const context = {
    outDir: safeOutDir,
    manifest,
    full: run.full,
    now,
    results,
    seenPageIds,
  };

  if (shouldMirrorWorkspace(config)) {
    const workspace = config.workspace || {};
    const workspaceResult = await searchWorkspacePages(workspace);
    run.discoveryComplete = run.discoveryComplete && workspaceResult.complete;
    results.discovery.push({
      source: 'workspace',
      complete: workspaceResult.complete,
      limit: workspaceResult.limit,
      count: workspaceResult.pages.length,
    });
    const prefix = workspace.pathPrefix ? sanitizeRelativePathPrefix(workspace.pathPrefix) : '';

    for (const page of workspaceResult.pages) {
      const title = titleFromPageResult(page);
      const relativePath = generatedMirrorPath(prefix, title, page.id);
      await processCandidate({
        page,
        outDir,
        relativePath,
      }, context);
    }
  }

  for (const page of config.pages || []) {
    if (!page.pageId) throw new Error('Each pages[] entry requires pageId');
    const pageMetadata = await getPage(page.pageId);
    await processCandidate({
      page: pageMetadata,
      outDir,
      relativePath: page.path || null,
    }, context);
  }

  for (const database of config.databases || []) {
    if (!database.databaseId) throw new Error('Each databases[] entry requires databaseId');
    const databaseResult = await queryDatabasePages(database);
    run.discoveryComplete = run.discoveryComplete && databaseResult.complete;
    results.discovery.push({
      source: 'database',
      databaseId: normalizeId(database.databaseId),
      dataSourceId: databaseResult.targetId,
      complete: databaseResult.complete,
      limit: databaseResult.limit,
      count: databaseResult.pages.length,
    });
    const prefix = database.pathPrefix ? sanitizeRelativePathPrefix(database.pathPrefix) : '';

    for (const page of databaseResult.pages) {
      const title = titleFromPageResult(page);
      const relativePath = generatedMirrorPath(prefix, title, page.id);
      await processCandidate({
        page,
        outDir,
        relativePath,
      }, context);
    }
  }

  if (run.pruneMode !== 'off' && (run.discoveryComplete || run.pruneMode === 'force')) {
    run.pruneAttempted = true;
    for (const [pageId, entry] of Object.entries(manifest.pages || {})) {
      if (seenPageIds.has(pageId)) continue;
      const pruned = safePruneFile(safeOutDir, entry);
      results.pruned.push({
        pageId,
        title: entry.title || '',
        path: pruned.path || entry.path || '',
        deletedFile: pruned.deleted,
        prunedAt: now,
      });
      delete manifest.pages[pageId];
    }
  } else if (run.pruneMode === 'off') {
    run.pruneSkippedReason = 'disabled';
  } else {
    run.pruneSkippedReason = 'discovery incomplete; use --prune force to prune anyway';
  }

  run.completedAt = new Date().toISOString();
  run.seen = seenPageIds.size;
  run.refreshed = results.refreshed.length;
  run.skipped = results.skipped.length;
  run.pruned = results.pruned.length;
  run.prunedPages = results.pruned;
  manifest.lastRun = run;
  manifest.workspace = {
    folder: output.workspaceFolder,
    name: output.workspaceInfo?.workspaceName || '',
    id: output.workspaceInfo?.workspaceId || '',
    botName: output.workspaceInfo?.botName || '',
    botId: output.workspaceInfo?.botId || '',
  };
  pushRunHistory(manifest, run, retentionRuns);
  saveManifest(safeOutDir, manifest);
  results.run = run;

  return results;
}

async function main() {
  let options = null;
  let config = null;
  try {
    options = parseArgs(process.argv.slice(2));
    const { configPath } = options;
    config = readConfig(configPath);
    if (options.report) {
      const report = await syncReport(config, options);
      if (hasJsonFlag()) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatSyncReport(report, report.manifestPath));
      }
      return;
    }

    const results = await mirrorConfig(config, options);

    if (hasJsonFlag()) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      log(`Notion mirror sync complete into ${results.outDir}`);
      log(`  Seen: ${results.run.seen}`);
      log(`  Refreshed: ${results.run.refreshed}`);
      log(`  Skipped unchanged: ${results.run.skipped}`);
      log(`  Pruned stale: ${results.run.pruned}`);
      if (results.run.pruneSkippedReason) log(`  Prune skipped: ${results.run.pruneSkippedReason}`);
      if (!results.run.discoveryComplete) log('  Discovery: incomplete');
      if (results.full) log('  Mode: full reconciliation');
      for (const result of results.refreshed) log(`  - refreshed ${result.title}: ${result.path}`);
      for (const result of results.pruned) log(`  - pruned ${result.title || result.pageId}: ${result.path}`);
      log('Mode: read-only cache; edit Notion directly');
    }
  } catch (error) {
    if (config && !options?.report) {
      try {
        await recordSyncFailure(config, options || {}, error);
      } catch (_) {
        // Preserve the original sync error for the caller.
      }
    }
    if (hasJsonFlag()) {
      console.log(JSON.stringify({ error: error.message }, null, 2));
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  checkApiKey();
  main();
} else {
  module.exports = { mirrorConfig };
}
