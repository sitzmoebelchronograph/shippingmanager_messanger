/**
 * @fileoverview HTTPS Certificate Generation and Management Module
 *
 * This module handles automatic generation and management of self-signed SSL/TLS certificates
 * for the Shipping Manager CoPilot application. It creates a Certificate Authority (CA) that can
 * be trusted by browsers, then generates server certificates signed by that CA.
 *
 * Key Features:
 * - Generates a long-lived (10 year) Certificate Authority that can be installed in system trust store
 * - Creates server certificates with Subject Alternative Names (SANs) for all network interfaces
 * - Supports localhost, 127.0.0.1, ::1, and all LAN IP addresses (e.g., 192.168.x.x)
 * - Provides automatic CA installation on Windows via certutil (requires admin rights)
 * - Certificates valid for 1 year and automatically regenerated when missing
 *
 * Why This Exists:
 * - WebSocket connections (wss://) require HTTPS, not just HTTP
 * - Browser security policies require trusted certificates for WebSocket communication
 * - Supporting multiple network interfaces allows access from other devices on LAN
 * - CA-based approach allows one-time browser trust instead of per-certificate warnings
 *
 * Certificate Chain:
 *   CA Certificate (10yr) → Server Certificate (1yr)
 *   ca-cert.pem, ca-key.pem → cert.pem, key.pem
 *
 * Installation Workflow:
 * 1. First run: Generate CA + server cert, prompt for CA installation
 * 2. User installs CA in system trust store (manual or automatic)
 * 3. All future server certificates signed by this CA are automatically trusted
 * 4. Server cert regenerated when missing (uses existing CA if available)
 *
 * @requires fs - File system operations for certificate storage
 * @requires path - Path resolution for certificate files
 * @requires https - HTTPS server creation
 * @requires os - Network interface detection and platform detection
 * @requires child_process - Certificate installation via certutil
 * @requires node-forge - RSA key generation and X.509 certificate creation
 * @module server/certificate
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { spawnSync } = require('child_process');
const forge = require('node-forge');
const logger = require('./utils/logger');

/**
 * APPDATA directory for storing user data (certificates, sessions, etc.)
 * Uses platform-specific AppData directory (no env vars)
 * Development mode: uses local ./userdata
 * Production (pkg): uses AppData/Local/ShippingManagerCoPilot
 * @constant {string}
 */
const { getAppDataDir } = require('./config');

// Determine if running as packaged executable
const isPkg = typeof process.pkg !== 'undefined';

let CERTS_DIR;
if (isPkg) {
  // Production: use AppData
  const APPDATA_DIR = path.join(getAppDataDir(), 'ShippingManagerCoPilot');
  CERTS_DIR = path.join(APPDATA_DIR, 'userdata', 'certs');
} else {
  // Development: use local project directory
  const PROJECT_ROOT = path.join(__dirname, '..');
  CERTS_DIR = path.join(PROJECT_ROOT, 'userdata', 'certs');
}

// Ensure certificates directory exists
if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
}

/**
 * File path for the Certificate Authority certificate (10-year validity)
 * @constant {string}
 */
const CA_CERT_PATH = path.join(CERTS_DIR, 'ca-cert.pem');

/**
 * File path for the Certificate Authority private key
 * @constant {string}
 */
const CA_KEY_PATH = path.join(CERTS_DIR, 'ca-key.pem');

/**
 * File path for the server certificate (1-year validity)
 * @constant {string}
 */
const CERT_PATH = path.join(CERTS_DIR, 'cert.pem');

/**
 * File path for the server private key
 * @constant {string}
 */
const KEY_PATH = path.join(CERTS_DIR, 'key.pem');

/**
 * Checks if a certificate with the given Common Name is already installed in Windows Certificate Store.
 *
 * @function isCertificateInstalled
 * @param {string} commonName - Certificate Common Name to search for
 * @returns {boolean} True if certificate is installed, false otherwise
 */
