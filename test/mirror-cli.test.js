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
const resolverCli = path.join(repo, 'scripts', 'resolve-live-token.js');
const notionLiveCli = path.join(repo, 'scripts', 'notion-live.js');
const provenanceCli = path.join(repo, 'scripts', 'provenance.js');
const privacyLintCli = path.join(repo, 'scripts', 'privacy-lint.js');
const syncSmokeCli = path.join(repo, 'scripts', 'sync-smoke.js');

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

function runResolver(args, options = {}) {
  return execFileSync(process.execPath, [resolverCli, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function runScript(script, args, options = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function runScriptFailure(script, args, options = {}) {
  try {
    runScript(script, args, options);
  } catch (error) {
    return error;
  }
  throw new Error('Expected command to fail');
}

test('live token resolver maps mirrored page to workspace tokenEnv', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'mirror');
  const personalDir = path.join(outDir, 'Personal');
  fs.mkdirSync(personalDir, { recursive: true });
  const pageId = '374bb4fe-9887-8022-a1b0-c4e26975c46a';
  const configPath = path.join(dir, 'config.json');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(configPath, JSON.stringify({
    outDir,
    workspaces: [
      { name: 'Business', outFolder: 'Business', tokenEnv: 'NOTION_API_KEY' },
      { name: 'Personal', outFolder: 'Personal', tokenEnv: 'NOTION_API_KEY_PERSONAL' },
    ],
  }));
  fs.writeFileSync(envPath, 'NOTION_API_KEY=ntn_business\nNOTION_API_KEY_PERSONAL=ntn_personal\n');
  fs.writeFileSync(path.join(personalDir, '.notion-search-mirror.json'), JSON.stringify({
    generatedBy: 'notion-sync-to-search',
    pages: {
      [pageId]: {
        pageId,
        title: 'WHISTLER WEEK',
        url: 'https://app.notion.com/p/WHISTLER-WEEK-374bb4fe98878022a1b0c4e26975c46a',
        path: 'notion-sync-read-only/Personal/WHISTLER WEEK - 374bb4fe.md',
      },
    },
  }));

  const output = runResolver([configPath, pageId.replace(/-/g, ''), '--env-file', envPath, '--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.workspaceName, 'Personal');
  assert.equal(parsed.workspaceFolder, 'Personal');
  assert.equal(parsed.tokenEnv, 'NOTION_API_KEY_PERSONAL');
  assert.equal(parsed.tokenAvailable, true);
});

test('live token resolver discovers auto workspace folders for a single token', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'mirror');
  const workspaceDir = path.join(outDir, 'Notion Workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const pageId = '228b9b5a-66b4-80bf-805c-d928791b2763';
  const configPath = path.join(dir, 'config.json');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(configPath, JSON.stringify({ outDir, workspaceFolder: 'auto' }));
  fs.writeFileSync(envPath, 'NOTION_API_KEY=ntn_single_workspace\n');
  fs.writeFileSync(path.join(workspaceDir, '.notion-search-mirror.json'), JSON.stringify({
    pages: {
      [pageId]: { pageId, title: 'Teamspace Home', url: 'https://example.notion.site/teamspace' },
    },
  }));

  const output = runResolver([configPath, pageId, '--env-file', envPath, '--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.workspaceName, 'Notion Workspace');
  assert.equal(parsed.workspaceFolder, 'Notion Workspace');
  assert.equal(parsed.tokenEnv, 'NOTION_API_KEY');
  assert.equal(parsed.tokenAvailable, true);
});

test('notion live wrapper maps the resolved workspace token to both CLI conventions', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'mirror');
  const personalDir = path.join(outDir, 'Anastasia');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(personalDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const pageId = '374bb4fe-9887-8022-a1b0-c4e26975c46a';
  const configPath = path.join(dir, 'config.json');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(configPath, JSON.stringify({
    outDir,
    workspaces: [
      { name: 'Anastasia Personal', outFolder: 'Anastasia', tokenEnv: 'NOTION_API_KEY' },
      { name: 'Chad Personal', outFolder: 'Chad', tokenEnv: 'NOTION_API_KEY_CHAD' },
    ],
  }));
  fs.writeFileSync(envPath, 'NOTION_API_KEY=anastasia-token\nNOTION_API_KEY_CHAD=chad-token\n');
  fs.writeFileSync(path.join(personalDir, '.notion-search-mirror.json'), JSON.stringify({
    pages: {
      [pageId]: { pageId, title: 'Attendees', url: 'https://example.notion.site/attendees' },
    },
  }));
  const stub = path.join(binDir, 'ntn');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const ok = process.env.NOTION_API_TOKEN === 'anastasia-token'
  && process.env.NOTION_API_KEY === 'anastasia-token'
  && !process.env.NOTION_API_KEY_CHAD;
console.log(JSON.stringify({ ok, args: process.argv.slice(2) }));
process.exit(ok ? 0 : 9);
`);
  fs.chmodSync(stub, 0o755);

  const output = runScript(notionLiveCli, [
    configPath,
    pageId,
    '--env-file', envPath,
    '--', 'pages', 'get', pageId, '--json',
  ], {
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      NOTION_API_KEY: '',
      NOTION_API_KEY_CHAD: 'chad-token-must-not-leak',
      NOTION_API_TOKEN: '',
    },
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.args, ['pages', 'get', pageId, '--json']);
});

test('notion live wrapper asks for workspace resolution instead of falling back', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    outDir: path.join(dir, 'mirror'),
    workspaces: [
      { name: 'Anastasia Personal', outFolder: 'Anastasia', tokenEnv: 'NOTION_API_KEY' },
      { name: 'Chad Personal', outFolder: 'Chad', tokenEnv: 'NOTION_API_KEY_CHAD' },
    ],
  }));

  const error = runScriptFailure(notionLiveCli, [
    configPath,
    'unknown-page',
    '--dry-run',
  ]);
  assert.equal(error.status, 2);
  assert.match(error.stderr, /Ask the user which configured Notion workspace/);
  assert.match(error.stderr, /do not fall back to a default token/);
});

test('provenance reports source URL, workspace, receipt, and token env', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'mirror');
  const waldenDir = path.join(outDir, 'Walden');
  fs.mkdirSync(waldenDir, { recursive: true });
  const pageId = '374bb4fe-9887-8022-a1b0-c4e26975c46a';
  const configPath = path.join(dir, 'config.json');
  const envPath = path.join(dir, '.env');
  const mdPath = path.join(waldenDir, 'OPEN CLAW MAIN BRAIN - 374bb4fe.md');
  fs.writeFileSync(configPath, JSON.stringify({
    outDir,
    workspaces: [
      { name: 'Walden Business', outFolder: 'Walden', tokenEnv: 'NOTION_API_KEY' },
      { name: 'Joanna Personal', outFolder: 'Joanna Workflow', tokenEnv: 'NOTION_API_KEY_PERSONAL' },
    ],
  }));
  fs.writeFileSync(envPath, 'NOTION_API_KEY=ntn_business\n');
  fs.writeFileSync(mdPath, `---\nnotion_page_id: "${pageId}"\nnotion_url: "https://example.notion.site/main-brain"\n---\n# OPEN CLAW MAIN BRAIN\n`);
  fs.writeFileSync(path.join(waldenDir, '.notion-search-mirror.json'), JSON.stringify({
    generatedBy: 'notion-sync-to-search',
    pages: {
      [pageId]: {
        pageId,
        title: 'OPEN CLAW MAIN BRAIN',
        url: 'https://example.notion.site/main-brain',
        relativePath: 'OPEN CLAW MAIN BRAIN - 374bb4fe.md',
        notionLastEditedTime: '2026-06-15T12:00:00.000Z',
      },
    },
  }));

  const output = runScript(provenanceCli, [configPath, 'OPEN CLAW MAIN BRAIN', '--env-file', envPath, '--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.matchCount, 1);
  assert.equal(parsed.matches[0].workspaceName, 'Walden Business');
  assert.equal(parsed.matches[0].workspaceFolder, 'Walden');
  assert.equal(parsed.matches[0].tokenEnv, 'NOTION_API_KEY');
  assert.equal(parsed.matches[0].tokenAvailable, true);
  assert.equal(parsed.matches[0].receipt.link, 'https://example.notion.site/main-brain');
});

test('privacy lint flags multi-workspace root search path', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config', 'notion-search-mirror.json');
  const openclawPath = path.join(dir, 'openclaw.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    outDir: path.join(dir, 'notion-sync-read-only'),
    workspaces: [
      { name: 'Walden Business', outFolder: 'Walden', tokenEnv: 'NOTION_API_KEY' },
      { name: 'Joanna Personal', outFolder: 'Joanna Workflow', tokenEnv: 'NOTION_API_KEY_PERSONAL' },
    ],
  }));
  fs.writeFileSync(openclawPath, JSON.stringify({
    agents: {
      defaults: {
        memorySearch: {
          extraPaths: [path.join(dir, 'notion-sync-read-only')],
        },
      },
    },
  }));

  const output = runScript(privacyLintCli, [configPath, '--openclaw-config', openclawPath, '--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.findings.some(finding => finding.code === 'multi-workspace-root-search-path'), true);
  assert.equal(parsed.findings.some(finding => finding.code === 'multi-workspace-root-search-path' && finding.severity === 'warn'), true);

  const strictError = runScriptFailure(privacyLintCli, [configPath, '--openclaw-config', openclawPath, '--strict', '--json']);
  const strictParsed = JSON.parse(strictError.stdout);
  assert.equal(strictParsed.ok, false);
  assert.equal(strictParsed.findings.some(finding => finding.code === 'multi-workspace-root-search-path' && finding.severity === 'error'), true);
});

test('sync smoke alerts only on stale and recovered transitions', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'mirror');
  const workspace = path.join(outDir, 'Work');
  const configPath = path.join(dir, 'config.json');
  const stateFile = path.join(dir, 'smoke-state.json');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ outDir, workspaceFolder: 'Work' }));
  fs.writeFileSync(path.join(workspace, '.notion-search-mirror.json'), JSON.stringify({
    generatedBy: 'notion-sync-to-search',
    pages: {},
    lastRun: {
      completedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      errors: 0,
    },
  }));

  const stale = runScriptFailure(syncSmokeCli, [configPath, '--state-file', stateFile, '--max-age-hours', '24', '--json']);
  const first = JSON.parse(stale.stdout);
  assert.equal(first.currentStatus, 'stale');
  assert.equal(first.transition, 'stale');
  assert.match(first.message, /Notion sync is stale/);

  const stillStale = runScriptFailure(syncSmokeCli, [configPath, '--state-file', stateFile, '--max-age-hours', '24', '--json']);
  const second = JSON.parse(stillStale.stdout);
  assert.equal(second.currentStatus, 'stale');
  assert.equal(second.transition, null);
  assert.equal(second.message, '');

  fs.writeFileSync(path.join(workspace, '.notion-search-mirror.json'), JSON.stringify({
    generatedBy: 'notion-sync-to-search',
    pages: {},
    lastRun: {
      completedAt: new Date().toISOString(),
      errors: 0,
      refreshed: 1,
      skipped: 2,
      pruned: 0,
    },
  }));
  const recovered = runScript(syncSmokeCli, [configPath, '--state-file', stateFile, '--max-age-hours', '24', '--json']);
  const third = JSON.parse(recovered);
  assert.equal(third.currentStatus, 'healthy');
  assert.equal(third.transition, 'recovered');
  assert.match(third.message, /has recovered/);
});

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

