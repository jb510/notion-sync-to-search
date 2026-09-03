#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');
const { ensureCollection, resolveSettings, updateIndex } = require('./shared-index.js');

function run(argv = process.argv.slice(2)) {
  if (argv.length < 1) throw new Error('Usage: sync-shared-index.js <notion-search-mirror.json> [mirror-config options]');
  const configPath = path.resolve(argv[0]);
  const mirror = spawnSync(process.execPath, [path.join(__dirname, 'mirror-config.js'), configPath, ...argv.slice(1)], {
    stdio: 'inherit',
  });
  if (mirror.status !== 0) throw new Error(`Notion mirror sync failed; shared index was not updated (exit ${mirror.status ?? 'unknown'})`);
  const settings = resolveSettings(configPath);
  ensureCollection(settings);
  return updateIndex(settings);
}

if (require.main === module) {
  try { run(); } catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }
}

module.exports = { run };
