import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.resolve(rootDir, 'dist/chrome-mv3');
const cachePath = path.resolve(rootDir, '.gdrive-sync-cache.json');

// Default to the project's connected agentCast Google Drive folder ID
const ROOT_FOLDER_ID = process.env.AGENTCAST_GDRIVE_FOLDER_ID || '13GYShwk_2RgoA62j2cApLRTBfLruGMhJ';
const TARGET_SUBFOLDER_NAME = 'extension-unpacked';

function runGdrive(args) {
  const out = execFileSync('gdrive', args, { encoding: 'utf8' });
  return out.trim();
}

function listFolderJson(folderId) {
  const out = runGdrive(['readonly', 'ls', folderId, '--json']);
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : parsed.files || parsed.items || [];
}

function ensureSubfolder(parentId, folderName) {
  const items = listFolderJson(parentId);
  const existing = items.find(
    (item) =>
      item.name === folderName &&
      (item.mimeType === 'application/vnd.google-apps.folder' || item.type === 'folder')
  );
  if (existing?.id) {
    return existing.id;
  }
  const createdRaw = runGdrive(['mutate', 'mkdir', folderName, '--parent', parentId, '--json']);
  try {
    const created = JSON.parse(createdRaw);
    if (created?.id) return created.id;
  } catch {
    // Fallback lookup
  }
  const refreshed = listFolderJson(parentId);
  const found = refreshed.find((item) => item.name === folderName);
  if (!found?.id) {
    throw new Error(`Failed to create or locate Drive folder "${folderName}" under ${parentId}`);
  }
  return found.id;
}

function collectFilesRel(dir, prefix = '') {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRel(abs, rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function loadCache() {
  if (!fs.existsSync(cachePath)) {
    return { folders: {}, files: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return { folders: {}, files: {} };
  }
}

function saveCache(cache) {
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

if (!fs.existsSync(distDir)) {
  throw new Error(`dist/chrome-mv3 does not exist. Run "pnpm build" first.`);
}

console.log(`[sync-gdrive] Syncing dist/chrome-mv3 -> Google Drive (agentCast/${TARGET_SUBFOLDER_NAME}/)...`);
const cache = loadCache();
const unpackedRootId = ensureSubfolder(ROOT_FOLDER_ID, TARGET_SUBFOLDER_NAME);
cache.folders[''] = unpackedRootId;

const allRelFiles = collectFilesRel(distDir);
// IMPORTANT: Always upload build-meta.json LAST so Chrome's dev-reloader triggers only after all assets finish syncing!
const orderedRelFiles = [
  ...allRelFiles.filter((f) => f !== 'build-meta.json').sort(),
  ...allRelFiles.filter((f) => f === 'build-meta.json'),
];

let uploadedCount = 0;
let skippedCount = 0;

for (const relPath of orderedRelFiles) {
  const absPath = path.join(distDir, relPath);
  const digest = sha256File(absPath);
  const cached = cache.files[relPath];

  if (cached?.id && cached.sha256 === digest && relPath !== 'build-meta.json') {
    skippedCount++;
    continue;
  }

  const dirName = path.posix.dirname(relPath);
  let parentFolderId = unpackedRootId;
  if (dirName && dirName !== '.') {
    if (cache.folders[dirName]) {
      parentFolderId = cache.folders[dirName];
    } else {
      let currentParent = unpackedRootId;
      let builtPath = '';
      for (const segment of dirName.split('/')) {
        builtPath = builtPath ? `${builtPath}/${segment}` : segment;
        currentParent = ensureSubfolder(currentParent, segment);
        cache.folders[builtPath] = currentParent;
      }
      parentFolderId = currentParent;
    }
  }

  const baseName = path.posix.basename(relPath);
  let fileId = cached?.id;

  if (!fileId) {
    const existingInFolder = listFolderJson(parentFolderId).find((item) => item.name === baseName);
    if (existingInFolder?.id) {
      fileId = existingInFolder.id;
    }
  }

  if (fileId) {
    runGdrive(['mutate', 'update', fileId, absPath]);
    console.log(`  ↻ updated ${relPath}`);
  } else {
    const raw = runGdrive(['mutate', 'upload', absPath, '--parent', parentFolderId, '--json']);
    try {
      const parsed = JSON.parse(raw);
      fileId = parsed?.id;
    } catch {
      // Lookup if --json format varied
    }
    if (!fileId) {
      const found = listFolderJson(parentFolderId).find((item) => item.name === baseName);
      fileId = found?.id;
    }
    console.log(`  + uploaded ${relPath}`);
  }

  cache.files[relPath] = { id: fileId, sha256: digest };
  uploadedCount++;
}

saveCache(cache);
console.log(
  `[sync-gdrive] Done! (${uploadedCount} synced, ${skippedCount} unchanged). Unpacked folder ID: ${unpackedRootId}`
);