test('env file parser handles dotenv values without shell evaluation', () => {
  const parsed = _internal.parseEnvContent(`
# comment
export NOTION_API_KEY=ntn_test
OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway
QUOTED="line\\nvalue"
SINGLE='literal value'
INLINE=value # comment
`);

  assert.equal(parsed.NOTION_API_KEY, 'ntn_test');
  assert.equal(parsed.OPENCLAW_WINDOWS_TASK_NAME, 'OpenClaw Gateway');
  assert.equal(parsed.QUOTED, 'line\nvalue');
  assert.equal(parsed.SINGLE, 'literal value');
  assert.equal(parsed.INLINE, 'value');
});

test('env file loader fills missing env vars without overriding explicit environment', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'NOTION_API_KEY=from_file\nNOTION_API_KEY_ALT=alt_from_file\n');

  const previousKey = process.env.NOTION_API_KEY;
  const previousAlt = process.env.NOTION_API_KEY_ALT;
  test.after(() => {
    if (previousKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = previousKey;
    if (previousAlt === undefined) delete process.env.NOTION_API_KEY_ALT;
    else process.env.NOTION_API_KEY_ALT = previousAlt;
  });

  process.env.NOTION_API_KEY = 'explicit';
  delete process.env.NOTION_API_KEY_ALT;
  const result = _internal.loadEnvFile(envPath);

  assert.deepEqual(result.loaded, ['NOTION_API_KEY_ALT']);
  assert.deepEqual(result.skipped, ['NOTION_API_KEY']);
  assert.equal(process.env.NOTION_API_KEY, 'explicit');
  assert.equal(process.env.NOTION_API_KEY_ALT, 'alt_from_file');
});

