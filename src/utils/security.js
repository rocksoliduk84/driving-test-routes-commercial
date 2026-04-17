import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { config, isProduction } from '../config.js';

export const normalizeEmail = (email = '') => String(email).trim().toLowerCase();
export const sha256 = (value = '') => crypto.createHash('sha256').update(String(value)).digest('hex');
export const hashPassword = async (password) => bcrypt.hash(password, config.bcryptRounds);
export const verifyPassword = async (password, passwordHash) => {
  if (!passwordHash) return false;
  return bcrypt.compare(password, passwordHash);
};
export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');
export const nowPlusDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
export const nowPlusHours = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000);
export const safeUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  picture: user.picture,
  role: user.role,
  status: user.status,
  activePlan: user.activePlan,
  planStatus: user.planStatus,
  emailVerifiedAt: user.emailVerifiedAt,
  mfaEnabled: user.mfaEnabled,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt
});
export const getIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
};
export const hashIp = (req) => sha256(getIp(req));
export const getFingerprintFromRequest = (req) => {
  const header = req.headers['x-device-fingerprint'];
  const bodyValue = req.body?.deviceFingerprint || req.body?.deviceId || req.query?.deviceFingerprint;
  const raw = header || bodyValue || 'unknown-device';
  return { raw: String(raw), hash: sha256(String(raw)) };
};
export const sessionCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  path: '/',
  maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000
});
export const csrfCookieOptions = () => ({
  httpOnly: false,
  sameSite: 'lax',
  secure: isProduction,
  path: '/',
  maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000
});
export const ensureStrongPassword = (password = '') => {
  const value = String(password);
  if (value.length < 12) {
    return 'Password must be at least 12 characters long.';
  }
  if (value.length > 128) {
    return 'Password must be 128 characters or fewer.';
  }
  return null;
};
export const constantTimeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};
