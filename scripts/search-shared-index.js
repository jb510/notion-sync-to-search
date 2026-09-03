#!/usr/bin/env node

const { buildSearchArgs, mergeHybridResults, resolveSettings, runQmd, semanticSearch } = require('./shared-index.js');

function parseArgs(argv) {
  const options = { configPath: null, query: null, limit: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === '--config' || argv[i] === '-c') && argv[i + 1]) options.configPath = argv[++i];
    else if ((argv[i] === '--query' || argv[i] === '-q') && argv[i + 1]) options.query = argv[++i];
    else if ((argv[i] === '--limit' || argv[i] === '-n') && argv[i + 1]) options.limit = argv[++i];
    else if (!argv[i].startsWith('-') && !options.query) options.query = argv[i];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!options.configPath) throw new Error('--config is required');
  if (!options.query) throw new Error('--query is required');
  return options;
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const settings = resolveSettings(options.configPath);
  const candidateLimit = Math.max(20, Math.min(options.limit * 4, 80));
  const bm25 = JSON.parse(runQmd(settings, buildSearchArgs(settings, options.query, candidateLimit)));
  if (!settings.semantic.enabled) {
    process.stdout.write(`${JSON.stringify(bm25.slice(0, options.limit), null, 2)}\n`);
    return;
  }
  const semantic = semanticSearch(settings, options.query, candidateLimit);
  process.stdout.write(`${JSON.stringify(mergeHybridResults(bm25, semantic, options.limit, settings.semantic.weight), null, 2)}\n`);
}

if (require.main === module) {
  try { run(); } catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }
}

module.exports = { parseArgs, run };
