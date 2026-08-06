// voice.js — Voice messages + voice calls for Nyxie. Both are E2EE.
//
// SPA note: this used to be loaded via <script src="voice.js"> right
// before </body>, i.e. after dashboard.html's inline <script> had
// already run top-to-bottom (defining `appendMessage`, `connectWS`,
// `ws`, etc. as plain globals) — so this file's top-level code could
// safely capture/wrap them the instant it parsed. Now that dashboard's
// logic lives in initDashboardView() and only runs when the router
// mounts #view-app (not at page-load / script-parse time), this file's
// body is wrapped in initVoiceFeatures() too, and dashboard.js calls it
// explicitly, near the end of initDashboardView(), right after
// connectWS() has set up `ws` and after appendMessage/connectWS have
// been assigned. That preserves the exact capture-then-wrap pattern
// below (installWsHook(), the appendMessage/connectWS reassignment)
// without changing how any of it works internally.
//
// This file is loaded via <script src="voice.js"></script> right before
// </body>, i.e. AFTER the big inline <script> in dashboard.html has
// already run. Classic (non-module) <script> tags in the same document
// share one global lexical scope, so top-level `let`/`const`/functions
// declared in that inline script — `ws`, `dms`, `currentRoom`,
// `currentUser`, `token`, `sentMsgIds`, `api()`, `toast()`,
// `appendMessage()`, `scrollToBottom()`, `escapeHtml()`, `getPublicKey()`,
// `nacl` — are all directly readable/writable here without any imports.
//
// Encryption model
// -----------------
// Voice messages: identical scheme to encrypted text messages already in
// this app — NaCl box (Curve25519-XSalsa20-Poly1305), asymmetric,
// sender's private key + recipient's public key. The only difference is
// the plaintext is raw audio bytes instead of a UTF-8 string, so we use
// separate binary encrypt/decrypt helpers instead of the text ones. The
// server only ever stores/relays ciphertext + nonce, exactly like text.
//
// Voice calls: WebRTC audio is already encrypted point-to-point via
// DTLS-SRTP (that's mandatory in WebRTC, not optional), so a call with no
// TURN relay in the path is already end-to-end encrypted in the ordinary
// sense. To make that guarantee independent of what TURN/relay
// infrastructure might exist later, we add a second, application-layer
// encryption pass over the actual audio frames using the WebRTC
// "Insertable Streams" API: each side generates an ephemeral X25519
// keypair for the call, exchanges public keys through the existing
// signaling channel, and derives a shared AES-GCM key via
// nacl.box.before() (Diffie-Hellman) — a key the signaling server never
// sees and cannot compute. Every encoded audio frame is then AES-GCM
// encrypted/decrypted client-side before it ever reaches the RTP layer.
// Insertable Streams currently only ships in Chromium-based browsers; if
// it's unavailable we fall back to relying on WebRTC's built-in
// DTLS-SRTP and tell the user, rather than silently downgrading.

