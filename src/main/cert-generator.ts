const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

export function getOrCreateCertificate(storageDir: string, extraHost?: string): { cert: string; key: string } {
  const certFile = path.join(storageDir, 'lanbeam-cert.pem');
  const keyFile = path.join(storageDir, 'lanbeam-key.pem');

  try {
    if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
      const cert = fs.readFileSync(certFile, 'utf8');
      const key = fs.readFileSync(keyFile, 'utf8');
      // If extraHost is provided, verify it is included in the existing certificate's SAN or recreate
      if (cert.length > 50 && key.length > 50) {
        if (!extraHost || cert.includes(extraHost)) {
          return { cert, key };
        }
      }
    }
  } catch (_) {}

  // Generate self-signed certificate using forge
  (global as any).window = global;
  const forge = require('./forge.min.js');
  forge.random.getBytesSync = (n: number) => crypto.randomBytes(n).toString('binary');
  forge.random.getBytes = (n: number, cb: (err: any, b: string) => void) => {
    const b = crypto.randomBytes(n).toString('binary');
    if (cb) return cb(null, b);
    return b;
  };

  const pki = forge.pki;
  const keys = pki.rsa.generateKeyPair(1024);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

  const attrs = [
    { name: 'commonName', value: extraHost || 'LANBeam Local Transfer' },
    { name: 'organizationName', value: 'LANBeam' }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  const altNames: any[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 2, value: 'lanbeam.local' }
  ];
  if (extraHost && extraHost !== '127.0.0.1' && extraHost !== 'localhost') {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(extraHost)) {
      altNames.push({ type: 7, ip: extraHost });
    } else {
      altNames.push({ type: 2, value: extraHost });
    }
  }

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: true
    },
    {
      name: 'subjectAltName',
      altNames
    }
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pemCert = pki.certificateToPem(cert);
  const pemKey = pki.privateKeyToPem(keys.privateKey);

  try {
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(certFile, pemCert, 'utf8');
    fs.writeFileSync(keyFile, pemKey, 'utf8');
  } catch (err) {
    console.warn('[Certificate] Could not persist certificate to disk:', err);
  }

  return { cert: pemCert, key: pemKey };
}
