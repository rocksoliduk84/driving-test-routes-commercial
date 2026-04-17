import { config } from '../config.js';
import { prisma } from '../db.js';
import {
  constantTimeEqual,
  csrfCookieOptions,
  getFingerprintFromRequest,
  hashIp,
  nowPlusDays,
  randomToken,
  safeUser,
  sessionCookieOptions,
  sha256,
  verifyPassword
} from '../utils/security.js';

export async function recordAuthEvent({ req, userId = null, email = null, eventType, outcome, metadata = null }) {
  try {
    await prisma.authEvent.create({
      data: {
        userId,
        email,
        eventType,
        outcome,
        ipHash: hashIp(req),
        userAgent: req.get('user-agent') || null,
        metadata
      }
    });
  } catch (error) {
    console.error('Failed to record auth event', error);
  }
}

function maxDevicesForUser(user) {
  return user.role === 'ADMIN' || user.activePlan === 'ENTERPRISE'
    ? config.maxEnterpriseDevices
    : config.maxDevicesPerUser;
}

export function hasPaidAccess(user) {
  return user.role === 'ADMIN' || user.activePlan === 'PRO' || user.activePlan === 'ENTERPRISE';
}

export async function resolveDeviceForUser(user, req, { forceTransfer = false } = {}) {
  const { raw, hash } = getFingerprintFromRequest(req);
  const ipHash = hashIp(req);
  const userAgent = req.get('user-agent') || null;

  let device = await prisma.device.findUnique({
    where: { userId_fingerprintHash: { userId: user.id, fingerprintHash: hash } }
  });

  const approvedDevices = await prisma.device.findMany({
    where: { userId: user.id, trustLevel: 'APPROVED', revokedAt: null },
    orderBy: { createdAt: 'asc' }
  });

  const alreadyApproved = device && device.trustLevel === 'APPROVED' && !device.revokedAt;
  const allowedSlots = maxDevicesForUser(user);

  if (forceTransfer) {
    await prisma.device.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { trustLevel: 'REVOKED', revokedAt: new Date() }
    });
    approvedDevices.length = 0;
  }

  if (!config.enforceDeviceLock || alreadyApproved || approvedDevices.length < allowedSlots) {
    device = await prisma.device.upsert({
      where: { userId_fingerprintHash: { userId: user.id, fingerprintHash: hash } },
      create: {
        userId: user.id,
        fingerprintHash: hash,
        label: raw.slice(0, 80),
        userAgent,
        lastIpHash: ipHash,
        trustLevel: 'APPROVED',
        approvedAt: new Date(),
        lastSeenAt: new Date()
      },
      update: {
        label: raw.slice(0, 80),
        userAgent,
        lastIpHash: ipHash,
        trustLevel: 'APPROVED',
        revokedAt: null,
        approvedAt: device?.approvedAt || new Date(),
        lastSeenAt: new Date()
      }
    });

    await prisma.user.update({ where: { id: user.id }, data: { activeDeviceId: device.id } });
    return { ok: true, device };
  }

  return {
    ok: false,
    error: 'DEVICE_LOCKED',
    message: 'This account is already linked to another approved device.',
    approvedDevices: approvedDevices.map((item) => ({ id: item.id, createdAt: item.createdAt, lastSeenAt: item.lastSeenAt, label: item.label }))
  };
}

export async function createSessionForUser(res, user, req, deviceId = null) {
  const token = randomToken(48);
  const csrfSecret = randomToken(24);
  await prisma.session.create({
    data: {
      userId: user.id,
      deviceId,
      tokenHash: sha256(token),
      csrfSecret,
      ipHash: hashIp(req),
      userAgent: req.get('user-agent') || null,
      expiresAt: nowPlusDays(config.sessionTtlDays)
    }
  });
  res.cookie(config.sessionCookieName, token, sessionCookieOptions());
  res.cookie(config.csrfCookieName, csrfSecret, csrfCookieOptions());
  return { csrfToken: csrfSecret };
}

export async function revokeCurrentSession(req, res) {
  const token = req.cookies?.[config.sessionCookieName];
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: sha256(token), revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
  res.clearCookie(config.sessionCookieName, { path: '/' });
  res.clearCookie(config.csrfCookieName, { path: '/' });
}

export async function authContext(req, _res, next) {
  const token = req.cookies?.[config.sessionCookieName];
  if (!token) return next();
  const tokenHash = sha256(token);
  const session = await prisma.session.findFirst({
    where: {
      tokenHash,
      revokedAt: null,
      expiresAt: { gt: new Date() }
    },
    include: { user: true, device: true }
  });
  if (!session || !session.user || session.user.status !== 'ACTIVE') return next();

  req.user = session.user;
  req.authSession = session;
  req.csrfToken = session.csrfSecret;

  const elapsedMs = Date.now() - new Date(session.lastSeenAt).getTime();
  if (elapsedMs > config.sessionRenewHours * 60 * 60 * 1000) {
    prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), expiresAt: nowPlusDays(config.sessionTtlDays) }
    }).catch((error) => console.error('Failed to renew session', error));
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  next();
}

export function requireCsrf(req, res, next) {
  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();
  const cookieToken = req.cookies?.[config.csrfCookieName];
  const headerToken = req.get('x-csrf-token') || req.body?.csrfToken;
  if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ error: 'CSRF validation failed.' });
  }
  next();
}

export async function requireRecentPassword(req, res, next) {
  if (!req.user?.passwordHash) return res.status(400).json({ error: 'Password re-authentication is not available for this account.' });
  const password = req.body?.password || '';
  const ok = await verifyPassword(password, req.user.passwordHash);
  if (!ok) return res.status(403).json({ error: 'Re-authentication failed.' });
  next();
}

export async function transferCurrentDevice(req, user) {
  const result = await resolveDeviceForUser(user, req, { forceTransfer: true });
  return result;
}

export const serializeSessionUser = (user) => safeUser(user);
