// scripts/copy-phone.js — copies src/phone/* into dist/phone/ so both the
// dev server (dist/main -> dist/phone) and the packaged app find the files
// at the same relative path. All files are copied flat (no subdirs needed).
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'phone');
const DST = path.join(__dirname, '..', 'dist', 'phone');

if (!fs.existsSync(SRC)) {
  console.error('phone UI missing at', SRC);
  process.exit(1);
}

fs.mkdirSync(DST, { recursive: true });

const files = fs.readdirSync(SRC);
for (const file of files) {
  const srcFile = path.join(SRC, file);
  const dstFile = path.join(DST, file);
  if (fs.statSync(srcFile).isFile()) {
    fs.copyFileSync(srcFile, dstFile);
    console.log(`phone: ${file} -> ${dstFile}`);
  }
}
console.log('phone UI present:', files.join(', '));
