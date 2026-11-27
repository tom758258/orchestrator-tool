import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy upstream notices from the locked Windows build inputs. This is a
// conservative notice collection, not a binary-content or license-policy audit.
const root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv.length !== 3) throw new Error('Usage: node scripts/copy-third-party-notices.mjs OUTPUT_DIR');
const output = resolve(process.argv[2]);
const licenses = join(output, 'licenses');
const noticeName = /^(licen[cs]es?|copying|notices?|copyrights?|authors|patents|unlicense|third[-_ ]party)([._ -]|$)/i;
const licenseDir = /^licen[cs]es?$/i;

function copyNotices(source, destination, declaredFile) {
  const files = new Set();
  function visit(dir, inLicenseDir = false) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
        visit(path, inLicenseDir || licenseDir.test(entry.name));
      } else if (entry.isFile() && (inLicenseDir || noticeName.test(entry.name))) {
        files.add(relative(source, path));
      }
    }
  }
  visit(source);
  if (declaredFile) {
    const path = resolve(source, declaredFile);
    const rel = relative(source, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !statSync(path).isFile()) {
      throw new Error(`Invalid declared license file: ${declaredFile}`);
    }
    files.add(rel);
  }
  for (const rel of [...files].sort()) {
    const target = join(destination, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, rel), target);
  }
  return files.size;
}

function rustPackages(manifest) {
  const metadata = JSON.parse(execFileSync('cargo', [
    'metadata', '--locked', '--format-version', '1', '--filter-platform',
    'x86_64-pc-windows-msvc', '--manifest-path', manifest,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const pending = [metadata.resolve.root];
  const seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) throw new Error(`Missing Cargo resolve node: ${id}`);
    // Include normal and build dependencies; exclude dev-only edges.
    for (const dep of node.deps) {
      if (dep.dep_kinds.some(({ kind }) => kind !== 'dev')) pending.push(dep.pkg);
    }
  }
  return metadata.packages.filter(pkg => seen.has(pkg.id) && pkg.source);
}

mkdirSync(output, { recursive: true });
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) copyFileSync(join(root, name), join(output, name));
cpSync(join(root, 'licenses'), licenses, { recursive: true });

const index = [
  'Orchestrator Tool - Collected third-party notices',
  'Windows x64 Cargo normal/build dependency graphs and installed npm non-dev lock entries.',
  'This conservative collection can include build-only inputs and is not a list of linked binary contents.',
  'Review any missing packaged notice against upstream before distributing.',
  '',
];
function record(name, declaredLicense, source, destination, count) {
  const path = relative(licenses, destination).split(sep).join('/');
  index.push(name, `  Declared license: ${declaredLicense || 'not declared'}`, `  Source: ${source}`,
    `  Notice files: ${count ? `${path}/ (${count})` : 'NONE FOUND - review upstream'}`, '');
  if (!count) console.warn(`No packaged notice files found: ${name}; review upstream.`);
}

const crates = new Map();
for (const manifest of ['Cargo.toml', 'apps/desktop/src-tauri/Cargo.toml']) {
  for (const pkg of rustPackages(join(root, manifest))) crates.set(pkg.id, pkg);
}
for (const pkg of [...crates.values()].sort((a, b) => a.id.localeCompare(b.id))) {
  const destination = join(licenses, 'rust', `${pkg.name}-${pkg.version}`);
  const count = copyNotices(dirname(pkg.manifest_path), destination, pkg.license_file);
  const source = pkg.source === 'registry+https://github.com/rust-lang/crates.io-index'
    ? `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download` : pkg.source;
  record(`Rust ${pkg.name} ${pkg.version}`, pkg.license || (pkg.license_file ? 'see declared license file' : null), source, destination, count);
}

const desktop = join(root, 'apps/desktop');
const lock = JSON.parse(readFileSync(join(desktop, 'package-lock.json'), 'utf8'));
for (const [path, pkg] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path || pkg.dev) continue;
  const installed = join(desktop, path);
  if (pkg.optional && !existsSync(installed)) continue;
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) throw new Error(`Installed npm version differs from lock: ${path}`);
  const destination = join(licenses, 'npm', path.replace(/^node_modules\//, ''));
  const count = copyNotices(installed, destination);
  record(`npm ${manifest.name} ${pkg.version}`, pkg.license || manifest.license, pkg.resolved || 'see package-lock.json', destination, count);
}
writeFileSync(join(licenses, 'DEPENDENCIES.txt'), index.join('\n') + '\n', 'utf8');