function isCertificateInstalled(commonName) {
  if (os.platform() !== 'win32') {
    return false; // Only works on Windows
  }

  try {
    const result = spawnSync('certutil', ['-verifystore', 'Root', commonName], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // certutil exits with code 0 if certificate found
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detects all non-internal IPv4 addresses from network interfaces.
 *
 * This function scans all network interfaces on the system and collects their IPv4 addresses,
 * excluding loopback/internal interfaces. These IPs are used as Subject Alternative Names (SANs)
 * in the server certificate, allowing the application to be accessed from other devices on the LAN.
 *
 * Why This Matters:
 * - Browsers require certificates to explicitly list all hostnames/IPs they'll be accessed via
 * - Without SANs for network IPs, accessing via 192.168.x.x would show certificate warnings
 * - Dynamically detecting IPs ensures certificates work across different network configurations
 *
 * @function getNetworkIPs
 * @returns {string[]} Array of IPv4 addresses (e.g., ['192.168.1.100', '10.0.0.5'])
 *
 * @example
 * const ips = getNetworkIPs();
 * console.log(ips); // ['192.168.1.100', '192.168.56.1']
 */
function getNetworkIPs() {
  const networkInterfaces = os.networkInterfaces();
  const ips = [];

  for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }

  return ips;
}

/**
 * Generates a self-signed Certificate Authority (CA) for signing server certificates.
 *
 * This function creates a long-lived (10 year) CA certificate and private key that can be
 * installed in the system's trust store. Once installed, all server certificates signed by
 * this CA will be automatically trusted by browsers without security warnings.
 *
 * Why This Approach:
 * - Self-signed server certificates trigger warnings on every access
 * - CA-based approach requires one-time installation, then all future certs are trusted
 * - 10-year validity means CA doesn't need frequent regeneration
 * - Automatic installation on Windows (via certutil) streamlines setup
 *
 * Certificate Properties:
 * - 2048-bit RSA key pair
 * - SHA-256 signature algorithm
 * - Basic Constraints: CA=true (can sign other certificates)
 * - Key Usage: Certificate Signing, CRL Signing
 * - Common Name: "Shipping Manager CoPilot CA"
 *
 * Platform-Specific Installation:
 * - Windows: Prompts UAC dialog for automatic installation via certutil
 * - macOS: Provides manual command for adding to System keychain
 * - Linux: Provides manual command for adding to ca-certificates
 *
 * Side Effects:
 * - Writes ca-cert.pem and ca-key.pem to project root
 * - Attempts automatic installation on Windows (requires user approval)
 * - Logs installation instructions to console
 *
 * @function generateCA
 * @returns {{cert: string, key: string}} Object with PEM-encoded CA certificate and private key
 *
 * @example
 * const ca = generateCA();
 * // Creates ca-cert.pem and ca-key.pem in project root
 * // On Windows, shows UAC prompt for installation
 * console.log(ca.cert); // PEM-encoded certificate
 */
function generateCA() {
  logger.info('Generating Certificate Authority (CA)...');

  // Check if old CA exists
  const oldCaExists = fs.existsSync(CA_CERT_PATH);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'Shipping Manager CoPilot CA' },
    { name: 'organizationName', value: 'Shipping Manager CoPilot' },
    { name: 'countryName', value: 'US' }
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: true
    },
    {
      name: 'keyUsage',
      keyCertSign: true,
      cRLSign: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true
    }
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const caPem = forge.pki.certificateToPem(cert);
  const caKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

  fs.writeFileSync(CA_CERT_PATH, caPem);
  fs.writeFileSync(CA_KEY_PATH, caKeyPem);

  logger.info('OK CA generated successfully');

  // If we replaced an old CA, we need to prompt user to uninstall old and install new
  if (oldCaExists) {
    logger.warn('WARNING: New CA certificate generated. Old certificates in system trust store should be replaced.');
    logger.info('   Use the Systray menu: Certificates > Uninstall CA Certificates, then Install CA Certificate');
  }

  // Try to install CA certificate automatically on Windows
  if (os.platform() === 'win32') {
    // Check if already installed
    if (isCertificateInstalled('Shipping Manager CoPilot CA')) {
      if (oldCaExists) {
        logger.info('NOTE: CA certificate is installed but may be outdated. Consider reinstalling via Systray menu.');
      } else {
        logger.info('OK CA certificate already installed in Windows Trust Store');
      }
      return { cert: caPem, key: caKeyPem };
    }
    try {
      logger.info('\n🔒 Installing CA certificate to Windows Trust Store...');
      logger.info('   (Admin rights required - UAC dialog will appear)\n');

      // Validate path doesn't contain dangerous characters (defense in depth)
      if (CA_CERT_PATH.includes("'") || CA_CERT_PATH.includes('"') || CA_CERT_PATH.includes(';')) {
        throw new Error('Invalid certificate path detected');
      }

      // Use spawnSync with proper argument escaping for PowerShell
      // PowerShell single quotes need to be escaped as ''
      const escapedPath = CA_CERT_PATH.replace(/'/g, "''");

      const result = spawnSync('powershell', [
        '-Command',
        `Start-Process certutil -ArgumentList '-addstore','-f','Root','${escapedPath}' -Verb RunAs -Wait`
      ], {
        stdio: 'inherit'
      });

      if (result.error) {
        throw result.error;
      }

      logger.info('\nOK CA certificate installed successfully!');
      logger.info('OK Browser will now trust all certificates from this CA\n');
    } catch {
      logger.warn('[Certificate] Installation cancelled or failed');
      logger.info('[Certificate] Manual installation:');
      logger.info(`   1. Right-click Command Prompt "Run as Administrator"`);
      logger.info(`   2. Run: certutil -addstore -f "Root" "${CA_CERT_PATH}"\n`);
    }
  } else if (os.platform() === 'darwin') {
    logger.info(`\n📋 macOS: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CA_CERT_PATH}"\n`);
  } else {
    logger.info(`\n📋 Linux: sudo cp "${CA_CERT_PATH}" /usr/local/share/ca-certificates/ && sudo update-ca-certificates\n`);
  }

  return { cert: caPem, key: caKeyPem };
}

/**
 * Generates a server certificate signed by the Certificate Authority.
 *
 * This function creates a 1-year server certificate with Subject Alternative Names (SANs)
 * covering all network interfaces. The certificate is signed by the CA (loaded or generated),
 * allowing browsers to trust it without warnings if the CA is installed in the system trust store.
 *
 * Why This Design:
 * - 1-year validity balances security (shorter lifespan) with convenience (not too frequent renewal)
 * - SANs for all network IPs enable access from other devices on LAN
 * - localhost + 127.0.0.1 + ::1 ensure local development works
 * - CA-signed approach means regenerating server cert doesn't require browser reconfiguration
 *
 * Certificate Properties:
 * - 2048-bit RSA key pair
 * - SHA-256 signature algorithm
 * - Common Name: "localhost"
 * - Subject Alternative Names:
 *   - DNS: localhost
 *   - IP: 127.0.0.1, ::1
 *   - IP: All detected network IPs (e.g., 192.168.1.100)
 * - Extended Key Usage: Server Authentication, Client Authentication
 *
 * Certificate Workflow:
 * 1. Check if CA exists, generate if missing
 * 2. Load CA certificate and private key
 * 3. Generate new server key pair
 * 4. Detect all network IPs via getNetworkIPs()
 * 5. Create certificate with SANs for localhost + all IPs
 * 6. Sign certificate with CA private key
 * 7. Write cert.pem and key.pem to disk
 *
 * Side Effects:
 * - May trigger CA generation if CA files don't exist
 * - Writes cert.pem and key.pem to project root
 * - Logs detected network IPs to console
 *
 * @function generateCertificate
 * @returns {void}
 *
 * @example
 * generateCertificate();
 * // Generates cert.pem and key.pem
 * // Console output:
 * //   "Adding network IP to certificate: 192.168.1.100"
 * //   "OK Server certificate generated successfully"
 */
function generateCertificate() {
  logger.info('Generating server certificate...');

  // Load or generate CA
  let caCert, caKey;
  if (!fs.existsSync(CA_CERT_PATH) || !fs.existsSync(CA_KEY_PATH)) {
    const ca = generateCA();
    caCert = forge.pki.certificateFromPem(ca.cert);
    caKey = forge.pki.privateKeyFromPem(ca.key);
  } else {
    caCert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT_PATH, 'utf8'));
    caKey = forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY_PATH, 'utf8'));
  }

  // Generate server key pair
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [
    { name: 'commonName', value: 'localhost' },
    { name: 'organizationName', value: 'Shipping Manager CoPilot' },
    { name: 'countryName', value: 'US' }
  ];

  cert.setSubject(attrs);
  cert.setIssuer(caCert.subject.attributes);

  // Get all network IPs
  const networkIPs = getNetworkIPs();

  // Build altNames array
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' }
  ];

  networkIPs.forEach(ip => {
    altNames.push({ type: 7, ip });
    logger.debug(`  Adding network IP to certificate: ${ip}`);
  });

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: false
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true
    },
    {
      name: 'subjectAltName',
      altNames: altNames
    }
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  fs.writeFileSync(CERT_PATH, certPem);
  fs.writeFileSync(KEY_PATH, keyPem);

  logger.info('OK Server certificate generated successfully');
}

