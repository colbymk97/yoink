#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);

function usage() {
  console.error('Usage: node scripts/ensure-sqlite-vec-target.mjs --target <target>');
}

function parseTarget(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') {
      return argv[i + 1];
    }
  }
  return '';
}

function packageNameForTarget(target) {
  switch (target) {
    case 'darwin-arm64':
      return 'sqlite-vec-darwin-arm64';
    case 'darwin-x64':
      return 'sqlite-vec-darwin-x64';
    case 'linux-arm64':
      return 'sqlite-vec-linux-arm64';
    case 'linux-x64':
      return 'sqlite-vec-linux-x64';
    case 'win32-x64':
      return 'sqlite-vec-windows-x64';
    default:
      return '';
  }
}

const target = parseTarget(args);
if (!target) {
  usage();
  process.exit(1);
}

const packageName = packageNameForTarget(target);
if (!packageName) {
  console.error(`Unsupported sqlite-vec target: ${target}`);
  process.exit(1);
}

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const packageLockPath = path.join(repoRoot, 'package-lock.json');
const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
const version =
  packageJson.optionalDependencies?.[packageName] ??
  packageJson.dependencies?.[packageName] ??
  '';
const resolvedUrl = packageLock.packages?.[`node_modules/${packageName}`]?.resolved ?? '';

const packageDir = path.join(repoRoot, 'node_modules', packageName);
if (fs.existsSync(packageDir)) {
  console.log(`sqlite-vec package already present for ${target}: ${packageName}`);
  process.exit(0);
}

const spec = version ? `${packageName}@${version}` : packageName;
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-vec-pack-'));
try {
  console.log(`Fetching sqlite-vec package for ${target}: ${spec}`);
  const packOutput = execFileSync(
    npmExecutable,
    ['pack', resolvedUrl || spec, '--pack-destination', tempDir],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const tarballName = packOutput
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1);

  if (!tarballName) {
    throw new Error(`Could not determine tarball name for ${spec}`);
  }

  const tarballPath = path.join(tempDir, tarballName);
  fs.mkdirSync(packageDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarballPath, '-C', packageDir, '--strip-components=1'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  console.log(`Installed sqlite-vec package for ${target}: ${packageName}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
