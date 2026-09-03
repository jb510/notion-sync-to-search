#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function safeName(value, label) {
  const text = String(value || '').trim();
  if (!text || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(text)) {
    throw new Error(`${label} must start with a letter and contain only letters, digits, dot, underscore, or dash`);
  }
  return text;
}

function resolveCommand(value) {
  const command = String(value || 'qmd').trim();
  if (!command || /[\r\n\0]/.test(command)) throw new Error('Invalid QMD command');
  return command;
}

function resolveRelative(basePath, value, fallback) {
  const selected = String(value || fallback || '').trim();
  if (!selected) throw new Error('Required path is empty');
  return path.isAbsolute(selected) ? path.resolve(selected) : path.resolve(basePath, selected);
}

function resolveSettings(configPath, overrides = {}) {
  const absoluteConfig = path.resolve(configPath);
  const config = readConfig(absoluteConfig);
  const index = config.searchIndex || {};
  if ((index.provider || 'qmd') !== 'qmd') throw new Error('searchIndex.provider must be "qmd"');
  const outDirValue = overrides.mirrorPath || config.outDir || 'notion-sync-read-only';
  const mirrorPath = path.isAbsolute(outDirValue)
    ? path.resolve(outDirValue)
    : path.resolve(path.dirname(absoluteConfig), outDirValue);
  const freshnessValue = index.freshnessFile || '.qmd-index-updated';
  const freshnessFile = path.isAbsolute(freshnessValue)
    ? path.resolve(freshnessValue)
    : path.join(mirrorPath, freshnessValue);
  const semantic = index.semantic || {};
  const semanticEnabled = semantic.enabled === true;
  if (semanticEnabled && (semantic.provider || 'fastembed') !== 'fastembed') {
    throw new Error('searchIndex.semantic.provider must be "fastembed"');
  }
  const basePath = path.dirname(absoluteConfig);
  return {
    configPath: absoluteConfig,
    mirrorPath,
    indexName: safeName(overrides.indexName || index.indexName, 'searchIndex.indexName'),
    collectionName: safeName(overrides.collectionName || index.collectionName || 'notion-mirror', 'searchIndex.collectionName'),
    mcpServerName: safeName(overrides.mcpServerName || index.mcpServerName || 'notion-search', 'searchIndex.mcpServerName'),
    qmdCommand: resolveCommand(overrides.qmdCommand || index.qmdCommand),
    embed: overrides.embed ?? index.embed !== false,
    noRerank: overrides.noRerank ?? index.noRerank !== false,
    freshnessFile,
    semantic: {
      enabled: semanticEnabled,
      provider: semantic.provider || 'fastembed',
      model: semantic.model || 'BAAI/bge-small-en-v1.5',
      pythonCommand: resolveRelative(basePath, semantic.pythonCommand, '.fastembed-venv/bin/python'),
      scriptPath: path.join(__dirname, 'fastembed-index.py'),
      indexPath: resolveRelative(mirrorPath, semantic.indexPath, '.fastembed/notion-vectors.sqlite'),
      cacheDir: resolveRelative(mirrorPath, semantic.cacheDir, '.fastembed/model-cache'),
      chunkChars: Math.max(400, Math.min(Number.parseInt(semantic.chunkChars, 10) || 1800, 6000)),
      chunkOverlap: Math.max(0, Math.min(Number.parseInt(semantic.chunkOverlap, 10) || 200, 1000)),
      maxCharsPerFile: Math.max(2000, Math.min(Number.parseInt(semantic.maxCharsPerFile, 10) || 12000, 100000)),
      batchSize: Math.max(1, Math.min(Number.parseInt(semantic.batchSize, 10) || 64, 256)),
      weight: Math.max(0.1, Math.min(Number(semantic.weight) || 0.8, 2)),
    },
  };
}

function qmdArgs(settings, args) {
  return ['--index', settings.indexName, ...args];
}

