const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { blocksToMarkdown, getAllBlocks, getApiKey, shouldFetchBlockChildren, _resetTokenCache } = require('../scripts/notion-utils.js');
const { _internal } = require('../scripts/mirror-config.js');
const { chunkBlocks, partRelativePath, removeOldGeneratedFiles } = require('../scripts/mirror-page.js');
const { _internal: openclawInternal } = require('../scripts/install-openclaw-memory.js');

const repo = path.resolve(__dirname, '..');
const cli = path.join(repo, 'scripts', 'mirror-config.js');
const schedulerCli = path.join(repo, 'scripts', 'install-scheduler.js');

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

test('manifest entry cache hit can use outDir-relative paths across working directories', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'mirror');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'page.md'), 'content');

  assert.equal(_internal.manifestEntryFileExists(outDir, {
    path: 'notion-sync-read-only/Jon/page.md',
    relativePath: 'page.md',
  }), true);
});

test('manifest entry cache hit requires every generated part', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const partOne = path.join(dir, 'page.md');
  const partTwo = path.join(dir, 'page.part-002.md');
  fs.writeFileSync(partOne, 'part one');
  fs.writeFileSync(partTwo, 'part two');

  assert.equal(_internal.manifestEntryFileExists(dir, {
    path: partOne,
    files: [
      { path: partOne, partNumber: 1 },
      { path: partTwo, partNumber: 2 },
    ],
  }), true);

  fs.unlinkSync(partTwo);
  assert.equal(_internal.manifestEntryFileExists(dir, {
    path: partOne,
    files: [
      { path: partOne, partNumber: 1 },
      { path: partTwo, partNumber: 2 },
    ],
  }), false);
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

test('skipped unchanged entries clear stale error metadata', () => {
  const entry = _internal.updateSkippedEntry({
    pageId: '3193f788-993c-81f3-a066-ccb43c832b89',
    syncStatus: 'error',
    error: 'Block limit exceeded',
    errorName: 'Error',
    failedAt: '2026-04-29T15:00:00.000Z',
  }, '2026-05-07T22:00:00.000Z');

  assert.equal(entry.syncStatus, 'skipped_unchanged');
  assert.equal(entry.error, undefined);
  assert.equal(entry.errorName, undefined);
  assert.equal(entry.failedAt, undefined);
});

test('block limit of zero does not reset to unbounded recursion', async () => {
  await assert.rejects(
    () => getAllBlocks('3193f788-993c-81f3-a066-ccb43c832b89', { maxBlocks: 0 }),
    /Block limit exceeded/,
  );
});

test('expired block deadline fails before network access', async () => {
  await assert.rejects(
    () => getAllBlocks('3193f788-993c-81f3-a066-ccb43c832b89', { deadlineMs: Date.now() - 1 }),
    /Page block fetch timed out/,
  );
});

test('child pages remain references instead of recursive inline content by default', () => {
  const childPage = {
    id: '349bb4fe-9887-8149-827f-dc0f3c7a4f6e',
    type: 'child_page',
    has_children: true,
    child_page: { title: 'OPEN CLAW MAIN BRAIN' },
  };
  const childDatabase = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    type: 'child_database',
    has_children: true,
    child_database: { title: 'Research Database' },
  };

  assert.equal(shouldFetchBlockChildren(childPage), false);
  assert.equal(shouldFetchBlockChildren(childDatabase), false);
  assert.equal(shouldFetchBlockChildren(childPage, { expandChildPages: true }), true);
  assert.equal(shouldFetchBlockChildren({ type: 'toggle', has_children: true }), true);

  const markdown = blocksToMarkdown([childPage, childDatabase]);
  assert.match(markdown, /## OPEN CLAW MAIN BRAIN/);
  assert.match(markdown, /Notion child page: 349bb4fe-9887-8149-827f-dc0f3c7a4f6e/);
  assert.match(markdown, /## Research Database/);
  assert.match(markdown, /Notion child database: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
});

test('large pages are split into stable markdown part paths', () => {
  const blocks = Array.from({ length: 5 }, (_, index) => ({ id: String(index + 1) }));
  assert.deepEqual(chunkBlocks(blocks, 2).map(chunk => chunk.map(block => block.id)), [
    ['1', '2'],
    ['3', '4'],
    ['5'],
  ]);
  assert.equal(partRelativePath('Folder/Huge Page - 3193f788.md', 1), 'Folder/Huge Page - 3193f788.md');
  assert.equal(partRelativePath('Folder/Huge Page - 3193f788.md', 2), 'Folder/Huge Page - 3193f788.part-002.md');
});

test('old manifest paths outside the current mirror are skipped during migration', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'new-mirror');
  const oldDir = path.join(dir, 'old-mirror');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, 'Page.md');
  fs.writeFileSync(oldFile, 'old');

  const result = removeOldGeneratedFiles(outDir, { path: oldFile }, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skippedOutside, [oldFile]);
  assert.equal(fs.existsSync(oldFile), true);
});

