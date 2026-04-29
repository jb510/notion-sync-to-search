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
const { mirrorPage, DEFAULT_OUT_DIR } = require('./mirror-page.js');

function usage(exitCode = 0) {
  console.log('Usage: mirror-config.js <config.json> [--json]');
  console.log('');
  console.log('Config shape:');
  console.log(JSON.stringify({
    outDir: DEFAULT_OUT_DIR,
    pages: [{ pageId: '...', path: '00 Index/Page.md' }],
    databases: [{ databaseId: '...', pathPrefix: '05 Research Library', limit: 100 }],
  }, null, 2));
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = stripTokenArg(argv);
  if (args.length < 1 || args[0] === '--help' || args[0] === '-h') usage(args[0] ? 0 : 1);
  return { configPath: args[0] };
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

async function getDatabaseQueryTarget(databaseId) {
  const dbInfo = await notionRequest(`/v1/databases/${encodeURIComponent(normalizeId(databaseId))}`, 'GET');
  return dbInfo.data_sources?.[0]?.id || normalizeId(databaseId);
}

async function queryDatabasePages(databaseConfig) {
  const limit = Math.max(1, Math.min(parseInt(databaseConfig.limit || 100, 10), 100));
  const targetId = await getDatabaseQueryTarget(databaseConfig.databaseId);
  const pages = [];
  let cursor = null;

  do {
    const payload = { page_size: Math.min(limit - pages.length, 100) };
    if (cursor) payload.start_cursor = cursor;
    if (databaseConfig.filter) payload.filter = databaseConfig.filter;
    if (databaseConfig.sorts || databaseConfig.sort) payload.sorts = databaseConfig.sorts || databaseConfig.sort;

    const result = await notionRequest(`/v1/data_sources/${encodeURIComponent(targetId)}/query`, 'POST', payload);
    pages.push(...result.results);
    cursor = result.has_more && pages.length < limit ? result.next_cursor : null;
  } while (cursor && pages.length < limit);

  return pages;
}

function titleFromPageResult(page) {
  for (const property of Object.values(page.properties || {})) {
    if (property?.type === 'title') {
      const title = property.title?.map(part => part.plain_text || '').join('').trim();
      if (title) return title;
    }
  }
  return 'Untitled';
}

async function mirrorConfig(config) {
  const outDir = config.outDir || DEFAULT_OUT_DIR;
  const results = [];

  for (const page of config.pages || []) {
    if (!page.pageId) throw new Error('Each pages[] entry requires pageId');
    results.push(await mirrorPage({
      pageId: page.pageId,
      outDir,
      relativePath: page.path || null,
    }));
  }

  for (const database of config.databases || []) {
    if (!database.databaseId) throw new Error('Each databases[] entry requires databaseId');
    const pages = await queryDatabasePages(database);
    const prefix = database.pathPrefix ? sanitizeRelativePathPrefix(database.pathPrefix) : '';

    for (const page of pages) {
      const title = titleFromPageResult(page);
      const relativePath = path.join(prefix, `${sanitizePathSegment(title)}.md`);
      results.push(await mirrorPage({
        pageId: page.id,
        outDir,
        relativePath,
      }));
    }
  }

  return results;
}

async function main() {
  try {
    const { configPath } = parseArgs(process.argv.slice(2));
    const config = readConfig(configPath);
    const results = await mirrorConfig(config);

    if (hasJsonFlag()) {
      console.log(JSON.stringify({ mirrored: results }, null, 2));
    } else {
      log(`Mirrored ${results.length} Notion page(s) into ${config.outDir || DEFAULT_OUT_DIR}`);
      for (const result of results) log(`  - ${result.title}: ${result.path}`);
      log('Mode: read-only cache; edit Notion directly');
    }
  } catch (error) {
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
