const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { getAllBlocks, getApiKey, _resetTokenCache } = require('../scripts/notion-utils.js');
const { _internal } = require('../scripts/mirror-config.js');
const { _internal: openclawInternal } = require('../scripts/install-openclaw-memory.js');

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

test('workspace token swap resets cached Notion token', async () => {
  const previousGlobal = process.env.NOTION_API_KEY;
  const previousWork = process.env.NOTION_API_KEY_WORK;
  test.after(() => {
    if (previousGlobal === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = previousGlobal;
    if (previousWork === undefined) delete process.env.NOTION_API_KEY_WORK;
    else process.env.NOTION_API_KEY_WORK = previousWork;
    _resetTokenCache();
  });

  process.env.NOTION_API_KEY = 'global-token';
  process.env.NOTION_API_KEY_WORK = 'work-token';
  _resetTokenCache();
  assert.equal(getApiKey(), 'global-token');

  await _internal.withWorkspaceToken({ tokenEnv: 'NOTION_API_KEY_WORK' }, async () => {
    assert.equal(getApiKey(), 'work-token');
  });
  assert.equal(getApiKey(), 'global-token');
});

test('single workspace config preserves tokenEnv', () => {
  const workspaces = _internal.workspaceConfigs({
    name: 'Work',
    tokenEnv: 'NOTION_API_KEY_WORK',
    workspaceFolder: 'Work',
  });
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].tokenEnv, 'NOTION_API_KEY_WORK');
});

test('default selected page paths include page id to avoid title collisions', () => {
  const pageA = { id: '11111111-1111-1111-1111-111111111111', properties: { Name: { type: 'title', title: [{ plain_text: 'Same Title' }] } } };
  const pageB = { id: '22222222-2222-2222-2222-222222222222', properties: { Name: { type: 'title', title: [{ plain_text: 'Same Title' }] } } };
  assert.equal(_internal.defaultPagePath(pageA), 'Same Title - 11111111.md');
  assert.equal(_internal.defaultPagePath(pageB), 'Same Title - 22222222.md');
});

test('manifest entry cache hit requires regular file', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const regularFile = path.join(dir, 'page.md');
  const directoryPath = path.join(dir, 'directory.md');
  fs.writeFileSync(regularFile, 'content');
  fs.mkdirSync(directoryPath);

  assert.equal(_internal.manifestEntryFileExists(dir, { path: regularFile }), true);
  assert.equal(_internal.manifestEntryFileExists(dir, { path: directoryPath }), false);
});

test('page sync errors are recorded as page-level entries', () => {
  const page = {
    id: '3193f788-993c-81f3-a066-ccb43c832b89',
    url: 'https://example.notion.site/page',
    last_edited_time: '2026-04-29T00:00:00.000Z',
    properties: { Name: { type: 'title', title: [{ plain_text: 'Huge Page' }] } },
  };
  const entry = _internal.pageErrorEntry(
    { page },
    page.id,
    'Huge Page - 3193f788.md',
    new Error('Block limit exceeded for 3193f788-993c-81f3-a066-ccb43c832b89; maxBlocksPerPage=1885'),
    '2026-04-29T15:00:00.000Z',
  );

  assert.equal(entry.title, 'Huge Page');
  assert.equal(entry.syncStatus, 'error');
  assert.equal(entry.relativePath, 'Huge Page - 3193f788.md');
  assert.match(entry.error, /Block limit exceeded/);
});

test('block limit of zero does not reset to unbounded recursion', async () => {
  await assert.rejects(
    () => getAllBlocks('3193f788-993c-81f3-a066-ccb43c832b89', { maxBlocks: 0 }),
    /Block limit exceeded/,
  );
});

test('openclaw memory helper links agent workspaces to one mirror', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const primary = path.join(dir, 'workspace');
  const coding = path.join(dir, 'workspace-coding');
  const configPath = path.join(dir, 'openclaw.json');
  fs.mkdirSync(path.join(primary, 'notion-sync-read-only'), { recursive: true });
  fs.mkdirSync(coding, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    agents: {
      list: [
        { id: 'main', workspace: primary },
        { id: 'coding', workspace: coding },
      ],
    },
  }));

  const result = openclawInternal.run([
    '--config', configPath,
    '--workspace', primary,
    '--mirror-path', 'notion-sync-read-only',
    '--link-agent-workspaces',
    '--json',
  ]);
  const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(updated.agents.defaults.memorySearch.extraPaths, ['notion-sync-read-only']);
  assert.equal(fs.lstatSync(path.join(coding, 'notion-sync-read-only')).isSymbolicLink(), true);
  assert.equal(result.links.some(link => link.agentId === 'coding' && link.action === 'linked'), true);
});
