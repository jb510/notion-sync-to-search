#!/usr/bin/env node
/**
 * Mirror a Notion page into local read-only markdown for search.
 *
 * The mirrored file is cache. Notion remains the source of truth.
 */

const fs = require('fs');
const path = require('path');
const {
  checkApiKey,
  notionRequest,
  normalizeId,
  getAllBlocks,
  blocksToMarkdown,
  stripTokenArg,
  hasJsonFlag,
  log,
  resolveSafePath,
  writeFileAtomic,
} = require('./notion-utils.js');

const DEFAULT_OUT_DIR = 'notion-sync-read-only';
const MANIFEST_FILE = '.notion-search-mirror.json';

function usage(exitCode = 0) {
  console.log('Usage: mirror-page.js <page-id> [--out-dir <dir>] [--path <relative-path>] [--json]');
  console.log('');
  console.log('Examples:');
  console.log('  mirror-page.js <notion-page-id>');
  console.log('  mirror-page.js <page-id> --out-dir "notion-sync-read-only"');
  console.log('  mirror-page.js <page-id> --path "05 Research Library/Topic.md"');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = stripTokenArg(argv);
  if (args.length < 1 || args[0] === '--help' || args[0] === '-h') usage(args[0] ? 0 : 1);

  const options = {
    pageId: args[0],
    outDir: DEFAULT_OUT_DIR,
    relativePath: null,
  };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--out-dir' && args[i + 1]) {
      options.outDir = args[++i];
    } else if (args[i] === '--path' && args[i + 1]) {
      options.relativePath = args[++i];
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  return options;
}

function slugifyTitle(title) {
  const cleaned = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'Untitled').slice(0, 120);
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function frontmatter(page, pageId, mirroredAt, part = null) {
  const parent = page.parent || {};
  const lines = [
    '---',
    'source: notion',
    'mirror_mode: read_only',
    `notion_object: ${yamlString(page.object || 'page')}`,
    `notion_page_id: ${yamlString(pageId)}`,
    `notion_url: ${yamlString(page.url || '')}`,
    `notion_last_edited_time: ${yamlString(page.last_edited_time || '')}`,
    `notion_archived: ${page.archived ? 'true' : 'false'}`,
    `notion_parent_type: ${yamlString(parent.type || '')}`,
    `notion_parent_id: ${yamlString(parent[parent.type] || '')}`,
    `mirrored_at: ${yamlString(mirroredAt)}`,
  ];
  if (part) {
    lines.push(`notion_mirror_part: ${part.partNumber}`);
    lines.push(`notion_mirror_part_count: ${part.partCount}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function getTitle(page) {
  for (const property of Object.values(page.properties || {})) {
    if (property?.type === 'title') {
      const title = property.title?.map(part => part.plain_text || '').join('').trim();
      if (title) return title;
    }
  }
  return 'Untitled';
}

async function getPage(pageId) {
  const id = normalizeId(pageId);
  return notionRequest(`/v1/pages/${encodeURIComponent(id)}`, 'GET');
}

function assertRelativePath(relativePath) {
  if (!relativePath) return;
  const normalized = path.normalize(relativePath);
  if (path.isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new Error(`--path must stay inside the mirror folder: ${relativePath}`);
  }
  if (/[\x00-\x1f]/.test(relativePath)) {
    throw new Error(`--path must not contain control characters: ${relativePath}`);
  }
  if (path.basename(normalized) === MANIFEST_FILE) {
    throw new Error(`--path must not target reserved mirror metadata file: ${MANIFEST_FILE}`);
  }
}

function isInside(baseDir, candidatePath) {
  const relative = path.relative(baseDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function manifestPath(outDir) {
  return path.join(outDir, MANIFEST_FILE);
}

function loadManifest(outDir) {
  const manifestPath = path.join(outDir, MANIFEST_FILE);
  let manifest = { generatedBy: 'notion-sync-to-search', pages: {} };

  if (fs.existsSync(manifestPath)) {
    if (fs.lstatSync(manifestPath).isSymbolicLink()) {
      throw new Error(`Refusing to read or write symlinked manifest: ${manifestPath}`);
    }
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      const badPath = `${manifestPath}.bad-${Date.now()}`;
      fs.renameSync(manifestPath, badPath);
      manifest = { generatedBy: 'notion-sync-to-search', pages: {} };
      manifest.recoveredFromCorruptManifest = {
        path: path.relative(process.cwd(), badPath),
        error: error.message,
        recoveredAt: new Date().toISOString(),
      };
    }
  }

  manifest.generatedBy = 'notion-sync-to-search';
  manifest.pages = manifest.pages || {};
  return manifest;
}

function saveManifest(outDir, manifest) {
  manifest.generatedBy = 'notion-sync-to-search';
  manifest.updatedAt = new Date().toISOString();
  manifest.pages = manifest.pages || {};
  writeRegularFile(manifestPath(outDir), JSON.stringify(manifest, null, 2) + '\n');
}

function updateManifest(manifest, entry) {
  manifest.generatedBy = 'notion-sync-to-search';
  manifest.pages = manifest.pages || {};
  manifest.pages[entry.pageId] = entry;
  return manifest;
}

function writeRegularFile(filePath, body) {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to write through symlink: ${filePath}`);
  }
  writeFileAtomic(filePath, body);
}

function entryOutputPaths(entry) {
  const paths = [];
  if (entry?.path) paths.push(entry.path);
  for (const file of entry?.files || []) {
    if (file?.path) paths.push(file.path);
  }
  return [...new Set(paths)];
}

