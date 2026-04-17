import 'dotenv/config';

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL || '',
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'dtrm_sid',
  csrfCookieName: process.env.CSRF_COOKIE_NAME || 'dtrm_csrf',
  sessionTtlDays: toInt(process.env.SESSION_TTL_DAYS, 30),
  sessionRenewHours: toInt(process.env.SESSION_RENEW_HOURS, 12),
  bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),
  allowGuestMode: toBool(process.env.ALLOW_GUEST_MODE, false),
  enforceDeviceLock: toBool(process.env.ENFORCE_DEVICE_LOCK, true),
  maxDevicesPerUser: toInt(process.env.MAX_DEVICES_PER_USER, 1),
  maxEnterpriseDevices: toInt(process.env.MAX_ENTERPRISE_DEVICES, 10),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleAuthEnabled: toBool(process.env.GOOGLE_AUTH_ENABLED, false),
  allowedGoogleHd: process.env.ALLOWED_GOOGLE_HD || '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePriceMonthly: process.env.STRIPE_PRICE_MONTHLY || '',
  stripePriceYearly: process.env.STRIPE_PRICE_YEARLY || '',
  stripePriceLifetime: process.env.STRIPE_PRICE_LIFETIME || '',
  billingPortalReturnUrl: process.env.BILLING_PORTAL_RETURN_URL || 'http://localhost:3000/#settings',
  checkoutSuccessUrl: process.env.CHECKOUT_SUCCESS_URL || 'http://localhost:3000/#adi',
  checkoutCancelUrl: process.env.CHECKOUT_CANCEL_URL || 'http://localhost:3000/#adi',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@example.com'
};

export const isProduction = config.nodeEnv === 'production';
export const billingEnabled = Boolean(config.stripeSecretKey && (config.stripePriceMonthly || config.stripePriceYearly || config.stripePriceLifetime));
