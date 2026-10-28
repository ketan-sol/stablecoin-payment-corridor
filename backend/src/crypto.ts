import { createCipheriv, createDecipheriv, createHmac, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { connect } from 'node:tls'
import { toHex, type Hex } from 'viem'

/** AES-256-GCM for IVMS101 payloads at rest: base64(iv | tag | ciphertext). */
export function encrypt(keyHex: Hex, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex.slice(2), 'hex'), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

export function decrypt(keyHex: Hex, blob: string): string {
  const raw = Buffer.from(blob, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex.slice(2), 'hex'), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

export const hmac = (secret: string, message: string) => createHmac('sha256', secret).update(message).digest('hex')

export function hmacEquals(secret: string, message: string, mac: string): boolean {
  const want = Buffer.from(hmac(secret, message), 'hex')
  const got = Buffer.from(mac, 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
}

export const randomBytes32 = (): Hex => toHex(randomBytes(32))
/** Permit2 unordered nonce: any unused uint256; random is collision-free in practice. */
export const randomNonce = (): bigint => BigInt(toHex(randomBytes(31)))

/** Post-quantum TLS: OpenSSL 3.5+ (in Node 24+ builds) offers the hybrid X25519MLKEM768 key exchange first by default,
 * so traffic to RPCs and Circle cannot be recorded now and decrypted later. ML-KEM in node:crypto is the tell. */
export function pqTlsAvailable(): boolean {
  try {
    generateKeyPairSync('ml-kem-768' as never)
    return true
  } catch {
    return false
  }
}

const negotiated = new Map<string, Promise<string>>()

/** The key exchange TLS negotiates with `url`'s host: "X25519MLKEM768" (post-quantum hybrid), "X25519" (classical),
 * or null for plain http. Probed once per host per process. */
export function tlsKeyExchange(url: string): Promise<string | null> {
  const u = new URL(url)
  if (u.protocol !== 'https:') return Promise.resolve(null)
  const host = `${u.hostname}:${u.port || 443}`
  let p = negotiated.get(host)
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      const s = connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname, timeout: 5000 }, () => {
        resolve((s.getEphemeralKeyInfo() as { name?: string } | null)?.name ?? 'unknown')
        s.end()
      })
      s.on('timeout', () => s.destroy(new Error('TLS handshake timed out')))
      s.on('error', reject)
    }).catch((e) => {
      negotiated.delete(host) // probe again next time
      return `error: ${(e as Error).message}`
    })
    negotiated.set(host, p)
  }
  return p
}