test('old generated file removal can use relativePath when cwd-relative path is stale', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'mirror');
  fs.mkdirSync(outDir, { recursive: true });
  const oldFile = path.join(outDir, 'Page.md');
  fs.writeFileSync(oldFile, 'old');

  const result = removeOldGeneratedFiles(outDir, {
    path: 'notion-sync-read-only/Jon/Page.md',
    relativePath: 'Page.md',
  }, []);
  assert.deepEqual(result.removed, [path.relative(process.cwd(), oldFile)]);
  assert.equal(fs.existsSync(oldFile), false);
});

test('legacy 500 block limit becomes chunk size, not total page cap', () => {
  const limits = _internal.parseLimits({ limits: { maxBlocksPerPage: 500 } });
  assert.equal(limits.maxBlocksPerPage, 20000);
  assert.equal(limits.maxBlocksPerOutputFile, 500);
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

test('openclaw memory helper supports state-level absolute mirror paths', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'workspace'), { recursive: true });
  const configPath = path.join(state, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: {}, list: [] } }));

  const result = openclawInternal.run(['--state-dir', state, '--json']);
  const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(updated.agents.defaults.memorySearch.extraPaths, [path.join(state, 'notion-sync-read-only')]);
  assert.equal(result.configPath, configPath);
  assert.equal(result.workspace, path.join(state, 'workspace'));
  assert.equal(result.mirrorPath, path.join(state, 'notion-sync-read-only'));
});

test('openclaw memory helper can replace legacy notion mirror paths', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'workspace'), { recursive: true });
  const configPath = path.join(state, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({
    agents: {
      defaults: {
        memorySearch: {
          extraPaths: ['notion-sync-read-only', '/old/state/notion-sync-read-only', '/keep/other-docs'],
        },
      },
      list: [],
    },
  }));

  openclawInternal.run(['--state-dir', state, '--replace-notion-paths', '--json']);
  const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(updated.agents.defaults.memorySearch.extraPaths, [
    '/keep/other-docs',
    path.join(state, 'notion-sync-read-only'),
  ]);
});

test('mirror config lock blocks concurrent sync runs and releases cleanly', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { outDir: path.join(dir, 'mirror') };
  const first = _internal.acquireSyncLock(config, { configPath: path.join(dir, 'config.json') });
  assert.equal(first.acquired, true);
  assert.throws(() => _internal.acquireSyncLock(config, {}), /already running/);
  first.release();
  const second = _internal.acquireSyncLock(config, {});
  assert.equal(second.acquired, true);
  second.release();
});

test('scheduler helper can generate state-level install plan', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'config'), { recursive: true });
  fs.writeFileSync(path.join(state, 'config', 'notion-search-mirror.json'), JSON.stringify({
    outDir: path.join(state, 'notion-sync-read-only'),
    sync: { intervalMinutes: 37 },
  }));

  const output = execFileSync(process.execPath, [
    schedulerCli,
    '--state-dir', state,
    '--name', 'notion-sync-to-search',
    '--json',
  ], { cwd: repo, encoding: 'utf8' });
  const plan = JSON.parse(output);
  assert.equal(plan.kind, process.platform === 'darwin' ? 'launchd' : 'systemd');
  assert.match(plan.content, /notion-search-mirror\.json/);
  assert.match(plan.content, /notion-sync-to-search\.log/);
  assert.match(plan.content, /state/);
  if (process.platform === 'darwin') {
    assert.equal(plan.path, path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.openclaw.notion-sync-to-search.plist'));
    assert.match(plan.content, /StartInterval/);
    assert.match(plan.content, /2220/);
  } else {
    assert.equal(plan.path, path.join(os.homedir(), '.config', 'systemd', 'user', 'notion-sync-to-search.service'));
    assert.match(plan.content, /EnvironmentFile=-/);
    assert.match(plan.content, /WorkingDirectory=/);
  }
});
