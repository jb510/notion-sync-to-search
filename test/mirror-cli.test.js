const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');
const cli = path.join(repo, 'scripts', 'mirror-config.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(repo, '.tmp-test-'));
}

function run(args, options = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function runFailure(args, options = {}) {
  try {
    run(args, options);
  } catch (error) {
    return error;
  }
  throw new Error('Expected command to fail');
}

test('report is local-only and includes pruned pages', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'mirror');
  const workspace = path.join(outDir, 'Work');
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ outDir, workspaceFolder: 'auto' }));
  fs.writeFileSync(path.join(workspace, '.notion-search-mirror.json'), JSON.stringify({
    generatedBy: 'notion-sync-to-search',
    runs: [{
      startedAt: new Date().toISOString(),
      refreshed: 1,
      skipped: 2,
      pruned: 1,
      prunedPages: [{ title: 'Old', path: 'Old.md', prunedAt: new Date().toISOString() }],
    }],
  }));

  const output = run([configPath, '--report', '--days', '7'], { env: { NOTION_API_KEY: '' } });
  assert.match(output, /Runs: 1/);
  assert.match(output, /Pruned pages:/);
});

test('status is local-only', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'mirror');
  const workspace = path.join(outDir, 'Work');
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ outDir, workspaceFolder: 'auto' }));
  fs.writeFileSync(path.join(workspace, '.notion-search-mirror.json'), JSON.stringify({
    generatedBy: 'notion-sync-to-search',
    pages: {},
    runs: [],
  }));

  const output = run([configPath, '--status', '--json'], { env: { NOTION_API_KEY: '' } });
  const parsed = JSON.parse(output);
  assert.equal(parsed.workspaceCount, 1);
  assert.equal(parsed.statuses[0].pageCount, 0);
});

test('multi-workspace config validates tokenEnv without requiring global token', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    outDir: path.join(dir, 'mirror'),
    workspaces: [
      { name: 'Work', workspaceFolder: 'Work', tokenEnv: 'NOTION_API_KEY_WORK' },
      { name: 'Personal', workspaceFolder: 'Personal', tokenEnv: 'NOTION_API_KEY_PERSONAL' },
    ],
  }));

  const error = runFailure([configPath, '--json'], {
    env: {
      NOTION_API_KEY: '',
      NOTION_API_KEY_WORK: 'ntn_fake',
      NOTION_API_KEY_PERSONAL: '',
    },
  });
  const parsed = JSON.parse(error.stdout);
  assert.match(parsed.error, /Personal/);
  assert.match(parsed.error, /NOTION_API_KEY_PERSONAL/);
  assert.doesNotMatch(parsed.error, /NOTION_API_KEY_WORK/);
});
