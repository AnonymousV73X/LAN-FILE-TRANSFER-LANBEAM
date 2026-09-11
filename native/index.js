// Stub shim so `require('./native/index.js')` doesn't throw when the Rust
// binary hasn't been compiled yet. The TS shim in core-loader.ts will
// detect this and fall back. Replace with the napi-rs-generated file after
// `napi build` has run.
module.exports = {
  hashChunk: () => { throw new Error('native core not built — run `npm run build:native`'); },
  estimateEntropy: () => 0,
  shouldCompressChunk: () => false,
  compressChunk: async () => Buffer.alloc(0),
  decompressChunk: async () => Buffer.alloc(0),
  buildMerkle: () => ({ root: '', leaves: [] }),
  verifyChunk: () => false,
  startQuicServer: async () => ({ port: 0, serverId: '' }),
  sendFileQuic: async () => { throw new Error('native core not built'); },
  generateSyntheticBenchmarkFile: async () => {},
};
