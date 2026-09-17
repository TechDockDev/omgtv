import bcrypt from "bcryptjs";

// Lower than password hashing (12) on purpose: a 4-digit PIN's brute-force
// resistance comes from the 5-attempt lockout (customer-service.ts), not hash
// cost — cost 12 adds ~100-300ms per check for no real security benefit here,
// and this endpoint needs to feel instant to the user.
const SALT_ROUNDS = 8;

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, SALT_ROUNDS);
}

export async function verifyPinHash(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}