function partRelativePath(relativePath, partNumber) {
  if (partNumber === 1) return relativePath;
  const parsed = path.parse(relativePath);
  const suffix = `.part-${String(partNumber).padStart(3, '0')}`;
  return path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext || '.md'}`);
}

function chunkBlocks(blocks, maxBlocksPerOutputFile) {
  const chunkSize = Math.max(1, maxBlocksPerOutputFile || blocks.length || 1);
  const chunks = [];
  for (let index = 0; index < blocks.length; index += chunkSize) {
    chunks.push(blocks.slice(index, index + chunkSize));
  }
  return chunks.length ? chunks : [[]];
}

function removeOldGeneratedFiles(outDir, previousEntry, nextOutputPaths) {
  const removed = [];
  const next = new Set(nextOutputPaths);
  for (const oldEntryPath of entryOutputPaths(previousEntry)) {
    const oldPath = resolveSafePath(oldEntryPath, { mode: 'write' });
    if (next.has(oldPath)) continue;
    if (!isInside(outDir, oldPath)) {
      throw new Error(`Refusing to remove previous mirror file outside mirror folder: ${oldEntryPath}`);
    }
    if (!fs.existsSync(oldPath)) continue;

    const stat = fs.lstatSync(oldPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to remove symlinked previous mirror file: ${oldEntryPath}`);
    }
    if (!stat.isFile()) continue;

    fs.unlinkSync(oldPath);
    removed.push(path.relative(process.cwd(), oldPath));
  }
  return removed;
}

async function mirrorPage(options) {
  const pageId = normalizeId(options.pageId);
  const outDir = resolveSafePath(options.outDir, { mode: 'write' });

  fs.mkdirSync(outDir, { recursive: true });

  const page = options.page || await getPage(pageId);
  const title = getTitle(page);
  const relativePath = options.relativePath || `${slugifyTitle(title)}.md`;
  assertRelativePath(relativePath);

  const outputPath = resolveSafePath(path.join(outDir, relativePath), { mode: 'write' });
  if (!isInside(outDir, outputPath)) {
    throw new Error(`Resolved output path escaped mirror folder: ${relativePath}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const blocks = await getAllBlocks(pageId, {
    maxBlocks: options.limits?.maxBlocksPerPage,
    deadlineMs: options.limits?.maxSecondsPerPage
      ? Date.now() + options.limits.maxSecondsPerPage * 1000
      : null,
  });
  const markdown = blocksToMarkdown(blocks);
  const maxBytes = options.limits?.maxMarkdownBytesPerPage;
  if (maxBytes && Buffer.byteLength(markdown, 'utf8') > maxBytes) {
    throw new Error(`Markdown limit exceeded for ${pageId}; maxMarkdownBytesPerPage=${maxBytes}`);
  }
  const mirroredAt = new Date().toISOString();
  const blockChunks = chunkBlocks(blocks, options.limits?.maxBlocksPerOutputFile);
  const partCount = blockChunks.length;
  const files = [];
  const outputPaths = [];

  for (let index = 0; index < blockChunks.length; index++) {
    const partNumber = index + 1;
    const chunkRelativePath = partRelativePath(relativePath, partNumber);
    assertRelativePath(chunkRelativePath);
    const chunkOutputPath = resolveSafePath(path.join(outDir, chunkRelativePath), { mode: 'write' });
    if (!isInside(outDir, chunkOutputPath)) {
      throw new Error(`Resolved output path escaped mirror folder: ${chunkRelativePath}`);
    }
    fs.mkdirSync(path.dirname(chunkOutputPath), { recursive: true });
    const chunkMarkdown = blocksToMarkdown(blockChunks[index]).trim();
    const part = partCount > 1 ? { partNumber, partCount } : null;
    const heading = part ? `# ${title} (part ${partNumber} of ${partCount})` : `# ${title}`;
    const body = `${frontmatter(page, pageId, mirroredAt, part)}${heading}\n\n${chunkMarkdown}\n`;
    writeRegularFile(chunkOutputPath, body);
    outputPaths.push(chunkOutputPath);
    files.push({
      partNumber,
      partCount,
      relativePath: chunkRelativePath,
      path: path.relative(process.cwd(), chunkOutputPath),
      blockCount: blockChunks[index].length,
    });
  }

  const removedPreviousPaths = removeOldGeneratedFiles(outDir, options.previousEntry, outputPaths);

  const entry = {
    ...(options.previousEntry || {}),
    pageId,
    title,
    url: page.url || '',
    notionLastEditedTime: page.last_edited_time || '',
    mirroredAt,
    lastSeenAt: options.lastSeenAt || mirroredAt,
    lastCheckedAt: options.lastCheckedAt || mirroredAt,
    syncStatus: 'refreshed',
    relativePath,
    path: files[0]?.path || path.relative(process.cwd(), outputPath),
    files,
    partCount,
    blockCount: blocks.length,
  };
  delete entry.error;
  delete entry.errorName;
  delete entry.failedAt;
  if (removedPreviousPaths.length) {
    entry.previousPath = removedPreviousPaths[0];
    entry.previousPaths = removedPreviousPaths;
    entry.previousPathRemovedAt = mirroredAt;
  }

  const manifest = options.manifest || loadManifest(outDir);
  updateManifest(manifest, entry);
  if (options.saveManifest !== false) saveManifest(outDir, manifest);

  return entry;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await mirrorPage(options);
    if (hasJsonFlag()) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      log(`Mirrored Notion page: ${result.title}`);
      log(`  Page: ${result.pageId}`);
      log(`  File: ${result.path}`);
      log('  Mode: read-only cache; edit Notion directly');
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
  module.exports = {
    mirrorPage,
    DEFAULT_OUT_DIR,
    MANIFEST_FILE,
    assertRelativePath,
    getPage,
    getTitle,
    isInside,
    loadManifest,
    saveManifest,
    writeRegularFile,
    entryOutputPaths,
    partRelativePath,
    chunkBlocks,
  };
}