/**
 * Loads existing server certificate or generates a new one if missing.
 *
 * This function implements lazy certificate generation - it only creates certificates
 * when they don't exist. This ensures the server can start quickly on subsequent runs
 * without regenerating certificates unnecessarily.
 *
 * Why This Pattern:
 * - Certificates are only generated when needed (first run or after deletion)
 * - Automatic regeneration ensures server always has valid certificates
 * - Existing certificates are reused to maintain consistent SSL fingerprints
 * - No manual intervention required for certificate management
 *
 * Certificate Lifecycle:
 * 1. Check if cert.pem and key.pem exist
 * 2. If missing, generate new server certificate (which may also generate CA)
 * 3. Read certificate and key files into memory
 * 4. Return as Buffer objects for HTTPS server
 *
 * @function loadCertificate
 * @returns {{cert: Buffer, key: Buffer}} Object with certificate and private key as Buffers
 *
 * @example
 * const credentials = loadCertificate();
 * const server = https.createServer(credentials, app);
 * // If certificates missing, generates them first
 * // Otherwise, loads existing cert.pem and key.pem
 */
function loadCertificate() {
  if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
    generateCertificate();
  }

  return {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH)
  };
}

/**
 * Creates an HTTPS server with automatically managed SSL certificates.
 *
 * This is the primary export function used by app.js to create the HTTPS server.
 * It handles certificate loading/generation transparently, providing a simple
 * interface for creating a secure server.
 *
 * Why HTTPS Required:
 * - WebSocket Secure (wss://) connections require HTTPS, not HTTP
 * - Modern browsers block insecure WebSocket connections from secure contexts
 * - Session cookies from shippingmanager.cc may have Secure flag, requiring HTTPS
 * - Accessing from other devices on LAN requires trusted certificates
 *
 * Certificate Management:
 * - Automatically loads or generates certificates via loadCertificate()
 * - No manual intervention required
 * - Server starts with valid HTTPS configuration on first run
 *
 * @function createHttpsServer
 * @param {Express} app - Express application instance
 * @returns {https.Server} HTTPS server instance configured with SSL certificates
 *
 * @example
 * const express = require('express');
 * const { createHttpsServer } = require('./server/certificate');
 *
 * const app = express();
 * const server = createHttpsServer(app);
 * server.listen(12345, () => {
 *   console.log('HTTPS server running on port 12345');
 * });
 */
function createHttpsServer(app) {
  const credentials = loadCertificate();
  return https.createServer(credentials, app);
}

module.exports = {
  createHttpsServer,
  loadCertificate
};
