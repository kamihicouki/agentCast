import { build } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(rootDir, 'dist/chrome-mv3');
const isWatch = process.argv.includes('--watch');
const buildTarget = process.env.BUILD_TARGET === 'production' ? 'production' : 'main';
const isPersonalMain = buildTarget === 'main';

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

/**
 * Generate a crisp, zero-dependency PNG icon (warm studio charcoal rounded badge + amber broadcast wave).
 */
function createBroadcastIconPng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.46;
  const cornerRadius = size * 0.24;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // PNG filter type 0 (None)
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const qx = Math.max(dx - (radius - cornerRadius), 0);
      const qy = Math.max(dy - (radius - cornerRadius), 0);
      const distRounded = Math.hypot(qx, qy) - cornerRadius;

      if (distRounded > 0.6) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      const edgeAlpha = distRounded > -0.6 ? Math.round((0.6 - distRounded) / 1.2 * 255) : 255;

      // Base warm studio charcoal (#18191D)
      let r = 24;
      let g = 25;
      let b = 29;

      // Subtle inner sheen
      const normY = y / size;
      r += Math.round((1 - normY) * 10);
      g += Math.round((1 - normY) * 10);
      b += Math.round((1 - normY) * 12);

      // Center mic dot + two concentric radio arcs in warm vermilion-amber (#E56B43 & #F3EFE6)
      const distCenter = Math.hypot(x - cx, y - cy * 1.06);
      const dotR = size * 0.11;
      const arc1R = size * 0.24;
      const arc2R = size * 0.36;
      const stroke = Math.max(size * 0.055, 1.15);
      const angle = Math.atan2(y - cy * 1.06, x - cx); // -PI..PI
      const inUpperArc = angle < -0.35 && angle > -Math.PI + 0.35;

      if (distCenter <= dotR) {
        r = 229;
        g = 107;
        b = 67;
      } else if (inUpperArc && Math.abs(distCenter - arc1R) <= stroke) {
        r = 243;
        g = 239;
        b = 230;
      } else if (inUpperArc && Math.abs(distCenter - arc2R) <= stroke * 0.9) {
        r = 229;
        g = 107;
        b = 67;
      } else if (
        Math.abs(x - cx) <= stroke * 0.75 &&
        y >= cy * 1.06 + dotR * 0.6 &&
        y <= cy * 1.06 + size * 0.24
      ) {
        r = 243;
        g = 239;
        b = 230;
      }

      raw[px] = Math.min(255, r);
      raw[px + 1] = Math.min(255, g);
      raw[px + 2] = Math.min(255, b);
      raw[px + 3] = edgeAlpha;
    }
  }

  function pngChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE( zlib.crc32(crcInput) >>> 0, 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function generateManifest() {
  const basePermissions = [
    'storage',
    'unlimitedStorage',
    'sidePanel',
    'offscreen',
    'alarms',
    'tabs',
    'tabGroups',
    'scripting',
    ...(isPersonalMain ? ['activeTab'] : []),
  ];

  const mainContentMatches = [
    'https://x.com/*',
    'https://twitter.com/*',
    'https://note.com/*',
    'https://zenn.dev/*',
    'https://news.yahoo.co.jp/*',
    'https://news.google.com/*',
  ];

  const manifest = {
    manifest_version: 3,
    name: isPersonalMain ? 'agentCast (Personal Dev)' : 'agentCast — Personal Podcast Reader',
    version: pkg.version,
    description:
      'フォロー中のSNS・ニュース・技術記事を自身のブラウザセッションで読み取り、2人掛け合いの個人用ラジオ番組に編成して再生するChrome拡張機能。',
    permissions: basePermissions,
    ...(isPersonalMain
      ? {
          host_permissions: ['<all_urls>'],
        }
      : {
          host_permissions: [
            'https://generativelanguage.googleapis.com/*',
            'https://api.openai.com/*',
          ],
          optional_host_permissions: ['https://*/*'],
        }),
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    action: {
      default_title: 'agentCast プレイヤーを開く',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    content_scripts: isPersonalMain
      ? [
          {
            matches: mainContentMatches,
            js: ['content.js'],
            run_at: 'document_idle',
          },
        ]
      : [],
    ...(isPersonalMain
      ? {
          web_accessible_resources: [
            {
              resources: ['build-meta.json'],
              matches: ['<all_urls>'],
            },
          ],
        }
      : {}),
  };

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function writeBuildMeta(buildId) {
  const hash = crypto.createHash('sha1');
  for (const file of ['manifest.json', 'background.js', 'content.js', 'sidepanel.html', 'offscreen.html']) {
    const p = path.join(outDir, file);
    if (fs.existsSync(p)) {
      hash.update(fs.readFileSync(p));
    }
  }
  const assetsDir = path.join(outDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    for (const f of fs.readdirSync(assetsDir).sort()) {
      hash.update(fs.readFileSync(path.join(assetsDir, f)));
    }
  }

  const contentHash = hash.digest('hex').slice(0, 12);
  const builtAt = new Date().toISOString();
  const buildMeta = {
    buildId,
    contentHash,
    builtAt,
    target: buildTarget,
    version: pkg.version,
  };
  fs.writeFileSync(path.join(outDir, 'build-meta.json'), JSON.stringify(buildMeta, null, 2));
  return buildMeta;
}

function writeIcons() {
  const iconsDir = path.join(outDir, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), createBroadcastIconPng(size));
  }
}

async function buildOnce() {
  const t0 = Date.now();
  const buildId = `${pkg.version}-${t0}`;
  const sharedDefine = {
    __AGENTCAST_TARGET__: JSON.stringify(buildTarget),
    __DEV_AUTO_RELOAD__: JSON.stringify(isPersonalMain),
    __AGENTCAST_BUILD_ID__: JSON.stringify(buildId),
    __AGENTCAST_VERSION__: JSON.stringify(pkg.version),
  };

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Multi-page HTML entries: sidepanel.html + offscreen.html (deterministic asset names for Drive sync!)
  await build({
    root: rootDir,
    configFile: false,
    logLevel: 'warn',
    plugins: [react()],
    define: sharedDefine,
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: false,
      target: 'es2022',
      rollupOptions: {
        input: {
          sidepanel: path.resolve(rootDir, 'sidepanel.html'),
          offscreen: path.resolve(rootDir, 'offscreen.html'),
        },
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
  });

  // 2. Background Service Worker (single self-contained ES module file)
  await build({
    root: rootDir,
    configFile: false,
    logLevel: 'warn',
    define: sharedDefine,
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: false,
      target: 'es2022',
      lib: {
        entry: path.resolve(rootDir, 'src/entrypoints/background/index.ts'),
        formats: ['es'],
        fileName: () => 'background.js',
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });

  // 3. Content Script (single self-contained IIFE bundle for MV3 content_scripts & chrome.scripting.executeScript)
  await build({
    root: rootDir,
    configFile: false,
    logLevel: 'warn',
    define: sharedDefine,
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: false,
      target: 'es2022',
      lib: {
        entry: path.resolve(rootDir, 'src/entrypoints/content/index.ts'),
        name: 'AgentCastContentScript',
        formats: ['iife'],
        fileName: () => 'content.js',
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });

  writeIcons();
  generateManifest();
  const meta = writeBuildMeta(buildId);
  console.log(
    `[agentCast] Built (${buildTarget}) -> dist/chrome-mv3 in ${Date.now() - t0}ms [buildId=${meta.buildId}]`
  );
}

await buildOnce();

if (isWatch) {
  console.log('[agentCast] Watching src/ for changes (Chrome extension will auto-reload via build-meta.json)...');
  let timer = null;
  let building = false;
  let queued = false;

  const triggerRebuild = async (changedPath) => {
    if (building) {
      queued = true;
      return;
    }
    building = true;
    try {
      console.log(`[agentCast] Change detected: ${changedPath}`);
      await buildOnce();
    } catch (err) {
      console.error('[agentCast] Build failed:', err);
    } finally {
      building = false;
      if (queued) {
        queued = false;
        void triggerRebuild('queued changes');
      }
    }
  };

  for (const watchTarget of ['src', 'sidepanel.html', 'offscreen.html']) {
    const absTarget = path.join(rootDir, watchTarget);
    if (!fs.existsSync(absTarget)) continue;
    fs.watch(absTarget, { recursive: fs.statSync(absTarget).isDirectory() }, (_event, filename) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void triggerRebuild(filename || watchTarget);
      }, 180);
    });
  }
}
