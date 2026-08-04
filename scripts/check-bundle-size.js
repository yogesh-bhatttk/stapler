import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const MAX_SIZE_KB = 900;
const MAX_SIZE_BYTES = MAX_SIZE_KB * 1024;

// Try multiple possible output paths
const possibleRoots = [
  path.resolve(process.cwd(), 'dist/web'),
  path.resolve(process.cwd(), 'dist/ext'),
  path.resolve(process.cwd(), 'dist')
];

const DIST_ROOT = possibleRoots.find(d => fs.existsSync(d));

if (!DIST_ROOT) {
  console.error(`Dist directory not found. Did you run build?`);
  process.exit(1);
}

// Collect all JS files from root and assets subdirectory, excluding workers
const collectJsFiles = dir => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.js') && !f.includes('worker'))
    .map(f => path.join(dir, f));
};

const allJsFiles = [
  ...collectJsFiles(DIST_ROOT),
  ...collectJsFiles(path.join(DIST_ROOT, 'assets'))
];

if (allJsFiles.length === 0) {
  console.error('No main JS bundle found in dist.');
  process.exit(1);
}

// The "initial chunk" is the entry JS that the browser loads first.
// It's typically named editor.js or index-*.js, and lives in the root or assets.
const mainChunkPath =
  allJsFiles.find(f => path.basename(f).startsWith('editor')) ||
  allJsFiles.find(f => path.basename(f).startsWith('index-')) ||
  allJsFiles[0];

const content = fs.readFileSync(mainChunkPath);
const gzipped = zlib.gzipSync(content);
const sizeBytes = gzipped.length;
const sizeKB = (sizeBytes / 1024).toFixed(2);

console.log(`Main chunk: ${path.relative(DIST_ROOT, mainChunkPath)}`);
console.log(`Raw size: ${(content.length / 1024).toFixed(2)} KB`);
console.log(`Gzipped size: ${sizeKB} KB`);

if (sizeBytes > MAX_SIZE_BYTES) {
  console.error(`❌ Bundle size check FAILED!`);
  console.error(`Size ${sizeKB} KB exceeds the limit of ${MAX_SIZE_KB} KB.`);
  process.exit(1);
}

console.log(`✅ Bundle size check PASSED. (${sizeKB} KB < ${MAX_SIZE_KB} KB)`);
process.exit(0);
