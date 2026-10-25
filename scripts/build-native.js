// scripts/build-native.js — builds native/ crate, outputs native/index.node.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'native');
const bin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'napi.cmd' : 'napi');
const r = spawnSync(bin, ['build', '--platform', '--release', '--js', 'false'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) process.exit(r.status || 1);

const node = fs.readdirSync(dir).find(f => f.endsWith('.node') && f !== 'index.node');
if (!node) { console.error('No .node output found in native/'); process.exit(1); }
fs.copyFileSync(path.join(dir, node), path.join(dir, 'index.node'));
