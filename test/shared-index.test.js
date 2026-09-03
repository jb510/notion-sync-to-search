const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shared = require('../scripts/shared-index.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-shared-index-'));
  const mirror = path.join(dir, 'mirror');
  fs.mkdirSync(mirror);
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    outDir: mirror,
    searchIndex: {
      provider: 'qmd',
      indexName: 'openclaw-test-notion',
      collectionName: 'notion-mirror',
      mcpServerName: 'notion-search',
      noRerank: true,
    },
  }));
  return { dir, mirror, config };
}

test('resolves an install-scoped named index', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const settings = shared.resolveSettings(f.config);
  assert.equal(settings.indexName, 'openclaw-test-notion');
  assert.equal(settings.collectionName, 'notion-mirror');
  assert.equal(settings.mirrorPath, f.mirror);
});

test('search is bounded, collection-scoped, and avoids reranking', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const settings = shared.resolveSettings(f.config);
  const args = shared.buildSearchArgs(settings, 'retreat planning', 500);
  assert.deepEqual(args.slice(0, 2), ['query', 'lex: retreat planning\nvec: retreat planning']);
  assert.equal(args[args.indexOf('--collection') + 1], 'notion-mirror');
  assert.equal(args[args.indexOf('-n') + 1], '20');
  assert.ok(args.includes('--no-rerank'));
});

test('non-embedding indexes use deterministic BM25 search', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const settings = shared.resolveSettings(f.config, { embed: false });
  const args = shared.buildSearchArgs(settings, 'retreat planning', 500);
  assert.deepEqual(args.slice(0, 2), ['search', 'retreat planning']);
  assert.equal(args[args.indexOf('--collection') + 1], 'notion-mirror');
  assert.equal(args[args.indexOf('-n') + 1], '20');
  assert.ok(!args.includes('--no-rerank'));
});

test('FastEmbed semantic fallback resolves install-scoped paths', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(f.config));
  config.searchIndex.embed = false;
  config.searchIndex.semantic = { enabled: true, provider: 'fastembed', weight: 0.7 };
  fs.writeFileSync(f.config, JSON.stringify(config));
  const settings = shared.resolveSettings(f.config);
  assert.equal(settings.semantic.enabled, true);
  assert.equal(settings.semantic.model, 'BAAI/bge-small-en-v1.5');
  assert.equal(settings.semantic.weight, 0.7);
  assert.ok(settings.semantic.indexPath.startsWith(f.mirror));
});

test('hybrid fusion preserves BM25 and semantic provenance', () => {
  const bm25 = [{ file: 'qmd://notion-mirror/A.md?index=x', title: 'A', score: 0.9 }];
  const semantic = [{ file: '/mirror/B.md', title: 'B', score: 0.95 }, { file: '/mirror/A.md', title: 'A', score: 0.8 }];
  const merged = shared.mergeHybridResults(bm25, semantic, 5, 0.8);
  assert.equal(merged[0].title, 'A');
  assert.deepEqual(merged[0].sources, ['bm25', 'fastembed']);
  assert.equal(merged[1].title, 'B');
});

test('hybrid fusion deduplicates differently formatted mirror filenames by page id', () => {
  const bm25 = [{ file: 'qmd://notion-mirror/Eating-Fish-2ebf4ee5.md?index=x', title: 'Fish', score: 0.9 }];
  const semantic = [{ file: '/mirror/Eating Fish - 2ebf4ee5.md', title: 'Fish', score: 0.8 }];
  const merged = shared.mergeHybridResults(bm25, semantic, 5, 0.8);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, ['bm25', 'fastembed']);
});

test('MCP server is pinned to the same named index', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const settings = shared.resolveSettings(f.config);
  const spec = shared.buildMcpSpec(settings);
  assert.deepEqual(spec.args, ['--index', 'openclaw-test-notion', 'mcp']);
  assert.deepEqual(spec.toolFilter.include, ['query', 'get', 'multi_get', 'status']);
});

test('non-embedding MCP exposes BM25 search instead of hybrid query', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const settings = shared.resolveSettings(f.config, { embed: false });
  const spec = shared.buildMcpSpec(settings);
  assert.deepEqual(spec.toolFilter.include, ['search', 'get', 'multi_get', 'status']);
});

test('unsafe or missing index names are rejected', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(f.config));
  config.searchIndex.indexName = '../shared';
  fs.writeFileSync(f.config, JSON.stringify(config));
  assert.throws(() => shared.resolveSettings(f.config), /indexName/);
});
