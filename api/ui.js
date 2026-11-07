// lists the web app files with their sha1, so the encore app can pull a newer ui without a new release.
// the app compares these hashes with its own files and downloads only the ones that differ.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// bump when the ui starts needing encore app endpoints that older releases lack (backend/version.py UI_API)
const API = 2;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOP = ['index.html', 'sw.js', 'manifest.webmanifest'];

// every file under app/, as forward-slash paths
function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    if (d.name.startsWith(".")) return [];
    return d.isDirectory() ? walk(rel) : [rel];
  });
}

export async function GET() {
  const files = {};
  for (const rel of [...TOP, ...walk('app')]) {
    files[rel] = crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
  }
  return Response.json({ api: API, files }, { headers: { 'Cache-Control': 'no-store' } });
}
