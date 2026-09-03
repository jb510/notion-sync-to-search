#!/usr/bin/env python3
import argparse, hashlib, json, os, sqlite3
from array import array
from pathlib import Path

def connect(index_path):
    target = Path(index_path); target.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(target); db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA foreign_keys=ON')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, title TEXT NOT NULL, notion_url TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (file_path TEXT NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(file_path, chunk_index), FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    '''); return db

def embedder(model, cache_dir):
    from fastembed import TextEmbedding
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    return TextEmbedding(model_name=model, cache_dir=cache_dir, threads=max(1, min(os.cpu_count() or 2, 8)))

def frontmatter(text):
    data = {}
    if not text.startswith('---\n'): return data
    end = text.find('\n---\n', 4)
    if end < 0: return data
    for line in text[4:end].splitlines():
        if ':' in line:
            key, value = line.split(':', 1); data[key.strip()] = value.strip().strip('"\'')
    return data

def chunk_text(text, size, overlap, max_chars):
    body = text
    if text.startswith('---\n'):
        end = text.find('\n---\n', 4)
        if end >= 0: body = text[end + 5:]
    body = '\n'.join(line.rstrip() for line in body.splitlines()).strip()[:max_chars]
    if not body: return []
    output, start = [], 0
    while start < len(body):
        end = min(len(body), start + size)
        if end < len(body):
            split = max(body.rfind('\n\n', start, end), body.rfind('\n', start, end), body.rfind(' ', start, end))
            if split > start + size // 2: end = split
        part = body[start:end].strip()
        if part: output.append(part)
        if end >= len(body): break
        start = max(start + 1, end - overlap)
    return output

def vector_blob(vector): return array('f', (float(v) for v in vector)).tobytes()
def blob_vector(blob):
    values = array('f'); values.frombytes(blob); return values

def index_command(args):
    db = connect(args.index); model = embedder(args.model, args.cache_dir)
    paths = sorted(str(p.resolve()) for p in Path(args.mirror).rglob('*.md') if '.fastembed' not in p.parts)
    existing = {row[0]: row[1] for row in db.execute('SELECT path,content_hash FROM files')}; changed = []
    for filename in paths:
        raw = Path(filename).read_bytes(); digest = hashlib.sha256(raw).hexdigest()
        if existing.get(filename) != digest: changed.append((filename, digest, raw.decode('utf-8', errors='replace')))
    removed = sorted(set(existing) - set(paths)); embedded = 0
    prepared, all_parts = [], []
    for filename, digest, text in changed:
        meta = frontmatter(text); title = meta.get('title') or Path(filename).stem
        parts = [f'Title: {title}\n{part}' for part in chunk_text(text, args.chunk_chars, args.chunk_overlap, args.max_chars_per_file)]
        prepared.append((filename, digest, title, meta.get('notion_url'), parts))
        all_parts.extend(parts)
    all_vectors = list(model.passage_embed(all_parts, batch_size=args.batch_size)) if all_parts else []
    offset = 0
    with db:
        for filename in removed: db.execute('DELETE FROM files WHERE path=?', (filename,))
        for filename, digest, title, notion_url, parts in prepared:
            vectors = all_vectors[offset:offset + len(parts)]; offset += len(parts)
            db.execute('DELETE FROM files WHERE path=?', (filename,))
            db.execute('INSERT INTO files(path,content_hash,title,notion_url,updated_at) VALUES(?,?,?,?,datetime("now"))', (filename,digest,title,notion_url))
            db.executemany('INSERT INTO chunks(file_path,chunk_index,text,vector) VALUES(?,?,?,?)', ((filename,i,part,vector_blob(vector)) for i,(part,vector) in enumerate(zip(parts,vectors))))
            embedded += len(parts)
        db.execute('INSERT OR REPLACE INTO metadata(key,value) VALUES("model",?)', (args.model,)); db.execute('INSERT OR REPLACE INTO metadata(key,value) VALUES("updated_at",datetime("now"))')
    print(json.dumps({'changedFiles':len(changed),'removedFiles':len(removed),'embeddedChunks':embedded,'totalFiles':db.execute('SELECT COUNT(*) FROM files').fetchone()[0],'totalChunks':db.execute('SELECT COUNT(*) FROM chunks').fetchone()[0],'model':args.model}))

def search_command(args):
    db = connect(args.index); stored = db.execute('SELECT value FROM metadata WHERE key="model"').fetchone()
    if stored and stored[0] != args.model: raise SystemExit(f'index model is {stored[0]}, requested {args.model}')
    query = list(embedder(args.model, args.cache_dir).query_embed([args.query]))[0]; best = {}
    rows = db.execute('SELECT f.path,f.title,f.notion_url,c.chunk_index,c.text,c.vector FROM chunks c JOIN files f ON f.path=c.file_path')
    for file_path,title,notion_url,chunk_index,text,blob in rows:
        score = sum(float(a)*float(b) for a,b in zip(query,blob_vector(blob)))
        if file_path not in best or score > best[file_path]['score']:
            best[file_path] = {'file':file_path,'title':title,'notion_url':notion_url,'score':score,'line':1,'snippet':text[:700],'chunk':chunk_index}
    print(json.dumps(sorted(best.values(),key=lambda item:item['score'],reverse=True)[:max(1,min(args.limit,80))],ensure_ascii=False))

def status_command(args):
    db = connect(args.index); stored = db.execute('SELECT value FROM metadata WHERE key="model"').fetchone()
    print(json.dumps({'ready':True,'files':db.execute('SELECT COUNT(*) FROM files').fetchone()[0],'chunks':db.execute('SELECT COUNT(*) FROM chunks').fetchone()[0],'model':stored[0] if stored else args.model,'index':str(Path(args.index).resolve())}))

def make_parser():
    root=argparse.ArgumentParser(); subs=root.add_subparsers(dest='command',required=True)
    for name in ('index','search','status'):
        sub=subs.add_parser(name); sub.add_argument('--index',required=True); sub.add_argument('--model',default='BAAI/bge-small-en-v1.5'); sub.add_argument('--cache-dir',required=True)
        if name=='index': sub.add_argument('--mirror',required=True); sub.add_argument('--chunk-chars',type=int,default=1800); sub.add_argument('--chunk-overlap',type=int,default=200); sub.add_argument('--max-chars-per-file',type=int,default=12000); sub.add_argument('--batch-size',type=int,default=64)
        elif name=='search': sub.add_argument('--query',required=True); sub.add_argument('--limit',type=int,default=20)
    return root

if __name__=='__main__':
    args=make_parser().parse_args(); {'index':index_command,'search':search_command,'status':status_command}[args.command](args)
