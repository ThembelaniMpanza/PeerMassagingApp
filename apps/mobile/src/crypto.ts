import { p256 } from '@noble/curves/p256';
import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';
import type { CryptoProvider } from '@ip-messenger/shared';

const encodeUrl = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeUrl = (value: string) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function createMobileCrypto(randomBytes: (length: number) => Uint8Array): CryptoProvider {
  return {
    randomBytes,
    digest: async (bytes) => sha256(bytes),
    async generateKeyPair() {
      let privateKey: Uint8Array;
      do { privateKey = randomBytes(32); } while (!p256.utils.isValidPrivateKey(privateKey));
      const publicBytes = p256.getPublicKey(privateKey, false);
      const publicKey = JSON.stringify({ key_ops: [], ext: true, kty: 'EC', crv: 'P-256',
        x: encodeUrl(publicBytes.slice(1, 33)),
        y: encodeUrl(publicBytes.slice(33)) });
      return { privateKey, publicKey };
    },
    async deriveKey(privateKey, publicKey) {
      const jwk = JSON.parse(publicKey);
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('Invalid peer public key');
      const x = decodeUrl(jwk.x);
      const y = decodeUrl(jwk.y);
      if (x.length !== 32 || y.length !== 32) throw new Error('Invalid public key length');
      return p256.getSharedSecret(privateKey as Uint8Array, Buffer.concat([Buffer.from([4]), x, y]), false).slice(1, 33);
    },
    encrypt: async (key, iv, bytes) => gcm(key, iv).encrypt(bytes),
    decrypt: async (key, iv, bytes) => gcm(key, iv).decrypt(bytes),
  };
}
