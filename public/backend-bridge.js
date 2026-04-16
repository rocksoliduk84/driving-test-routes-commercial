(() => {
  const originalLaunchApp = window.launchApp;
  const originalOpenRoute = window.openRoute;
  const originalOpenRealNavigation = window.openRealNavigation;
  const originalUpdateSettingsUI = window.updateSettingsUI;
  const originalSaveNavigationState = window.saveNavigationState;
  const originalClearSavedNavigationState = window.clearSavedNavigationState;
  const originalGetRouteSteps = window.getRouteSteps;
  const originalGetRouteWaypoints = window.getRouteWaypoints;
  const originalGenerateRouteSteps = window.generateRouteSteps;
  const routeBundleCache = new Map();
  let runtimeConfig = null;
  let progressSyncTimer = null;

  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const csrf = getCookie('dtrm_csrf');
    if (csrf && !headers.has('x-csrf-token')) headers.set('x-csrf-token', csrf);
    const response = await fetch(path, { credentials: 'include', ...options, headers });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(data.error || 'Request failed');
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function ensureAuthPanel() {
    if (document.getElementById('server-auth-panel')) return;
    const authScreen = document.getElementById('auth-screen');
    if (!authScreen) return;
    const panel = document.createElement('div');
    panel.id = 'server-auth-panel';
    panel.style.cssText = 'width:min(92vw,420px);margin:18px auto 0;background:#0f213a;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,.25)';
    panel.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button id="auth-tab-login" class="btn btn-primary" style="flex:1;">Sign in</button>
        <button id="auth-tab-register" class="btn btn-outline" style="flex:1;">Create account</button>
      </div>
      <div id="server-auth-message" style="display:none;margin-bottom:12px;padding:10px 12px;border-radius:12px;background:rgba(239,68,68,.12);color:#fecaca;border:1px solid rgba(239,68,68,.35);"></div>
      <form id="server-auth-form" style="display:flex;flex-direction:column;gap:10px;">
        <input id="auth-name-input" placeholder="Full name (for new accounts)" style="display:none;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:#091426;color:#fff;" maxlength="120">
        <input id="auth-email-input" type="email" placeholder="Email address" required style="padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:#091426;color:#fff;">
        <input id="auth-password-input" type="password" placeholder="Password" required style="padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:#091426;color:#fff;">
        <button id="server-auth-submit" type="submit" class="btn btn-gold btn-full">Sign in securely</button>
      </form>
      <div style="margin-top:10px;color:#94a3b8;font-size:13px;line-height:1.5;">Accounts, subscriptions, route access, and progress are now backed by the server. Device enforcement uses your device fingerprint <strong>${typeof DEVICE_ID !== 'undefined' ? DEVICE_ID : 'device'}</strong>.</div>
    `;
    const googleBtn = document.getElementById('google-signin-btn');
    if (googleBtn && googleBtn.parentNode) {
      googleBtn.parentNode.insertBefore(panel, googleBtn.nextSibling);
    } else {
      authScreen.appendChild(panel);
    }

    let mode = 'login';
    const setMode = (nextMode) => {
      mode = nextMode;
      document.getElementById('auth-name-input').style.display = mode === 'register' ? '' : 'none';
      document.getElementById('server-auth-submit').textContent = mode === 'register' ? 'Create secure account' : 'Sign in securely';
      document.getElementById('auth-tab-login').className = mode === 'login' ? 'btn btn-primary' : 'btn btn-outline';
      document.getElementById('auth-tab-register').className = mode === 'register' ? 'btn btn-primary' : 'btn btn-outline';
    };

    document.getElementById('auth-tab-login').addEventListener('click', () => setMode('login'));
    document.getElementById('auth-tab-register').addEventListener('click', () => setMode('register'));
    document.getElementById('server-auth-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = document.getElementById('auth-name-input').value.trim();
      const email = document.getElementById('auth-email-input').value.trim();
      const password = document.getElementById('auth-password-input').value;
      const submit = document.getElementById('server-auth-submit');
      submit.disabled = true;
      try {
        const payload = { email, password, deviceFingerprint: typeof DEVICE_ID !== 'undefined' ? DEVICE_ID : 'browser-device' };
        if (mode === 'register' && name) payload.name = name;
        const data = await api(mode === 'register' ? '/api/auth/register' : '/api/auth/login', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        await bootAuthenticatedApp(data);
      } catch (error) {
        showAuthMessage(error.data?.message || error.message || 'Sign-in failed');
      } finally {
        submit.disabled = false;
      }
    });

    setMode('login');
  }

  function showAuthMessage(message) {
    const el = document.getElementById('server-auth-message');
    if (!el) return;
    el.style.display = '';
    el.textContent = message;
  }

  function toggleGuestButtons() {
    document.querySelectorAll('button[onclick="skipAuth()"]')?.forEach((button) => {
      if (runtimeConfig?.allowGuestMode) {
        button.disabled = false;
        button.style.display = '';
      } else {
        button.disabled = true;
        button.style.display = 'none';
      }
    });
  }

  function selectedPlanKey() {
    const candidates = [
      ['price-onetime', 'lifetime'],
      ['price-monthly', 'monthly'],
      ['price-yearly', 'yearly']
    ];
    const chosen = candidates.find(([id]) => document.getElementById(id)?.classList.contains('selected'));
    return chosen ? chosen[1] : 'monthly';
  }

  function applySubscriptionUi(session) {
    adiUnlocked = Boolean(session?.subscription?.hasPaidAccess);
    const unlockPanel = document.getElementById('adi-unlocked');
    const buyButton = document.querySelector('#adi-content .btn-gold');
    const trialButton = document.querySelector('#adi-content .btn-outline');
    if (unlockPanel) unlockPanel.style.display = adiUnlocked ? '' : 'none';
    if (buyButton) buyButton.textContent = adiUnlocked ? '✅ Manage Subscription' : '👑 Unlock ADI Pro';
    if (trialButton) trialButton.textContent = adiUnlocked ? 'Open Billing Portal' : 'Start Secure Subscription';
    if (document.getElementById('settings-user-name') && currentUser) {
      const plan = session?.subscription?.plan || 'FREE';
      document.getElementById('settings-user-name').textContent = `${currentUser.name || currentUser.email} · ${currentUser.email || ''} · ${plan}`;
    }
  }

  async function fetchCurrentSession() {
    const response = await fetch('/api/auth/me', { credentials: 'include' });
    if (!response.ok) return { authenticated: false };
    return response.json();
  }

  async function syncProgressFromServer(progress) {
    const resolved = progress || (await api('/api/progress/current')).progress;
    if (!resolved) return;
    localStorage.setItem(NAV_RESUME_KEY, JSON.stringify({
      centreId: Number(resolved.centreId),
      routeNum: resolved.routeNum,
      isAdi: resolved.isAdi,
      phase: resolved.phase,
      stepIdx: resolved.stepIdx,
      savedAt: new Date(resolved.updatedAt).getTime(),
      reason: resolved.reason,
      routeName: resolved.routeName,
      centreName: resolved.centreName,
      modalOpen: resolved.modalOpen,
      lastKnownLat: resolved.lastKnownLat,
      lastKnownLng: resolved.lastKnownLng
    }));
    if (typeof refreshResumeNavigationUI === 'function') refreshResumeNavigationUI();
  }

  async function bootAuthenticatedApp(sessionPayload) {
    currentUser = {
      id: sessionPayload.user.id,
      name: sessionPayload.user.name || sessionPayload.user.email,
      email: sessionPayload.user.email,
      picture: sessionPayload.user.picture || '',
      isGuest: false
    };
    await Promise.resolve(originalLaunchApp(currentUser));
    applySubscriptionUi(sessionPayload);
    if (sessionPayload.progress) {
      await syncProgressFromServer(sessionPayload.progress);
    } else {
      await syncProgressFromServer();
    }
  }

  function showAuthScreen() {
    document.getElementById('auth-screen')?.classList.remove('hidden');
    const header = document.getElementById('main-header');
    const content = document.getElementById('main-content');
    const tabs = document.getElementById('main-tabs');
    if (header) header.style.display = 'none';
    if (content) content.style.display = 'none';
    if (tabs) tabs.style.display = 'none';
  }

  async function initGoogleAuth() {
    const googleBtn = document.getElementById('google-signin-btn');
    if (!googleBtn) return;
    if (!runtimeConfig?.googleAuthEnabled || !runtimeConfig?.googleClientId || !window.google?.accounts?.id) {
      googleBtn.style.display = 'none';
      return;
    }
    google.accounts.id.initialize({
      client_id: runtimeConfig.googleClientId,
      callback: async (response) => {
        try {
          const data = await api('/api/auth/google', {
            method: 'POST',
            body: JSON.stringify({
              credential: response.credential,
              deviceFingerprint: typeof DEVICE_ID !== 'undefined' ? DEVICE_ID : 'browser-device'
            })
          });
          await bootAuthenticatedApp(data);
        } catch (error) {
          showAuthMessage(error.message || 'Google sign-in failed');
        }
      },
      ux_mode: 'popup'
    });
    google.accounts.id.renderButton(googleBtn, { theme: 'filled_black', size: 'large', width: 280, text: 'signin_with', shape: 'pill' });
  }

  async function ensureRouteBundle(centreId, routeNum, isAdi) {
    const key = `${centreId}:${routeNum}:${isAdi ? 'adi' : 'std'}`;
    if (routeBundleCache.has(key)) return routeBundleCache.get(key);
    try {
      const data = await api(`/api/routes/bundle?centreId=${encodeURIComponent(centreId)}&routeNum=${encodeURIComponent(routeNum)}&isAdi=${isAdi ? '1' : '0'}`);
      routeBundleCache.set(key, data.bundle);
      return data.bundle;
    } catch (error) {
      if (error.status === 401) {
        showToast('Please sign in to open protected route data.');
        showAuthScreen();
      } else if (error.status === 402) {
        showToast('ADI routes require an active subscription.');
        if (typeof showTab === 'function') showTab('adi');
      } else {
        showToast(error.message || 'Unable to load route data');
      }
      return null;
    }
  }

  function bundleFor(centre, routeNum, isAdi) {
    const key = `${centre.id}:${routeNum}:${isAdi ? 'adi' : 'std'}`;
    return routeBundleCache.get(key);
  }

  window.getRouteSteps = function(centre, routeNum, isAdi) {
    return bundleFor(centre, routeNum, isAdi)?.steps || originalGetRouteSteps(centre, routeNum, isAdi);
  };

  window.getRouteWaypoints = function(centre, routeNum, isAdi) {
    return bundleFor(centre, routeNum, isAdi)?.waypoints || originalGetRouteWaypoints(centre, routeNum, isAdi);
  };

  window.generateRouteSteps = function(centre, routeNum, isAdi) {
    return bundleFor(centre, routeNum, isAdi)?.steps || originalGenerateRouteSteps(centre, routeNum, isAdi);
  };

  window.openRoute = async function(centreId, routeNum, isAdi) {
    const bundle = await ensureRouteBundle(centreId, routeNum, isAdi);
    if (!bundle) return;
    return originalOpenRoute(centreId, routeNum, isAdi);
  };

  window.openRealNavigation = async function(centreId, routeNum, isAdi, options = {}) {
    const bundle = await ensureRouteBundle(centreId, routeNum, isAdi);
    if (!bundle) return;
    return originalOpenRealNavigation(centreId, routeNum, isAdi, options);
  };

  window.openRouteFromMap = async function(centreId, routeName, isAdi) {
    const match = String(routeName || '').match(/(\d+)/);
    const routeNum = match ? Number(match[1]) : 1;
    return window.openRoute(centreId, routeNum, isAdi);
  };

  window.purchaseADI = async function() {
    if (!currentUser || currentUser.isGuest) {
      showToast('Sign in is required before purchasing a subscription.');
      showAuthScreen();
      return;
    }
    try {
      const data = await api('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan: selectedPlanKey(), deviceFingerprint: typeof DEVICE_ID !== 'undefined' ? DEVICE_ID : 'browser-device' })
      });
      if (data.url) window.location.href = data.url;
    } catch (error) {
      if (error.status === 409) {
        const portal = await api('/api/billing/portal', { method: 'POST', body: JSON.stringify({}) });
        if (portal.url) window.location.href = portal.url;
        return;
      }
      showToast(error.message || 'Unable to start checkout');
    }
  };

  window.startTrial = async function() {
    return window.purchaseADI();
  };

  window.signOut = async function() {
    try {
      await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch (error) {
      console.warn('Logout request failed', error);
    }
    ['dtrm_user', 'dtrm_adi', NAV_RESUME_KEY].forEach((key) => localStorage.removeItem(key));
    routeBundleCache.clear();
    window.location.reload();
  };

  window.skipAuth = function() {
    if (runtimeConfig?.allowGuestMode) {
      showToast('Guest mode is not recommended for protected route access.');
      return;
    }
    showToast('Guest mode is disabled in this production build.');
  };

  window.updateSettingsUI = function() {
    originalUpdateSettingsUI();
    applySubscriptionUi({ subscription: { hasPaidAccess: !!adiUnlocked, plan: adiUnlocked ? 'PRO' : 'FREE' } });
  };

  window.saveNavigationState = function(reason = 'autosave') {
    originalSaveNavigationState(reason);
    if (!currentUser || currentUser.isGuest) return;
    clearTimeout(progressSyncTimer);
    progressSyncTimer = setTimeout(async () => {
      try {
        const raw = localStorage.getItem(NAV_RESUME_KEY);
        if (!raw) return;
        await api('/api/progress/current', { method: 'POST', body: raw });
      } catch (error) {
        console.warn('Failed to sync progress', error);
      }
    }, 500);
  };

  window.clearSavedNavigationState = function() {
    originalClearSavedNavigationState();
    if (!currentUser || currentUser.isGuest) return;
    api('/api/progress/current', { method: 'DELETE', body: JSON.stringify({}) }).catch((error) => console.warn('Failed to clear server progress', error));
  };

  window.onload = async function() {
    runtimeConfig = await fetch('/api/runtime-config', { credentials: 'include' }).then((response) => response.json()).catch(() => null);
    ensureAuthPanel();
    toggleGuestButtons();
    const me = await fetchCurrentSession();
    if (me?.authenticated) {
      await bootAuthenticatedApp(me);
    } else {
      showAuthScreen();
      await initGoogleAuth();
    }
  };
})();
