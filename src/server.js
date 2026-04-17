import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import path from 'path';
import Stripe from 'stripe';
import { OAuth2Client } from 'google-auth-library';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { config, billingEnabled } from './config.js';
import { prisma } from './db.js';
import {
  authContext,
  createSessionForUser,
  hasPaidAccess,
  recordAuthEvent,
  requireAuth,
  requireCsrf,
  requireRecentPassword,
  resolveDeviceForUser,
  revokeCurrentSession,
  serializeSessionUser,
  transferCurrentDevice
} from './middleware/auth.js';
import { apiRateLimit, authRateLimit } from './middleware/rate-limits.js';
import { findCentreById, getCentres, getRouteBundle } from './services/routes-data.js';
import { ensureStrongPassword, hashPassword, normalizeEmail, safeUser, verifyPassword } from './utils/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const stripe = billingEnabled ? new Stripe(config.stripeSecretKey) : null;
const googleClient = config.googleAuthEnabled && config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

const app = express();
app.set('trust proxy', 1);

function boolFromQuery(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function mapSubscriptionState(status) {
  switch (status) {
    case 'trialing': return 'TRIALING';
    case 'active': return 'ACTIVE';
    case 'past_due': return 'PAST_DUE';
    case 'canceled': return 'CANCELED';
    case 'unpaid': return 'UNPAID';
    default: return 'INACTIVE';
  }
}

function planConfig(plan) {
  const normalized = String(plan || 'monthly').toLowerCase();
  if (normalized === 'yearly' && config.stripePriceYearly) {
    return { mode: 'subscription', priceId: config.stripePriceYearly, planTier: 'PRO', planLabel: 'yearly' };
  }
  if ((normalized === 'lifetime' || normalized === 'onetime') && config.stripePriceLifetime) {
    return { mode: 'payment', priceId: config.stripePriceLifetime, planTier: 'PRO', planLabel: 'lifetime' };
  }
  if (config.stripePriceMonthly) {
    return { mode: 'subscription', priceId: config.stripePriceMonthly, planTier: 'PRO', planLabel: 'monthly' };
  }
  return null;
}

async function ensureStripeCustomer(user) {
  if (!stripe) throw new Error('Stripe is not configured');
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name || undefined,
    metadata: { userId: user.id }
  });
  await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

async function applySubscriptionState({ userId, customerId, subscriptionId = null, priceId = null, planTier = 'PRO', status = 'INACTIVE', currentPeriodEnd = null, cancelAtPeriodEnd = false, metadata = null }) {
  const nextState = mapSubscriptionState(status);
  if (subscriptionId) {
    await prisma.subscription.upsert({
      where: { providerSubscriptionId: subscriptionId },
      create: {
        userId,
        provider: 'stripe',
        providerCustomerId: customerId,
        providerSubscriptionId: subscriptionId,
        providerPriceId: priceId,
        planTier,
        status: nextState,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        metadata
      },
      update: {
        providerCustomerId: customerId,
        providerPriceId: priceId,
        planTier,
        status: nextState,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        metadata
      }
    });
  }

  const hasAccess = nextState === 'ACTIVE' || nextState === 'TRIALING';
  await prisma.user.update({
    where: { id: userId },
    data: {
      stripeCustomerId: customerId || undefined,
      activePlan: hasAccess ? planTier : 'FREE',
      planStatus: nextState
    }
  });
}

