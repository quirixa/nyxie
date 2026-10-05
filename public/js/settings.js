// settings.js — account/profile/appearance settings view. Ported from
// settings.html's inline <script>. Wrapped in initSettingsView() so the
// router can call it right after the #view-settings template is in the
// DOM, instead of it auto-running at script-parse time.

function initSettingsView() {

  // ---- State ----
  const API = '';
  // token / currentUser live in state.js (shared with dashboard.js);
  // refresh them from storage each time this view mounts.
  token = localStorage.getItem('nyxie_token');
  currentUser = JSON.parse(localStorage.getItem('nyxie_user') || 'null');
  let emailVisible = false;
  let _pendingAvatarDecoration = null;
  let _pendingCardDecoration = null;
  let _shop = null; // last GET /api/shop response

  if (!token || !currentUser) { router.navigate('/login'); return; }

  // ---- Helpers ----
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => el.style.opacity = '0', 2500);
  }

  function logout() {
    clearSession();
    router.navigate('/login');
  }

  function goBack() {
    router.navigate('/app');
  }

  async function api(method, path, body) {
    try {
      const res = await fetch(API + '/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: body ? JSON.stringify(body) : undefined
      });
      if (res.status === 401) { logout(); return null; }
      if (res.status === 403) {
        const data = await res.json();
        if (data.disabled) {
          toast('Account disabled. Please re‑enable it by logging in.');
        }
        return data;
      }
      return res.json();
    } catch {
      return null;
    }
  }

  function isMobileLayout() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function showSettingsList() {
    document.querySelector('.settings-container').classList.remove('mobile-tab-active');
  }

  // ---- Tab switching ----
  function switchTab(tab) {
    document.querySelectorAll('.settings-sidebar .nav-item-settings').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    document.querySelectorAll('.settings-tab').forEach(el => {
      el.style.display = el.id === 'tab-' + tab ? 'block' : 'none';
    });
    if (isMobileLayout()) document.querySelector('.settings-container').classList.add('mobile-tab-active');
    if (tab === 'language') initLanguageSettings();
    if (tab !== 'voice') stopMicTest();
    if (tab === 'my-account') refresh2fa();
    else if (tab === 'sessions') refreshSessions();
    else if (tab === 'voice') loadVoiceSettings();
    else if (tab === 'profile') {
      // The decoration shop is rendered by JS, so it must (re)load whenever
      // this tab is opened. Keep any unsaved selection the user already made.
      if (_pendingAvatarDecoration === null) _pendingAvatarDecoration = currentUser.avatar_decoration || 'none';
      if (_pendingCardDecoration === null) _pendingCardDecoration = currentUser.card_decoration || 'none';
      renderShop();
      loadShop();
    }
    else if (tab === 'sync') loadSyncTab();
    else if (tab === 'experiments') renderExperiments();
    else if (tab === 'bots') refreshBots();
    else if (tab === 'feedback') loadFeedbackTab();
    else if (tab === 'changelogs') renderChangelog();
    else if (tab === 'source' || tab === 'donate') loadLinkTabs();
  }

  // ---- Load user data ----
  function hashColor(name) {
    const colors = ['#fd6671', '#eb459e', '#ed4245', '#3ba55c', '#faa61a', '#1abc9c', '#e67e22', '#9b59b6'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
    return colors[Math.abs(h) % colors.length];
  }

  function applyBannerStyle(el, user) {
    if (!el || !user) return;
    if (user.banner) {
      el.style.background = `url("${versionedMediaUrl(user.banner)}") center/cover no-repeat`;
    } else if (user.banner_color) {
      el.style.background = user.banner_color;
    } else {
      el.style.background = 'linear-gradient(135deg, var(--accent), var(--accent-hover))';
    }
  }

  // ---- Profile form functions ----
  function loadProfileForm() {
    const name = currentUser.display_name || currentUser.username;
    const avatarEl = document.getElementById('profile-avatar-preview');
    const letterEl = document.getElementById('profile-avatar-letter');
    if (currentUser.avatar) {
      avatarEl.innerHTML = `<img src="${escapeHtml(versionedMediaUrl(currentUser.avatar))}" style="width:100%;height:100%;object-fit:cover;" />`;
      letterEl.style.display = 'none';
    } else {
      avatarEl.innerHTML = `<span id="profile-avatar-letter">${name[0].toUpperCase()}</span>`;
      avatarEl.style.background = hashColor(name);
      letterEl.style.display = 'block';
    }

    applyBannerStyle(document.getElementById('profile-banner-preview'), currentUser);
    document.querySelectorAll('.banner-swatch').forEach(s => {
      s.classList.toggle('active', !!currentUser.banner_color && s.dataset.color.toLowerCase() === currentUser.banner_color.toLowerCase());
    });
    if (currentUser.banner_color) {
      document.getElementById('profile-banner-color-custom').value = currentUser.banner_color;
    }

    document.getElementById('profile-display-name').value = currentUser.display_name || '';
    updateDisplayNameCounter();
    document.getElementById('profile-bio').value = currentUser.bio || '';
    updateBioCounter();
    // Profile effect preview: only for admin-authorised users.
    const fxHost = document.getElementById('profile-avatar-fx-host');
    if (fxHost && window.NyxFx) {
      fxHost.dataset.fxUid = currentUser.id;
      window.NyxFx.setAvatarFx(fxHost, !!currentUser.profile_effect, true);
    }
    _pendingAvatarDecoration = currentUser.avatar_decoration || 'none';
    _pendingCardDecoration = currentUser.card_decoration || 'none';
    renderShop();   // paint immediately from whatever we have...
    loadShop();     // ...then refresh ownership/balance from the server
  }

  function updateDisplayNameCounter() {
    const val = document.getElementById('profile-display-name').value;
    document.getElementById('display-name-counter').textContent = val.length;
  }

  function updateBioCounter() {
    const val = document.getElementById('profile-bio').value;
    document.getElementById('bio-counter').textContent = val.length;
  }

  // ---- Cosmetics shop (avatar + card decorations, bought with NX) ----
  // Ownership is decided by the server; the client only reflects it. A tile
  // is selectable only if owned (or 'none'); everything else shows a Buy button.
  async function loadShop() {
    const data = await api('GET', '/shop');
    if (data && !data.error && Array.isArray(data.items)) {
      _shop = data;
      renderShop();
    }
  }

  function shopSlot(type) {
    return type === 'avatar_decoration'
      ? { pending: () => _pendingAvatarDecoration, el: 'avatar-decoration-picker', pick: 'selectAvatarDecoration', label: 'None' }
      : { pending: () => _pendingCardDecoration, el: 'card-decoration-picker', pick: 'selectCardDecoration', label: 'None' };
  }

  function tileHtml(type, item) {
    const slot = shopSlot(type);
    const id = item ? item.id : 'none';
    const name = item ? item.name : 'None';
    const owned = !item || item.owned;
    const active = slot.pending() === id;
    const preview = type === 'avatar_decoration'
      ? `<span class="decoration-preview decoration-${id}"><span></span></span>`
      : `<span class="card-deco-preview" data-card-decoration="${id}"></span>`;
    let footer;
    if (owned) {
      footer = `<span class="shop-state">${active ? 'Selected' : (item ? 'Owned' : '')}</span>`;
    } else {
      const afford = !_shop || _shop.balance >= item.price;
      footer = `<button type="button" class="shop-buy-btn ${afford ? '' : 'cant'}" onclick="event.stopPropagation(); buyCosmetic('${id}')">${item.priceDisplay.replace(/\.00$/, '')} NX</button>`;
    }
    const attrs = owned ? `class="shop-tile selectable${active ? ' active' : ''}" role="button" tabindex="0" onclick="${slot.pick}('${id}')"` : 'class="shop-tile"';
    return `<div ${attrs} title="${escapeHtml(item ? item.description : 'No decoration')}"><span class="shop-name">${escapeHtml(name)}</span>${preview}${footer}</div>`;
  }

  function renderShop() {
    const bal = document.getElementById('shop-balance');
    if (bal) bal.innerHTML = `Balance: <strong>${_shop ? escapeHtml(_shop.balanceDisplay) : '…'}</strong> NX`;
    ['avatar_decoration', 'card_decoration'].forEach(type => {
      const grid = document.getElementById(shopSlot(type).el);
      if (!grid) return;
      const items = _shop ? _shop.items.filter(i => i.type === type) : [];
      grid.innerHTML = tileHtml(type, null) + items.map(i => tileHtml(type, i)).join('');
    });
  }

  function setShopError(msg) {
    const el = document.getElementById('shop-error');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }

  function ownsInShop(id) {
    return id === 'none' || !!(_shop && _shop.items.some(i => i.id === id && i.owned));
  }

  function selectAvatarDecoration(id) {
    if (!ownsInShop(id)) return;
    _pendingAvatarDecoration = id;
    renderShop();
  }
  function selectCardDecoration(id) {
    if (!ownsInShop(id)) return;
    _pendingCardDecoration = id;
    renderShop();
  }

  async function buyCosmetic(id) {
    const item = _shop && _shop.items.find(i => i.id === id);
    if (!item) return;
    setShopError('');
    if (!confirm(`Buy "${item.name}" for ${item.priceDisplay} NX?`)) return;
    const res = await api('POST', `/shop/items/${encodeURIComponent(id)}/purchase`);
    if (!res || res.error) {
      setShopError(res?.error || 'Purchase failed. Please try again.');
      return;
    }
    _shop = res.shop;
    // Pre-select what they just bought; it's only worn once they hit Save.
    if (item.type === 'avatar_decoration') _pendingAvatarDecoration = id; else _pendingCardDecoration = id;
    renderShop();
    toast(`Bought ${item.name}! Hit Save to wear it.`);
  }

  let _pendingBannerColor = null;

  function setProfileBannerColor(color) {
    _pendingBannerColor = color;
    document.querySelectorAll('.banner-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color.toLowerCase() === color.toLowerCase());
    });
    document.getElementById('profile-banner-color-custom').value = color;
    document.getElementById('profile-banner-preview').style.background = color;
  }

  async function uploadProfileAvatar(file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('avatar', file);
    try {
      const res = await fetch('/api/users/avatar', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: formData
      });
      const data = await res.json();
      if (data.ok) {
        currentUser.avatar = data.avatar;
        if (data.avatar) versionedMediaUrl(data.avatar, true); // force fresh fetch, see utils.js
        localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
        loadProfileForm();
        toast('Avatar updated');
      } else {
        toast(data.error || 'Upload failed');
      }
    } catch (err) {
      toast('Upload error');
    }
  }

  async function removeProfileAvatar() {
    toast('Remove avatar not implemented, but you can upload a new one.');
  }

  async function uploadProfileBanner(file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('banner', file);
    try {
      const res = await fetch('/api/users/banner', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: formData
      });
      const data = await res.json();
      if (data.ok) {
        currentUser.banner = data.banner;
        currentUser.banner_color = null;
        _pendingBannerColor = null;
        if (data.banner) versionedMediaUrl(data.banner, true); // force fresh fetch, see utils.js
        localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
        document.querySelectorAll('.banner-swatch').forEach(s => s.classList.remove('active'));
        loadProfileForm();
        toast('Banner updated');
      } else {
        toast(data.error || 'Upload failed');
      }
    } catch (err) {
      toast('Upload error');
    }
  }

  async function removeProfileBanner() {
    try {
      const res = await fetch('/api/users/banner', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      });
      const data = await res.json();
      if (data.ok) {
        currentUser.banner = null;
        currentUser.banner_color = null;
        _pendingBannerColor = null;
        localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
        document.querySelectorAll('.banner-swatch').forEach(s => s.classList.remove('active'));
        loadProfileForm();
        toast('Banner removed');
      } else {
        toast(data.error || 'Failed to remove banner');
      }
    } catch (err) {
      toast('Error removing banner');
    }
  }

  function resetProfileForm() {
    loadProfileForm();
    _pendingBannerColor = null;
    toast('Form reset');
  }

  async function saveProfileChanges() {
    const displayName = document.getElementById('profile-display-name').value.trim();
    const bio = document.getElementById('profile-bio').value.trim();

    if (displayName.length > 32) {
      toast('Display name too long (max 32)');
      return;
    }
    if (bio.length > 500) {
      toast('Bio too long (max 500)');
      return;
    }

    const payload = {};
    if (displayName !== currentUser.display_name) payload.display_name = displayName;
    if (bio !== (currentUser.bio || '')) payload.bio = bio;
    const selectedDecoration = _pendingAvatarDecoration || 'none';
    if (selectedDecoration !== (currentUser.avatar_decoration || 'none')) {
      payload.avatar_decoration = selectedDecoration;
    }
    const selectedCard = _pendingCardDecoration || 'none';
    if (selectedCard !== (currentUser.card_decoration || 'none')) {
      payload.card_decoration = selectedCard;
    }
    if (_pendingBannerColor !== null && _pendingBannerColor !== (currentUser.banner_color || '')) {
      payload.banner_color = _pendingBannerColor;
    }

    if (Object.keys(payload).length === 0) {
      toast('No changes to save');
      return;
    }

    const saveBtn = document.querySelector('.profile-actions .btn-primary');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const res = await api('PATCH', '/users/me', payload);
      if (res?.error) { toast(res.error); return; }
      if (res.user) {
        currentUser.display_name = res.user.display_name;
        currentUser.bio = res.user.bio;
        currentUser.banner_color = res.user.banner_color;
        currentUser.banner = res.user.banner;
        currentUser.avatar_decoration = res.user.avatar_decoration || 'none';
        currentUser.card_decoration = res.user.card_decoration || 'none';
        localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
        _pendingBannerColor = null;
        toast('Profile updated');
        loadProfileForm();
        loadUserData();
    initLanguageSettings();
      }
    } catch (err) {
      toast(err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  // ---- Load user data for display ----
  async function loadUserData() {
    const data = await api('GET', '/auth/me');
    if (data?.user) {
      currentUser = data.user;
      localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
    }
    document.getElementById('settings-username').textContent = '@' + currentUser.username;
    Badges.renderInto(document.getElementById('settings-badges'), currentUser.id, { size: 'md', empty: 'None yet' });
    emailVisible = false;
    document.getElementById('settings-email').textContent = '••••••••';
    if (document.getElementById('tab-profile').style.display !== 'none') {
      loadProfileForm();
    }
  }

  // ---- Other account actions (unchanged) ----
  function toggleEmailVisibility() {
    emailVisible = !emailVisible;
    const el = document.getElementById('settings-email');
    if (emailVisible) {
      el.textContent = currentUser.email || 'user@example.com';
    } else {
      el.textContent = '••••••••';
    }
  }

  function openChangeUsername() {
    document.getElementById('change-username-modal').style.display = 'flex';
    document.getElementById('new-username-input').value = '';
    document.getElementById('new-username-input').focus();
  }

  async function saveUsername() {
    const input = document.getElementById('new-username-input');
    const newUsername = input.value.trim();
    if (!newUsername) { toast('Please enter a username'); return; }
    if (newUsername.length < 3 || newUsername.length > 30 || !/^[a-zA-Z0-9_-]+$/.test(newUsername)) {
      toast('Invalid username (3-30 chars, letters, numbers, _ or -)');
      return;
    }
    if (await ReservedUsernames.isReserved(newUsername)) {
      toast('Username not available');
      return;
    }
    const check = await api('GET', `/users/search?q=${encodeURIComponent(newUsername)}`);
    if (check?.users?.some(u => u.username.toLowerCase() === newUsername.toLowerCase() && u.id !== currentUser.id)) {
      toast('Username already taken');
      return;
    }
    const res = await api('PATCH', '/users/me', { username: newUsername });
    if (res?.error) { toast(res.error); return; }
    if (res.user) {
      currentUser.username = res.user.username;
      localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
      toast('Username updated');
      document.getElementById('change-username-modal').style.display = 'none';
      document.getElementById('settings-username').textContent = '@' + currentUser.username;
      loadProfileForm();
    }
  }

  function openChangeEmail() {
    document.getElementById('change-email-modal').style.display = 'flex';
    document.getElementById('new-email-input').value = '';
    document.getElementById('email-current-password').value = '';
    document.getElementById('new-email-input').focus();
  }

  async function saveEmail() {
    const email = document.getElementById('new-email-input').value.trim().toLowerCase();
    const password = document.getElementById('email-current-password').value;
    if (!email) { toast('Please enter an email'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast('Invalid email address');
      return;
    }
    if (!password) { toast('Current password is required to change email'); return; }
    const res = await api('PATCH', '/users/me', { email, current_password: password });
    if (res?.error) { toast(res.error); return; }
    if (res.user) {
      currentUser.email = res.user.email;
      localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
      toast('Email updated');
      document.getElementById('change-email-modal').style.display = 'none';
      emailVisible = false;
      document.getElementById('settings-email').textContent = '••••••••';
    }
  }

  function openChangePassword() {
    document.getElementById('change-password-modal').style.display = 'flex';
    document.getElementById('change-current-password').value = '';
    document.getElementById('change-new-password').value = '';
    document.getElementById('change-confirm-password').value = '';
    document.getElementById('change-current-password').focus();
  }

  // Re-encrypt this device's local private key with a new password so
  // the server-stored backup can still be unlocked after the password
  // change. Devices with no local key (or if nacl failed to load) are
  // skipped — the server already refuses a password change that would
  // strand an existing backup, but if this account has never backed a
  // key up at all there's nothing to re-wrap.
  async function deriveKEK(password, saltB64) {
    const salt = saltB64 ? nacl.util.decodeBase64(saltB64) : nacl.randomBytes(16);
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, baseKey, 256);
    return { kek: new Uint8Array(bits), saltB64: nacl.util.encodeBase64(salt) };
  }

  async function rewrapPrivateKeyForNewPassword(newPassword) {
    if (typeof nacl === 'undefined' || !nacl.box || !currentUser?.id) return null;
    const privB64 = localStorage.getItem('nyxie_private_key_' + currentUser.id);
    if (!privB64) return null;
    const secretKey = nacl.util.decodeBase64(privB64);
    const { kek, saltB64 } = await deriveKEK(newPassword);
    const nonce = nacl.randomBytes(24);
    const box = nacl.secretbox(secretKey, nonce, kek);
    return {
      encrypted_private_key: nacl.util.encodeBase64(box),
      key_salt: saltB64,
      key_nonce: nacl.util.encodeBase64(nonce)
    };
  }

  async function savePassword() {
    const current = document.getElementById('change-current-password').value;
    const newPass = document.getElementById('change-new-password').value;
    const confirm = document.getElementById('change-confirm-password').value;
    if (!current) { toast('Current password required'); return; }
    if (newPass.length < 8) { toast('New password must be at least 8 characters'); return; }
    if (newPass !== confirm) { toast('Passwords do not match'); return; }
    const keyBundle = await rewrapPrivateKeyForNewPassword(newPass);
    const res = await api('PATCH', '/users/me', {
      current_password: current,
      new_password: newPass,
      ...(keyBundle || {})
    });
    if (res?.error) {
      if (res.error.includes('private key bundle')) {
        toast('Unlock your encrypted messages on this device first (reload and enter your password), then change your password.');
      } else {
        toast(res.error);
      }
      return;
    }
    toast('Password updated');
    document.getElementById('change-password-modal').style.display = 'none';
  }

  function openDisableAccount() {
    document.getElementById('disable-account-modal').style.display = 'flex';
    document.getElementById('disable-password').value = '';
    document.getElementById('disable-password').focus();
  }

  async function disableAccount() {
    const password = document.getElementById('disable-password').value;
    if (!password) { toast('Password is required'); return; }
    const res = await api('POST', '/users/disable', { password });
    if (res?.error) { toast(res.error); return; }
    toast('Account disabled. You will be logged out.');
    document.getElementById('disable-account-modal').style.display = 'none';
    setTimeout(logout, 1500);
  }

  function openDeleteAccount() {
    document.getElementById('delete-account-modal').style.display = 'flex';
    document.getElementById('delete-password').value = '';
    document.getElementById('delete-password').focus();
  }

  // ---- UPDATED deleteAccount with message purge flag ----
 async function deleteAccount() {
  const password = document.getElementById('delete-password').value;
  const deleteMessages = document.getElementById('delete-messages-checkbox').checked;

  if (!password) {
    toast('Password is required');
    return;
  }

  const confirmMsg = deleteMessages
    ? 'This will permanently delete your account AND all your messages. Are you sure?'
    : 'This will permanently delete your account. Are you sure?';
  if (!confirm(confirmMsg)) return;

  try {
    const res = await api('DELETE', '/users/me', {
      password,
      delete_messages: deleteMessages
    });

    if (res?.error) {
      toast(res.error);
      return;
    }

    toast('Account permanently deleted.');
    document.getElementById('delete-account-modal').style.display = 'none';
    setTimeout(logout, 1500);
  } catch (err) {
    toast('Delete failed: ' + err.message);
  }
}

  // ═══════════════════════════════════════════════════════════════
  // Settings tabs: Sessions, Two-factor, Voice, Sync, Experiments,
  // Bots, Feedback, Changelogs, Source Code, Donate
  // ═══════════════════════════════════════════════════════════════
  const byId = id => document.getElementById(id);

  function timeAgo(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' hr ago';
    const d = Math.floor(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }

  function copyText(text, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast(okMsg || 'Copied')).catch(() => toast('Could not copy'));
    } else {
      toast('Could not copy');
    }
  }

  // ---- Sessions ----
  const ICON_DESKTOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
  const ICON_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';

  async function refreshSessions() {
    const list = byId('sessions-list');
    if (!list) return;
    list.innerHTML = '<div class="px-empty">Loading…</div>';
    const res = await api('GET', '/account/sessions');
    if (!res || res.error) { list.innerHTML = '<div class="px-empty">Couldn\'t load sessions.</div>'; return; }
    let html = res.sessions.map(s => `
      <div class="px-card">
        <div class="px-card-icon">${s.mobile ? ICON_PHONE : ICON_DESKTOP}</div>
        <div class="px-card-body">
          <div class="px-card-title">${escapeHtml(s.browser)} on ${escapeHtml(s.os)} ${s.current ? '<span class="px-badge">This device</span>' : ''}</div>
          <div class="px-card-sub">Active ${timeAgo(s.lastActive)} · signed in ${new Date(s.createdAt).toLocaleDateString()}${s.ip ? ' · ' + escapeHtml(s.ip) : ''}</div>
        </div>
        ${s.current ? '' : `<div class="px-card-actions"><button type="button" class="px-mini-btn danger" onclick="revokeSession('${escapeHtml(s.id)}')">Log out</button></div>`}
      </div>`).join('');
    if (res.legacyToken) {
      html = '<div class="px-card"><div class="px-card-icon">' + ICON_DESKTOP + '</div><div class="px-card-body"><div class="px-card-title">This device <span class="px-badge">Current</span></div><div class="px-card-sub">You signed in before session tracking was added. Log out and back in to see it listed here.</div></div></div>' + html;
    }
    list.innerHTML = html || '<div class="px-empty">No active sessions.</div>';
    const others = res.sessions.filter(s => !s.current).length;
    byId('sessions-revoke-all').disabled = others === 0 && !res.legacyToken;
  }

  async function revokeSession(id) {
    const res = await api('DELETE', '/account/sessions/' + encodeURIComponent(id));
    if (res?.error) { toast(res.error); return; }
    toast('Device logged out');
    refreshSessions();
  }

  async function revokeOtherSessions() {
    if (!confirm('Log out every other device? You\'ll stay signed in here.')) return;
    const res = await api('DELETE', '/account/sessions');
    if (res?.error) { toast(res.error); return; }
    if (res && res.token) {
      token = res.token;
      localStorage.setItem('nyxie_token', res.token);
    }
    toast('Logged out of all other devices');
    refreshSessions();
  }

  // ---- Two-factor: authenticator + backup codes ----
  let twofaState = { enabled: false, remaining: 0 };
  let twofaSecret = '';
  let backupCodes = [];
  let twofaPwAction = null;

  async function refresh2fa() {
    const res = await api('GET', '/account/2fa');
    if (!res || res.error) return;
    twofaState = { enabled: !!res.enabled, remaining: res.backupCodesRemaining || 0 };
    const title = byId('twofa-auth-title'), desc = byId('twofa-auth-desc'), backup = byId('twofa-backup-desc');
    if (title) title.textContent = twofaState.enabled ? 'Authenticator is on' : 'Add Authenticator';
    if (desc) desc.textContent = twofaState.enabled ? 'Tap to turn off two-factor authentication' : 'Use an authenticator app to generate codes';
    if (backup) backup.textContent = twofaState.enabled ? `${twofaState.remaining} of 10 codes left — tap to make new ones` : 'Get 10 one-time use backup codes';
  }

  async function addAuthenticator() {
    if (twofaState.enabled) { openTwofaPassword('disable'); return; }
    const res = await api('POST', '/account/2fa/setup', {});
    if (!res || res.error) { toast(res?.error || 'Could not start setup'); return; }
    twofaSecret = res.secret;
    byId('twofa-secret').textContent = res.secret.match(/.{1,4}/g).join(' ');
    byId('twofa-code').value = '';
    byId('twofa-setup-modal').style.display = 'flex';
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas(byId('twofa-qr'), res.otpauthUri, { width: 180, margin: 1 }, () => {});
    }
    byId('twofa-code').focus();
  }

  function copyTwofaSecret() { copyText(twofaSecret, 'Secret copied'); }

  async function enableAuthenticator() {
    const code = byId('twofa-code').value.trim();
    if (!/^\d{6}$/.test(code.replace(/\s/g, ''))) { toast('Enter the 6-digit code from your app'); return; }
    const btn = byId('twofa-enable-btn');
    btn.disabled = true;
    const res = await api('POST', '/account/2fa/enable', { code });
    btn.disabled = false;
    if (!res || res.error) { toast(res?.error || 'Could not turn on authenticator'); return; }
    byId('twofa-setup-modal').style.display = 'none';
    toast('Two-factor authentication is on');
    showBackupCodes(res.backupCodes);
    refresh2fa();
  }

  function generateBackupCodes() {
    if (!twofaState.enabled) {
      toast('Turn on an authenticator first — backup codes are its fallback');
      addAuthenticator();
      return;
    }
    openTwofaPassword('backup');
  }

  function openTwofaPassword(action) {
    twofaPwAction = action;
    byId('twofa-password-title').textContent = action === 'disable' ? 'Turn off authenticator' : 'New backup codes';
    byId('twofa-password-desc').textContent = action === 'disable'
      ? 'Enter your password to turn off two-factor authentication. Your backup codes will stop working.'
      : 'Enter your password to generate 10 new codes. Any codes you had before will stop working.';
    byId('twofa-password-btn').textContent = action === 'disable' ? 'Turn off' : 'Generate';
    byId('twofa-password').value = '';
    byId('twofa-password-modal').style.display = 'flex';
    byId('twofa-password').focus();
  }

  async function submitTwofaPassword() {
    const password = byId('twofa-password').value;
    if (!password) { toast('Password is required'); return; }
    const btn = byId('twofa-password-btn');
    btn.disabled = true;
    const path = twofaPwAction === 'disable' ? '/account/2fa/disable' : '/account/2fa/backup-codes';
    const res = await api('POST', path, { password });
    btn.disabled = false;
    if (!res || res.error) { toast(res?.error || 'Something went wrong'); return; }
    byId('twofa-password-modal').style.display = 'none';
    if (twofaPwAction === 'disable') toast('Two-factor authentication is off');
    else showBackupCodes(res.backupCodes);
    refresh2fa();
  }

  function showBackupCodes(codes) {
    backupCodes = codes || [];
    byId('backup-codes-grid').innerHTML = backupCodes.map(c => `<code>${escapeHtml(c)}</code>`).join('');
    byId('backup-codes-modal').style.display = 'flex';
  }
  function copyBackupCodes() { copyText(backupCodes.join('\n'), 'Codes copied'); }
  function downloadBackupCodes() {
    const text = 'Nyxie backup codes for @' + currentUser.username + '\nEach code works once.\n\n' + backupCodes.join('\n') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'nyxie-backup-codes.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- Voice settings ----
  let micTest = null;

  function fillDeviceSelect(sel, devices, current, fallbackLabel) {
    const real = devices.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    sel.innerHTML = '<option value="default">System default</option>' +
      real.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || (fallbackLabel + ' ' + (i + 1)))}</option>`).join('');
    sel.value = Array.from(sel.options).some(o => o.value === current) ? current : 'default';
  }

  async function populateAudioDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const p = getVoicePrefs();
      fillDeviceSelect(byId('voice-input-device'), devs.filter(d => d.kind === 'audioinput'), p.inputDeviceId, 'Microphone');
      fillDeviceSelect(byId('voice-output-device'), devs.filter(d => d.kind === 'audiooutput'), p.outputDeviceId, 'Speaker');
    } catch (e) { /* leave the default option */ }
  }

  function loadVoiceSettings() {
    const p = getVoicePrefs();
    byId('voice-input-volume').value = p.inputVolume;
    byId('voice-input-volume-val').textContent = p.inputVolume + '%';
    byId('voice-output-volume').value = p.outputVolume;
    byId('voice-output-volume-val').textContent = p.outputVolume + '%';
    byId('voice-noise').checked = !!p.noiseSuppression;
    byId('voice-echo').checked = !!p.echoCancellation;
    byId('voice-agc').checked = !!p.autoGainControl;
    const outSel = byId('voice-output-device');
    const canSink = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
    outSel.disabled = !canSink;
    byId('voice-output-hint').style.display = canSink ? 'none' : '';
    populateAudioDevices();

    const root = byId('tab-voice');
    if (root.dataset.bound) return;
    root.dataset.bound = '1';
    const restartTest = () => { if (micTest) { stopMicTest(); startMicTest(); } };
    byId('voice-input-device').addEventListener('change', e => { saveVoicePrefs({ inputDeviceId: e.target.value }); restartTest(); });
    byId('voice-output-device').addEventListener('change', e => { saveVoicePrefs({ outputDeviceId: e.target.value }); });
    byId('voice-input-volume').addEventListener('input', e => {
      byId('voice-input-volume-val').textContent = e.target.value + '%';
      saveVoicePrefs({ inputVolume: Number(e.target.value) });
    });
    byId('voice-input-volume').addEventListener('change', restartTest);
    byId('voice-output-volume').addEventListener('input', e => {
      byId('voice-output-volume-val').textContent = e.target.value + '%';
      saveVoicePrefs({ outputVolume: Number(e.target.value) });
    });
    [['voice-noise', 'noiseSuppression'], ['voice-echo', 'echoCancellation'], ['voice-agc', 'autoGainControl']].forEach(([id, key]) => {
      byId(id).addEventListener('change', e => { saveVoicePrefs({ [key]: e.target.checked }); restartTest(); });
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', populateAudioDevices);
    }
  }

  async function startMicTest() {
    let stream;
    try { stream = await nyxieGetMic(); } catch (e) { toast('Microphone access denied'); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const fill = byId('voice-meter-fill');
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      fill.style.width = Math.min(100, (peak / 128) * 140) + '%';
      raf = requestAnimationFrame(tick);
    };
    micTest = { stop() { cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); ctx.close().catch(() => {}); } };
    byId('voice-mic-test-btn').textContent = 'Stop test';
    tick();
    populateAudioDevices(); // device labels are available once permission is granted
  }

  function stopMicTest() {
    if (!micTest) return;
    micTest.stop();
    micTest = null;
    const btn = byId('voice-mic-test-btn');
    if (btn) btn.textContent = 'Test microphone';
    const fill = byId('voice-meter-fill');
    if (fill) fill.style.width = '0%';
  }

  function toggleMicTest() { micTest ? stopMicTest() : startMicTest(); }

  function testSpeakers() {
    const a = nyxieApplyOutput(new Audio('/assets/sounds/notification.mp3'));
    a.play().catch(() => toast('Could not play a test sound'));
  }

  // ---- Sync ----
  function renderSyncStatus() {
    const last = nyxieSyncLast();
    byId('sync-status').textContent = last ? 'Last synced: ' + new Date(last).toLocaleString() : 'Last synced: never';
  }

  function loadSyncTab() {
    byId('sync-auto').checked = nyxieSyncAuto();
    renderSyncStatus();
    const box = byId('sync-auto');
    if (box.dataset.bound) return;
    box.dataset.bound = '1';
    box.addEventListener('change', async () => {
      localStorage.setItem('nyxie_sync_auto', String(box.checked));
      if (!box.checked) { toast('Automatic sync is off'); return; }
      const res = await api('GET', '/account/settings-sync');
      if (res && !res.error && !res.data) {
        try { await nyxiePushSettings(); toast('Sync is on — this device\'s settings were saved'); } catch (e) { toast(e.message); }
      } else {
        toast('Sync is on. Use "Download saved settings" to apply what\'s already saved.');
      }
      renderSyncStatus();
    });
  }

  async function syncUpload() {
    try { await nyxiePushSettings(); toast('Settings uploaded'); renderSyncStatus(); } catch (e) { toast(e.message); }
  }

  async function syncDownload() {
    try {
      const r = await nyxiePullSettings(true);
      if (!r.applied) { toast('Nothing has been saved to your account yet'); return; }
      toast('Saved settings applied');
      renderExperiments();
      renderSyncStatus();
      const fs = byId('font-select');
      if (fs && localStorage.getItem('font')) fs.value = localStorage.getItem('font');
      if (window.initLanguageSettings) initLanguageSettings();
    } catch (e) { toast(e.message); }
  }

  async function syncDelete() {
    if (!confirm('Delete the synced copy of your settings? Settings on your devices are not changed.')) return;
    const res = await api('DELETE', '/account/settings-sync');
    if (res?.error) { toast(res.error); return; }
    localStorage.removeItem('nyxie_sync_last');
    toast('Synced copy deleted');
    renderSyncStatus();
  }

  // ---- Experiments ----
  function renderExperiments() {
    const list = byId('experiments-list');
    if (!list) return;
    const cur = getExperiments();
    list.innerHTML = NYXIE_EXPERIMENTS.map(e => `
      <div class="toggle-row">
        <div class="toggle-info"><div class="toggle-label">${escapeHtml(e.label)}</div><div class="toggle-desc">${escapeHtml(e.desc)}</div></div>
        <label class="switch px-switch"><input type="checkbox" data-px data-exp="${e.id}" ${cur[e.id] ? 'checked' : ''}/><span class="slider round"></span></label>
      </div>`).join('');
    list.querySelectorAll('input[data-exp]').forEach(i => i.addEventListener('change', () => setExperiment(i.dataset.exp, i.checked)));
  }

  function resetExperiments() {
    localStorage.setItem('nyxie_experiments', '{}');
    applyExperiments();
    renderExperiments();
    toast('All experiments are off');
  }

  // ---- Bots ----
  let botsCache = [];
  let editingBotId = null;
  let botTokenValue = '';

  async function refreshBots() {
    const list = byId('bots-list');
    if (!list) return;
    const res = await api('GET', '/account/bots');
    if (!res || res.error) { list.innerHTML = '<div class="px-empty">Couldn\'t load your bots.</div>'; return; }
    botsCache = res.bots;
    byId('bots-create-btn').disabled = res.bots.length >= res.max;
    if (!res.bots.length) { list.innerHTML = '<div class="px-empty">You haven\'t created any bots yet.</div>'; return; }
    list.innerHTML = res.bots.map(b => `
      <div class="px-card">
        <div class="px-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/></svg></div>
        <div class="px-card-body">
          <div class="px-card-title">${escapeHtml(b.name)}</div>
          <div class="px-card-sub">${b.description ? escapeHtml(b.description) + ' · ' : ''}Token ending ${escapeHtml(b.tokenHint)} · created ${new Date(b.createdAt).toLocaleDateString()}</div>
        </div>
        <div class="px-card-actions">
          <button type="button" class="px-mini-btn" onclick="openBotModal('${escapeHtml(b.id)}')">Edit</button>
          <button type="button" class="px-mini-btn" onclick="resetBotToken('${escapeHtml(b.id)}')">Reset token</button>
          <button type="button" class="px-mini-btn danger" onclick="deleteBot('${escapeHtml(b.id)}')">Delete</button>
        </div>
      </div>`).join('');
  }

  function openBotModal(id) {
    editingBotId = id || null;
    const bot = id ? botsCache.find(b => b.id === id) : null;
    byId('bot-modal-title').textContent = bot ? 'Edit bot' : 'Create bot';
    byId('bot-name').value = bot ? bot.name : '';
    byId('bot-desc').value = bot ? bot.description : '';
    byId('bot-modal').style.display = 'flex';
    byId('bot-name').focus();
  }

  function showBotToken(t) {
    botTokenValue = t;
    byId('bot-token-value').textContent = t;
    byId('bot-token-modal').style.display = 'flex';
  }
  function copyBotToken() { copyText(botTokenValue, 'Token copied'); }

  async function saveBot() {
    const name = byId('bot-name').value.trim();
    const description = byId('bot-desc').value.trim();
    if (name.length < 2) { toast('Give your bot a name (at least 2 characters)'); return; }
    const btn = byId('bot-save-btn');
    btn.disabled = true;
    const res = editingBotId
      ? await api('PATCH', '/account/bots/' + encodeURIComponent(editingBotId), { name, description })
      : await api('POST', '/account/bots', { name, description });
    btn.disabled = false;
    if (!res || res.error) { toast(res?.error || 'Could not save bot'); return; }
    byId('bot-modal').style.display = 'none';
    if (res.token) showBotToken(res.token); else toast('Bot updated');
    refreshBots();
  }

  async function resetBotToken(id) {
    if (!confirm('Reset this bot\'s token? Anything using the old token will stop working.')) return;
    const res = await api('POST', '/account/bots/' + encodeURIComponent(id) + '/reset-token', {});
    if (!res || res.error) { toast(res?.error || 'Could not reset token'); return; }
    showBotToken(res.token);
    refreshBots();
  }

  async function deleteBot(id) {
    if (!confirm('Delete this bot? This can\'t be undone.')) return;
    const res = await api('DELETE', '/account/bots/' + encodeURIComponent(id));
    if (res?.error) { toast(res.error); return; }
    toast('Bot deleted');
    refreshBots();
  }

  // ---- Feedback ----
  let feedbackCategory = 'bug';

  function setFeedbackCategory(cat) {
    feedbackCategory = cat;
    document.querySelectorAll('#feedback-category .px-chip').forEach(c => c.classList.toggle('active', c.dataset.cat === cat));
  }

  function loadFeedbackTab() {
    const ta = byId('feedback-message');
    if (!ta.dataset.bound) {
      ta.dataset.bound = '1';
      ta.addEventListener('input', () => { byId('feedback-count').textContent = ta.value.length; });
    }
    refreshFeedbackHistory();
  }

  async function sendFeedback() {
    const message = byId('feedback-message').value.trim();
    if (message.length < 10) { toast('Please write at least 10 characters'); return; }
    let diagnostics;
    if (byId('feedback-diagnostics').checked) {
      diagnostics = [
        navigator.userAgent,
        screen.width + 'x' + screen.height,
        'lang ' + (localStorage.getItem('nyxie_language') || navigator.language),
        'theme ' + (localStorage.getItem('theme') || 'dark'),
      ].join(' | ');
    }
    const btn = byId('feedback-send-btn');
    btn.disabled = true;
    const res = await api('POST', '/account/feedback', { category: feedbackCategory, message, diagnostics });
    btn.disabled = false;
    if (!res || res.error) { toast(res?.error || 'Could not send feedback'); return; }
    byId('feedback-message').value = '';
    byId('feedback-count').textContent = '0';
    toast('Thanks — feedback sent');
    refreshFeedbackHistory();
  }

  async function refreshFeedbackHistory() {
    const list = byId('feedback-history');
    const res = await api('GET', '/account/feedback');
    if (!res || res.error || !res.feedback.length) { list.innerHTML = '<div class="px-empty">Nothing sent yet.</div>'; return; }
    const label = { bug: 'Bug', idea: 'Idea', other: 'Other' };
    list.innerHTML = res.feedback.map(f => `
      <div class="px-card">
        <div class="px-card-body">
          <div class="px-card-title"><span class="px-badge muted">${label[f.category] || 'Other'}</span> ${f.status === 'new' ? 'Received' : escapeHtml(f.status)}</div>
          <div class="px-card-sub px-fb-msg">${escapeHtml(f.message.length > 240 ? f.message.slice(0, 240) + '…' : f.message)}</div>
          <div class="px-card-sub">${new Date(f.createdAt).toLocaleString()}</div>
        </div>
      </div>`).join('');
  }

  // ---- Changelogs ----
  const CHANGELOG = [
    {
      title: 'Settings and wallet filled in',
      date: 'September 28, 2026',
      items: [
        'Sessions: see every device signed in to your account and log any of them out.',
        'Two-factor authentication with an authenticator app, plus one-time backup codes.',
        'Voice settings: pick your microphone and speakers, set volumes, test your mic, and toggle noise suppression, echo cancellation and auto gain.',
        'Sync: keep your theme, language and other preferences the same across devices.',
        'Experiments: compact messages, larger text, reduced motion and stronger borders.',
        'My Bots: create bot applications and manage their tokens.',
        'Feedback: send bug reports and ideas from inside the app.',
        'Wallet: scan a Nyxie QR code with your camera (or upload one) to start a payment.',
      ],
    },
    {
      title: 'Earlier',
      date: 'Before this changelog',
      items: [
        'Direct messages, group chats and servers with channels, roles and invites.',
        'End-to-end encrypted messages, voice messages and voice calls.',
        'NX wallet with PIN-protected sending, receiving and transaction history.',
        'Marketplace, badges, custom themes and accent colours, and multiple languages.',
      ],
    },
  ];

  function renderChangelog() {
    const el = byId('changelog-list');
    if (!el || el.dataset.rendered) return;
    el.dataset.rendered = '1';
    el.innerHTML = CHANGELOG.map(r => `
      <div class="settings-section px-release">
        <h3>${escapeHtml(r.title)}</h3>
        <div class="px-date">${escapeHtml(r.date)}</div>
        <ul>${r.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
      </div>`).join('');
  }

  // ---- Source code / Donate ----
  function safeLink(url) { return /^https?:\/\//i.test(url || '') ? url : ''; }

  function loadLinkTabs() {
    const src = safeLink(NYXIE_LINKS.source);
    byId('source-link-row').style.display = src ? '' : 'none';
    if (src) byId('source-link').href = src;
    const don = safeLink(NYXIE_LINKS.donate);
    byId('donate-link-row').style.display = don ? '' : 'none';
    byId('donate-nolink').style.display = don ? 'none' : '';
    if (don) byId('donate-link').href = don;
  }

  function copyInviteLink() { copyText(location.origin, 'Link copied — share it with a friend'); }

  // ---- Language ----
  function initLanguageSettings() {
    const select = document.getElementById('nyxie-language-select');
    const grid = document.getElementById('nyxie-language-grid');
    if (!select || !grid || !window.NYXIE_LANGUAGES) return;

    const languages = window.NYXIE_LANGUAGES;
    const active = window.getLanguage ? window.getLanguage() : 'en';

    select.innerHTML = languages.map(lang =>
      `<option value="${lang.code}">${lang.flag} ${escapeHtml(lang.native)} — ${escapeHtml(lang.name)}</option>`
    ).join('');
    select.value = active;

    grid.innerHTML = languages.map(lang => `
      <button type="button" class="language-option${lang.code === active ? ' active' : ''}" data-language="${lang.code}">
        <span class="language-flag" aria-hidden="true">${lang.flag}</span>
        <span>
          <span class="language-name">${escapeHtml(lang.name)}</span>
          <span class="language-native">${escapeHtml(lang.native)}</span>
        </span>
      </button>
    `).join('');

    grid.querySelectorAll('.language-option').forEach(button => {
      button.addEventListener('click', () => {
        select.value = button.dataset.language;
        grid.querySelectorAll('.language-option').forEach(b => b.classList.toggle('active', b === button));
      });
    });

    select.addEventListener('change', () => {
      grid.querySelectorAll('.language-option').forEach(b => b.classList.toggle('active', b.dataset.language === select.value));
    });

    const apply = document.getElementById('nyxie-language-apply');
    if (apply && !apply.dataset.bound) {
      apply.dataset.bound = '1';
      apply.addEventListener('click', () => {
        if (window.setLanguage) window.setLanguage(select.value);
        initLanguageSettings();
        toast(window.t ? window.t('Language updated') : 'Language updated');
      });
    }

    document.addEventListener('nyxie:languagechange', () => {
      const current = window.getLanguage ? window.getLanguage() : 'en';
      if (select) select.value = current;
      grid.querySelectorAll('.language-option').forEach(b => b.classList.toggle('active', b.dataset.language === current));
    });
  }

  // ---- Appearance ----
  // Theme + accent are handled globally by theme.js (setTheme/setAccent/applyTheme/applyAccent),
  // shared with dashboard.html, so this page always matches whatever theme is active elsewhere.

  function saveCustomAccent() {
    const hexInput = document.getElementById('custom-accent-hex');
    const colorInput = document.getElementById('custom-accent-color');
    let color = hexInput.value.trim() || colorInput.value;
    if (!/^#([0-9A-F]{3}){1,2}$/i.test(color)) {
      toast('Please enter a valid hex color (e.g., #ff0000)');
      return;
    }
    setAccent(color);
    const customSwatch = document.querySelector('.accent-swatch.custom-color');
    if (customSwatch) customSwatch.style.background = color + ' !important';
    hexInput.value = '';
    toast('Custom accent color saved!');
  }

  // ---- Init ----
  // (this view is mounted well after DOMContentLoaded already fired
  // once for the whole SPA, so this runs directly instead of waiting
  // for another one)
  (function () {
    loadUserData();

    // theme.js already applied the saved theme + accent on its own DOMContentLoaded
    // listener; just sync any settings-specific UI bits (custom swatch color) here.
    const savedAccent = localStorage.getItem('accent');
    if (savedAccent) {
      const customSwatch = document.querySelector('.accent-swatch.custom-color');
      if (customSwatch && !document.querySelector(`.accent-swatch[data-color="${savedAccent}"]`)) {
        customSwatch.style.background = savedAccent + ' !important';
      }
    }

    const fontSelect = document.getElementById('font-select');
    const savedFont = localStorage.getItem('font');
    if (savedFont) {
      fontSelect.value = savedFont;
      document.body.style.fontFamily = savedFont + ', sans-serif';
    }
    fontSelect.addEventListener('change', function() {
      document.body.style.fontFamily = this.value + ', sans-serif';
      localStorage.setItem('font', this.value);
      toast('Font: ' + this.value);
    });

    document.querySelectorAll('.switch input:not([data-px])').forEach(el => {
      const saved = localStorage.getItem('switch-' + el.id);
      if (saved !== null) el.checked = saved === 'true';
      el.addEventListener('change', function() {
        localStorage.setItem('switch-' + this.id, this.checked);
      });
    });

    if (document.getElementById('tab-profile').style.display !== 'none') {
      loadProfileForm();
    }
    refresh2fa();
  })();

  // Expose functions globally
  window.switchTab = switchTab;
  window.goBack = goBack;
  window.logout = logout;
  window.openChangeUsername = openChangeUsername;
  window.saveUsername = saveUsername;
  window.toggleEmailVisibility = toggleEmailVisibility;
  window.openChangeEmail = openChangeEmail;
  window.saveEmail = saveEmail;
  window.openChangePassword = openChangePassword;
  window.savePassword = savePassword;
  window.openDisableAccount = openDisableAccount;
  window.disableAccount = disableAccount;
  window.openDeleteAccount = openDeleteAccount;
  window.deleteAccount = deleteAccount;
  window.generateBackupCodes = generateBackupCodes;
  window.addAuthenticator = addAuthenticator;
  window.setTheme = setTheme;
  window.setAccent = setAccent;
  window.saveCustomAccent = saveCustomAccent;
  window.setProfileBannerColor = setProfileBannerColor;
  window.uploadProfileAvatar = uploadProfileAvatar;
  window.removeProfileAvatar = removeProfileAvatar;
  window.uploadProfileBanner = uploadProfileBanner;
  window.removeProfileBanner = removeProfileBanner;
  window.resetProfileForm = resetProfileForm;
  window.saveProfileChanges = saveProfileChanges;
  window.updateDisplayNameCounter = updateDisplayNameCounter;
  window.updateBioCounter = updateBioCounter;
  window.selectAvatarDecoration = selectAvatarDecoration;
  window.selectCardDecoration = selectCardDecoration;
  window.buyCosmetic = buyCosmetic;
  window.loadProfileForm = loadProfileForm;
  window.loadUserData = loadUserData;
  window.initLanguageSettings = initLanguageSettings;
  Object.assign(window, {
    refreshSessions, revokeSession, revokeOtherSessions,
    enableAuthenticator, copyTwofaSecret, submitTwofaPassword, copyBackupCodes, downloadBackupCodes,
    toggleMicTest, testSpeakers,
    syncUpload, syncDownload, syncDelete,
    resetExperiments,
    openBotModal, saveBot, resetBotToken, deleteBot, copyBotToken,
    setFeedbackCategory, sendFeedback,
    copyInviteLink,
  });

  function destroySettingsView() {
    stopMicTest();
    // Nothing to tear down (no WebSocket, no timers/observers set up
    // by this view) — present for symmetry with the dashboard/voice
    // teardown and as a hook for future settings-view state.
  }
  window.destroySettingsView = destroySettingsView;
}
window.initSettingsView = initSettingsView;