function runQmd(settings, args, options = {}) {
  return execFileSync(settings.qmdCommand, qmdArgs(settings, args), {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function collectionState(settings) {
  const result = spawnSync(settings.qmdCommand, qmdArgs(settings, ['collection', 'show', settings.collectionName]), {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) return { exists: false, output: `${result.stdout || ''}${result.stderr || ''}` };
  return { exists: true, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function ensureCollection(settings, options = {}) {
  if (!fs.statSync(settings.mirrorPath).isDirectory()) throw new Error(`Mirror directory not found: ${settings.mirrorPath}`);
  const state = collectionState(settings);
  if (state.exists) {
    const normalizedOutput = state.output.replace(/\\/g, '/');
    const normalizedPath = settings.mirrorPath.replace(/\\/g, '/');
    if (!normalizedOutput.includes(normalizedPath)) {
      throw new Error(`QMD collection ${settings.collectionName} exists but does not point at ${settings.mirrorPath}`);
    }
    return { action: 'existing', output: state.output.trim() };
  }
  if (options.dryRun) return { action: 'would-add' };
  runQmd(settings, ['collection', 'add', settings.mirrorPath, '--name', settings.collectionName]);
  return { action: 'added' };
}

function updateIndex(settings, options = {}) {
  if (options.dryRun) return { action: 'would-update', embed: settings.embed, semantic: settings.semantic.enabled };
  runQmd(settings, ['update'], { stdio: 'inherit' });
  if (settings.embed) {
    runQmd(settings, ['embed', '-c', settings.collectionName, '--max-docs-per-batch', '100', '--max-batch-mb', '32'], { stdio: 'inherit' });
  }
  if (settings.semantic.enabled) {
    execFileSync(settings.semantic.pythonCommand, [
      settings.semantic.scriptPath, 'index',
      '--mirror', settings.mirrorPath,
      '--index', settings.semantic.indexPath,
      '--model', settings.semantic.model,
      '--cache-dir', settings.semantic.cacheDir,
      '--chunk-chars', String(settings.semantic.chunkChars),
      '--chunk-overlap', String(settings.semantic.chunkOverlap),
      '--max-chars-per-file', String(settings.semantic.maxCharsPerFile),
      '--batch-size', String(settings.semantic.batchSize),
    ], { stdio: 'inherit', maxBuffer: 64 * 1024 * 1024 });
  }
  fs.mkdirSync(path.dirname(settings.freshnessFile), { recursive: true });
  fs.closeSync(fs.openSync(settings.freshnessFile, 'a'));
  const now = new Date();
  fs.utimesSync(settings.freshnessFile, now, now);
  return { action: 'updated', embed: settings.embed, semantic: settings.semantic.enabled, freshnessFile: settings.freshnessFile };
}

function semanticSearch(settings, query, limit = 20) {
  if (!settings.semantic.enabled) return [];
  const output = execFileSync(settings.semantic.pythonCommand, [
    settings.semantic.scriptPath, 'search',
    '--index', settings.semantic.indexPath,
    '--model', settings.semantic.model,
    '--cache-dir', settings.semantic.cacheDir,
    '--query', String(query), '--limit', String(limit),
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output).map(item => {
    const heading = String(item.snippet || '').match(/\n#\s+([^\n]+)/);
    if (heading) item.title = heading[1].trim();
    return item;
  });
}

function resultKey(item) {
  const value = String(item.file || item.path || '');
  if (item.notion_url) return String(item.notion_url).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const snippetUrl = String(item.snippet || '').match(/notion_url:\s*["']?([^"'\s]+)/i);
  if (snippetUrl) return snippetUrl[1].replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const pageId = decodeURIComponent(value.split('?')[0]).match(/[- ]([0-9a-f]{8})\.md$/i);
  if (pageId) return `notion-page-${pageId[1].toLowerCase()}`;
  return path.basename(value.split('?')[0]).toLowerCase();
}

function mergeHybridResults(bm25, semantic, limit, semanticWeight = 0.8) {
  const scores = new Map();
  const add = (items, source, weight) => items.forEach((item, rank) => {
    const key = resultKey(item);
    if (!key) return;
    const current = scores.get(key) || { ...item, fusionScore: 0, sources: [], bm25: null, semantic: null };
    current.fusionScore += weight / (61 + rank);
    if (!current.sources.includes(source)) current.sources.push(source);
    if (source === 'bm25') current.bm25 = { rank: rank + 1, score: item.score ?? null };
    else current.semantic = { rank: rank + 1, score: item.score ?? null };
    if ((!current.title || current.title === path.basename(current.file || '')) && item.title) current.title = item.title;
    if (!current.snippet && item.snippet) current.snippet = item.snippet;
    scores.set(key, current);
  });
  add(bm25, 'bm25', 1);
  add(semantic, 'fastembed', semanticWeight);
  return [...scores.values()].sort((a, b) => b.fusionScore - a.fusionScore)
    .slice(0, Math.max(1, Math.min(Number.parseInt(limit, 10) || 5, 20)));
}

function buildSearchArgs(settings, query, limit = 5) {
  const boundedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 5, 20));
  const normalized = String(query).replace(/[\r\n]+/g, ' ');
  if (!settings.embed) {
    return ['search', normalized, '--collection', settings.collectionName, '--format', 'json', '-n', String(boundedLimit)];
  }
  const queryDocument = `lex: ${normalized}\nvec: ${normalized}`;
  const args = ['query', queryDocument, '--collection', settings.collectionName, '--format', 'json', '-n', String(boundedLimit)];
  if (settings.noRerank) args.push('--no-rerank');
  return args;
}

function buildMcpSpec(settings) {
  const searchTool = settings.embed ? 'query' : 'search';
  return {
    command: settings.qmdCommand,
    args: ['--index', settings.indexName, 'mcp'],
    requestTimeoutMs: 60000,
    connectionTimeoutMs: 10000,
    supportsParallelToolCalls: true,
    toolFilter: { include: [searchTool, 'get', 'multi_get', 'status'] },
  };
}

module.exports = {
  buildMcpSpec,
  buildSearchArgs,
  collectionState,
  ensureCollection,
  qmdArgs,
  readConfig,
  resolveSettings,
  runQmd,
  semanticSearch,
  mergeHybridResults,
  updateIndex,
};
