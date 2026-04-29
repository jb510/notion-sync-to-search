/**
 * Shared utilities for Notion API scripts
 * Common functions for HTTP requests, error handling, and data extraction
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOTION_VERSION = process.env.NOTION_VERSION || '2026-03-11';
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_MIN_INTERVAL_MS = 350;
const MAX_REQUEST_BODY_BYTES = 500 * 1024;
const MAX_RATE_LIMIT_RETRIES = 5;

// Cached token (resolved once per process)
let _cachedToken = undefined;
let _lastRequestAt = 0;

/**
 * Resolve the Notion API token from NOTION_API_KEY only.
 */
function resolveToken() {
  if (_cachedToken !== undefined) return _cachedToken;
  if (process.env.NOTION_API_KEY) {
    _cachedToken = process.env.NOTION_API_KEY;
    return _cachedToken;
  }

  _cachedToken = null;
  return null;
}

/**
 * Expand a path that starts with ~ to the user's home directory
 */
function expandHomePath(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

/**
 * Normalize network-level request errors into user-friendly guidance
 */
function wrapNetworkError(err) {
  const networkCodes = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);
  if (networkCodes.has(err.code)) {
    return new Error('Could not reach Notion API. Check your internet connection.');
  }
  return new Error(`Could not reach Notion API. ${err.message}`);
}

/**
 * Get the Notion API key (resolves from all supported sources)
 */
function getApiKey() {
  return resolveToken();
}

/**
 * Check if a Notion API token was provided, exit with helpful message if not
 */
function checkApiKey() {
  // Allow usage/help output without requiring credentials.
  if (hasHelpFlag()) return;

  if (!getApiKey()) {
    const message = 'No Notion API token found. Set NOTION_API_KEY in the environment.';
    if (hasJsonFlag()) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error('Error: No Notion API token provided');
      console.error('');
      console.error(message);
      console.error('');
      console.error('Usage:');
      console.error('  NOTION_API_KEY=ntn_... node scripts/<script>.js [args]');
      console.error('');
      console.error('Credentials are read from the environment only and are never accepted as positional arguments.');
      console.error('Create an integration at https://www.notion.so/my-integrations');
    }
    process.exit(1);
  }
}

/**
 * Strip token-related flags from an args array so scripts don't parse them as their own args
 */
function hasJsonFlag() {
  return process.argv.includes('--json');
}

function hasHelpFlag() {
  return process.argv.includes('--help') || process.argv.includes('-h');
}

function log(msg) {
  if (!hasJsonFlag()) console.error(msg);
}

function isPathInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNoSymlinkAncestors(baseDir, targetPath) {
  const baseReal = fs.realpathSync(baseDir);
  const absolute = path.resolve(targetPath);
  const relative = path.relative(baseReal, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return;

  const parts = relative.split(path.sep).filter(Boolean);
  let current = baseReal;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to traverse symlinked path component: ${current}`);
    }
  }
}

function resolveSafePath(inputPath, options = {}) {
  const { mode = 'read' } = options;

  if (!inputPath) {
    throw new Error('Path is required');
  }

  const expanded = expandHomePath(inputPath);
  const absolute = path.resolve(expanded);

  let candidatePath = absolute;

  if (fs.existsSync(absolute)) {
    try {
      candidatePath = fs.realpathSync(absolute);
    } catch (_) {
      candidatePath = absolute;
    }
  } else if (mode === 'write') {
    const parentDir = path.dirname(absolute);
    if (fs.existsSync(parentDir)) {
      try {
        candidatePath = path.join(fs.realpathSync(parentDir), path.basename(absolute));
      } catch (_) {
        candidatePath = absolute;
      }
    }
  }

  const workspaceRoot = fs.realpathSync(process.cwd());
  assertNoSymlinkAncestors(workspaceRoot, absolute);
  if (!isPathInside(workspaceRoot, candidatePath)) {
    const action = mode === 'write' ? 'write to' : 'read from';
    throw new Error(
      `Refusing to ${action} path outside current workspace: ${inputPath}.`
    );
  }

  return candidatePath;
}

function writeFileAtomic(filePath, body) {
  const requestedPath = path.resolve(expandHomePath(filePath));
  if (fs.existsSync(requestedPath) && fs.lstatSync(requestedPath).isSymbolicLink()) {
    throw new Error(`Refusing to write through symlink: ${requestedPath}`);
  }

  const absolute = resolveSafePath(filePath, { mode: 'write' });
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`Refusing to write through symlink: ${absolute}`);
  }

  const dir = path.dirname(absolute);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, absolute);
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (_) {
    // Some platforms/filesystems do not support fsync on directories.
  }
}

function stripTokenArg(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      // skip flag only (no value)
    } else {
      result.push(args[i]);
    }
  }
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForRequestSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, _lastRequestAt + REQUEST_MIN_INTERVAL_MS - now);
  if (waitMs > 0) await sleep(waitMs);
  _lastRequestAt = Date.now();
}

/**
 * Make a Notion API request with proper error handling, conservative
 * client-side throttling, and Retry-After handling for 429 responses.
 */
async function notionRequest(path, method, data = null, attempt = 0) {
  await waitForRequestSlot();
  try {
    return await notionRequestOnce(path, method, data);
  } catch (error) {
    if (error.statusCode === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      await sleep(error.retryAfterMs || 1000);
      return notionRequest(path, method, data, attempt + 1);
    }
    throw error;
  }
}

function notionRequestOnce(path, method, data = null) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return Promise.reject(new Error('No Notion API token found. Set NOTION_API_KEY in the environment.'));
  }

  return new Promise((resolve, reject) => {
    const requestData = data ? JSON.stringify(data) : null;
    if (requestData && Buffer.byteLength(requestData) > MAX_REQUEST_BODY_BYTES) {
      reject(new Error('Notion API request body exceeds the 500KB payload limit.'));
      return;
    }

    const options = {
      hostname: 'api.notion.com',
      port: 443,
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      }
    };

    if (requestData) {
      options.headers['Content-Length'] = Buffer.byteLength(requestData);
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve(body);
          }
        } else {
          reject(createDetailedError(res.statusCode, body, res.headers));
        }
      });
    });

    req.on('error', (err) => {
      reject(wrapNetworkError(err));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Notion API request timed out.'));
    });
    if (requestData) {
      req.write(requestData);
    }
    req.end();
  });
}

/**
 * Create detailed error message based on status code and response
 */
function createDetailedError(statusCode, body, headers = {}) {
  let error;
  try {
    error = JSON.parse(body);
  } catch (e) {
    const plainError = new Error(`API error (${statusCode}): ${body}`);
    plainError.statusCode = statusCode;
    return plainError;
  }

  const errorCode = error.code;
  const errorMessage = error.message;
  let result;

  switch (statusCode) {
    case 400:
      if (errorCode === 'validation_error') {
        result = new Error(`Validation error: ${errorMessage}. Check your input data.`);
        break;
      }
      result = new Error(`Bad request: ${errorMessage}`);
      break;

    case 401:
      result = new Error('Authentication failed. Check that your token is valid and has access to this resource.');
      break;

    case 404:
      if (errorCode === 'object_not_found') {
        result = new Error('Page/database not found. Verify the ID and that your integration has access.');
        break;
      }
      result = new Error(`Not found: ${errorMessage}`);
      break;

    case 429:
      result = new Error('Rate limit exceeded. Retried after Notion Retry-After guidance.');
      result.retryAfterMs = Math.max(1, Number.parseInt(headers['retry-after'] || '1', 10)) * 1000;
      break;

    case 500:
    case 503:
      result = new Error(`Notion server error (${statusCode}). Try again later.`);
      break;

    default:
      result = new Error(`API error (${statusCode}): ${errorMessage || body}`);
      break;
  }

  result.statusCode = statusCode;
  result.notionCode = errorCode;
  return result;
}

// --- ID Utilities ---

/**
 * Normalize a Notion page/block ID to UUID format with hyphens
 */
function normalizeId(id) {
  const clean = id.replace(/-/g, '');
  if (clean.length === 32) {
    return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
  }
  return id;
}

// --- Property Utilities ---

/**
 * Extract title from a page or database object
 */
function extractTitle(item) {
  if (item.object === 'page') {
    const titleProp = Object.values(item.properties || {}).find(p => p.type === 'title');
    if (titleProp && titleProp.title && titleProp.title.length > 0) {
      return titleProp.title.map(t => t.plain_text).join('');
    }
  } else if (item.object === 'database' || item.object === 'data_source') {
    if (item.title && item.title.length > 0) {
      return item.title.map(t => t.plain_text).join('');
    }
  }
  return '(Untitled)';
}

/**
 * Extract value from a property based on its type
 */
function extractPropertyValue(property) {
  switch (property.type) {
    case 'title':
      return property.title.map(t => t.plain_text).join('');
    case 'rich_text':
      return property.rich_text.map(t => t.plain_text).join('');
    case 'number':
      return property.number;
    case 'select':
      return property.select?.name || null;
    case 'multi_select':
      return property.multi_select.map(s => s.name);
    case 'date':
      return property.date ? { start: property.date.start, end: property.date.end } : null;
    case 'checkbox':
      return property.checkbox;
    case 'url':
      return property.url;
    case 'email':
      return property.email;
    case 'phone_number':
      return property.phone_number;
    case 'relation':
      return property.relation.map(r => r.id);
    case 'created_time':
      return property.created_time;
    case 'last_edited_time':
      return property.last_edited_time;
    default:
      return property[property.type];
  }
}

// --- Block to Markdown ---

/**
 * Extract plain text from rich_text array
 */
function richTextToPlain(richText) {
  if (!richText || richText.length === 0) return '';
  return richText.map(rt => rt.plain_text || '').join('');
}

/**
 * Extract markdown-formatted text from rich_text array
 */
function richTextToMarkdown(richText) {
  if (!richText || richText.length === 0) return '';

  return richText.map(rt => {
    let text = rt.plain_text || '';
    const ann = rt.annotations || {};

    if (ann.code) text = `\`${text}\``;
    if (ann.bold) text = `**${text}**`;
    if (ann.italic) text = `*${text}*`;
    if (ann.strikethrough) text = `~~${text}~~`;

    if (rt.href) {
      text = `[${text}](${rt.href})`;
    } else if (rt.text && rt.text.link) {
      text = `[${text}](${rt.text.link.url})`;
    }

    return text;
  }).join('');
}

