// auth.js — login + register view logic, and the E2EE key setup/recovery
// helpers both views need. Ported from login.html's and register.html's
// inline <script> tags. Each used to run immediately because the whole
// HTML page it was embedded in only existed while that page was open;
// now that both views are templates inside one SPA shell, each is
// wrapped in an init function the router calls right after cloning that
// view's template into #app-root.

function initLoginView() {
  const form = document.getElementById('loginForm');
  const loginField = document.getElementById('loginField');
  const passwordInput = document.getElementById('password');
  const loginGroup = document.getElementById('loginGroup');
  const passwordGroup = document.getElementById('passwordGroup');
  const loginBtn = document.getElementById('loginBtn');

  function clearError(groupElement) {
    if (!groupElement) return;
    const input = groupElement.querySelector('input');
    const existingError = groupElement.querySelector('.error-message');
    if (existingError) existingError.remove();
    if (input) input.classList.remove('input-error');
  }

  function setError(groupElement, errorMessage) {
    if (!groupElement) return;
    const input = groupElement.querySelector('input');
    const existingError = groupElement.querySelector('.error-message');
    if (existingError) existingError.remove();
    if (input) input.classList.add('input-error');
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = errorMessage;
    groupElement.appendChild(errorDiv);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(loginGroup);
    clearError(passwordGroup);
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';

    const loginVal = loginField.value.trim();
    const passwordVal = passwordInput.value.trim();

    if (!loginVal) {
      setError(loginGroup, 'Username or email is required');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign in';
      loginField.focus();
      return;
    }
    if (!passwordVal) {
      setError(passwordGroup, 'Password is required');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign in';
      passwordInput.focus();
      return;
    }

    const isEmail = isValidEmail(loginVal);
    const payload = isEmail ? { email: loginVal, password: passwordVal } : { username: loginVal, password: passwordVal };

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      token = data.token;
      currentUser = data.user;
      localStorage.setItem('nyxie_token', data.token);
      localStorage.setItem('nyxie_user', JSON.stringify(data.user));

      await recoverEncryptionKey(data.user, passwordVal);

      toast(`Welcome back, ${data.user.display_name || data.user.username}!`, false);
      setTimeout(() => { router.navigate('/app'); }, 400);
    } catch (err) {
      toast(err.message, true);
      setError(passwordGroup, err.message);
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign in';
    }
  });

  loginField.addEventListener('input', () => clearError(loginGroup));
  passwordInput.addEventListener('input', () => clearError(passwordGroup));
  setTimeout(() => loginField.focus(), 100);
}

function initRegisterView() {
  const usernameInput = document.getElementById('username');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const confirmInput = document.getElementById('confirmPassword');
  const displayNameInput = document.getElementById('displayName');
  const usernameGroup = document.getElementById('usernameGroup');
  const emailGroup = document.getElementById('emailGroup');
  const passwordGroup = document.getElementById('passwordGroup');
  const confirmGroup = document.getElementById('confirmGroup');
  const displayNameGroup = document.getElementById('displayNameGroup');
  const form = document.getElementById('registerForm');
  const submitBtn = document.getElementById('submitBtn');

  function clearError(groupElement) {
    if (!groupElement) return;
    const input = groupElement.querySelector('input');
    const existingError = groupElement.querySelector('.error-message');
    if (existingError) existingError.remove();
    if (input) input.classList.remove('input-error');
  }

  function setError(groupElement, errorMessage) {
    if (!groupElement) return;
    const input = groupElement.querySelector('input');
    const existingError = groupElement.querySelector('.error-message');
    if (existingError) existingError.remove();
    if (input) input.classList.add('input-error');
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = errorMessage;
    groupElement.appendChild(errorDiv);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(usernameGroup);
    clearError(emailGroup);
    clearError(passwordGroup);
    clearError(confirmGroup);
    clearError(displayNameGroup);

    const username = usernameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirm = confirmInput.value;
    const displayName = displayNameInput.value.trim();

    if (!username || username.length < 3 || username.length > 30 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
      setError(usernameGroup, 'Username must be 3-30 characters and contain only letters, numbers, underscore or hyphen.');
      usernameInput.focus();
      return;
    }
    const reserved = ['admin', 'root', 'system', 'nyxie', 'support'];
    if (reserved.includes(username.toLowerCase())) {
      setError(usernameGroup, 'This username is not available.');
      usernameInput.focus();
      return;
    }

    if (!isValidEmail(email)) {
      setError(emailGroup, 'Invalid email address.');
      emailInput.focus();
      return;
    }

    if (password.length < 8) {
      setError(passwordGroup, 'Password must be at least 8 characters.');
      passwordInput.focus();
      return;
    }

    if (password !== confirm) {
      setError(confirmGroup, 'Passwords do not match.');
      confirmInput.focus();
      return;
    }

    if (displayName && displayName.length > 64) {
      setError(displayNameGroup, 'Display name too long (max 64 characters).');
      displayNameInput.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account...';

    try {
      const resp = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          email,
          password,
          display_name: displayName || undefined
        })
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Registration failed');
      }
      token = data.token;
      currentUser = data.user;
      localStorage.setItem('nyxie_token', data.token);
      localStorage.setItem('nyxie_user', JSON.stringify(data.user));
      await setupEncryptionKeys(data.user.id, password, data.token);
      toast(`Welcome, ${data.user.display_name || data.user.username}!`, false);
      setTimeout(() => { router.navigate('/app'); }, 700);
    } catch (err) {
      toast(err.message, true);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
    }
  });

  usernameInput.addEventListener('input', () => clearError(usernameGroup));
  emailInput.addEventListener('input', () => clearError(emailGroup));
  passwordInput.addEventListener('input', () => clearError(passwordGroup));
  confirmInput.addEventListener('input', () => clearError(confirmGroup));
  displayNameInput.addEventListener('input', () => clearError(displayNameGroup));
}

