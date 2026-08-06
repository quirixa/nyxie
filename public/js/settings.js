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
  }

  function updateDisplayNameCounter() {
    const val = document.getElementById('profile-display-name').value;
    document.getElementById('display-name-counter').textContent = val.length;
  }

  function updateBioCounter() {
    const val = document.getElementById('profile-bio').value;
    document.getElementById('bio-counter').textContent = val.length;
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
        localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
        _pendingBannerColor = null;
        toast('Profile updated');
        loadProfileForm();
        loadUserData();
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
    const reserved = ['admin', 'root', 'system', 'nyxie', 'support'];
    if (reserved.includes(newUsername.toLowerCase())) {
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

  function generateBackupCodes() { toast('Backup codes generation coming soon'); }
  function addAuthenticator() { toast('Authenticator setup coming soon'); }

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

    document.querySelectorAll('.switch input').forEach(el => {
      const saved = localStorage.getItem('switch-' + el.id);
      if (saved !== null) el.checked = saved === 'true';
      el.addEventListener('change', function() {
        localStorage.setItem('switch-' + this.id, this.checked);
      });
    });

    if (document.getElementById('tab-profile').style.display !== 'none') {
      loadProfileForm();
    }
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
  window.loadProfileForm = loadProfileForm;
  window.loadUserData = loadUserData;

  function destroySettingsView() {
    // Nothing to tear down (no WebSocket, no timers/observers set up
    // by this view) — present for symmetry with the dashboard/voice
    // teardown and as a hook for future settings-view state.
  }
  window.destroySettingsView = destroySettingsView;
}
window.initSettingsView = initSettingsView;