async function syncStripeSubscriptionFromObject(subscription, fallbackUserId = null) {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  let user = null;
  if (customerId) {
    user = await prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
  }
  if (!user && fallbackUserId) {
    user = await prisma.user.findUnique({ where: { id: fallbackUserId } });
  }
  if (!user) return;
  await applySubscriptionState({
    userId: user.id,
    customerId,
    subscriptionId: subscription.id,
    priceId,
    planTier: 'PRO',
    status: subscription.status,
    currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    metadata: subscription.metadata || null
  });
}

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !config.stripeWebhookSecret) {
    return res.status(503).send('Stripe webhook not configured');
  }
  let event;
  try {
    const signature = req.get('stripe-signature');
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId || null;
        if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await syncStripeSubscriptionFromObject(subscription, userId);
        }
        if (session.mode === 'payment' && userId) {
          const user = await prisma.user.findUnique({ where: { id: userId } });
          if (user) {
            await applySubscriptionState({
              userId: user.id,
              customerId: typeof session.customer === 'string' ? session.customer : null,
              planTier: 'PRO',
              status: 'active',
              metadata: session.metadata || null
            });
          }
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncStripeSubscriptionFromObject(event.data.object);
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          await syncStripeSubscriptionFromObject(subscription);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          await syncStripeSubscriptionFromObject(subscription);
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handling failed', error);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(authContext);
app.use('/api', apiRateLimit);

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
  name: z.string().trim().min(1).max(120).optional(),
  deviceFingerprint: z.string().min(3).max(200)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
  deviceFingerprint: z.string().min(3).max(200)
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'driving-test-routes-api' });
});

app.get('/api/runtime-config', (_req, res) => {
  res.json({
    appName: 'Driving Test Routes Master',
    googleAuthEnabled: config.googleAuthEnabled,
    googleClientId: config.googleClientId,
    allowGuestMode: config.allowGuestMode,
    billingEnabled,
    supportEmail: config.supportEmail,
    enforceDeviceLock: config.enforceDeviceLock
  });
});

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please provide a valid email, password, and device fingerprint.' });
  }
  const { email, password, name } = parsed.data;
  const normalizedEmail = normalizeEmail(email);
  const passwordIssue = ensureStrongPassword(password);
  if (passwordIssue) return res.status(400).json({ error: passwordIssue });

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    await recordAuthEvent({ req, email: normalizedEmail, userId: existing.id, eventType: 'register', outcome: 'duplicate' });
    return res.status(409).json({ error: 'An account already exists for that email.' });
  }

  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash: await hashPassword(password),
      name: name || null,
      emailVerifiedAt: new Date()
    }
  });

  const device = await resolveDeviceForUser(user, req);
  if (!device.ok) {
    return res.status(423).json(device);
  }

  const session = await createSessionForUser(res, user, req, device.device.id);
  await recordAuthEvent({ req, email: normalizedEmail, userId: user.id, eventType: 'register', outcome: 'success' });
  res.status(201).json({
    authenticated: true,
    user: serializeSessionUser(user),
    csrfToken: session.csrfToken,
    subscription: { plan: user.activePlan, status: user.planStatus, hasPaidAccess: hasPaidAccess(user) }
  });
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid email or password.' });
  }
  const { email, password } = parsed.data;
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    await recordAuthEvent({ req, email: normalizedEmail, userId: user?.id || null, eventType: 'login', outcome: 'failed' });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (user.status !== 'ACTIVE') {
    await recordAuthEvent({ req, email: normalizedEmail, userId: user.id, eventType: 'login', outcome: 'blocked_status' });
    return res.status(403).json({ error: 'This account is not allowed to sign in.' });
  }

  const device = await resolveDeviceForUser(user, req);
  if (!device.ok) {
    await recordAuthEvent({ req, email: normalizedEmail, userId: user.id, eventType: 'login', outcome: 'device_locked', metadata: { approvedDevices: device.approvedDevices } });
    return res.status(423).json(device);
  }

  const session = await createSessionForUser(res, user, req, device.device.id);
  await recordAuthEvent({ req, email: normalizedEmail, userId: user.id, eventType: 'login', outcome: 'success' });
  res.json({
    authenticated: true,
    user: serializeSessionUser(user),
    csrfToken: session.csrfToken,
    subscription: { plan: user.activePlan, status: user.planStatus, hasPaidAccess: hasPaidAccess(user) }
  });
});