// Generate this account's E2EE keypair and back it up on the server,
// encrypted with a key derived from the account password (the server
// never sees the plaintext private key or the password itself). If the
// nacl CDN script failed to load, skip silently — dashboard.js's own
// ensureE2EEKeys() will retry.
async function setupEncryptionKeys(userId, password, authToken) {
  if (typeof nacl === 'undefined' || !nacl.box) return;
  try {
    const keyPair = nacl.box.keyPair();
    const publicKeyB64 = nacl.util.encodeBase64(keyPair.publicKey);

    const salt = nacl.randomBytes(16);
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, baseKey, 256);
    const kek = new Uint8Array(bits);

    const nonce = nacl.randomBytes(24);
    const box = nacl.secretbox(keyPair.secretKey, nonce, kek);

    await fetch('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
      body: JSON.stringify({
        public_key: publicKeyB64,
        encrypted_private_key: nacl.util.encodeBase64(box),
        key_salt: nacl.util.encodeBase64(salt),
        key_nonce: nacl.util.encodeBase64(nonce)
      })
    });

    localStorage.setItem('nyxie_private_key_' + userId, nacl.util.encodeBase64(keyPair.secretKey));
    localStorage.setItem('nyxie_public_key_' + userId, publicKeyB64);
  } catch (e) {
    console.warn('E2EE key setup failed, dashboard will retry:', e);
  }
}

// If this device already has a private key for this account, nothing to
// do. Otherwise, if the server has an encrypted backup, unlock it with
// the password just entered so this device can read past messages
// immediately (rather than generating a fresh, unrelated keypair, which
// would make every past message undecryptable). If there's no backup at
// all yet, leave it to dashboard.js's ensureE2EEKeys(), which will
// prompt once and generate/back up a keypair there.
async function recoverEncryptionKey(user, password) {
  if (typeof nacl === 'undefined' || !nacl.box) return;
  const privKey = 'nyxie_private_key_' + user.id;
  if (localStorage.getItem(privKey)) return;
  if (!user.encrypted_private_key || !user.key_salt || !user.key_nonce) return;

  try {
    const salt = nacl.util.decodeBase64(user.key_salt);
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, baseKey, 256);
    const kek = new Uint8Array(bits);

    const secret = nacl.secretbox.open(
      nacl.util.decodeBase64(user.encrypted_private_key),
      nacl.util.decodeBase64(user.key_nonce),
      kek
    );
    if (!secret) return;

    const keyPair = nacl.box.keyPair.fromSecretKey(secret);
    if (nacl.util.encodeBase64(keyPair.publicKey) !== user.public_key) return;

    localStorage.setItem(privKey, nacl.util.encodeBase64(secret));
    localStorage.setItem('nyxie_public_key_' + user.id, user.public_key);
  } catch (e) {
    console.warn('Key recovery failed, dashboard will retry:', e);
  }
}