/**
 * Convert Notion blocks to markdown string
 */
function blocksToMarkdown(blocks) {
  const lines = [];

  for (const block of blocks) {
    const type = block.type;
    const content = block[type];

    switch (type) {
      case 'heading_1':
        lines.push(`# ${richTextToMarkdown(content.rich_text)}`, '');
        break;
      case 'heading_2':
        lines.push(`## ${richTextToMarkdown(content.rich_text)}`, '');
        break;
      case 'heading_3':
        lines.push(`### ${richTextToMarkdown(content.rich_text)}`, '');
        break;
      case 'paragraph': {
        const text = richTextToMarkdown(content.rich_text);
        if (text.trim()) lines.push(text, '');
        break;
      }
      case 'bulleted_list_item':
        lines.push(`- ${richTextToMarkdown(content.rich_text)}`);
        break;
      case 'numbered_list_item':
        lines.push(`1. ${richTextToMarkdown(content.rich_text)}`);
        break;
      case 'to_do': {
        const checked = content.checked ? 'x' : ' ';
        lines.push(`- [${checked}] ${richTextToMarkdown(content.rich_text)}`);
        break;
      }
      case 'toggle':
        lines.push(`- ${richTextToMarkdown(content.rich_text)}`, '');
        break;
      case 'code': {
        const code = richTextToPlain(content.rich_text);
        const lang = content.language || 'plain text';
        lines.push(`\`\`\`${lang}`, code, '```', '');
        break;
      }
      case 'divider':
        lines.push('---', '');
        break;
      case 'quote':
        lines.push(`> ${richTextToMarkdown(content.rich_text)}`, '');
        break;
      case 'callout': {
        const marker = content.icon?.emoji || '[Callout]';
        lines.push(`${marker} ${richTextToMarkdown(content.rich_text)}`, '');
        break;
      }
      case 'child_page':
        lines.push(`## ${content.title || 'Untitled child page'}`, '');
        break;
      case 'child_database':
        lines.push(`## ${content.title || 'Untitled child database'}`, '');
        break;
      case 'bookmark':
      case 'embed':
      case 'link_preview':
        if (content.url) lines.push(content.url, '');
        break;
      case 'image':
      case 'file':
      case 'pdf':
      case 'video': {
        const caption = richTextToMarkdown(content.caption || []);
        const url = content.external?.url || '';
        if (caption || url) lines.push([caption, url].filter(Boolean).join(' '), '');
        break;
      }
      case 'table_row': {
        const cells = content.cells || [];
        lines.push(`| ${cells.map(cell => richTextToMarkdown(cell)).join(' | ')} |`);
        break;
      }
      default:
        break;
    }
  }

  return lines.join('\n');
}

// --- Notion Page Helpers ---

/**
 * Fetch all blocks from a page/block, handling pagination
 */
async function getAllBlocks(blockId) {
  const normalizedId = normalizeId(blockId);
  let allBlocks = [];
  let cursor = null;

  do {
    const encodedId = encodeURIComponent(normalizedId);
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('start_cursor', cursor);
    const path = `/v1/blocks/${encodedId}/children?${params.toString()}`;
    const response = await notionRequest(path, 'GET');

    for (const block of response.results) {
      allBlocks.push(block);
      if (block.has_children) {
        const childBlocks = await getAllBlocks(block.id);
        allBlocks = allBlocks.concat(childBlocks);
      }
    }

    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return allBlocks;
}

module.exports = {
  // Config
  NOTION_VERSION,
  getApiKey,
  resolveToken,
  checkApiKey,
  stripTokenArg,
  hasJsonFlag,
  hasHelpFlag,
  log,
  resolveSafePath,
  writeFileAtomic,
  expandHomePath,
  wrapNetworkError,

  // HTTP
  notionRequest,
  createDetailedError,

  // IDs
  normalizeId,

  // Properties
  extractTitle,
  extractPropertyValue,

  // Rich text
  richTextToPlain,
  richTextToMarkdown,

  // Markdown conversion
  blocksToMarkdown,

  // Page helpers
  getAllBlocks,

  // Testing
  _resetTokenCache: () => { _cachedToken = undefined; },
  _resetRateLimitState: () => { _lastRequestAt = 0; },
};
