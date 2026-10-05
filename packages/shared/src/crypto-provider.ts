/** Platform adapter; mobile supplies audited primitives and native random bytes. */
export interface CryptoProvider {
  randomBytes(length: number): Uint8Array;
  digest(bytes: Uint8Array): Promise<Uint8Array>;
  generateKeyPair(): Promise<{ privateKey: unknown; publicKey: string }>;
  deriveKey(privateKey: unknown, publicKey: string): Promise<Uint8Array>;
  encrypt(key: Uint8Array, iv: Uint8Array, bytes: Uint8Array): Promise<Uint8Array>;
  decrypt(key: Uint8Array, iv: Uint8Array, bytes: Uint8Array): Promise<Uint8Array>;
}

const source = (bytes: Uint8Array) => bytes as unknown as BufferSource;
async function aesKey(bytes: Uint8Array) {
  return crypto.subtle.importKey('raw', source(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export let cryptoProvider: CryptoProvider = {
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  digest: async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', source(bytes))),
  async generateKeyPair() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return { privateKey: pair.privateKey, publicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)) };
  },
  async deriveKey(privateKey, publicKey) {
    const remote = await crypto.subtle.importKey('jwk', JSON.parse(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: remote }, privateKey as CryptoKey, 256));
  },
  async encrypt(key, iv, bytes) {
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: source(iv) }, await aesKey(key), source(bytes)));
  },
  async decrypt(key, iv, bytes) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: source(iv) }, await aesKey(key), source(bytes)));
  },
};

export function setCryptoProvider(provider: CryptoProvider): void { cryptoProvider = provider; }
