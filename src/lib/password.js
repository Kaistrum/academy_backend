import bcrypt from 'bcryptjs';
import env from '../config/env.js';

export function hashPassword(plain) {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) {
    // OAuth-only account: still burn a comparable amount of time so the
    // response doesn't reveal whether the address has a password set.
    await bcrypt.compare(plain, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    return false;
  }
  return bcrypt.compare(plain, hash);
}
