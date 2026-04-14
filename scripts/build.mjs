/**
 * build.mjs
 *
 * Compiles TypeScript source files to GJS-compatible JavaScript and assembles
 * the final distributable extension directory at ./dist/<UUID>/.
 *
 * GJS loads extension files as native ES modules, so we use tsc directly
 * (no bundling). Each compiled file keeps its gi:// and resource:// imports
 * as bare specifiers — GJS resolves them at runtime.
 */

import { execSync } from 'child_process';
import { copyFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';

const UUID    = 'search-does-search@searchdoessearch.github.io';
const DIST    = 'dist';
const OUT_DIR = join(DIST, UUID);

// ---------------------------------------------------------------------------
// Clean previous build
// ---------------------------------------------------------------------------
if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
}
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, 'schemas'), { recursive: true });

// ---------------------------------------------------------------------------
// Compile TypeScript → JavaScript via tsc
// tsc reads tsconfig.json (outDir: ./dist), so output lands in ./dist/*.js
// We then move those files into the UUID subdirectory.
// ---------------------------------------------------------------------------
console.log('→ Compiling TypeScript...');
execSync('npx tsc --outDir dist/tmp', { stdio: 'inherit' });

// Move compiled JS files from dist/tmp into dist/<UUID>/
const tmpDir = join(DIST, 'tmp');
for (const file of readdirSync(tmpDir)) {
  if (file.endsWith('.js') || file.endsWith('.js.map')) {
    copyFileSync(join(tmpDir, file), join(OUT_DIR, file));
  }
}
rmSync(tmpDir, { recursive: true });

// ---------------------------------------------------------------------------
// Copy static assets
// ---------------------------------------------------------------------------
console.log('→ Copying static assets...');
copyFileSync('metadata.json', join(OUT_DIR, 'metadata.json'));
copyFileSync(
  'schemas/org.gnome.shell.extensions.search-does-search.gschema.xml',
  join(OUT_DIR, 'schemas/org.gnome.shell.extensions.search-does-search.gschema.xml')
);

console.log(`\n✓ Build complete → ${OUT_DIR}`);
console.log('  Run: make install   to install the extension locally');
console.log('  Run: make pack      to create a .shell-extension.zip for publishing\n');
