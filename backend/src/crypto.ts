import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
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