app.post('/api/auth/google', authRateLimit, async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'Google sign-in is not enabled.' });
  const credential = String(req.body?.credential || '');
  if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });

  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) {
      return res.status(400).json({ error: 'Invalid Google identity payload.' });
    }
    if (config.allowedGoogleHd && payload.hd !== config.allowedGoogleHd) {
      return res.status(403).json({ error: 'This Google Workspace domain is not allowed.' });
    }

    const email = normalizeEmail(payload.email);
    let user = await prisma.user.findFirst({ where: { OR: [{ googleSub: payload.sub }, { email }] } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          googleSub: payload.sub,
          name: payload.name || payload.given_name || email,
          picture: payload.picture || null,
          emailVerifiedAt: new Date()
        }
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleSub: payload.sub,
          name: payload.name || user.name,
          picture: payload.picture || user.picture,
          emailVerifiedAt: user.emailVerifiedAt || new Date()
        }
      });
    }

    const device = await resolveDeviceForUser(user, req);
    if (!device.ok) {
      await recordAuthEvent({ req, email, userId: user.id, eventType: 'google_login', outcome: 'device_locked' });
      return res.status(423).json(device);
    }

    const session = await createSessionForUser(res, user, req, device.device.id);
    await recordAuthEvent({ req, email, userId: user.id, eventType: 'google_login', outcome: 'success' });
    res.json({
      authenticated: true,
      user: serializeSessionUser(user),
      csrfToken: session.csrfToken,
      subscription: { plan: user.activePlan, status: user.planStatus, hasPaidAccess: hasPaidAccess(user) }
    });
  } catch (error) {
    console.error('Google sign-in failed', error);
    res.status(401).json({ error: 'Google sign-in failed.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.user) {
    return res.json({ authenticated: false });
  }
  const [devices, progress] = await Promise.all([
    prisma.device.findMany({
      where: { userId: req.user.id, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, label: true, trustLevel: true, createdAt: true, lastSeenAt: true }
    }),
    prisma.userProgress.findFirst({ where: { userId: req.user.id }, orderBy: { updatedAt: 'desc' } })
  ]);

  res.json({
    authenticated: true,
    user: safeUser(req.user),
    csrfToken: req.csrfToken,
    subscription: { plan: req.user.activePlan, status: req.user.planStatus, hasPaidAccess: hasPaidAccess(req.user) },
    devices,
    progress
  });
});

app.post('/api/auth/logout', requireAuth, requireCsrf, async (req, res) => {
  await revokeCurrentSession(req, res);
  await recordAuthEvent({ req, email: req.user.email, userId: req.user.id, eventType: 'logout', outcome: 'success' });
  res.json({ ok: true });
});

app.post('/api/auth/device/transfer', requireAuth, requireCsrf, async (req, res, next) => {
  try {
    if (req.user.passwordHash) {
      await requireRecentPassword(req, res, async () => {
        const result = await transferCurrentDevice(req, req.user);
        res.json({ ok: true, device: result.device || null });
      });
      return;
    }
    const result = await transferCurrentDevice(req, req.user);
    res.json({ ok: true, device: result.device || null });
  } catch (error) {
    next(error);
  }
});

app.get('/api/routes/centres', (_req, res) => {
  res.json({
    centres: getCentres().map((centre) => ({
      ...centre,
      standardRouteCount: 15,
      adiRouteCount: 7
    }))
  });
});

app.get('/api/routes/bundle', requireAuth, async (req, res) => {
  const centreId = Number.parseInt(String(req.query.centreId || ''), 10);
  const routeNum = Number.parseInt(String(req.query.routeNum || '1'), 10) || 1;
  const isAdi = boolFromQuery(req.query.isAdi);
  const centre = findCentreById(centreId);
  if (!centre) return res.status(404).json({ error: 'Test centre not found.' });
  if (isAdi && !hasPaidAccess(req.user)) {
    return res.status(402).json({ error: 'An active subscription is required for ADI routes.' });
  }
  const bundle = getRouteBundle(centreId, routeNum, isAdi);
  await recordAuthEvent({ req, email: req.user.email, userId: req.user.id, eventType: 'route_access', outcome: 'success', metadata: { centreId, routeNum, isAdi } });
  res.json({ bundle });
});

app.get('/api/progress/current', requireAuth, async (req, res) => {
  const progress = await prisma.userProgress.findFirst({
    where: { userId: req.user.id },
    orderBy: { updatedAt: 'desc' }
  });
  res.json({ progress });
});