test('env file loader tolerates missing env file', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = _internal.loadEnvFile(path.join(dir, '.env'));

  assert.equal(result.missing, true);
  assert.deepEqual(result.loaded, []);
  assert.deepEqual(result.skipped, []);
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

test('workspace outFolder aliases workspaceFolder', () => {
  const workspaces = _internal.workspaceConfigs({
    outDir: 'notion-sync-read-only',
    workspaces: [
      { name: 'Business', outFolder: 'Walden Business', tokenEnv: 'NOTION_API_KEY_WORK' },
    ],
  });
  assert.equal(workspaces.length, 1);
  assert.equal(_internal.configuredWorkspaceFolder(workspaces[0].config), 'Walden Business');
  assert.equal(workspaces[0].config.workspaceFolder, 'Walden Business');
});

test('multi-workspace output folders must be unique', async () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspaces = _internal.workspaceConfigs({
    outDir: path.join(dir, 'mirror'),
    workspaces: [
      { name: 'Business', workspaceFolder: 'Same', tokenEnv: 'NOTION_API_KEY_WORK' },
      { name: 'Personal', outFolder: 'Same', tokenEnv: 'NOTION_API_KEY_PERSONAL' },
    ],
  });

  await assert.rejects(
    () => _internal.assertUniqueWorkspaceOutputs(workspaces),
    /output folder collision/,
  );
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
    '--allow-legacy-per-agent-index',
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

  const result = openclawInternal.run(['--allow-legacy-per-agent-index', '--state-dir', state, '--json']);
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

  openclawInternal.run(['--allow-legacy-per-agent-index', '--state-dir', state, '--replace-notion-paths', '--json']);
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
  assert.match(plan.content, /--env-file/);
  assert.match(plan.content, /\.env/);
  assert.doesNotMatch(plan.content, /set -a/);
  if (process.platform === 'darwin') {
    assert.equal(plan.path, path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.openclaw.notion-sync-to-search.plist'));
    assert.match(plan.content, /StartInterval/);
    assert.match(plan.content, /2220/);
  } else {
    assert.equal(plan.path, path.join(os.homedir(), '.config', 'systemd', 'user', 'notion-sync-to-search.service'));
    assert.doesNotMatch(plan.content, /EnvironmentFile=-/);
    assert.match(plan.content, /WorkingDirectory=/);
  }
});

test('scheduler helper can generate smoke monitor plan', () => {
  const dir = tmpdir();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'config'), { recursive: true });
  fs.writeFileSync(path.join(state, 'config', 'notion-search-mirror.json'), JSON.stringify({
    outDir: path.join(state, 'notion-sync-read-only'),
    smoke: {
      intervalMinutes: 30,
      maxAgeHours: 24,
    },
  }));

  const ctx = require('../scripts/install-scheduler.js')._internal.buildContext({
    configPath: 'config/notion-search-mirror.json',
    configSetByCli: false,
    stateDir: state,
    everyMinutes: null,
    everySetByCli: false,
    name: 'notion-sync-to-search',
    nameSetByCli: false,
    envFile: null,
    logDir: null,
    systemdScope: 'system',
    mode: 'print',
    report: false,
    smoke: true,
    reportDays: 7,
  });

  assert.equal(ctx.name, 'notion-sync-to-search-smoke');
  assert.equal(ctx.everyMinutes, 30);
  assert.match(ctx.scriptPath, /sync-smoke\.js$/);
  assert.match(ctx.logPath, /notion-sync-to-search-smoke\.log$/);
  assert.equal(ctx.commandArgs.includes('--env-file'), false);
});

