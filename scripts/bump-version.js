#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function bumpPatch(v) {
  const parts = v.split('.').map(Number);
  if (parts.length < 3) {
    while (parts.length < 3) parts.push(0);
  }
  parts[2] = (parts[2] || 0) + 1;
  return parts.join('.');
}

try {
  const root = path.join(__dirname, '..');
  const pkgPath = path.join(root, 'package.json');
  const pkgcPath = path.join(root, 'package.jsonc');

  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgText);
  const oldVersion = pkg.version || '0.0.0';
  const newVersion = bumpPatch(oldVersion);

  // update package.json
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  // update package.jsonc by replacing the first occurrence of the version value
  if (fs.existsSync(pkgcPath)) {
    let pkgcText = fs.readFileSync(pkgcPath, 'utf8');
    pkgcText = pkgcText.replace(/("version"\s*:\s*")([^"]+)(")/, `$1${newVersion}$3`);
    fs.writeFileSync(pkgcPath, pkgcText, 'utf8');
  }

  // Output results for the workflow to capture
  console.log(`VERSION=${newVersion}`);
  console.log(`NAME=${pkg.name}`);
} catch (err) {
  console.error('Failed to bump version:', err);
  process.exit(1);
}