app.post('/api/progress/current', requireAuth, requireCsrf, async (req, res) => {
  const payload = req.body || {};
  const centreId = String(payload.centreId || '');
  const routeNum = Number.parseInt(String(payload.routeNum || '1'), 10) || 1;
  const isAdi = Boolean(payload.isAdi);
  if (!centreId) return res.status(400).json({ error: 'centreId is required.' });
  const centre = findCentreById(Number.parseInt(centreId, 10));
  const routeName = payload.routeName || `${isAdi ? 'ADI Route' : 'Standard Route'} ${routeNum}`;
  const centreName = payload.centreName || centre?.name || 'Unknown Centre';

  const progress = await prisma.userProgress.upsert({
    where: { userId_centreId_routeNum_isAdi: { userId: req.user.id, centreId, routeNum, isAdi } },
    create: {
      userId: req.user.id,
      centreId,
      routeNum,
      isAdi,
      phase: Number.parseInt(String(payload.phase || '1'), 10) || 1,
      stepIdx: Number.parseInt(String(payload.stepIdx || '0'), 10) || 0,
      routeName,
      centreName,
      modalOpen: Boolean(payload.modalOpen),
      reason: payload.reason || null,
      lastKnownLat: payload.lastKnownLat ?? null,
      lastKnownLng: payload.lastKnownLng ?? null,
      payload
    },
    update: {
      phase: Number.parseInt(String(payload.phase || '1'), 10) || 1,
      stepIdx: Number.parseInt(String(payload.stepIdx || '0'), 10) || 0,
      routeName,
      centreName,
      modalOpen: Boolean(payload.modalOpen),
      reason: payload.reason || null,
      lastKnownLat: payload.lastKnownLat ?? null,
      lastKnownLng: payload.lastKnownLng ?? null,
      payload
    }
  });
  res.json({ ok: true, progress });
});

app.delete('/api/progress/current', requireAuth, requireCsrf, async (req, res) => {
  const centreId = req.body?.centreId ? String(req.body.centreId) : null;
  if (centreId) {
    await prisma.userProgress.deleteMany({ where: { userId: req.user.id, centreId } });
  } else {
    await prisma.userProgress.deleteMany({ where: { userId: req.user.id } });
  }
  res.json({ ok: true });
});

app.post('/api/billing/checkout', requireAuth, requireCsrf, async (req, res) => {
  if (!billingEnabled || !stripe) {
    return res.status(503).json({ error: 'Billing is not configured yet.' });
  }
  const selectedPlan = planConfig(req.body?.plan);
  if (!selectedPlan) return res.status(400).json({ error: 'Selected plan is not configured.' });
  if (hasPaidAccess(req.user) && req.user.activePlan !== 'FREE') {
    return res.status(409).json({ error: 'This account already has an active paid subscription.' });
  }
  const customerId = await ensureStripeCustomer(req.user);
  const session = await stripe.checkout.sessions.create({
    mode: selectedPlan.mode,
    customer: customerId,
    line_items: [{ price: selectedPlan.priceId, quantity: 1 }],
    success_url: config.checkoutSuccessUrl,
    cancel_url: config.checkoutCancelUrl,
    allow_promotion_codes: true,
    metadata: { userId: req.user.id, plan: selectedPlan.planLabel },
    subscription_data: selectedPlan.mode === 'subscription' ? { metadata: { userId: req.user.id, plan: selectedPlan.planLabel } } : undefined
  });
  res.json({ url: session.url });
});

app.post('/api/billing/portal', requireAuth, requireCsrf, async (req, res) => {
  if (!stripe || !req.user.stripeCustomerId) {
    return res.status(400).json({ error: 'Billing portal is not available for this account.' });
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: req.user.stripeCustomerId,
    return_url: config.billingPortalReturnUrl
  });
  res.json({ url: session.url });
});

app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

async function start() {
  try {
    await prisma.$connect();
    app.listen(config.port, () => {
      console.log(`Driving Test Routes server listening on port ${config.port}`);
    });
  } catch (error) {
    console.error('Failed to start server', error);
    process.exit(1);
  }
}

start();