test('normal sync result output omits per-page refreshed noise unless verbose', () => {
  const lines = [];
  const originalLog = console.log;
  test.after(() => { console.log = originalLog; });
  console.log = line => lines.push(String(line));

  const results = {
    outDir: '/tmp/mirror',
    full: true,
    run: {
      seen: 10,
      refreshed: 8,
      skipped: 2,
      pruned: 1,
      errors: 0,
    },
    refreshed: Array.from({ length: 8 }, (_, index) => ({ title: `Page ${index}`, path: `Page ${index}.md` })),
    errors: [],
    pruned: [{ title: 'Old Page', path: 'Old Page.md' }],
  };

  _internal.logSyncResults(results, { verbose: false });
  assert.match(lines.join('\n'), /Refreshed: 8/);
  assert.doesNotMatch(lines.join('\n'), /- refreshed Page/);
  assert.doesNotMatch(lines.join('\n'), /- pruned Old Page/);

  lines.length = 0;
  _internal.logSyncResults(results, { verbose: true });
  assert.match(lines.join('\n'), /- refreshed Page 0/);
  assert.match(lines.join('\n'), /- pruned Old Page/);
});

test('multi-workspace sync result output includes per-workspace summaries', () => {
  const lines = [];
  const originalLog = console.log;
  test.after(() => { console.log = originalLog; });
  console.log = line => lines.push(String(line));

  _internal.logSyncResults({
    multiWorkspace: true,
    workspaces: [
      { name: 'Business', run: { seen: 2, refreshed: 1, skipped: 1, pruned: 0, errors: 0 } },
      { name: 'Personal', failed: true, error: 'No Notion API token found', run: { seen: 0, refreshed: 0, skipped: 0, pruned: 0, errors: 1, failed: true } },
    ],
    errors: [{ title: 'Personal', error: 'No Notion API token found' }],
    run: {
      seen: 2,
      refreshed: 1,
      skipped: 1,
      pruned: 0,
      errors: 1,
      failedWorkspaces: 1,
    },
  });

  const output = lines.join('\n');
  assert.match(output, /Workspace Business: seen=2 refreshed=1 skipped=1 pruned=0 errors=0/);
  assert.match(output, /Workspace Personal: seen=0 refreshed=0 skipped=0 pruned=0 errors=1 failed=yes/);
  assert.match(output, /Failed workspaces: 1/);
});
