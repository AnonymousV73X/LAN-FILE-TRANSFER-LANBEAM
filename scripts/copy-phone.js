// scripts/copy-phone.js — phone web UI lives in src/phone and is served at runtime,
// so it doesn't need to be copied. This script just ensures the dir is in place.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'phone');
if (!fs.existsSync(SRC)) {
  console.error('phone UI missing at', SRC);
  process.exit(1);
}
console.log('phone UI present:', fs.readdirSync(SRC).join(', '));
