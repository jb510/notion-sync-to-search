#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveSettings } = require('./shared-index.js');

function run(argv = process.argv.slice(2)) {
  const at = argv.indexOf('--config');
  if (at < 0 || !argv[at + 1]) throw new Error('--config is required');
  const settings = resolveSettings(argv[at + 1]);
  if (!settings.semantic.enabled) throw new Error('FastEmbed semantic search is not enabled in config');
  const venvDir = path.resolve(path.dirname(settings.semantic.pythonCommand), '..');
  if (!fs.existsSync(settings.semantic.pythonCommand)) execFileSync(process.env.PYTHON || 'python3', ['-m', 'venv', venvDir], { stdio: 'inherit' });
  execFileSync(settings.semantic.pythonCommand, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
  execFileSync(settings.semantic.pythonCommand, ['-m', 'pip', 'install', 'fastembed>=0.7,<0.8'], { stdio: 'inherit' });
  execFileSync(settings.semantic.pythonCommand, [settings.semantic.scriptPath, 'status', '--index', settings.semantic.indexPath,
    '--model', settings.semantic.model, '--cache-dir', settings.semantic.cacheDir], { stdio: 'inherit' });
}

if (require.main === module) {
  try { run(); } catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }
}

module.exports = { run };
