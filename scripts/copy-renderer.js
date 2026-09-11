// scripts/copy-renderer.js — copies renderer HTML/CSS/JS into dist/ for Electron to load.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const DST = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(DST, { recursive: true });
for (const name of ['index.html', 'styles.css', 'main.js']) {
  fs.copyFileSync(path.join(SRC, name), path.join(DST, name));
  console.log('renderer:', name, '->', path.join(DST, name));
}

// Copy fonts directory
const fontsSrc = path.join(SRC, 'fonts');
const fontsDst = path.join(DST, 'fonts');
if (fs.existsSync(fontsSrc)) {
  fs.mkdirSync(fontsDst, { recursive: true });
  for (const font of fs.readdirSync(fontsSrc)) {
    fs.copyFileSync(path.join(fontsSrc, font), path.join(fontsDst, font));
  }
  console.log('renderer: fonts copied');
}
