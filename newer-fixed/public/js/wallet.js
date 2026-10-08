// wallet.js — NX wallet frontend. Classic script (no import/export),
// same pattern as the rest of the app (see state.js's header comment):
// top-level `let`/`function` declarations here share one global lexical
// environment with dashboard.js, state.js, utils.js, etc. Reads the
// shared `token` global from state.js and reuses `toast()`/`escapeHtml()`
// from utils.js. Everything here talks to the real /api/wallet backend —
// no hard-coded balances or fake success states (spec section 22).

const WALLET_API = '';

let _walletHasPin = false;
let _walletFilter = 'all';
let _walletCache = { wallet: null, recent: [] };

// Multi-step send flow state, reset every time the modal opens.
let _sendFlow = { recipient: null, recipientDisplay: null, amount: null, note: null, idempotencyKey: null };

async function walletApi(method, path, body, headers) {
  try {
    const res = await fetch(WALLET_API + '/api/wallet' + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, headers || {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong');
      err.code = data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.status) throw e; // already a wallet API error
    const err = new Error('Network error — check your connection');
    throw err;
  }
}

// ─── Panel: home view ──────────────────────────────────────────────

async function initWalletPanel() {
  showWalletHome();
  document.getElementById('wallet-recent-list').innerHTML = '<div class="wallet-empty">Loading…</div>';
  document.getElementById('wallet-balance-amount').textContent = '—';
  try {
    const { wallet } = await walletApi('GET', '');
    _walletCache.wallet = wallet;
    _walletHasPin = !!wallet.hasPin;
    renderWalletBalance(wallet);
  } catch (e) {
    toast(e.message, true);
  }
  try {
    const { transactions } = await walletApi('GET', '/transactions?limit=5');
    _walletCache.recent = transactions;
    renderTxList('wallet-recent-list', transactions);
  } catch (e) {
    document.getElementById('wallet-recent-list').innerHTML = '<div class="wallet-empty">Couldn\'t load activity.</div>';
  }
}

function renderWalletBalance(wallet) {
  document.getElementById('wallet-balance-amount').textContent = wallet.balanceDisplay + ' NX';
  const label = document.getElementById('wallet-status-label');
  if (wallet.status === 'FROZEN') {
    label.textContent = 'NX Balance — Frozen';
    label.style.color = 'var(--danger)';
  } else {
    label.textContent = 'NX Balance';
    label.style.color = '';
  }
}

function showWalletHome() {
  document.getElementById('wallet-home-view').style.display = '';
  document.getElementById('wallet-history-view').style.display = 'none';
}

async function showWalletHistory() {
  document.getElementById('wallet-home-view').style.display = 'none';
  document.getElementById('wallet-history-view').style.display = '';
  await loadWalletHistory();
}

async function setWalletFilter(filter) {
  _walletFilter = filter;
  document.querySelectorAll('.wtab').forEach(el => el.classList.toggle('active', el.dataset.filter === filter));
  await loadWalletHistory();
}

async function loadWalletHistory() {
  const list = document.getElementById('wallet-full-list');
  list.innerHTML = '<div class="wallet-empty">Loading…</div>';
  try {
    const filterParam = _walletFilter === 'all' ? '' : '&filter=' + _walletFilter;
    const { transactions } = await walletApi('GET', '/transactions?limit=100' + filterParam);
    renderTxList('wallet-full-list', transactions);
  } catch (e) {
    list.innerHTML = '<div class="wallet-empty">Couldn\'t load transactions.</div>';
  }
}

function renderTxList(containerId, txs) {
  const el = document.getElementById(containerId);
  if (!txs || !txs.length) {
    el.innerHTML = '<div class="wallet-empty">No transactions yet.</div>';
    return;
  }
  el.innerHTML = txs.map(tx => {
    const out = tx.direction === 'OUT';
    const sign = out ? '-' : '+';
    const who = tx.counterpartyUsername ? '@' + escapeHtml(tx.counterpartyUsername)
      : (tx.type === 'SYSTEM_CREDIT' ? 'Test funds' : tx.type.replace(/_/g, ' '));
    const label = tx.type === 'SHOP_PURCHASE' ? escapeHtml(tx.description || 'Shop purchase')
      : (out ? `Sent to ${who}` : `Received from ${who}`);
    return `
      <div class="wallet-tx-row" onclick="openTxDetail('${tx.id}')">
        <div class="wtx-icon ${out ? 'out' : 'in'}">${out
          ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>'
          : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>'
        }</div>
        <div class="wtx-info">
          <div class="wtx-label">${label}</div>
          <div class="wtx-date">${formatDay(tx.createdAt)} · ${formatTime(tx.createdAt)}</div>
        </div>
        <div class="wtx-amount ${out ? 'out' : 'in'}">${sign}${escapeHtml(tx.amountDisplay)} NX</div>
      </div>`;
  }).join('');
}

async function openTxDetail(txId) {
  try {
    const { transaction: tx } = await walletApi('GET', '/transactions/' + encodeURIComponent(txId));
    const out = tx.direction === 'OUT';
    document.getElementById('wtx-amount').textContent = (out ? '-' : '+') + tx.amountDisplay + ' NX';
    document.getElementById('wtx-amount').style.color = out ? 'var(--danger)' : 'var(--online)';
    document.getElementById('wtx-status').textContent = tx.status;
    document.getElementById('wtx-counterparty').textContent = tx.counterpartyUsername ? '@' + tx.counterpartyUsername : '—';
    document.getElementById('wtx-note').textContent = tx.description || '—';
    document.getElementById('wtx-reference').textContent = tx.reference;
    document.getElementById('wtx-date').textContent = new Date(tx.createdAt).toLocaleString();
    document.getElementById('wallet-tx-modal').style.display = 'flex';
  } catch (e) {
    toast(e.message, true);
  }
}

// ─── Send flow ──────────────────────────────────────────────────────

function openSendModal() {
  if (!_walletHasPin) {
    toast('Set a wallet PIN first');
    openWalletPinModal();
    return;
  }
  _sendFlow = { recipient: null, recipientDisplay: null, amount: null, note: null, idempotencyKey: null };
  document.getElementById('wm-recipient').value = '';
  document.getElementById('wm-amount').value = '';
  document.getElementById('wm-note').value = '';
  document.getElementById('wm-pin').value = '';
  if (_sendPrefill) {
    document.getElementById('wm-recipient').value = _sendPrefill;
    _sendPrefill = null;
  }
  sendModalShowStep('form');
  document.getElementById('send-money-modal').style.display = 'flex';
}

function closeSendModal() {
  document.getElementById('send-money-modal').style.display = 'none';
  // Refresh balance/activity in case a send completed.
  if (document.getElementById('wallet-panel').style.display !== 'none') initWalletPanel();
}

function sendModalShowStep(name) {
  ['form', 'confirm', 'pin', 'sending', 'success'].forEach(s => {
    document.getElementById('wm-step-' + s).style.display = s === name ? '' : 'none';
  });
}

function sendModalBack(step) { sendModalShowStep(step); }

async function sendModalContinue() {
  const recipient = document.getElementById('wm-recipient').value.trim();
  const amount = document.getElementById('wm-amount').value.trim();
  const note = document.getElementById('wm-note').value.trim();

  if (!recipient) return toast('Enter a recipient', true);
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
    return toast('Enter a valid amount', true);
  }

  const btn = document.getElementById('wm-continue-btn');
  btn.disabled = true;
  try {
    const lookupId = recipient.replace(/^@/, '');
    const preview = await walletApi('GET', '/' + encodeURIComponent(lookupId));
    _sendFlow.recipient = recipient;
    _sendFlow.recipientDisplay = preview.username ? '@' + preview.username : recipient;
    _sendFlow.amount = amount;
    _sendFlow.note = note;

    document.getElementById('wm-confirm-amount').textContent = amount + ' NX';
    document.getElementById('wm-confirm-recipient').textContent = _sendFlow.recipientDisplay;
    document.getElementById('wm-confirm-note').textContent = note || '—';
    sendModalShowStep('confirm');
  } catch (e) {
    toast(e.status === 404 ? 'Recipient not found' : e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function sendModalGoToPin() {
  document.getElementById('wm-pin').value = '';
  sendModalShowStep('pin');
}

async function submitSend() {
  const pin = document.getElementById('wm-pin').value.trim();
  if (!/^\d{4,6}$/.test(pin)) return toast('Enter your 4–6 digit PIN', true);

  // One idempotency key per logical send attempt — reused across a
  // retry of the *same* attempt (e.g. a flaky network response) so a
  // double-tap or resubmit can never create two transfers, but a fresh
  // key is minted the next time the modal is opened for a new payment.
  if (!_sendFlow.idempotencyKey) {
    _sendFlow.idempotencyKey = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  }

  const sendBtn = document.getElementById('wm-send-btn');
  sendBtn.disabled = true;
  sendModalShowStep('sending');
  try {
    const { transaction } = await walletApi('POST', '/send', {
      recipient: _sendFlow.recipient,
      amount: _sendFlow.amount,
      pin,
      note: _sendFlow.note || undefined,
    }, { 'Idempotency-Key': _sendFlow.idempotencyKey });

    document.getElementById('wm-success-amount').textContent = _sendFlow.amount + ' NX';
    document.getElementById('wm-success-ref').textContent = transaction.reference;
    sendModalShowStep('success');
  } catch (e) {
    toast(e.message, true);
    sendModalShowStep('pin');
  } finally {
    sendBtn.disabled = false;
  }
}

// ─── Receive ────────────────────────────────────────────────────────

async function openReceiveModal() {
  try {
    const data = await walletApi('GET', '/receive');
    document.getElementById('wm-receive-username').textContent = '@' + data.username;
    document.getElementById('wm-receive-walletid').textContent = data.walletId;
    document.getElementById('receive-modal').dataset.walletId = data.walletId;
    document.getElementById('receive-modal').style.display = 'flex';
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas(document.getElementById('wm-qr-canvas'), data.qrPayload, { width: 200, margin: 1 }, (err) => {
        if (err) console.error('QR render error:', err);
      });
    }
  } catch (e) {
    toast(e.message, true);
  }
}

function copyWalletId() {
  const id = document.getElementById('receive-modal').dataset.walletId;
  if (!id) return;
  navigator.clipboard?.writeText(id).then(() => toast('Wallet ID copied')).catch(() => toast('Could not copy', true));
}

function shareWalletId() {
  const id = document.getElementById('receive-modal').dataset.walletId;
  if (!id) return;
  if (navigator.share) {
    navigator.share({ title: 'My Nyxie Wallet', text: `Send me NX: ${id}` }).catch(() => {});
  } else {
    copyWalletId();
  }
}

// ─── PIN setup / change ─────────────────────────────────────────────

function openWalletPinModal() {
  const title = document.getElementById('wpm-title');
  const sub = document.getElementById('wpm-sub');
  const currentWrap = document.getElementById('wpm-current-wrap');
  document.getElementById('wpm-current-pin').value = '';
  document.getElementById('wpm-new-pin').value = '';
  document.getElementById('wpm-confirm-pin').value = '';
  if (_walletHasPin) {
    title.textContent = 'Change Wallet PIN';
    sub.textContent = 'Enter your current PIN and choose a new one.';
    currentWrap.style.display = '';
  } else {
    title.textContent = 'Set Wallet PIN';
    sub.textContent = 'Create a 4–6 digit PIN to protect your wallet.';
    currentWrap.style.display = 'none';
  }
  document.getElementById('wallet-pin-modal').style.display = 'flex';
}

async function submitWalletPin() {
  const newPin = document.getElementById('wpm-new-pin').value.trim();
  const confirmPin = document.getElementById('wpm-confirm-pin').value.trim();
  if (!/^\d{4,6}$/.test(newPin)) return toast('PIN must be 4–6 digits', true);
  if (newPin !== confirmPin) return toast('PINs do not match', true);

  const btn = document.getElementById('wpm-save-btn');
  btn.disabled = true;
  try {
    if (_walletHasPin) {
      const currentPin = document.getElementById('wpm-current-pin').value.trim();
      if (!currentPin) { toast('Enter your current PIN', true); btn.disabled = false; return; }
      await walletApi('PUT', '/pin', { currentPin, newPin });
    } else {
      await walletApi('POST', '/pin', { pin: newPin });
      _walletHasPin = true;
    }
    toast('PIN saved');
    document.getElementById('wallet-pin-modal').style.display = 'none';
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}
// ─── Scan to pay ────────────────────────────────────────────────────
// Reads a Nyxie wallet QR (nyx://pay/<walletId>) with the camera, an
// uploaded image, or a typed wallet ID, then opens the Send flow with
// that recipient filled in. Uses the browser's BarcodeDetector where it
// exists and falls back to the jsQR library (loaded in index.html).

let _scan = { stream: null, timer: 0, detector: null, busy: false, cooldownUntil: 0 };
let _sendPrefill = null;

const _WALLET_QR_RE = /^nyx:\/\/pay\/([A-Za-z0-9-]{4,64})$/;

function _scanSetStatus(msg, isErr) {
  const el = document.getElementById('wm-scan-status');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}

async function openScanModal() {
  if (!_walletHasPin) {
    toast('Set a wallet PIN first');
    openWalletPinModal();
    return;
  }
  document.getElementById('wm-scan-manual').value = '';
  document.getElementById('scan-modal').style.display = 'flex';
  await startScan();
}

function closeScanModal() {
  stopScan();
  document.getElementById('scan-modal').style.display = 'none';
}

async function startScan() {
  const view = document.getElementById('wm-scan-view');
  const video = document.getElementById('wm-scan-video');
  view.classList.remove('px-nocam');
  _scanSetStatus('Starting camera…');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    view.classList.add('px-nocam');
    _scanSetStatus('Camera isn\'t available here (it needs HTTPS). Upload an image or enter a wallet ID instead.', true);
    return;
  }
  try {
    _scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    view.classList.add('px-nocam');
    _scanSetStatus('Camera access was blocked. Upload an image or enter a wallet ID instead.', true);
    return;
  }
  // The modal may have been closed while the permission prompt was open.
  if (document.getElementById('scan-modal').style.display === 'none') { stopScan(); return; }

  video.srcObject = _scan.stream;
  try { await video.play(); } catch (e) { /* autoplay quirks — frames still arrive */ }
  if (!_scan.detector && 'BarcodeDetector' in window) {
    try { _scan.detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { _scan.detector = null; }
  }
  if (!_scan.detector && typeof jsQR === 'undefined') {
    view.classList.add('px-nocam');
    stopScan();
    _scanSetStatus('QR scanning isn\'t supported in this browser. Enter a wallet ID instead.', true);
    return;
  }
  _scanSetStatus('Point your camera at a Nyxie wallet QR code.');
  _scan.timer = setInterval(_scanTick, 200);
}

function stopScan() {
  clearInterval(_scan.timer);
  _scan.timer = 0;
  if (_scan.stream) _scan.stream.getTracks().forEach(t => t.stop());
  _scan.stream = null;
  const video = document.getElementById('wm-scan-video');
  if (video) video.srcObject = null;
}

async function _decodeQr(source, width, height) {
  if (_scan.detector) {
    const found = await _scan.detector.detect(source);
    return found && found[0] ? found[0].rawValue : null;
  }
  if (typeof jsQR === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  const img = ctx.getImageData(0, 0, width, height);
  const code = jsQR(img.data, width, height, { inversionAttempts: 'dontInvert' });
  return code ? code.data : null;
}

async function _scanTick() {
  const video = document.getElementById('wm-scan-video');
  if (_scan.busy || !video || video.readyState < 2 || Date.now() < _scan.cooldownUntil) return;
  _scan.busy = true;
  try {
    const text = await _decodeQr(video, video.videoWidth, video.videoHeight);
    if (text) _handleScanResult(text);
  } catch (e) { /* a bad frame — try the next one */ }
  _scan.busy = false;
}

function _handleScanResult(text) {
  const m = _WALLET_QR_RE.exec(String(text).trim());
  if (!m) {
    _scan.cooldownUntil = Date.now() + 2000;
    _scanSetStatus('That QR code isn\'t a Nyxie wallet code.', true);
    return;
  }
  _startPaymentTo(m[1]);
}

function _startPaymentTo(walletId) {
  closeScanModal();
  _sendPrefill = walletId;
  openSendModal();
}

async function scanFromImage(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    if (!_scan.detector && 'BarcodeDetector' in window) {
      try { _scan.detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) {}
    }
    const text = await _decodeQr(bmp, bmp.width, bmp.height);
    if (!text) { _scanSetStatus('Couldn\'t find a QR code in that image.', true); return; }
    _handleScanResult(text);
  } catch (e) {
    _scanSetStatus('Couldn\'t read that image.', true);
  }
}

function scanUseManual() {
  const raw = document.getElementById('wm-scan-manual').value.trim();
  if (!raw) { _scanSetStatus('Enter a wallet ID first.', true); return; }
  const m = _WALLET_QR_RE.exec(raw);
  const id = m ? m[1] : raw.replace(/^@/, '');
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) { _scanSetStatus('That doesn\'t look like a wallet ID.', true); return; }
  _startPaymentTo(id);
}