function initVoiceFeatures() {
  'use strict';

  // ---------------------------------------------------------------------
  // Binary NaCl secretbox helpers (voice messages, shared-secret E2EE)
  // ---------------------------------------------------------------------

  function b64ToBytes(b64) { return nacl.util.decodeBase64(b64); }
  function bytesToB64(bytes) { return nacl.util.encodeBase64(bytes); }
  // The private key is namespaced per-account (nyxie_private_key_<userId>)
  // so it can't leak across accounts on a shared browser profile — see
  // ensureE2EEKeys() in dashboard.html, which is the single source of
  // truth for how/where it's stored.
  function myPrivateKey() {
    if (!currentUser?.id) return null;
    return localStorage.getItem('nyxie_private_key_' + currentUser.id);
  }

  // The other participant's user id for the currently open DM, or null
  // if no DM is open (voice messages/calls only make sense in a DM).
  function currentDmOtherId() {
    if (!currentRoom) return null;
    const dm = dms.find(d => d.id === currentRoom.id);
    return dm ? dm._otherId : null;
  }

  // Formats a duration in seconds as "m:ss" — used for the live
  // recording timer, a sent voice message's length, and the call timer.
  function fmtDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // Derive shared key for a room (same as dashboard.html)
  async function getVoiceSharedKey(roomId) {
    const dm = dms.find(d => d.id === roomId);
    const otherId = dm ? dm._otherId : null;
    if (!otherId) return null;
    const otherPub = await getPublicKey(otherId);
    const myPriv = myPrivateKey();
    if (!otherPub || !myPriv) return null;
    const otherPubBytes = b64ToBytes(otherPub);
    const myPrivBytes = b64ToBytes(myPriv);
    return nacl.box.before(otherPubBytes, myPrivBytes);
  }

  function encryptBinary(bytes, sharedKey) {
    const nonce = nacl.randomBytes(24);
    const box = nacl.secretbox(bytes, nonce, sharedKey);
    return { ciphertext: bytesToB64(box), nonce: bytesToB64(nonce) };
  }

  function decryptBinary(ciphertextB64, nonceB64, sharedKey) {
    try {
      return nacl.secretbox.open(
        b64ToBytes(ciphertextB64), b64ToBytes(nonceB64), sharedKey
      );
    } catch { return null; }
  }
  // ---------------------------------------------------------------------
  // Styles + call UI shell (injected at runtime — kept out of the huge
  // hand-written dashboard.html markup)
  // ---------------------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = `
    #voice-record-btn { background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1.15rem;padding:2px 4px;display:flex;align-items:center;justify-content:center;transition:color .15s;flex-shrink:0;user-select:none;-webkit-user-select:none;touch-action:none; }
    #voice-record-btn:hover { color: var(--text-primary); }
    #voice-record-btn.recording { color: #e33a3a; animation: voice-pulse 1s ease-in-out infinite; }
    @keyframes voice-pulse { 0%,100%{opacity:1;} 50%{opacity:.35;} }
    #voice-record-timer { font-size:.8rem; color:#e33a3a; margin-right:2px; font-variant-numeric:tabular-nums; flex-shrink:0; }

    .voice-msg-bubble { display:flex; align-items:center; gap:10px; background:var(--bg-input); border-radius:14px; padding:8px 12px; max-width:240px; }
    .voice-msg-play { width:30px;height:30px;border-radius:50%;background:var(--accent);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:.85rem; }
    .voice-msg-bar { flex:1; height:4px; background:rgba(255,255,255,.15); border-radius:2px; position:relative; overflow:hidden; min-width:60px; }
    .voice-msg-bar-fill { position:absolute; left:0; top:0; bottom:0; width:0%; background:var(--accent); }
    .voice-msg-duration { font-size:.72rem; color:var(--text-muted); flex-shrink:0; font-variant-numeric:tabular-nums; }
    .voice-msg-lock { font-size:.7rem; color:var(--text-muted); flex-shrink:0; }

    #call-overlay { position:fixed; inset:0; background:rgba(0,0,0,.6); display:none; align-items:center; justify-content:center; z-index:9999; }
    #call-overlay.open { display:flex; }
    #call-card { background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:16px; padding:32px; width:290px; text-align:center; box-shadow:var(--shadow); }
    #call-avatar { width:84px;height:84px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:2rem;font-weight:600;color:#fff;margin:0 auto 16px;overflow:hidden; }
    #call-avatar img { width:100%;height:100%;object-fit:cover; }
    #call-name { font-size:1.1rem; font-weight:600; margin-bottom:4px; color:var(--text-primary); }
    #call-status { font-size:.82rem; color:var(--text-muted); margin-bottom:22px; }
    .call-btn-row { display:flex; gap:18px; justify-content:center; }
    .call-round-btn { width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;transition:transform .1s; }
    .call-round-btn:active { transform:scale(.92); }
    .call-round-btn.accept { background:#3ba55c; }
    .call-round-btn.decline { background:#e33a3a; }
    .call-round-btn svg { width:22px;height:22px; }

    #call-bar { position:fixed; top:0; left:0; right:0; background:var(--accent); color:#fff; display:none; align-items:center; justify-content:center; gap:14px; padding:9px 12px; font-size:.83rem; z-index:9998; }
    #call-bar.open { display:flex; }
    #call-bar button { background:rgba(255,255,255,.22); border:none; color:#fff; border-radius:6px; padding:4px 12px; cursor:pointer; font-size:.78rem; font-weight:500; }
    #call-bar button:hover { background:rgba(255,255,255,.32); }
  `;
  // Guard against duplicate injection. initVoiceFeatures() is called
  // every time initDashboardView() runs — i.e. every time the user
  // navigates to /app, not just on first load. The style tag, call
  // overlay, and call bar below are appended to document.head/body
  // directly (not into #app-root, which the router clears on every
  // navigation), so without this guard they'd pile up: a second visit
  // to /app would leave two #call-overlay / #call-bar elements in the
  // DOM with duplicated child ids (#call-name, #call-status,
  // #call-bar-timer, etc). document.getElementById() always returns the
  // FIRST match in document order, so any code later in this same file
  // that looks elements up by id (updateCallUI, the timer tick, etc.)
  // would keep reading/writing the stale first (oldest) copy while the
  // visually-on-top, most-recently-appended copy silently never updates
  // — which is exactly what made calls look broken/frozen after
  // navigating away and back once.
  const alreadyInjected = !!document.getElementById('call-overlay');
  let overlay = document.getElementById('call-overlay');
  let callBar = document.getElementById('call-bar');

  if (!alreadyInjected) {
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'call-overlay';
    overlay.innerHTML = `
      <div id="call-card">
        <div id="call-avatar">?</div>
        <div id="call-name">—</div>
        <div id="call-status">calling…</div>
        <div class="call-btn-row" id="call-btn-row"></div>
      </div>`;
    document.body.appendChild(overlay);

    callBar = document.createElement('div');
    callBar.id = 'call-bar';
    callBar.innerHTML = `<span id="call-bar-lock">🔒</span><span id="call-bar-text">On call</span><span id="call-bar-timer">00:00</span><button id="call-bar-mute" type="button">Mute</button><button id="call-bar-hangup" type="button">Hang up</button>`;
    document.body.appendChild(callBar);
    callBar.querySelector('#call-bar-hangup').onclick = () => hangUp();
    callBar.querySelector('#call-bar-mute').onclick = () => {
      if (!localStream) return;
      const track = localStream.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      callBar.querySelector('#call-bar-mute').textContent = track.enabled ? 'Mute' : 'Unmute';
    };
  }

  const svgHangup = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.996.996 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .27-.11.52-.29.7l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85a.99.99 0 0 1-.56-.9v-3.1A17.9 17.9 0 0 0 12 9z"/></svg>';
  const svgAccept = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>';

  function makeCallBtn(cls, svg, onClick) {
    const btn = document.createElement('button');
    btn.className = 'call-round-btn ' + cls;
    btn.type = 'button';
    btn.innerHTML = svg;
    btn.onclick = onClick;
    return btn;
  }

  // ---------------------------------------------------------------------
  // Voice messages
  // ---------------------------------------------------------------------

  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStream = null;
  let recordStartTime = 0;
  let recordTimerInterval = null;
  let recordCancelled = false;

  function injectMicButton() {
    const inputBox = document.getElementById('input-box');
    const sendBtn = document.getElementById('send-btn');
    if (!inputBox || !sendBtn || document.getElementById('voice-record-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'voice-record-btn';
    btn.type = 'button';
    btn.title = 'Hold to record a voice message';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"/><path d="M19 11a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.92V20H9a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2h-2v-2.08A7 7 0 0 0 19 11z"/></svg>';
    sendBtn.parentNode.insertBefore(btn, sendBtn);

    const start = (ev) => { ev.preventDefault(); startRecording(); };
    const stop = (ev) => { if (ev) ev.preventDefault(); stopRecordingAndSend(false); };
    const cancel = () => stopRecordingAndSend(true);

    btn.addEventListener('mousedown', start);
    btn.addEventListener('touchstart', start, { passive: false });
    btn.addEventListener('mouseup', stop);
    btn.addEventListener('touchend', stop);
    btn.addEventListener('mouseleave', cancel);
    btn.addEventListener('contextmenu', e => e.preventDefault());
  }

  async function startRecording() {
    if (mediaRecorder) return; // already recording
    if (!currentRoom) { toast('Open a conversation first'); return; }
    const otherId = currentDmOtherId();
    if (!otherId) { toast('Voice messages are only available in direct messages'); return; }

    const recipientPub = await getPublicKey(otherId);
    if (!recipientPub || !myPrivateKey()) {
      toast('🔒 Cannot send voice message — encryption keys unavailable');
      return;
    }

    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('Microphone access denied');
      return;
    }

    recordedChunks = [];
    recordCancelled = false;
    const mimeType = (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    mediaRecorder = new MediaRecorder(recordStream, { mimeType });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start();
    recordStartTime = Date.now();

    const btn = document.getElementById('voice-record-btn');
    btn.classList.add('recording');
    let timerEl = document.getElementById('voice-record-timer');
    if (!timerEl) {
      timerEl = document.createElement('span');
      timerEl.id = 'voice-record-timer';
      btn.parentNode.insertBefore(timerEl, btn);
    }
    timerEl.textContent = '0:00';
    recordTimerInterval = setInterval(() => {
      timerEl.textContent = fmtDuration((Date.now() - recordStartTime) / 1000);
    }, 200);
  }

  async function stopRecordingAndSend(cancelled) {
    if (!mediaRecorder) return;
    recordCancelled = cancelled;
    const durationSec = (Date.now() - recordStartTime) / 1000;

    const btn = document.getElementById('voice-record-btn');
    btn.classList.remove('recording');
    clearInterval(recordTimerInterval);
    const timerEl = document.getElementById('voice-record-timer');
    if (timerEl) timerEl.remove();

    const recorder = mediaRecorder;
    mediaRecorder = null;
    const finished = new Promise(resolve => { recorder.onstop = resolve; });
    if (recorder.state !== 'inactive') recorder.stop();
    recordStream.getTracks().forEach(t => t.stop());
    await finished;

    if (recordCancelled || durationSec < 0.6 || !recordedChunks.length) {
      if (!recordCancelled) toast('Recording too short');
      return;
    }

    const blob = new Blob(recordedChunks, { type: recorder.mimeType || 'audio/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const otherId = currentDmOtherId();
    const recipientPub = await getPublicKey(otherId);
    const myPriv = myPrivateKey();
    if (!recipientPub || !myPriv) { toast('🔒 Cannot send voice message — encryption keys unavailable'); return; }

    const sharedKey = await getVoiceSharedKey(currentRoom.id);
    if (!sharedKey) { toast('🔒 Cannot send voice message — encryption keys unavailable'); return; }
    const { ciphertext, nonce } = encryptBinary(bytes, sharedKey);
    const res = await api('POST', `/rooms/${currentRoom.id}/messages`, {
      type: 'voice', ciphertext, nonce, duration: Math.round(durationSec)
    });
    if (!res || res.error) { toast(res?.error || 'Failed to send voice message'); return; }

    if (res.message?.id) sentMsgIds.add(res.message.id);
    if (!_roomHasMessages) {
      document.getElementById('messages-container').innerHTML = '';
      _roomHasMessages = true;
    }
    appendMessage(res.message);
    scrollToBottom();

    const dmObj = dms.find(d => d.id === currentRoom.id);
    if (dmObj) {
      dmObj.last_message = '🎤 Voice message';
      dmObj.last_message_at = res.message.created_at;
      dms = [dmObj, ...dms.filter(d => d.id !== dmObj.id)];
      renderDMList();
      document.querySelector(`[data-room-id="${currentRoom.id}"]`)?.classList.add('active');
    }
  }

  const voiceAudioCache = new Map(); // msg.id -> { audio }

  window.__playVoiceMsg = async function (msgId) {
    const msg = window._messagesById.get(msgId);
    if (!msg) return;
    const bubble = document.getElementById('voice-bubble-' + msgId);
    if (!bubble) return;
    const playBtn = bubble.querySelector('.voice-msg-play');
    const fill = bubble.querySelector('.voice-msg-bar-fill');

    let entry = voiceAudioCache.get(msgId);
    if (!entry) {
      const sharedKey = await getVoiceSharedKey(msg.room_id);
      if (!sharedKey) { toast('🔒 Cannot decrypt voice message — keys unavailable'); return; }
      const bytes = decryptBinary(msg.content, msg.nonce, sharedKey);
      if (!bytes) { toast('🔒 Failed to decrypt voice message'); return; }
      const blob = new Blob([bytes], { type: 'audio/webm' });
      const audio = new Audio(URL.createObjectURL(blob));
      audio.addEventListener('timeupdate', () => {
        if (audio.duration) fill.style.width = (audio.currentTime / audio.duration * 100) + '%';
      });
      audio.addEventListener('ended', () => { playBtn.textContent = '▶'; fill.style.width = '0%'; });
      entry = { audio };
      voiceAudioCache.set(msgId, entry);
    }

    voiceAudioCache.forEach((e, id) => {
      if (id !== msgId && !e.audio.paused) {
        e.audio.pause();
        document.getElementById('voice-bubble-' + id)?.querySelector('.voice-msg-play')?.replaceChildren(document.createTextNode('▶'));
      }
    });

    if (entry.audio.paused) { entry.audio.play(); playBtn.textContent = '⏸'; }
    else { entry.audio.pause(); playBtn.textContent = '▶'; }
  };

  async function renderVoiceMessage(msg) {
    const container = document.getElementById('messages-container');
    if (msg.id && container.querySelector(`[data-msg-id="${msg.id}"]`)) return;

    const isOwn = msg.user_id === currentUser.id;
    const msgDate = new Date(msg.created_at).toDateString();
    const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const fullTime = new Date(msg.created_at).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    window._messagesById.set(msg.id, msg);

    if (msgDate !== window._lastMsgDate) {
      window._lastMsgDate = msgDate;
      const today = new Date().toDateString();
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      const label = msgDate === today ? 'Today' : msgDate === yesterday ? 'Yesterday' : new Date(msg.created_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      const div = document.createElement('div');
      div.className = 'msg-date-divider';
      div.innerHTML = `<span>${label}</span>`;
      container.appendChild(div);
      window._lastMsgUserId = null;
    }

    const now = msg.created_at;
    const sameUser = msg.user_id === window._lastMsgUserId && (now - window._lastMsgTime) < 5 * 60 * 1000;
    window._lastMsgUserId = msg.user_id;
    window._lastMsgTime = now;

    const displayName = msg.display_name || msg.username || 'Unknown';
    const bubble = `
      <div class="voice-msg-bubble" id="voice-bubble-${msg.id}">
        <button class="voice-msg-play" onclick="window.__playVoiceMsg('${msg.id}')">▶</button>
        <div class="voice-msg-bar"><div class="voice-msg-bar-fill"></div></div>
        <span class="voice-msg-duration">${fmtDuration(msg.duration)}</span>
        <span class="voice-msg-lock" title="End-to-end encrypted">🔒</span>
      </div>`;

    const row = document.createElement('div');
    row.dataset.msgId = msg.id;

    if (sameUser) {
      row.className = 'msg-row compact' + (isOwn ? ' outgoing' : '');
      row.innerHTML = `
        <div class="msg-content-col">
          <span class="msg-timestamp-inline" title="${fullTime}">${timeStr}</span>
          ${bubble}
        </div>`;
    } else {
      row.className = 'msg-row' + (isOwn ? ' outgoing' : '');
      row.style.marginTop = '17px';
      row.innerHTML = `
        <div class="msg-content-col">
          <div class="msg-header">
            <span class="msg-author" onclick="showUserProfile(event, '${msg.user_id}')">${escapeHtml(displayName)}</span>
            <span class="msg-timestamp" title="${fullTime}">${timeStr}</span>
          </div>
          ${bubble}
        </div>`;
    }

    container.appendChild(row);
  }

  // Wrap whatever appendMessage currently is (the E2EE-text-decrypting
  // version installed earlier in dashboard.html) so voice messages get
  // routed to their own renderer instead of being treated as text.
  const appendMessageBeforeVoice = appendMessage;
  appendMessage = async function (msg) {
    if (msg && msg.msg_type === 'voice') { await renderVoiceMessage(msg); return; }
    return appendMessageBeforeVoice.call(this, msg);
  };

  // ---------------------------------------------------------------------
  // Voice calls (WebRTC, DM-only, E2EE)
  // ---------------------------------------------------------------------

  const insertableStreamsSupported = !!(window.RTCRtpSender && RTCRtpSender.prototype.createEncodedStreams);
  const RTC_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    encodedInsertableStreams: insertableStreamsSupported
  };

  let pc = null;
  let localStream = null;
  let currentCallId = null;
  let callRole = null;        // 'caller' | 'callee'
  let callPeerId = null;
  let callPeerName = null;
  let myEphemeral = null;     // nacl keypair for this call only
  let sharedCallKey = null;   // Uint8Array, derived via nacl.box.before
  let pendingOffer = null;
  let callTimerInterval = null;
  let cryptoKeyPromise = null;

  function importCallKey() {
    if (!cryptoKeyPromise) {
      cryptoKeyPromise = crypto.subtle.importKey('raw', sharedCallKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    return cryptoKeyPromise;
  }

  async function setupSenderE2EE(sender) {
    if (!sharedCallKey || !sender.createEncodedStreams) return;
    const key = await importCallKey();
    const streams = sender.createEncodedStreams();
    const transform = new TransformStream({
      async transform(frame, controller) {
        try {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, frame.data);
          const out = new Uint8Array(iv.length + encrypted.byteLength);
          out.set(iv, 0);
          out.set(new Uint8Array(encrypted), iv.length);
          frame.data = out.buffer;
          controller.enqueue(frame);
        } catch { /* drop frame rather than send it unencrypted */ }
      }
    });
    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch(() => {});
  }

  async function setupReceiverE2EE(receiver) {
    if (!receiver || !sharedCallKey || !receiver.createEncodedStreams) return;
    const key = await importCallKey();
    const streams = receiver.createEncodedStreams();
    const transform = new TransformStream({
      async transform(frame, controller) {
        try {
          const data = new Uint8Array(frame.data);
          const iv = data.slice(0, 12);
          const ciphertext = data.slice(12);
          frame.data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
          controller.enqueue(frame);
        } catch { /* drop frame rather than play garbage audio */ }
      }
    });
    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch(() => {});
  }

  function setupSenderE2EEForAllSenders() {
    if (!insertableStreamsSupported) return;
    pc.getSenders().forEach(s => { if (s.track) setupSenderE2EE(s); });
  }

  function createPeerConnection() {
    const conn = new RTCPeerConnection(RTC_CONFIG);
    conn.onicecandidate = (e) => {
      if (e.candidate && currentCallId) {
        ws.send(JSON.stringify({ type: 'call_ice_candidate', call_id: currentCallId, candidate: e.candidate }));
      }
    };
    conn.ontrack = (e) => {
      let remoteAudio = document.getElementById('call-remote-audio');
      if (!remoteAudio) {
        remoteAudio = document.createElement('audio');
        remoteAudio.id = 'call-remote-audio';
        remoteAudio.autoplay = true;
        document.body.appendChild(remoteAudio);
      }
      remoteAudio.srcObject = e.streams[0];
      if (insertableStreamsSupported) {
        const receiver = conn.getReceivers().find(r => r.track === e.track);
        if (receiver) setupReceiverE2EE(receiver);
      }
    };
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === 'failed') { toast('Call connection failed'); teardownCall(); }
    };
    return conn;
  }

  window.startCall = async function () {
    if (currentCallId) { toast('Already on a call'); return; }
    if (!currentRoom) { toast('Open a conversation first'); return; }
    const otherId = currentDmOtherId();
    if (!otherId) { toast('Voice calls are only available in direct messages'); return; }

    const dm = dms.find(d => d.id === currentRoom.id);
    callPeerName = dm?.display_name || dm?.name || 'Unknown';

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch { toast('Microphone access denied'); return; }

    callRole = 'caller';
    callPeerId = otherId;
    currentCallId = crypto.randomUUID();
    myEphemeral = nacl.box.keyPair();
    sharedCallKey = null;
    cryptoKeyPromise = null;

    pc = createPeerConnection();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    showCallUI('outgoing', dm?._avatar);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({
      type: 'call_offer',
      target_user_id: otherId,
      room_id: currentRoom.id,
      call_id: currentCallId,
      sdp: offer.sdp,
      ephemeral_pubkey: bytesToB64(myEphemeral.publicKey)
    }));
  };

  async function acceptCall() {
    const offerMsg = pendingOffer;
    if (!offerMsg) return;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch { toast('Microphone access denied'); rejectCall(); return; }

    myEphemeral = nacl.box.keyPair();
    sharedCallKey = nacl.box.before(b64ToBytes(offerMsg.ephemeral_pubkey), myEphemeral.secretKey);
    cryptoKeyPromise = null;

    pc = createPeerConnection();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    setupSenderE2EEForAllSenders();

    await pc.setRemoteDescription({ type: 'offer', sdp: offerMsg.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    ws.send(JSON.stringify({
      type: 'call_answer',
      call_id: currentCallId,
      sdp: answer.sdp,
      ephemeral_pubkey: bytesToB64(myEphemeral.publicKey)
    }));

    pendingOffer = null;
    showCallUI('active');
  }

  function rejectCall() {
    if (currentCallId) ws.send(JSON.stringify({ type: 'call_reject', call_id: currentCallId }));
    teardownCall();
  }

  function hangUp() {
    if (currentCallId) ws.send(JSON.stringify({ type: 'call_end', call_id: currentCallId }));
    teardownCall();
  }

  function teardownCall() {
    if (pc) { pc.getSenders().forEach(s => s.track && s.track.stop()); pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    const remoteAudio = document.getElementById('call-remote-audio');
    if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio.remove(); }
    currentCallId = null; callRole = null; callPeerId = null; callPeerName = null;
    myEphemeral = null; sharedCallKey = null; cryptoKeyPromise = null; pendingOffer = null;
    clearInterval(callTimerInterval); callTimerInterval = null;
    hideCallUI();
  }

  function showCallUI(state, avatarUrl) {
    const avatarEl = document.getElementById('call-avatar');
    const nameEl = document.getElementById('call-name');
    const statusEl = document.getElementById('call-status');
    const btnRow = document.getElementById('call-btn-row');

    nameEl.textContent = callPeerName || 'Unknown';
    avatarEl.innerHTML = avatarUrl ? `<img src="${escapeHtml(avatarUrl)}">` : '';
    if (!avatarUrl) avatarEl.textContent = (callPeerName || '?')[0].toUpperCase();

    if (state === 'outgoing') {
      overlay.classList.add('open');
      callBar.classList.remove('open');
      statusEl.textContent = 'Calling…';
      btnRow.innerHTML = '';
      btnRow.appendChild(makeCallBtn('decline', svgHangup, () => hangUp()));
    } else if (state === 'incoming') {
      overlay.classList.add('open');
      statusEl.textContent = 'Incoming voice call';
      btnRow.innerHTML = '';
      btnRow.appendChild(makeCallBtn('decline', svgHangup, () => rejectCall()));
      btnRow.appendChild(makeCallBtn('accept', svgAccept, () => acceptCall()));
    } else if (state === 'active') {
      overlay.classList.remove('open');
      callBar.classList.add('open');
      document.getElementById('call-bar-lock').textContent = insertableStreamsSupported ? '🔒' : '🔓';
      document.getElementById('call-bar-lock').title = insertableStreamsSupported
        ? 'End-to-end encrypted (frame-level E2EE + DTLS-SRTP)'
        : 'Encrypted via standard WebRTC (DTLS-SRTP); frame-level E2EE unsupported in this browser';
      document.getElementById('call-bar-text').textContent = 'Call with ' + (callPeerName || 'Unknown');
      document.getElementById('call-bar-mute').textContent = 'Mute';
      startCallTimer();
    }
  }

  function hideCallUI() {
    overlay.classList.remove('open');
    callBar.classList.remove('open');
  }

  function startCallTimer() {
    const startedAt = Date.now();
    clearInterval(callTimerInterval);
    callTimerInterval = setInterval(() => {
      document.getElementById('call-bar-timer').textContent = fmtDuration((Date.now() - startedAt) / 1000);
    }, 1000);
  }

  // -- incoming signaling ---------------------------------------------

  async function handleCallOffer(msg) {
    if (currentCallId) {
      ws.send(JSON.stringify({ type: 'call_reject', call_id: msg.call_id }));
      return;
    }
    currentCallId = msg.call_id;
    callRole = 'callee';
    callPeerId = msg.from_user_id;
    callPeerName = msg.from_display_name || msg.from_username || 'Unknown';
    pendingOffer = msg;
    showCallUI('incoming', msg.from_avatar);
  }

  async function handleCallAnswer(msg) {
    if (msg.call_id !== currentCallId || !pc) return;
    sharedCallKey = nacl.box.before(b64ToBytes(msg.ephemeral_pubkey), myEphemeral.secretKey);
    cryptoKeyPromise = null;
    setupSenderE2EEForAllSenders();
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    showCallUI('active');
  }

  async function handleCallIce(msg) {
    if (msg.call_id !== currentCallId || !pc) return;
    try { await pc.addIceCandidate(msg.candidate); } catch { /* ignore stray/late candidates */ }
  }

  function handleCallReject(msg) {
    if (msg.call_id !== currentCallId) return;
    toast('Call declined');
    teardownCall();
  }

  function handleCallBusy(msg) {
    toast(msg.self ? 'You are already on a call' : (callPeerName || 'They') + ' is on another call');
    teardownCall();
  }

  function handleCallEnd(msg) {
    if (msg.call_id !== currentCallId) return;
    toast('Call ended');
    teardownCall();
  }

  function handleCallError(msg) {
    toast(msg.message || 'Call error');
    teardownCall();
  }

  function routeCallMessage(e) {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.type) {
      case 'call_offer': handleCallOffer(msg); break;
      case 'call_answer': handleCallAnswer(msg); break;
      case 'call_ice_candidate': handleCallIce(msg); break;
      case 'call_reject': handleCallReject(msg); break;
      case 'call_busy': handleCallBusy(msg); break;
      case 'call_end': handleCallEnd(msg); break;
      case 'call_error': handleCallError(msg); break;
    }
  }

  // The main script's connectWS() already ran (synchronously) before this
  // file loaded, so `ws` and `ws.onmessage` already exist — wrap the
  // handler that's on it right now rather than waiting to be called.
  function installWsHook() {
    if (typeof ws === 'undefined' || !ws) return false;
    const prior = ws.onmessage;
    if (prior && prior.__voiceHooked) return true;
    const wrapped = function (e) { prior && prior.call(ws, e); routeCallMessage(e); };
    wrapped.__voiceHooked = true;
    ws.onmessage = wrapped;
    return true;
  }
  if (!installWsHook()) setTimeout(installWsHook, 500);

  // connectWS is a function declaration (a property of window), so
  // reassigning it here also redirects the reconnect call the main
  // script makes via `setTimeout(connectWS, 2000)` on ws.onclose — every
  // future (re)connection gets the hook re-applied to its fresh socket.
  const origConnectWS = connectWS;
  connectWS = function () {
    origConnectWS();
    installWsHook();
  };

  // ---------------------------------------------------------------------
  // Wire up the mic button once the chat UI exists
  // ---------------------------------------------------------------------

  injectMicButton();
  const chatObserver = new MutationObserver(() => injectMicButton());
  chatObserver.observe(document.body, { childList: true, subtree: true });

  // Tracked so destroyVoiceFeatures() (called by router.js when
  // navigating away from #view-app) can stop observing and hang up any
  // in-progress call instead of leaking them across view mounts.
  _voiceRuntime.chatObserver = chatObserver;
  _voiceRuntime.hangUp = hangUp;
  _voiceRuntime.stopRecordingAndSend = stopRecordingAndSend;
  _voiceRuntime.getMediaRecorder = () => mediaRecorder;
}
window.initVoiceFeatures = initVoiceFeatures;

// Populated by initVoiceFeatures() each time it runs; read by
// destroyVoiceFeatures() to clean up observers/timers/an in-progress
// call or recording when the user navigates away from the dashboard.
const _voiceRuntime = {};

function destroyVoiceFeatures() {
  try { if (_voiceRuntime.chatObserver) _voiceRuntime.chatObserver.disconnect(); } catch (e) {}
  try { if (_voiceRuntime.getMediaRecorder && _voiceRuntime.getMediaRecorder()) _voiceRuntime.stopRecordingAndSend(true); } catch (e) {}
  try { if (_voiceRuntime.hangUp) _voiceRuntime.hangUp(); } catch (e) {}
  for (const k of Object.keys(_voiceRuntime)) delete _voiceRuntime[k];
}
window.destroyVoiceFeatures = destroyVoiceFeatures;