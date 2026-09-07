'use strict';
// Build script: inline public/ into inline-assets.js, then package a single-file exe with pkg.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'inline-assets.js');
const PKG = path.join(ROOT, 'node_modules', 'pkg', 'lib-es5', 'bin.js');
const ENTRY = path.join(ROOT, 'server.js');
const OUTPUT = path.join(__dirname, 'mothership.exe');

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    const st = fs.statSync(fp);
    if (st.isDirectory()) walk(fp, base, out);
    else out['/' + path.relative(base, fp).split(path.sep).join('/')] = fs.readFileSync(fp).toString('base64');
  }
}

const map = {};
walk(PUBLIC, PUBLIC, map);
fs.writeFileSync(OUT, 'module.exports = ' + JSON.stringify(map, null, 2) + ';\n');
console.log('[1/2] inline-assets.js written (' + Object.keys(map).length + ' files)');

console.log('[2/2] packaging exe with pkg ...');
// Move any existing exe aside so pkg doesn't try a (sandboxed) safe-delete on it.
if (fs.existsSync(OUTPUT)) {
  const old = OUTPUT + '.old-' + Date.now();
  fs.renameSync(OUTPUT, old);
  console.log('  moved old exe -> ' + path.basename(old));
}
execFileSync(process.execPath, [
  PKG, ENTRY,
  '--targets', 'node18-win-x64',
  '--output', OUTPUT
], { stdio: 'inherit', cwd: ROOT });
console.log('done -> ' + OUTPUT);
