import { readFileSync } from 'node:fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function firstTomlVersion(path) {
  const match = readFileSync(path, 'utf8').match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) throw new Error(`${path} does not declare a package version`);
  return match[1];
}

function cargoLockPackageVersion(path, packageName) {
  const block = readFileSync(path, 'utf8')
    .split(/\r?\n(?=\[\[package\]\])/)
    .find(value => new RegExp(`^name\\s*=\\s*"${packageName}"\\s*$`, 'm').test(value));
  const match = block?.match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) throw new Error(`${path} does not contain the ${packageName} package version`);
  return match[1];
}

const tag = process.argv[2] ?? '';
const tagMatch = /^v(\d+\.\d+\.\d+)$/.exec(tag);
if (!tagMatch) {
  console.error(`Release tag must use the exact vMAJOR.MINOR.PATCH form; received: ${tag || '(empty)'}`);
  process.exit(1);
}

const expected = tagMatch[1];
const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const versions = new Map([
  ['package.json', packageJson.version],
  ['package-lock.json root', packageLock.version],
  ['package-lock.json package', packageLock.packages?.['']?.version],
  ['src-tauri/tauri.conf.json', readJson('src-tauri/tauri.conf.json').version],
  ['src-tauri/Cargo.toml', firstTomlVersion('src-tauri/Cargo.toml')],
  ['src-tauri/Cargo.lock app', cargoLockPackageVersion('src-tauri/Cargo.lock', 'app')],
]);
const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length) {
  console.error(`Release tag ${tag} expects every project version to be ${expected}:`);
  for (const [source, version] of mismatches) console.error(`- ${source}: ${version ?? '(missing)'}`);
  process.exit(1);
}

console.log(`Release tag ${tag} matches all project version declarations.`);
