#!/usr/bin/env node

const { execFileSync } = require('child_process');
const { buildMcpSpec, ensureCollection, resolveSettings, updateIndex } = require('./shared-index.js');

function parseArgs(argv) {
  const options = { configPath: null, configureOpenClaw: false, openclawCommand: 'openclaw', dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === '--config' || argv[i] === '-c') && argv[i + 1]) options.configPath = argv[++i];
    else if (argv[i] === '--configure-openclaw') options.configureOpenClaw = true;
    else if (argv[i] === '--openclaw-command' && argv[i + 1]) options.openclawCommand = argv[++i];
    else if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') return { help: true };
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!options.configPath && !options.help) throw new Error('--config is required');
  return options;
}

function usage() {
  console.log('Usage: install-shared-index.js --config <notion-search-mirror.json> [--configure-openclaw] [--dry-run] [--json]');
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return usage();
  const settings = resolveSettings(options.configPath);
  const collection = ensureCollection(settings, { dryRun: options.dryRun });
  const index = updateIndex(settings, { dryRun: options.dryRun });
  const mcpSpec = buildMcpSpec(settings);
  let mcp = { action: 'not-requested', server: settings.mcpServerName, spec: mcpSpec };
  if (options.configureOpenClaw) {
    if (options.dryRun) mcp = { action: 'would-configure', server: settings.mcpServerName, spec: mcpSpec };
    else {
      execFileSync(options.openclawCommand, ['mcp', 'set', settings.mcpServerName, JSON.stringify(mcpSpec)], { stdio: 'inherit' });
      mcp = { action: 'configured', server: settings.mcpServerName, spec: mcpSpec };
    }
  }
  const result = { settings, collection, index, mcp };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Shared Notion index: ${settings.indexName}`);
    console.log(`Collection: ${settings.collectionName} (${collection.action})`);
    console.log(`MCP server: ${settings.mcpServerName} (${mcp.action})`);
  }
  return result;
}

if (require.main === module) {
  try { run(); } catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }
}

module.exports = { run };
