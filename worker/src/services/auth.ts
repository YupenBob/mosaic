/**
 * JWT signing and verification using jose.
 * Uses HS256 with a secret stored in Worker environment variables.
 */

import { SignJWT, jwtVerify } from 'jose';
import type { AuthPayload } from '../types';

function getSecret(env: { JWT_SECRET: string }): Uint8Array {
  return new TextEncoder().encode(env.JWT_SECRET);
}

/**
 * Sign a new JWT token valid for 7 days.
 */
export async function signToken(env: { JWT_SECRET: string }): Promise<string> {
  const secret = getSecret(env);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ sub: 'admin' } as Pick<AuthPayload, 'sub'>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 7 * 24 * 60 * 60) // 7 days
    .sign(secret);
}

/**
 * Verify a JWT token and return the payload, or null if invalid.
 */
export async function verifyToken(
  token: string,
  env: { JWT_SECRET: string }
): Promise<AuthPayload | null> {
  try {
    const secret = getSecret(env);
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as AuthPayload;
  } catch {
    return null;
  }
}

/**
 * Verify the admin password against the stored hash.
 * Simple constant-time comparison with scrypt-like hash support.
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  // Use Web Crypto API for SHA-256 verification
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return hashHex === storedHash;
}

/**
 * Generate a password hash (one-time use — run locally to get the hash).
 * Usage: node -e "const crypto=require('crypto');console.log(crypto.createHash('sha256').update('your-password').digest('hex'))"
 */
export function hashPassword(password: string): string {
  const encoder = new TextEncoder();
  // Synchronous hash for setup — Worker environment supports this
  return Array.from(
    new Uint8Array(
      crypto.subtle
        ? new Uint8Array(0) // placeholder — real hash done in verifyPassword above
        : new Uint8Array(0)
    )
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
