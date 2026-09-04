// dashboard.js — the main chat UI (DMs, messages, friends, profile, E2EE
// key management, presence/typing over WebSocket, file attachments).
// This is the complete, self-contained file.

function initDashboardView() {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  EMOJI ENGINE — loads from emojis.json, with minimal fallback
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const EmojiDB = (() => {
    let emojis = [];
    let byName = new Map();
    let loaded = false;
    let loadPromise = null;
    const FALLBACK = [
      { name: 'smile', emoji: '😊' },
      { name: 'heart', emoji: '❤️' },
      { name: 'thumbs up', emoji: '👍' },
      { name: 'fire', emoji: '🔥' },
      { name: 'skull', emoji: '💀' },
      { name: 'sparkles', emoji: '✨' },
      { name: 'wave', emoji: '👋' },
      { name: 'cry', emoji: '😢' }
    ];
    const RECENT_KEY = 'nyxie_recent_emojis';
    const MAX_RECENT = 12;

    function getRecent() {
      try { const raw = localStorage.getItem(RECENT_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
    }
    function saveRecent(list) {
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch {}
    }
    function touchRecent(emojiChar) {
      let recent = getRecent().filter(e => e !== emojiChar);
      recent.unshift(emojiChar);
      saveRecent(recent);
      const picker = document.getElementById('emoji-picker');
      if (picker && picker.classList.contains('open')) {
        renderEmojiPicker(document.getElementById('ep-search').value);
      }
    }
    function load() {
      if (loaded) return Promise.resolve(emojis);
      if (loadPromise) return loadPromise;
      loadPromise = new Promise((resolve) => {
        fetch('/assets/emojis.json')
          .then(r => { if (!r.ok) throw new Error(); return r.json(); })
          .then(data => {
            if (Array.isArray(data) && data.length) {
              emojis = data;
            } else { throw new Error(); }
            buildIndex();
            loaded = true;
            resolve(emojis);
          })
          .catch(() => {
            emojis = FALLBACK;
            buildIndex();
            loaded = true;
            resolve(emojis);
          });
      });
      return loadPromise;
    }
    function buildIndex() {
      byName.clear();
      for (const item of emojis) {
        if (item.name && item.emoji) byName.set(item.name.toLowerCase(), item.emoji);
      }
    }
    function search(query, limit = 10) {
      const q = query.toLowerCase().trim();
      if (!q) return [];
      const recent = getRecent();
      const exact = [], starts = [], contains = [];
      for (const item of emojis) {
        const name = item.name.toLowerCase();
        if (name === q) exact.push(item);
        else if (name.startsWith(q)) starts.push(item);
        else if (name.includes(q)) contains.push(item);
      }
      const sortAlpha = (a, b) => a.name.localeCompare(b.name);
      exact.sort(sortAlpha); starts.sort(sortAlpha); contains.sort(sortAlpha);
      const resultMap = new Map();
      for (const r of recent) {
        const found = emojis.find(e => e.emoji === r);
        if (found && !resultMap.has(found.emoji)) resultMap.set(found.emoji, found);
      }
      for (const item of exact) if (!resultMap.has(item.emoji)) resultMap.set(item.emoji, item);
      for (const item of starts) if (!resultMap.has(item.emoji)) resultMap.set(item.emoji, item);
      for (const item of contains) if (!resultMap.has(item.emoji)) resultMap.set(item.emoji, item);
      return [...resultMap.values()].slice(0, limit);
    }
    function getByName(name) {
      return byName.get(name.toLowerCase()) || null;
    }
    return { load, search, getByName, touchRecent, getRecent, isLoaded: () => loaded, getEmojis: () => emojis };
  })();

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  EMOJI PICKER UI
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  let emojiPickerOpen = false;
  let epSearchTimeout = null;

  function toggleEmojiPicker() {
    const picker = document.getElementById('emoji-picker');
    if (picker.classList.contains('open')) {
      picker.classList.remove('open');
      emojiPickerOpen = false;
      return;
    }
    picker.classList.add('open');
    emojiPickerOpen = true;
    document.getElementById('ep-search').value = '';
    document.getElementById('ep-search').focus();
    renderEmojiPicker('');
  }

  function renderEmojiPicker(query) {
    const container = document.getElementById('ep-results');
    if (!container) return;
    const q = (query || '').trim();
    let results = [];
    if (q) {
      results = EmojiDB.search(q, 10);
      if (!results.length) {
        container.innerHTML = `<div class="ep-empty">No emojis found</div>`;
        return;
      }
      let html = `<div class="ep-grid">`;
      for (const item of results) html += renderEmojiItem(item);
      html += `</div>`;
      container.innerHTML = html;
      return;
    }
    const allEmojis = EmojiDB.getEmojis();
    const recent = EmojiDB.getRecent();
    const recentEmojis = recent.map(r => allEmojis.find(e => e.emoji === r)).filter(Boolean);
    let html = '';
    if (recentEmojis.length) {
      html += `<div class="ep-section-label">Recent</div><div class="ep-grid">`;
      for (const item of recentEmojis) html += renderEmojiItem(item);
      html += `</div>`;
    }
    const shown = new Set(recentEmojis.map(e => e.emoji));
    const remaining = allEmojis.filter(e => !shown.has(e.emoji));
    if (remaining.length) {
      html += `<div class="ep-section-label">All Emojis</div><div class="ep-grid">`;
      for (const item of remaining) html += renderEmojiItem(item);
      html += `</div>`;
    }
    container.innerHTML = html || `<div class="ep-empty">No emojis loaded</div>`;
  }

  function renderEmojiItem(item) {
    const name = item.name || '';
    const displayName = name.length > 24 ? name.slice(0, 22) + '…' : name;
    return `<button class="ep-item" onclick="selectEmoji('${item.emoji.replace(/'/g, "\\'")}')" title="${name.replace(/'/g, '\\\'')}">
      ${item.emoji}
      <span class="ep-tooltip">${displayName}</span>
    </button>`;
  }

  function selectEmoji(emoji) {
    const input = document.getElementById('msg-input');
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const val = input.value;
    input.value = val.slice(0, start) + emoji + val.slice(end);
    input.focus();
    const newPos = start + emoji.length;
    input.selectionStart = input.selectionEnd = newPos;
    input.dispatchEvent(new Event('input'));
    EmojiDB.touchRecent(emoji);
    document.getElementById('emoji-picker').classList.remove('open');
    emojiPickerOpen = false;
    document.getElementById('shortcode-suggest').classList.remove('open');
  }

  function clearEmojiSearch() {
    document.getElementById('ep-search').value = '';
    renderEmojiPicker('');
    document.getElementById('ep-search').focus();
    document.getElementById('ep-clear-btn').classList.remove('visible');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SHORTCODE SUGGEST
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  let scActive = false, scQuery = '', scResults = [], scSelectedIndex = -1;

  function handleShortcodeInput(input) {
    const val = input.value, pos = input.selectionStart || 0;
    let colonPos = -1;
    for (let i = pos - 1; i >= 0; i--) {
      if (val[i] === ':') { colonPos = i; break; }
      if (val[i] === ' ' || val[i] === '\n') break;
    }
    if (colonPos === -1) { closeShortcodeSuggest(); return; }
    const query = val.slice(colonPos + 1, pos);
    if (!query || query.includes(' ') || query.length > 30) { closeShortcodeSuggest(); return; }
    if (colonPos > 0 && val[colonPos - 1] !== ' ' && val[colonPos - 1] !== '\n') {
      const before = val[colonPos - 1];
      if (before.match(/[a-zA-Z0-9]/)) { closeShortcodeSuggest(); return; }
    }
    scQuery = query;
    scSelectedIndex = -1;
    const results = EmojiDB.search(query, 10);
    scResults = results;
    if (!results.length) { closeShortcodeSuggest(); return; }
    showShortcodeSuggest(results, query, colonPos, pos);
  }

  function showShortcodeSuggest(results, query, colonPos, cursorPos) {
    const suggest = document.getElementById('shortcode-suggest');
    const qLower = query.toLowerCase();
    let html = '';
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      const name = item.name || '';
      const idx = name.toLowerCase().indexOf(qLower);
      let displayName = name;
      if (idx !== -1) {
        const before = name.slice(0, idx);
        const match = name.slice(idx, idx + query.length);
        const after = name.slice(idx + query.length);
        displayName = `${before}<span class="highlight">${match}</span>${after}`;
      }
      const active = i === scSelectedIndex ? 'active' : '';
      html += `<div class="sc-item ${active}" data-index="${i}" onclick="selectShortcode(${i})">
        <span class="sc-emoji">${item.emoji}</span>
        <span class="sc-name">${displayName}</span>
        <span class="sc-shortcode">:${name}:</span>
      </div>`;
    }
    suggest.innerHTML = html;
    suggest.classList.add('open');
    suggest.dataset.colonPos = colonPos;
    suggest.dataset.cursorPos = cursorPos;
    scActive = true;
  }

  function closeShortcodeSuggest() {
    document.getElementById('shortcode-suggest').classList.remove('open');
    scActive = false;
    scResults = [];
    scSelectedIndex = -1;
    scQuery = '';
  }

  function selectShortcode(index) {
    const results = scResults;
    if (!results || index < 0 || index >= results.length) return;
    const item = results[index];
    const suggest = document.getElementById('shortcode-suggest');
    const colonPos = parseInt(suggest.dataset.colonPos, 10);
    const cursorPos = parseInt(suggest.dataset.cursorPos, 10);
    const input = document.getElementById('msg-input');
    const val = input.value;
    const before = val.slice(0, colonPos);
    const after = val.slice(cursorPos);
    input.value = before + item.emoji + after;
    const newPos = colonPos + item.emoji.length;
    input.selectionStart = input.selectionEnd = newPos;
    input.focus();
    input.dispatchEvent(new Event('input'));
    EmojiDB.touchRecent(item.emoji);
    closeShortcodeSuggest();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  MENTION SUGGEST (@username) — mirrors the :shortcode: logic above,
  //  but resolves against currentRoomMembers instead of the emoji DB.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  let mnActive = false, mnResults = [], mnSelectedIndex = -1;

  function handleMentionInput(input) {
    const val = input.value, pos = input.selectionStart || 0;
    let atPos = -1;
    for (let i = pos - 1; i >= 0; i--) {
      if (val[i] === '@') { atPos = i; break; }
      if (val[i] === ' ' || val[i] === '\n') break;
    }
    if (atPos === -1) { closeMentionSuggest(); return; }
    if (atPos > 0) {
      const before = val[atPos - 1];
      if (before && before !== ' ' && before !== '\n') { closeMentionSuggest(); return; }
    }
    const query = val.slice(atPos + 1, pos);
    if (query.includes(' ') || query.length > 32) { closeMentionSuggest(); return; }
    const qLower = query.toLowerCase();
    const results = currentRoomMembers
      .filter(m => m.id !== currentUser.id)
      .filter(m => m.username.toLowerCase().includes(qLower) || (m.display_name || '').toLowerCase().includes(qLower))
      .slice(0, 8);
    mnResults = results;
    mnSelectedIndex = -1;
    if (!results.length) { closeMentionSuggest(); return; }
    showMentionSuggest(results, query, atPos, pos);
  }

  function showMentionSuggest(results, query, atPos, cursorPos) {
    const suggest = document.getElementById('mention-suggest');
    let html = '';
    for (let i = 0; i < results.length; i++) {
      const m = results[i];
      const name = m.display_name || m.username;
      const letter = (name[0] || '?').toUpperCase();
      const avatarHtml = m.avatar
        ? `<img src="${escapeHtml(versionedMediaUrl(m.avatar))}" alt="" />`
        : letter;
      const active = i === mnSelectedIndex ? 'active' : '';
      html += `<div class="sc-item mn-item ${active}" data-index="${i}" onclick="selectMention(${i})">
        <span class="mn-avatar" style="${m.avatar ? '' : 'background:' + hashColor(name) + ';'}">${avatarHtml}</span>
        <span class="mn-name">${escapeHtml(name)}</span>
        <span class="mn-username">@${escapeHtml(m.username)}</span>
      </div>`;
    }
    suggest.innerHTML = html;
    suggest.classList.add('open');
    suggest.dataset.atPos = atPos;
    suggest.dataset.cursorPos = cursorPos;
    mnActive = true;
  }

  function closeMentionSuggest() {
    document.getElementById('mention-suggest').classList.remove('open');
    mnActive = false;
    mnResults = [];
    mnSelectedIndex = -1;
  }

  function selectMention(index) {
    const results = mnResults;
    if (!results || index < 0 || index >= results.length) return;
    const m = results[index];
    const suggest = document.getElementById('mention-suggest');
    const atPos = parseInt(suggest.dataset.atPos, 10);
    const cursorPos = parseInt(suggest.dataset.cursorPos, 10);
    const input = document.getElementById('msg-input');
    const val = input.value;
    const before = val.slice(0, atPos);
    const after = val.slice(cursorPos);
    const inserted = '@' + m.username + ' ';
    input.value = before + inserted + after;
    const newPos = atPos + inserted.length;
    input.selectionStart = input.selectionEnd = newPos;
    input.focus();
    input.dispatchEvent(new Event('input'));
    closeMentionSuggest();
  }

  // Resolves the plaintext compose text against currentRoomMembers to a
  // list of mentioned user IDs. Run at send time on the plaintext (not
  // the ciphertext) — the server never sees message content for E2EE
  // rooms, so it can't detect mentions itself; this is why `mentions` is
  // sent as its own explicit field in the payload alongside content/
  // ciphertext, same pattern as reply_to_id.
  function resolveMentions(plaintext) {
    if (!plaintext || !currentRoomMembers.length) return [];
    const found = new Set();
    for (const m of currentRoomMembers) {
      if (m.id === currentUser.id) continue;
      const re = new RegExp(`(^|[^\\w@])@${escapeRegExp(m.username)}(?!\\w)`);
      if (re.test(plaintext)) found.add(m.id);
    }
    return [...found];
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  DASHBOARD CORE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const API = '';
  token = localStorage.getItem('nyxie_token');
  currentUser = JSON.parse(localStorage.getItem('nyxie_user') || 'null');
  ws = null; wsReady = false; currentRoom = null;
  dms = []; unreadCounts = {}; typingTimers = {}; pendingJoins = [];
  sentMsgIds.clear();
  let ctxRoomId = null, chatToDelete = null;
  let selectModeActive = false;
  window.selectModeActive = false;
  let selectedRoomIds = new Set();
  let friends = [], friendRequests = { incoming: [], outgoing: [] };
  let currentFriendsTab = 'all';
  let _searchTimer, _friendSearchTimer, toastTimeout = null;
  let _profileUserId = null, _roomHasMessages = false, currentNav = 'home';
  let _dashboardPollTimer = null;
  let pendingFiles = []; // ─── attachments
  // Members of whichever room is currently open, from the 'room_state'
  // websocket event — [{id, username, display_name}]. Powers the
  // @mention autocomplete and, via mnActive, tells the compose box which
  // usernames are real users worth resolving into a mention on send.
  let currentRoomMembers = [];
  // Dedupes the notification sound when the same message reaches us
  // through both the room broadcast ('new_message') and the dedicated
  // ('mention') ping — see both handlers below. Capped and trimmed so it
  // can't grow unbounded over a long session.
  const notifiedMsgIds = new Set();
  function markNotified(id) {
    notifiedMsgIds.add(id);
    if (notifiedMsgIds.size > 200) {
      const first = notifiedMsgIds.values().next().value;
      notifiedMsgIds.delete(first);
    }
  }

  if (!token || !currentUser) { router.navigate('/login'); return; }

  scrollToBottom = function scrollToBottom() {
    const container = document.getElementById('messages-container');
    if (container) container.scrollTop = container.scrollHeight;
  }

  function isNearBottom(container, threshold = 150) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }

  // Attachment images have no known width/height until they actually
  // load, so the browser can't reserve space for them up front — they
  // pop in late and grow their row. Without this, that either yanks
  // whoever's reading the chat right now around, or (since
  // scrollToBottom() upstream measured scrollHeight *before* the image
  // had loaded) leaves the view sitting above the real bottom of the
  // conversation once it does. If the user was already pinned to the
  // bottom, keep them pinned as each image resolves; if they'd scrolled
  // up to read history, leave their position alone. Assigned without a
  // declaration keyword (matching appendMessage below) so the inline
  // onload/onerror handlers in buildAttachmentsHtml — which run in
  // global scope — can reach it.
  handleMsgImageSettled = function (img) {
    const container = document.getElementById('messages-container');
    if (container && isNearBottom(container)) scrollToBottom();
  };
  handleMsgImageError = function (img) {
    const container = document.getElementById('messages-container');
    const fallback = document.createElement('span');
    fallback.textContent = '🖼️ Image failed to load';
    fallback.style.cssText = 'color:var(--text-muted);font-size:.85rem;';
    img.replaceWith(fallback);
    if (container && isNearBottom(container)) scrollToBottom();
  };

  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
  }

  function logout() {
    clearSession();
    if (ws) { try { ws.close(); } catch (e) {} }
    if (_dashboardPollTimer) clearInterval(_dashboardPollTimer);
    router.navigate('/login');
  }

  // router.js calls this (typeof-checked, so it's silently a no-op if
  // missing — which it was: this function didn't exist at all, so
  // navigating away from /app never actually tore anything down). That
  // meant every trip to /app left the previous mount's WebSocket open
  // (a second, third, Nth socket all still receiving events and all
  // still holding the poll interval alive), and left voice.js's
  // MutationObserver running forever instead of being disconnected.
  // Closing/clearing them here is what actually makes leaving and
  // re-entering /app behave like a fresh mount instead of stacking state
  // on top of the previous one.
  function destroyDashboardView() {
    if (ws) { try { ws.close(); } catch (e) {} }
    if (_dashboardPollTimer) clearInterval(_dashboardPollTimer);
    if (typeof destroyVoiceFeatures === 'function') { try { destroyVoiceFeatures(); } catch (e) {} }
  }

  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeJs(s) {
    if (!s) return '';
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }
  function hashColor(name) {
    const colors = ['#fd6671', '#eb459e', '#ed4245', '#3ba55c', '#faa61a', '#1abc9c', '#e67e22', '#9b59b6'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
    return colors[Math.abs(h) % colors.length];
  }
  function pipClass(status) { return status === 'online' ? 'pip-online' : 'pip-offline'; }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function fmtLastSeen(ts) {
    if (!ts) return 'unknown';
    const d = new Date(ts), now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function isMobileLayout() { return window.matchMedia('(max-width: 768px)').matches; }
  function showMobileList() { document.getElementById('app').classList.remove('mobile-view-detail'); }
  function showMobileDetail() { if (isMobileLayout()) document.getElementById('app').classList.add('mobile-view-detail'); }
  function toggleSidebar() {
    if (isMobileLayout()) { showMobileList(); return; }
    document.getElementById('sidebar').classList.toggle('collapsed');
  }

  async function navigateTo(section) {
    currentNav = section;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-' + section)?.classList.add('active');
    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('friends-panel').style.display = 'none';
    document.getElementById('saved-notes-panel').style.display = 'none';
    document.getElementById('wallet-panel').style.display = 'none';
    document.getElementById('chat-view').style.display = 'none';
    if (section === 'home') {
      document.getElementById('welcome-view').style.display = 'flex';
      showMobileList();
    } else if (section === 'friends') {
      document.getElementById('friends-panel').style.display = 'flex';
      await loadFriendsData();
      renderFriendsList();
      showMobileDetail();
    } else if (section === 'saved') {
      document.getElementById('saved-notes-panel').style.display = 'flex';
      showMobileDetail();
    } else if (section === 'wallet') {
      document.getElementById('wallet-panel').style.display = 'flex';
      if (typeof initWalletPanel === 'function') initWalletPanel();
      showMobileDetail();
    }
    // Keep the address bar in sync with the wallet section specifically
    // (it's the one section with its own real route — see '/wallets' in
    // router.js) so refreshing while it's open lands back on it instead
    // of resetting to home. This is a plain history update, not a
    // router.navigate() call — it must NOT re-run the SPA router (that
    // would tear down and rebuild the whole dashboard just to switch
    // panels). Same idea for leaving an open conversation (its own
    // '/app/rooms/:id' route — see openRoom()) for a different section:
    // drop back to a plain URL without pushing a new history entry.
    const path = window.location.pathname;
    const onWalletUrl = path === '/wallets';
    const onRoomUrl = path.startsWith('/app/rooms/');
    if (section === 'wallet' && !onWalletUrl) {
      window.history.replaceState({}, '', '/wallets');
    } else if (section !== 'wallet' && (onWalletUrl || onRoomUrl)) {
      window.history.replaceState({}, '', '/app');
    }
  }

  // Bumped on every openRoom() call; each in-flight load captures its own
  // value and checks it before touching the DOM. Without this, opening a
  // room while a previous room's message fetch was still resolving (easy
  // to trigger with a rapid double-tap on mobile, or fast-switching
  // between two conversations) let both loads' `container.innerHTML = ''`
  // + `await appendMessage(m)` loops interleave — since each append
  // awaits E2EE decryption, control yields mid-loop, so a stale loop
  // could resume *after* a newer one had already cleared and repopulated
  // the container, re-appending its own messages on top. That's what
  // produced the doubled/overlapping message text.
  let _roomLoadToken = 0;

  // `fromRoute: true` means we're here because router.js already matched
  // '/app/rooms/:roomId' and mounted the dashboard for it (page load,
  // refresh, or browser back/forward) — the address bar is already
  // correct, so skip pushing a new history entry. Every other caller
  // (clicking a DM, opening from search, etc.) is a real navigation and
  // should push, so the room gets its own back/forward-able, shareable
  // URL — the whole point of giving each chat its own route.
  function openRoom(roomId, { fromRoute = false } = {}) {
    const room = dms.find(d => d.id === roomId);
    if (!room) return toast('Conversation not found');
    const loadToken = ++_roomLoadToken;
    currentRoom = room;
    const targetPath = `/app/rooms/${room.id}`;
    if (!fromRoute && window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
    _roomHasMessages = false;
    currentRoomMembers = []; // stale until the fresh 'room_state' event for this room arrives
    closeMentionSuggest();
    clearUnread(room.id);
    document.querySelectorAll('.dm-item').forEach(el => el.classList.remove('active'));
    const el = document.querySelector(`[data-room-id="${room.id}"]`);
    if (el) el.classList.add('active');

    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('friends-panel').style.display = 'none';
    document.getElementById('saved-notes-panel').style.display = 'none';
    document.getElementById('wallet-panel').style.display = 'none';
    // Added as requested: ensure wallet-panel and notifications-panel are hidden
    document.getElementById('wallet-panel').style.display = 'none';
    document.getElementById('notifications-panel').style.display = 'none';
    document.getElementById('chat-view').style.display = 'flex';
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    showMobileDetail();

    wsJoin(room.id);

    const name = room.display_name || room.name || 'Unknown';
    const chAvatar = document.getElementById('ch-avatar');
    chAvatar.textContent = name[0].toUpperCase();
    chAvatar.style.background = hashColor(name);
    chAvatar.innerHTML = '';
    chAvatar.textContent = name[0].toUpperCase();
    chAvatar.style.background = hashColor(name);
    document.getElementById('chat-room-name-text').textContent = '@' + name;
    document.getElementById('msg-input').placeholder = 'Message @' + name;

    if (room._otherId) {
      api('GET', `/users/${room._otherId}`).then(udata => {
        if (loadToken !== _roomLoadToken) return; // a newer room open superseded this one
        if (udata?.user) {
          const status = udata.user.status || 'offline';
          const dot = document.getElementById('ch-status-dot');
          if (dot) dot.className = `ch-status-dot ${pipClass(status)}`;
          const statusText = status === 'offline' ? (udata.user.last_seen ? `last seen ${fmtLastSeen(udata.user.last_seen)}` : 'offline') : 'online';
          const text = document.getElementById('chat-status-text');
          if (text) text.textContent = statusText;
          const chAvatarEl = document.getElementById('ch-avatar');
          if (udata.user.avatar) {
            chAvatarEl.innerHTML = `<img src="${versionedMediaUrl(udata.user.avatar)}" style="width:100%;height:100%;object-fit:cover;" />`;
          } else {
            chAvatarEl.textContent = name[0].toUpperCase();
            chAvatarEl.style.background = hashColor(name);
          }
        }
      });
    }

    const container = document.getElementById('messages-container');
    container.innerHTML = `<div style="color:var(--text-muted);padding:32px;text-align:center">Loading...</div>`;
    api('GET', `/rooms/${room.id}/messages`).then(async data => {
      if (loadToken !== _roomLoadToken) return; // a newer room open superseded this one — don't touch the DOM
      container.innerHTML = '';
      window._lastMsgUserId = null;
      window._lastMsgTime = 0;
      window._lastMsgDate = null;
      if (data?.messages?.length) {
        _roomHasMessages = true;
        for (const m of data.messages) {
          if (loadToken !== _roomLoadToken) return; // bail mid-loop if superseded
          await appendMessage(m);
        }
        scrollToBottom();
      } else {
        const otherName = room.display_name || room.name || 'Unknown';
        container.innerHTML = `
          <div class="conversation-start">
            <div class="start-header">
              <h3>This is the start of your legendary conversation with</h3>
              <h1>@${escapeHtml(otherName)}.</h1>
            </div>
          </div>
        `;
        _roomHasMessages = false;
      }
    });
  }

  api = async function api(method, path, body) {
    try {
      const res = await fetch(API + '/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: body ? JSON.stringify(body) : undefined
      });
      if (res.status === 401) { logout(); return null; }
      return res.json();
    } catch {
      return null;
    }
  }

  function wsJoin(roomId) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'join_room', room_id: roomId }));
    } else {
      pendingJoins.push(roomId);
    }
  }

  connectWS = function () {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);

    ws.onopen = () => {
      wsReady = true;
      dms.forEach(r => ws.send(JSON.stringify({ type: 'join_room', room_id: r.id })));
      [...new Set(pendingJoins)].forEach(id => ws.send(JSON.stringify({ type: 'join_room', room_id: id })));
      pendingJoins = [];
    };

    ws.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case 'new_message': {
          const m = msg.message;
          if (sentMsgIds.has(m.id)) { sentMsgIds.delete(m.id); break; }

          // Sound for anything from someone else, unless we're actively
          // looking at that exact room right now (a focused, open
          // conversation doesn't need an audio nudge on top of the message
          // just appearing). Rooms we're already joined to over the socket
          // (every DM, on connect) get this broadcast directly; a mention in
          // one of those would otherwise also trigger the dedicated 'mention'
          // event below for the same message, so notifiedMsgIds dedupes
          // that down to a single sound.
          if (m.user_id !== currentUser.id && !notifiedMsgIds.has(m.id)) {
            const roomOpenAndFocused = currentRoom?.id === m.room_id && document.hasFocus();
            if (!roomOpenAndFocused) { playNotificationSound(); markNotified(m.id); }
          }

          if (currentRoom?.id === m.room_id) {
            if (!_roomHasMessages) {
              document.getElementById('messages-container').innerHTML = '';
              _roomHasMessages = true;
            }
            await appendMessage(m);
            scrollToBottom();
          } else {
            markUnread(m.room_id);
            const dm = dms.find(d => d.id === m.room_id);
            if (dm) {
              (async () => {
                let preview = m.msg_type === 'voice'
                  ? '🎤 Voice message'
                  : await decryptDmPreview(m.content, m.nonce, dm._otherId);
                if (!preview && m.attachments && m.attachments.length) {
                  preview = '📎 Attachment';
                }
                dm.last_message = preview || '📎 Attachment';
                dm.last_message_at = m.created_at;
                dms = [dm, ...dms.filter(d => d.id !== dm.id)];
                renderDMList();
              })();
            } else {
              loadDMs();
            }
          }
          break;
        }

        case 'message_edited': {
          const el = document.querySelector(`[data-msg-id="${msg.message_id}"] .msg-text`);
          if (el) el.innerHTML = escapeHtml(msg.content) + '<span class="edited-tag">(edited)</span>';
          break;
        }

        case 'message_deleted': {
          const textEl = document.querySelector(`[data-msg-id="${msg.message_id}"] .msg-text`);
          if (textEl) { textEl.innerHTML = 'Message deleted'; textEl.classList.add('deleted'); }
          const acts = document.querySelector(`[data-msg-id="${msg.message_id}"] .msg-actions`);
          if (acts) acts.remove();
          break;
        }

        case 'typing':
          if (msg.room_id === currentRoom?.id && msg.user_id !== currentUser.id) {
            showTyping(msg.display_name || msg.username);
          }
          break;

        case 'presence_update': {
          console.log(`[Presence] Received update for user ${msg.user_id} status ${msg.status}`);
          updatePresence(msg.user_id, msg.status);
          updateFriendStatus(msg.user_id, msg.status);
          break;
        }

        case 'room_state': {
          if (msg.room_id === currentRoom?.id) {
            currentRoomMembers = msg.members.map(m => ({ id: m.id, username: m.username, display_name: m.display_name, avatar: m.avatar }));
            msg.members.forEach(m => {
              if (m.id !== currentUser.id) {
                updatePresence(m.id, m.status);
                updateFriendStatus(m.id, m.status);
              }
            });
          }
          break;
        }

        case 'mention': {
          // Targeted ping from the server for a message that mentions us —
          // fires even if we don't have that room open/joined right now
          // (e.g. a group room we haven't opened this session). No message
          // content is ever included (the server can't see it for E2EE
          // rooms anyway) — just enough to notify. notifiedMsgIds dedupes
          // against the room broadcast above when both reach us for the
          // same message (always true for DMs, which we're joined to on
          // connect).
          if (msg.from?.id !== currentUser.id) {
            if (!notifiedMsgIds.has(msg.message_id)) { playNotificationSound(); markNotified(msg.message_id); }
            toast(`💬 ${msg.from?.display_name || msg.from?.username || 'Someone'} mentioned you`);
          }
          break;
        }

        case 'dm_created': {
          if (!dms.find(d => d.id === msg.room_id)) {
            const other = msg.with_user;
            const newDm = {
              id: msg.room_id,
              is_dm: 1,
              display_name: other.display_name || other.username,
              _otherId: other.id,
              _status: 'offline',
              _avatar: other.avatar || null,
              last_message: null,
              last_message_at: null
            };
            dms = [newDm, ...dms];
            renderDMList();
            wsJoin(msg.room_id);
            api('GET', `/users/${other.id}`).then(u => {
              newDm._status = u?.user?.status || 'offline';
              newDm._avatar = u?.user?.avatar || null;
              renderDMList();
            });
          }
          break;
        }

        case 'friend_request': {
          const r = msg.request;
          if (!friendRequests.incoming.find(x => x.id === r.id)) {
            friendRequests.incoming = [r, ...friendRequests.incoming];
            updateFriendsBadge();
            if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
            toast(`👋 ${r.from_name || r.from_username} sent you a friend request`);
          }
          break;
        }

        case 'friend_accepted': {
          const f = msg.friend;
          friendRequests.incoming = friendRequests.incoming.filter(r => r.id !== msg.request_id);
          friendRequests.outgoing = friendRequests.outgoing.filter(r => r.id !== msg.request_id);
          if (f && !friends.find(x => x.id === f.id)) friends = [...friends, f];
          updateFriendsBadge();
          if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
          if (f) toast(`✅ ${f.display_name || f.username} accepted your friend request`);
          break;
        }

        case 'friend_request_declined': {
          friendRequests.outgoing = friendRequests.outgoing.filter(r => r.id !== msg.request_id);
          updateFriendsBadge();
          if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
          break;
        }

        case 'friend_request_cancelled': {
          friendRequests.incoming = friendRequests.incoming.filter(r => r.id !== msg.request_id);
          updateFriendsBadge();
          if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
          break;
        }

        case 'friend_removed': {
          friends = friends.filter(f => f.id !== msg.user_id);
          if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
          break;
        }

        case 'connected':
          break;
      }
    };

    ws.onclose = () => {
      wsReady = false;
      setTimeout(connectWS, 2000);
    };
  };

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  E2EE HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function base64ToUint8Array(b64) {
    try { return nacl.util.decodeBase64(b64); } catch { return null; }
  }
  function uint8ArrayToBase64(arr) {
    try { return nacl.util.encodeBase64(arr); } catch { return ''; }
  }

  function deriveSharedKey(otherPublicKeyB64, myPrivateKeyB64) {
    const otherPub = base64ToUint8Array(otherPublicKeyB64);
    const myPriv = base64ToUint8Array(myPrivateKeyB64);
    if (!otherPub || !myPriv) return null;
    return nacl.box.before(otherPub, myPriv);
  }

  function encryptMessage(plaintext, sharedKey) {
    if (!sharedKey) return { ciphertext: null, nonce: null };
    const nonce = nacl.randomBytes(24);
    const encrypted = nacl.secretbox(
      nacl.util.decodeUTF8(plaintext),
      nonce,
      sharedKey
    );
    return { ciphertext: uint8ArrayToBase64(encrypted), nonce: uint8ArrayToBase64(nonce) };
  }

  function decryptMessage(ciphertextB64, nonceB64, sharedKey) {
    if (!ciphertextB64 || !nonceB64 || !sharedKey) return null;
    const decrypted = nacl.secretbox.open(
      base64ToUint8Array(ciphertextB64),
      base64ToUint8Array(nonceB64),
      sharedKey
    );
    if (!decrypted) return null;
    return nacl.util.encodeUTF8(decrypted);
  }

  getPublicKey = async function getPublicKey(userId) {
    try {
      const res = await api('GET', `/users/${userId}`);
      return res?.user?.public_key || null;
    } catch { return null; }
  }

  const _sharedKeyCache = new Map();

  async function getSharedKeyForRoom(roomId) {
    if (_sharedKeyCache.has(roomId)) return _sharedKeyCache.get(roomId);
    const dm = dms.find(d => d.id === roomId);
    const otherId = dm ? dm._otherId : null;
    if (!otherId) return null;
    const otherPub = await getPublicKey(otherId);
    const myPriv = localStorage.getItem('nyxie_private_key_' + currentUser.id);
    if (!otherPub || !myPriv) return null;
    const key = deriveSharedKey(otherPub, myPriv);
    if (key) _sharedKeyCache.set(roomId, key);
    return key;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  KEY MANAGEMENT (wrap/unwrap, ensureE2EEKeys, etc.)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async function deriveKEK(password, saltB64) {
    const salt = saltB64 ? base64ToUint8Array(saltB64) : nacl.randomBytes(16);
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, baseKey, 256
    );
    return { kek: new Uint8Array(bits), saltB64: uint8ArrayToBase64(salt) };
  }

  function wrapPrivateKey(secretKeyBytes, kek) {
    const nonce = nacl.randomBytes(24);
    const box = nacl.secretbox(secretKeyBytes, nonce, kek);
    return { encrypted_private_key: uint8ArrayToBase64(box), key_nonce: uint8ArrayToBase64(nonce) };
  }

  function unwrapPrivateKey(encryptedB64, nonceB64, kek) {
    return nacl.secretbox.open(base64ToUint8Array(encryptedB64), base64ToUint8Array(nonceB64), kek);
  }

  function promptForPassword(title, subtitle) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;';
      overlay.innerHTML = `
        <div style="background:#151515;border:1px solid #262626;border-radius:14px;padding:28px;width:360px;max-width:90vw;">
          <h3 style="color:#f5f5f5;font-size:1.1rem;margin-bottom:8px;">${title}</h3>
          <p style="color:#8b8b8b;font-size:.85rem;line-height:1.5;margin-bottom:18px;">${subtitle}</p>
          <input type="password" id="_pwPromptInput" placeholder="Your password" style="width:100%;padding:12px;border:1px solid #2c2c2c;border-radius:8px;background:#101010;color:#f5f5f5;font-size:.9rem;outline:none;margin-bottom:14px;box-sizing:border-box;" />
          <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button id="_pwPromptCancel" style="padding:10px 16px;border:none;border-radius:8px;background:#1a1a1a;color:#ccc;cursor:pointer;font-size:.85rem;">Skip for now</button>
            <button id="_pwPromptOk" style="padding:10px 16px;border:none;border-radius:8px;background:#f5f5f5;color:#111;font-weight:600;cursor:pointer;font-size:.85rem;">Unlock</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#_pwPromptInput');
      const finish = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector('#_pwPromptOk').onclick = () => finish(input.value || null);
      overlay.querySelector('#_pwPromptCancel').onclick = () => finish(null);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value || null); });
      setTimeout(() => input.focus(), 50);
    });
  }

  async function consumePendingPassword() {
    const pw = sessionStorage.getItem('nyxie_pending_pw');
    sessionStorage.removeItem('nyxie_pending_pw');
    return pw || null;
  }

  async function ensureE2EEKeys() {
    const userId = currentUser?.id;
    if (!userId) return;
    if (typeof nacl === 'undefined' || !nacl.box) {
      console.warn('nacl not available — skipping E2EE key setup');
      return;
    }
    const privKeyKey = `nyxie_private_key_${userId}`;
    const pubKeyKey = `nyxie_public_key_${userId}`;
    const privateKeyB64Local = localStorage.getItem(privKeyKey);

    if (privateKeyB64Local) {
      try {
        const secretKey = base64ToUint8Array(privateKeyB64Local);
        const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);
        const publicKeyB64 = uint8ArrayToBase64(keyPair.publicKey);
        localStorage.setItem(pubKeyKey, publicKeyB64);

        const me = await api('GET', '/auth/me');
        const serverUser = me?.user;
        if (serverUser && serverUser.public_key !== publicKeyB64) {
          await api('PATCH', '/users/me', { public_key: publicKeyB64 });
        }
        if (serverUser && !serverUser.encrypted_private_key) {
          const password = await consumePendingPassword() ??
            await promptForPassword('Back up your encryption key', 'Enter your password once so this device\'s messages stay readable if you sign in elsewhere.');
          if (password) {
            const { kek, saltB64 } = await deriveKEK(password);
            const wrapped = wrapPrivateKey(secretKey, kek);
            await api('PATCH', '/users/me', { public_key: publicKeyB64, encrypted_private_key: wrapped.encrypted_private_key, key_salt: saltB64, key_nonce: wrapped.key_nonce });
          }
        }
      } catch (e) { console.warn('E2EE self-check failed:', e); }
      return;
    }

    let serverUser = null;
    try {
      const me = await api('GET', '/auth/me');
      serverUser = me?.user || null;
    } catch {}

    if (serverUser?.encrypted_private_key && serverUser?.key_salt && serverUser?.key_nonce) {
      let password = await consumePendingPassword();
      let unlocked = false;
      for (let attempt = 0; attempt < 3 && !unlocked; attempt++) {
        if (!password) {
          password = await promptForPassword(
            'Unlock your messages',
            'This device doesn\'t have your encryption key yet. Enter your account password to restore it — your password is never sent to the server.'
          );
          if (!password) return;
        }
        try {
          const { kek } = await deriveKEK(password, serverUser.key_salt);
          const secret = unwrapPrivateKey(serverUser.encrypted_private_key, serverUser.key_nonce, kek);
          if (secret) {
            const keyPair = nacl.box.keyPair.fromSecretKey(secret);
            if (uint8ArrayToBase64(keyPair.publicKey) === serverUser.public_key) {
              localStorage.setItem(privKeyKey, uint8ArrayToBase64(secret));
              localStorage.setItem(pubKeyKey, serverUser.public_key);
              unlocked = true;
              toast('🔓 Encryption key restored');
              break;
            }
          }
        } catch (e) { console.warn('Unlock attempt failed:', e); }
        toast('❌ Incorrect password — try again');
        password = null;
      }
      return;
    }

    const keyPair = nacl.box.keyPair();
    const privateKeyB64 = uint8ArrayToBase64(keyPair.secretKey);
    const publicKeyB64 = uint8ArrayToBase64(keyPair.publicKey);
    localStorage.setItem(privKeyKey, privateKeyB64);
    localStorage.setItem(pubKeyKey, publicKeyB64);

    const password = await consumePendingPassword() ??
      await promptForPassword('Set up encryption', 'Enter your password to protect your new encryption key so it can sync safely to other devices.');
    try {
      if (password) {
        const { kek, saltB64 } = await deriveKEK(password);
        const wrapped = wrapPrivateKey(keyPair.secretKey, kek);
        await api('PATCH', '/users/me', { public_key: publicKeyB64, encrypted_private_key: wrapped.encrypted_private_key, key_salt: saltB64, key_nonce: wrapped.key_nonce });
        toast('🔑 New encryption keys generated');
      } else {
        await api('PATCH', '/users/me', { public_key: publicKeyB64 });
        toast('🔑 New encryption keys generated (not backed up)');
      }
    } catch { /* ignore */ }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  DECRYPT DM PREVIEW, LOAD DMs, RENDER DM LIST
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async function decryptDmPreview(content, nonce, otherId, otherPublicKey) {
    if (!nonce) return content;
    const pub = otherPublicKey || (otherId ? await getPublicKey(otherId) : null);
    const priv = localStorage.getItem('nyxie_private_key_' + currentUser.id);
    if (!pub || !priv) return '🔒 Encrypted message';
    const sharedKey = deriveSharedKey(pub, priv);
    if (!sharedKey) return '🔒 Shared key failed';
    const decrypted = decryptMessage(content, nonce, sharedKey);
    return decrypted !== null ? decrypted : '🔒 Encrypted message';
  }

  async function loadDMs() {
    const data = await api('GET', '/rooms');
    if (!data) return;
    const fresh = (data.rooms || []).filter(r => r.is_dm || r.is_dm === 1);
    await Promise.all(fresh.map(async dm => {
      let otherPublicKey = null;
      if (dm._otherId) {
        const udata = await api('GET', `/users/${dm._otherId}`);
        dm._status = udata?.user?.status || 'offline';
        dm._avatar = udata?.user?.avatar || null;
        otherPublicKey = udata?.user?.public_key || null;
      }
      if (dm.last_message_nonce) {
        let preview = await decryptDmPreview(dm.last_message, dm.last_message_nonce, dm._otherId, otherPublicKey);
        if (!preview) preview = '📎 Attachment';
        dm.last_message = preview;
      } else if (dm.last_message_at) {
        // There was a last message but it has no content (e.g. attachment-only)
        dm.last_message = dm.last_message || '📎 Attachment';
      }
    }));
    dms = fresh;
    renderDMList();
    dms.forEach(d => wsJoin(d.id));
  }

  function renderDMList() {
    const list = document.getElementById('dm-list');
    if (!dms.length) {
      list.innerHTML = `<div class="dm-empty">No conversations yet</div>`;
      return;
    }
    list.innerHTML = dms.map(dm => {
      const name = dm.display_name || dm.name || 'Unknown';
      const status = dm._status || 'offline';
      const unread = unreadCounts[dm.id] || 0;
      const preview = dm.last_message ? escapeHtml(dm.last_message.slice(0, 50)) : '<i style="color:var(--text-muted)">No messages yet</i>';
      const time = dm.last_message_at ? fmtTime(dm.last_message_at) : '';
      const isActive = currentRoom?.id === dm.id;
      let avatarHtml = name[0].toUpperCase();
      if (dm._avatar) {
        avatarHtml = `<img src="${versionedMediaUrl(dm._avatar)}" style="width:100%;height:100%;object-fit:cover;" />`;
      }
      const dmAvatar = `<div class="dm-avatar" style="background:${hashColor(name)}">${avatarHtml}</div>`;
      const chk = `<div class="dm-checkbox" onclick="event.stopPropagation();toggleDMSelect('${dm.id}',this.closest('.dm-item'))"></div>`;
      return `<div class="dm-item${isActive ? ' active' : ''}" data-room-id="${dm.id}"
        onclick="window.selectModeActive?toggleDMSelect('${dm.id}',this):openRoom('${dm.id}')"
        oncontextmenu="showCtxMenu(event,'${dm.id}')">
        ${chk}
        <div class="dm-avatar-wrap">
          ${dmAvatar}
          <div class="status-pip ${pipClass(status)}" data-uid-pip="${dm._otherId||''}"></div>
        </div>
        <div class="dm-content">
          <div class="dm-top">
            <div class="dm-name">${escapeHtml(name)}</div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
              ${unread ? `<span class="dm-badge">${unread}</span>` : ''}
              <span class="dm-time">${time}</span>
            </div>
          </div>
          <div class="dm-preview">${preview}</div>
        </div>
        <div class="dm-actions">
          <button class="dm-action-btn danger" onclick="event.stopPropagation();hideDM('${dm.id}')" title="Hide">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>`;
    }).join('');
  }

  // ─── HIDE DM (hide from sidebar, keep messages) ──────────
  function hideDM(roomId) {
    const dm = dms.find(d => d.id === roomId);
    if (!dm) return;
    dms = dms.filter(d => d.id !== roomId);
    delete unreadCounts[roomId];
    if (currentRoom?.id === roomId) {
      currentRoom = null;
      document.getElementById('chat-view').style.display = 'none';
      navigateTo('home');
    }
    renderDMList();
    toast('Conversation hidden');
  }

  function closeDM(roomId) { hideDM(roomId); }

  // ─── PRESENCE (with null checks) ──────────────────────────
  function updatePresence(userId, status) {
    document.querySelectorAll(`[data-uid-pip="${userId}"]`).forEach(el => {
      if (el) el.className = `status-pip ${pipClass(status)}`;
    });
    const activeDm = dms.find(d => d.id === currentRoom?.id);
    if (activeDm && activeDm._otherId === userId) {
      const dot = document.getElementById('ch-status-dot');
      if (dot) dot.className = `ch-status-dot ${pipClass(status)}`;
      const text = document.getElementById('chat-status-text');
      if (text) text.textContent = status === 'online' ? 'online' : 'offline';
    }
    const dm = dms.find(d => d._otherId === userId);
    if (dm) dm._status = status;
  }

  function updateFriendStatus(userId, status) {
    const friend = friends.find(f => f.id == userId);
    if (friend) {
      friend.status = status;
      if (document.getElementById('friends-panel').style.display === 'flex') {
        renderFriendsList();
      }
    }
  }

  function markUnread(roomId) {
    if (currentRoom?.id === roomId) return;
    unreadCounts[roomId] = (unreadCounts[roomId] || 0) + 1;
    renderDMList();
  }
  function clearUnread(roomId) {
    delete unreadCounts[roomId];
    renderDMList();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  ATTACHMENT PREVIEW & REMOVE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function renderAttachmentPreviews() {
    let bar = document.getElementById('attachment-preview-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'attachment-preview-bar';
      bar.style.cssText = 'display:flex;gap:8px;padding:8px 16px;overflow-x:auto;border-top:1px solid var(--border-color);background:var(--bg-secondary);';
      const inputArea = document.getElementById('input-area');
      if (inputArea) inputArea.insertBefore(bar, document.getElementById('input-box'));
    }
    if (!pendingFiles.length) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    bar.innerHTML = pendingFiles.map((f, i) => {
      const isImage = f.type && f.type.startsWith('image/');
      const thumb = isImage ? URL.createObjectURL(f) : '';
      return `
        <div class="attachment-chip" style="position:relative;display:flex;align-items:center;gap:6px;background:var(--bg-tertiary);padding:6px 10px;border-radius:8px;flex-shrink:0;border:1px solid var(--border-color);">
          ${isImage ? `<img src="${thumb}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;" />` : `<span style="font-size:1.2rem;">📎</span>`}
          <span style="font-size:.8rem;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.name)}</span>
          <button onclick="window.removeAttachment(${i})" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1rem;line-height:1;padding:0 4px;">×</button>
        </div>`;
    }).join('');
  }

  window.removeAttachment = function(idx) {
    if (idx >= 0 && idx < pendingFiles.length) {
      pendingFiles.splice(idx, 1);
      renderAttachmentPreviews();
    }
  };

  function handleFileUpload(files) {
    if (!files || files.length === 0) return;
    for (const f of files) {
      pendingFiles.push(f);
    }
    renderAttachmentPreviews();
    document.getElementById('file-input').value = '';
    toast(`${files.length} file(s) ready to send`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SEND MESSAGE (with attachments)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  let replyingTo = null;

  function setReplyTo(msgId) {
    const msg = window._messagesById.get(msgId);
    if (!msg) return;
    replyingTo = msg;
    const bar = document.getElementById('reply-preview-bar');
    document.getElementById('rpb-author').textContent = msg.display_name || msg.username || 'Unknown';
    document.getElementById('rpb-text').textContent = msg.deleted ? 'Message deleted' : msg.content;
    if (bar) bar.classList.add('open');
    closeReactionPicker();
    closeMoreMenu();
    document.getElementById('msg-input').focus();
  }

  function cancelReply() {
    replyingTo = null;
    const bar = document.getElementById('reply-preview-bar');
    if (bar) bar.classList.remove('open');
  }

  function jumpToMessage(msgId) {
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!el) { toast('Original message not loaded'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('search-current');
    setTimeout(() => el.classList.remove('search-current'), 1200);
  }

  // Two messages sent close together (e.g. a text message, then an
  // attachment) each go through their own independent async work before
  // hitting the network — text waits on E2EE key derivation/encryption,
  // attachments wait on the upload — so their POST requests can finish
  // (and render) out of send order even though the server processed them
  // in order. Chaining through _sendQueue forces each call to fully
  // finish (network round-trip + DOM append) before the next one's body
  // even starts, so render order always matches click order.
  let _sendQueue = Promise.resolve();
  function sendMessage() {
    _sendQueue = _sendQueue.then(() => sendMessageInner()).catch(err => console.error('[Send] queued send failed:', err));
    return _sendQueue;
  }

  async function sendMessageInner() {
    const input = document.getElementById('msg-input');
    const plaintext = input.value.trim();

    // Allow send if there's text OR pending files
    if ((!plaintext && !pendingFiles.length) || !currentRoom) return;

    input.value = '';

    // ─── Upload pending files ──────────────────────────────────
    const uploadedFiles = [];
    console.log('[Upload] Starting upload of', pendingFiles.length, 'files');
    for (const file of pendingFiles) {
      const formData = new FormData();
      formData.append('file', file);
      try {
        console.log('[Upload] Uploading:', file.name);
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: formData
        });
        const data = await res.json();
        console.log('[Upload] Response:', data);
        if (data.url) {
          uploadedFiles.push({ name: file.name, url: data.url, type: file.type });
        } else {
          toast('Upload failed for ' + file.name);
        }
      } catch (e) {
        console.error('[Upload] Error:', e);
        toast('Upload error for ' + file.name);
      }
    }
    pendingFiles = [];
    renderAttachmentPreviews();

    // ─── Build message payload ──────────────────────────────────
    let payload = {};
    const sharedKey = await getSharedKeyForRoom(currentRoom.id);
    if (plaintext) {
      if (sharedKey) {
        const { ciphertext, nonce } = encryptMessage(plaintext, sharedKey);
        payload = { ciphertext, nonce };
      } else {
        payload = { content: plaintext };
      }
    }
    if (uploadedFiles.length) payload.attachments = uploadedFiles;

    // Resolved from the plaintext we just encrypted (or the plain content,
    // in an unencrypted room) — sent as its own field since the server
    // can't parse @mentions out of ciphertext itself. See resolveMentions().
    if (plaintext) {
      const mentionIds = resolveMentions(plaintext);
      if (mentionIds.length) payload.mentions = mentionIds;
    }

    if (replyingTo) {
      payload.reply_to_id = replyingTo.id;
      payload.reply_to_author = replyingTo.display_name || replyingTo.username;
      payload.reply_to_snippet = replyingTo.deleted ? 'Message deleted' : replyingTo.content;
    }

    console.log('[Send] Payload:', payload);
    const res = await api('POST', `/rooms/${currentRoom.id}/messages`, payload);
    if (res?.error) { toast(res.error); return; }
    if (res.message?.id) sentMsgIds.add(res.message.id);
    if (replyingTo && res.message) {
      res.message.reply_to_id = res.message.reply_to_id || replyingTo.id;
      res.message.reply_to_author = res.message.reply_to_author || payload.reply_to_author;
      res.message.reply_to_snippet = res.message.reply_to_snippet || payload.reply_to_snippet;
    }
    if (!_roomHasMessages) {
      document.getElementById('messages-container').innerHTML = '';
      _roomHasMessages = true;
    }
    cancelReply();
    await appendMessage(res.message);
    scrollToBottom();
    const dmObj = dms.find(d => d.id === currentRoom.id);
    if (dmObj) {
      dmObj.last_message = plaintext || '📎 Attachment';
      dmObj.last_message_at = Date.now();
      dms = [dmObj, ...dms.filter(d => d.id !== dmObj.id)];
      renderDMList();
      document.querySelector(`[data-room-id="${currentRoom.id}"]`)?.classList.add('active');
    }
    closeShortcodeSuggest();
    closeMentionSuggest();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  MESSAGE RENDER (includes attachments)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  window._messagesById = window._messagesById || new Map();

  function buildReplyQuoteHtml(msg) {
    if (!msg.reply_to_id) return '';
    const original = window._messagesById.get(msg.reply_to_id);
    const author = original ? (original.display_name || original.username || 'Unknown') : (msg.reply_to_author || 'Unknown');
    const snippet = original ? (original.deleted ? 'Message deleted' : original.content) : (msg.reply_to_snippet || 'Original message');
    const trimmed = snippet.length > 80 ? snippet.slice(0, 80) + '…' : snippet;
    return `<div class="msg-reply-quote" onclick="jumpToMessage('${msg.reply_to_id}')">
      <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
      <span class="rq-author">${escapeHtml(author)}</span>
      <span class="rq-text">${escapeHtml(trimmed)}</span>
    </div>`;
  }

  function buildReactionsHtml(msg) {
    const reactions = msg.reactions;
    if (!reactions || !Object.keys(reactions).length) return '';
    let html = '<div class="msg-reactions">';
    for (const [emoji, userIds] of Object.entries(reactions)) {
      if (!userIds || !userIds.length) continue;
      const mine = userIds.includes(currentUser.id);
      html += `<button class="reaction-pill${mine ? ' mine' : ''}" onclick="quickReact('${emoji}','${msg.id}')" title="${userIds.length} reacted">
        <span>${emoji}</span><span class="r-count">${userIds.length}</span>
      </button>`;
    }
    html += '</div>';
    return html;
  }

  function buildAttachmentsHtml(msg) {
    if (!msg.attachments || !msg.attachments.length) return '';
    let html = '<div class="msg-attachments" style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">';
    for (const a of msg.attachments) {
      if (a.type && a.type.startsWith('image/')) {
        // min-height gives the bubble *some* footprint before the image
        // has actually loaded (its real size is unknown until then), so
        // the pop-in is smaller; handleMsgImageSettled/handleMsgImageError
        // (defined next to scrollToBottom) keep the view pinned to the
        // bottom through that pop-in for anyone who was already there.
        html += `<img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}" loading="lazy" decoding="async" style="max-width:320px;max-height:240px;min-height:48px;min-width:48px;border-radius:8px;object-fit:cover;background:var(--bg-tertiary);cursor:pointer;" onload="handleMsgImageSettled(this)" onerror="handleMsgImageError(this)" onclick="window.open(this.src,'_blank')" />`;
      } else {
        html += `<a href="${escapeHtml(a.url)}" target="_blank" style="color:var(--accent);font-size:.85rem;">📎 ${escapeHtml(a.name)}</a>`;
      }
    }
    html += '</div>';
    return html;
  }

  function buildMsgActionsHtml(msg, isOwn) {
    if (msg.deleted) return '';
    const ownActions = isOwn ? `
        <button class="msg-act-btn" title="Edit" onclick="editMsg('${msg.id}',this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </button>
        <button class="msg-act-btn danger" title="Delete" onclick="deleteMsg('${msg.id}','${msg.room_id}', event)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <line x1="10" y1="11" x2="10" y2="17"/>
            <line x1="14" y1="11" x2="14" y2="17"/>
          </svg>
        </button>` : '';
    return `
      <div class="msg-actions">
        <button class="msg-act-btn" title="Add reaction" onclick="toggleReactionPicker(event,'${msg.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
            <line x1="9" y1="9" x2="9.01" y2="9"/>
            <line x1="15" y1="9" x2="15.01" y2="9"/>
          </svg>
        </button>
        <button class="msg-act-btn" title="Reply" onclick="setReplyTo('${msg.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 17 4 12 9 7"/>
            <path d="M20 18v-2a4 4 0 0 0-4-4H4"/>
          </svg>
        </button>
        ${ownActions}
        <button class="msg-act-btn" title="More" onclick="toggleMoreMenu(event,'${msg.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="5" r="1.5"/>
            <circle cx="12" cy="12" r="1.5"/>
            <circle cx="12" cy="19" r="1.5"/>
          </svg>
        </button>
      </div>`;
  }

  appendMessage = function (msg) {
    const container = document.getElementById('messages-container');
    if (msg.id && container.querySelector(`[data-msg-id="${msg.id}"]`)) return;
    window._messagesById.set(msg.id, msg);
    const isOwn = msg.user_id === currentUser.id;
    const msgDate = new Date(msg.created_at).toDateString();
    const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const fullTime = new Date(msg.created_at).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
    const sameUser = msg.user_id === window._lastMsgUserId && (now - window._lastMsgTime) < 5 * 60 * 1000 && !msg.reply_to_id;
    window._lastMsgUserId = msg.user_id;
    window._lastMsgTime = now;
    const displayName = msg.display_name || msg.username || 'Unknown';
    // Highlight @mentions in the (already decrypted, if applicable) text.
    // msg.mentions is a list of user IDs from the server; resolve those
    // against the room's member list (which we already have from
    // 'room_state') to get displayable usernames — highlightMentions only
    // ever wraps text that matches a real member's username, and
    // re-escapes it, so this can't introduce anything from raw content.
    const mentionedMembers = msg.mentions && msg.mentions.length
      ? currentRoomMembers.filter(m => msg.mentions.includes(m.id))
      : null;
    const escapedContent = escapeHtml(msg.content);
    const highlightedContent = mentionedMembers ? highlightMentions(escapedContent, mentionedMembers, currentUser.id) : escapedContent;
    const textHtml = msg.deleted ? 'Message deleted' : `${highlightedContent}${msg.edited_at ? '<span class="edited-tag">(edited)</span>' : ''}`;
    const replyHtml = buildReplyQuoteHtml(msg);
    const reactionsHtml = buildReactionsHtml(msg);
    const attachmentsHtml = buildAttachmentsHtml(msg);
    const actionsHtml = buildMsgActionsHtml(msg, isOwn);
    const row = document.createElement('div');
    row.dataset.msgId = msg.id;
    if (sameUser) {
      row.className = 'msg-row compact' + (isOwn ? ' outgoing' : '');
      row.innerHTML = `
        <div class="msg-content-col">
          <span class="msg-timestamp-inline" title="${fullTime}">${timeStr}</span>
          ${replyHtml}
          <span class="msg-text${msg.deleted ? ' deleted' : ''}">${textHtml}</span>
          ${attachmentsHtml}
          ${reactionsHtml}
        </div>
        ${actionsHtml}`;
    } else {
      row.className = 'msg-row' + (isOwn ? ' outgoing' : '');
      row.style.marginTop = '17px';
      row.innerHTML = `
        <div class="msg-content-col">
          <div class="msg-header">
            <span class="msg-author" onclick="showUserProfile(event, '${msg.user_id}')">${escapeHtml(displayName)}</span>
            <span class="msg-timestamp" title="${fullTime}">${timeStr}</span>
          </div>
          ${replyHtml}
          <span class="msg-text${msg.deleted ? ' deleted' : ''}">${textHtml}</span>
          ${attachmentsHtml}
          ${reactionsHtml}
        </div>
        ${actionsHtml}`;
    }
    container.appendChild(row);
  }

  // ─── APPEND MESSAGE E2EE WRAPPER ──────────────────────────
  const originalAppendMessage = appendMessage;
  // originalAppendMessage reads/writes window._lastMsgUserId & _lastMsgTime
  // to decide grouping (same-author "compact" row, near-zero top margin,
  // vs. a fresh group with 17px of breathing room) — and it does that
  // *inside* this now-async function, right before the row is inserted.
  // Every message has to clear an E2EE decrypt here first, and decrypt
  // time isn't constant: a message with no text (e.g. an image sent with
  // no caption) has no `nonce` at all and resolves almost immediately,
  // while a text message right after it does have a nonce and can hit the
  // 300ms decrypt-retry path below. Without serializing, two concurrent
  // calls can finish in the *opposite* order they were made in — so the
  // text message's grouping check can run against stale state, get
  // misclassified as "same group" as an unrelated image, and render with
  // no gap above it. Chaining every call through one shared queue forces
  // them to run — and update that shared state — strictly in call order,
  // no matter how long any individual decrypt takes. (This backs up
  // _sendQueue and the room-load loop above, which assumed this was
  // already true.)
  let _appendMsgQueue = Promise.resolve();
  appendMessage = function(msg, retry = false) {
    const run = async () => {
      let displayContent = msg.content;
      if (msg.nonce) {
        const sharedKey = await getSharedKeyForRoom(msg.room_id);
        if (sharedKey) {
          const decrypted = decryptMessage(msg.content, msg.nonce, sharedKey);
          if (decrypted !== null) displayContent = decrypted;
          else if (!retry) {
            await new Promise(r => setTimeout(r, 300));
            const sharedKey2 = await getSharedKeyForRoom(msg.room_id);
            if (sharedKey2) {
              const decrypted2 = decryptMessage(msg.content, msg.nonce, sharedKey2);
              displayContent = decrypted2 !== null ? decrypted2 : '🔒 Failed to decrypt';
            } else displayContent = '🔒 Shared key unavailable';
          } else displayContent = '🔒 Failed to decrypt';
        } else displayContent = '🔒 Shared key unavailable';
      }
      // Leave msg.content set to the decrypted plaintext (don't revert to
      // ciphertext) — the message object is stored by reference in
      // window._messagesById (see originalAppendMessage), and other code
      // that looks it up later — reply quotes, the reply-preview bar,
      // editing — all read msg.content expecting plaintext.
      msg.content = displayContent;
      originalAppendMessage.call(this, msg);
    };
    // .then(run, run) so one failed append doesn't wedge every append after it.
    _appendMsgQueue = _appendMsgQueue.then(run, run);
    return _appendMsgQueue;
  };

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  EDIT, DELETE, REACTIONS, MORE MENU (short versions)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function editMsg(msgId, btn) {
    const row = document.querySelector(`[data-msg-id="${msgId}"]`);
    const textEl = row?.querySelector('.msg-text');
    if (!row || !textEl) return;
    const msg = window._messagesById.get(msgId);
    const original = (msg ? msg.content : textEl.textContent.replace('(edited)', '')).trim();
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-edit-box';
    wrapper.innerHTML = `
      <textarea class="msg-edit-input" rows="1"></textarea>
      <div class="msg-edit-hint">escape to <a class="me-cancel">cancel</a> • enter to <a class="me-save">save</a></div>
    `;
    const textarea = wrapper.querySelector('.msg-edit-input');
    textarea.value = original;
    textEl.replaceWith(wrapper);
    const autoResize = () => { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; };
    autoResize();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.addEventListener('input', autoResize);
    const finish = async (save) => {
      const newContent = textarea.value.trim();
      if (save && newContent && newContent !== original) {
        if (msg) msg.content = newContent;
        const span = document.createElement('span');
        span.className = 'msg-text';
        span.innerHTML = `${escapeHtml(newContent)}<span class="edited-tag">(edited)</span>`;
        wrapper.replaceWith(span);
        await api('PATCH', `/rooms/${currentRoom.id}/messages/${msgId}`, { content: newContent });
      } else {
        const span = document.createElement('span');
        span.className = 'msg-text' + (msg?.deleted ? ' deleted' : '');
        span.innerHTML = msg?.deleted ? 'Message deleted' : `${escapeHtml(original)}${msg?.edited_at ? '<span class="edited-tag">(edited)</span>' : ''}`;
        wrapper.replaceWith(span);
      }
    };
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    wrapper.querySelector('.me-save').addEventListener('click', () => finish(true));
    wrapper.querySelector('.me-cancel').addEventListener('click', () => finish(false));
  }

  function deleteMsg(msgId, roomId, event) {
    const popup = document.getElementById('confirm-popup');
    popup.innerHTML = `
      <div class="cp-title">Delete message?</div>
      <div class="cp-desc">This can't be undone.</div>
      <div class="cp-actions">
        <button class="cp-btn cancel" id="cp-cancel-btn">Cancel</button>
        <button class="cp-btn danger" id="cp-delete-btn">Delete</button>
      </div>`;
    popup.classList.add('open');
    let anchorRect;
    if (event && event.currentTarget) {
      anchorRect = event.currentTarget.getBoundingClientRect();
    } else {
      const row = document.querySelector(`[data-msg-id="${msgId}"] .msg-act-btn.danger`);
      anchorRect = row ? row.getBoundingClientRect() : { right: window.innerWidth / 2 + 120, bottom: window.innerHeight / 2 };
    }
    const popupWidth = 240;
    let left = anchorRect.right - popupWidth;
    if (left < 8) left = 8;
    popup.style.left = `${left}px`;
    popup.style.top = `${anchorRect.bottom + 6}px`;
    const close = () => popup.classList.remove('open');
    popup.querySelector('#cp-cancel-btn').onclick = close;
    popup.querySelector('#cp-delete-btn').onclick = async () => {
      close();
      await api('DELETE', `/rooms/${roomId}/messages/${msgId}`);
    };
  }

  // ── Reactions ──
  let activeReactionMsgId = null;
  let lastReactionAnchorRect = null;
  function toggleReactionPicker(event, msgId) {
    event.stopPropagation();
    closeMoreMenu();
    const popup = document.getElementById('reaction-picker-popup');
    if (activeReactionMsgId === msgId && popup.classList.contains('open')) {
      closeReactionPicker();
      return;
    }
    activeReactionMsgId = msgId;
    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();
    lastReactionAnchorRect = rect;
    popup.classList.add('open');
    const popupWidth = 250;
    let left = rect.right - popupWidth;
    if (left < 8) left = 8;
    popup.style.left = `${left}px`;
    popup.style.top = `${rect.top - 46}px`;
  }
  function closeReactionPicker() {
    document.getElementById('reaction-picker-popup').classList.remove('open');
    activeReactionMsgId = null;
  }
  function openFullReactionPicker() {
    const msgId = activeReactionMsgId;
    const anchorRect = lastReactionAnchorRect;
    closeReactionPicker();
    if (!msgId) return;
    _reactionPickerTargetMsgId = msgId;
    const picker = document.getElementById('reaction-emoji-picker');
    picker.classList.add('open');
    const pickerWidth = 320;
    let left = (anchorRect ? anchorRect.right : window.innerWidth / 2) - pickerWidth;
    if (left < 8) left = 8;
    if (left + pickerWidth > window.innerWidth - 8) left = window.innerWidth - pickerWidth - 8;
    let top = anchorRect ? anchorRect.top - 400 : 80;
    if (top < 8) top = (anchorRect ? anchorRect.bottom + 8 : 80);
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
    document.getElementById('rep-search').value = '';
    document.getElementById('rep-search').focus();
    renderReactionEmojiPicker('');
  }
  function closeFullReactionPicker() {
    document.getElementById('reaction-emoji-picker').classList.remove('open');
    _reactionPickerTargetMsgId = null;
  }
  let _reactionPickerTargetMsgId = null;
  function renderReactionEmojiPicker(query) {
    const container = document.getElementById('rep-results');
    if (!container) return;
    document.getElementById('rep-clear-btn').classList.toggle('visible', !!query);
    const q = (query || '').trim();
    let results = [];
    if (q) results = EmojiDB.search(q, 24);
    else results = EmojiDB.getEmojis().slice(0, 48);
    if (!results.length) {
      container.innerHTML = `<div class="ep-empty">${q ? 'No emojis found' : 'No emojis loaded'}</div>`;
      return;
    }
    let html = `<div class="ep-grid">`;
    for (const item of results) {
      const name = (item.name || '').replace(/'/g, '\\\'');
      html += `<button class="ep-item" onclick="selectReactionEmoji('${item.emoji.replace(/'/g, "\\'")}')" title="${name}">${item.emoji}<span class="ep-tooltip">${item.name || ''}</span></button>`;
    }
    html += `</div>`;
    container.innerHTML = html;
  }
  function clearReactionEmojiSearch() {
    document.getElementById('rep-search').value = '';
    renderReactionEmojiPicker('');
    document.getElementById('rep-search').focus();
    document.getElementById('rep-clear-btn').classList.remove('visible');
  }
  function selectReactionEmoji(emoji) {
    const msgId = _reactionPickerTargetMsgId;
    closeFullReactionPicker();
    if (!msgId) return;
    EmojiDB.touchRecent(emoji);
    quickReact(emoji, msgId);
  }
  function quickReact(emoji, msgIdOverride) {
    const msgId = msgIdOverride || activeReactionMsgId;
    if (!msgId) return;
    const msg = window._messagesById.get(msgId);
    if (!msg) return;
    msg.reactions = msg.reactions || {};
    const list = msg.reactions[emoji] = msg.reactions[emoji] || [];
    const idx = list.indexOf(currentUser.id);
    let added = true;
    if (idx === -1) list.push(currentUser.id);
    else { list.splice(idx, 1); added = false; if (list.length === 0) delete msg.reactions[emoji]; }
    renderReactionsForMessage(msgId);
    closeReactionPicker();
    api('POST', `/rooms/${msg.room_id}/messages/${msgId}/reactions`, { emoji, action: added ? 'add' : 'remove' }).catch(() => {});
  }
  function renderReactionsForMessage(msgId) {
    const msg = window._messagesById.get(msgId);
    const row = document.querySelector(`[data-msg-id="${msgId}"] .msg-content-col`);
    if (!msg || !row) return;
    let reactionsEl = row.querySelector('.msg-reactions');
    const html = buildReactionsHtml(msg);
    if (reactionsEl) {
      if (html) reactionsEl.outerHTML = html; else reactionsEl.remove();
    } else if (html) {
      row.insertAdjacentHTML('beforeend', html);
    }
  }

  // ── More Menu ──
  function toggleMoreMenu(event, msgId) {
    event.stopPropagation();
    closeReactionPicker();
    const popup = document.getElementById('more-menu-popup');
    const wasOpenForSame = popup.dataset.msgId === msgId && popup.classList.contains('open');
    if (wasOpenForSame) { closeMoreMenu(); return; }
    const msg = window._messagesById.get(msgId);
    const isOwn = msg && msg.user_id === currentUser.id;
    popup.dataset.msgId = msgId;
    popup.innerHTML = `
      <button class="mm-item" onclick="copyMsgText('${msgId}')">
        <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy text
      </button>
      <button class="mm-item" onclick="setReplyTo('${msgId}');closeMoreMenu()">
        <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
        Reply
      </button>
      <button class="mm-item" onclick="toggleReactionPicker(event,'${msgId}')">
        <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
        Add reaction
      </button>
      ${isOwn ? `
      <div class="mm-divider"></div>
      <button class="mm-item" onclick="editMsg('${msgId}', document.querySelector('[data-msg-id=\\'${msgId}\\'] .msg-act-btn'));closeMoreMenu()">
        <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        Edit
      </button>
      <button class="mm-item danger" onclick="closeMoreMenu();deleteMsg('${msgId}','${msg.room_id}', event)">
        <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        Delete
      </button>` : ''}
    `;
    popup.classList.add('open');
    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();
    const menuWidth = 176;
    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    popup.style.left = `${left}px`;
    popup.style.top = `${rect.bottom + 4}px`;
  }
  function closeMoreMenu() {
    document.getElementById('more-menu-popup').classList.remove('open');
  }
  function copyMsgText(msgId) {
    const msg = window._messagesById.get(msgId);
    if (!msg) return;
    const text = msg.deleted ? '' : msg.content;
    navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard')).catch(() => toast('Could not copy'));
    closeMoreMenu();
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.reaction-picker-popup') && !e.target.closest('.msg-act-btn')) closeReactionPicker();
    if (!e.target.closest('.more-menu-popup') && !e.target.closest('.msg-act-btn')) closeMoreMenu();
    if (!e.target.closest('.confirm-popup') && !e.target.closest('.msg-act-btn.danger') && !e.target.closest('.mm-item.danger')) {
      document.getElementById('confirm-popup').classList.remove('open');
    }
    if (!e.target.closest('.reaction-full-picker') && !e.target.closest('.rp-more-btn')) closeFullReactionPicker();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SEARCH IN CHAT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  let chatSearchMatches = [];
  let chatSearchIndex = -1;
  function searchInChat() {
    document.getElementById('chat-search-bar').classList.add('open');
    document.getElementById('chat-search-input').value = '';
    document.getElementById('chat-search-input').focus();
    filterChatMessages('');
  }
  function closeChatSearch() {
    document.getElementById('chat-search-bar').classList.remove('open');
    clearChatSearchHighlights();
    chatSearchMatches = [];
    chatSearchIndex = -1;
  }
  function clearChatSearchHighlights() {
    document.querySelectorAll('#messages-container .msg-text mark.search-hit').forEach(mark => {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
    document.querySelectorAll('#messages-container .msg-row.search-current').forEach(row => row.classList.remove('search-current'));
  }
  function filterChatMessages(query) {
    clearChatSearchHighlights();
    chatSearchMatches = [];
    chatSearchIndex = -1;
    const q = query.trim().toLowerCase();
    const countEl = document.getElementById('chat-search-count');
    const prevBtn = document.getElementById('cs-prev-btn');
    const nextBtn = document.getElementById('cs-next-btn');
    if (!q) { countEl.textContent = '0 / 0'; prevBtn.disabled = true; nextBtn.disabled = true; return; }
    const rows = document.querySelectorAll('#messages-container .msg-row');
    rows.forEach(row => {
      const textEl = row.querySelector('.msg-text');
      if (!textEl) return;
      const raw = textEl.textContent;
      const lower = raw.toLowerCase();
      if (lower.includes(q)) {
        chatSearchMatches.push(row);
        const idx = lower.indexOf(q);
        const before = raw.slice(0, idx);
        const match = raw.slice(idx, idx + q.length);
        const after = raw.slice(idx + q.length);
        textEl.innerHTML = `${escapeHtml(before)}<mark class="search-hit">${escapeHtml(match)}</mark>${escapeHtml(after)}`;
      }
    });
    countEl.textContent = chatSearchMatches.length ? `1 / ${chatSearchMatches.length}` : '0 / 0';
    prevBtn.disabled = nextBtn.disabled = chatSearchMatches.length === 0;
    if (chatSearchMatches.length) {
      chatSearchIndex = 0;
      focusChatSearchMatch();
    }
  }
  function chatSearchNav(direction) {
    if (!chatSearchMatches.length) return;
    chatSearchIndex = (chatSearchIndex + direction + chatSearchMatches.length) % chatSearchMatches.length;
    focusChatSearchMatch();
  }
  function focusChatSearchMatch() {
    document.querySelectorAll('#messages-container .msg-row.search-current').forEach(row => row.classList.remove('search-current'));
    const row = chatSearchMatches[chatSearchIndex];
    if (!row) return;
    row.classList.add('search-current');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('chat-search-count').textContent = `${chatSearchIndex + 1} / ${chatSearchMatches.length}`;
  }
  document.getElementById('chat-search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); chatSearchNav(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeChatSearch(); }
  });

  // ─── INPUT HANDLING ──────────────────────────────────────
  document.getElementById('send-btn').addEventListener('click', sendMessage);
  // The ":"-triggered emoji shortcode popup (handleShortcodeInput,
  // showShortcodeSuggest, selectShortcode) was fully implemented above
  // but never actually hooked up to the input box — nothing called
  // handleShortcodeInput() as the user typed, so the popup could never
  // appear. Wiring it to the 'input' event is what makes typing ":fire"
  // actually open the suggestion list, the way it does in Discord/Telegram.
  document.getElementById('msg-input').addEventListener('input', e => {
    handleShortcodeInput(e.target);
    // Only one popup at a time — an "@" mention query takes priority
    // over a stale ":" shortcode popup left open from earlier in the
    // same line.
    handleMentionInput(e.target);
    if (mnActive) closeShortcodeSuggest();
  });
  document.getElementById('msg-input').addEventListener('keydown', e => {
    // While the mention popup is open, arrow keys move the highlighted
    // suggestion and Enter/Tab confirm it instead of sending the message;
    // Escape just closes the popup. Checked before the shortcode popup
    // since input's listener above already closes shortcode whenever
    // mention is active, but keydown can fire on the same tick.
    if (mnActive && mnResults.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mnSelectedIndex = (mnSelectedIndex + 1) % mnResults.length;
        showMentionSuggest(mnResults, '', parseInt(document.getElementById('mention-suggest').dataset.atPos, 10), parseInt(document.getElementById('mention-suggest').dataset.cursorPos, 10));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mnSelectedIndex = (mnSelectedIndex - 1 + mnResults.length) % mnResults.length;
        showMentionSuggest(mnResults, '', parseInt(document.getElementById('mention-suggest').dataset.atPos, 10), parseInt(document.getElementById('mention-suggest').dataset.cursorPos, 10));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(mnSelectedIndex >= 0 ? mnSelectedIndex : 0);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionSuggest();
        return;
      }
    }
    // While the shortcode popup is open, arrow keys move the highlighted
    // suggestion and Enter/Tab confirm it instead of sending the message;
    // Escape just closes the popup. Only plain Enter (no popup open)
    // falls through to sendMessage(), same as before.
    if (scActive && scResults.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        scSelectedIndex = (scSelectedIndex + 1) % scResults.length;
        showShortcodeSuggest(scResults, scQuery, parseInt(document.getElementById('shortcode-suggest').dataset.colonPos, 10), parseInt(document.getElementById('shortcode-suggest').dataset.cursorPos, 10));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        scSelectedIndex = (scSelectedIndex - 1 + scResults.length) % scResults.length;
        showShortcodeSuggest(scResults, scQuery, parseInt(document.getElementById('shortcode-suggest').dataset.colonPos, 10), parseInt(document.getElementById('shortcode-suggest').dataset.cursorPos, 10));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectShortcode(scSelectedIndex >= 0 ? scSelectedIndex : 0);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeShortcodeSuggest();
        return;
      }
    }
    if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
    if (ws && ws.readyState === WebSocket.OPEN && currentRoom) {
      ws.send(JSON.stringify({ type: 'typing', room_id: currentRoom.id }));
    }
  });

  const typingUsers = new Map();
  function showTyping(name) {
    typingUsers.set(name, Date.now());
    renderTyping();
    clearTimeout(typingTimers[name]);
    typingTimers[name] = setTimeout(() => { typingUsers.delete(name); renderTyping(); }, 3000);
  }
  function renderTyping() {
    const el = document.getElementById('typing-indicator');
    const names = [...typingUsers.keys()];
    el.textContent = names.length ? `${names[0]} is typing…` : '';
  }

  // ─── USER PROFILE POPOUT (others) ──────────────────────
  async function showUserProfile(event, userId) {
    if (userId === currentUser.id) { toggleProfilePopout(); return; }
    const popout = document.getElementById('user-profile-popout');
    popout.style.display = 'block';
    _profileUserId = userId;
    const rect = event.target.getBoundingClientRect();
    const top = rect.bottom + 8;
    const left = rect.left;
    const popoutWidth = 380;
    const popoutHeight = 300;
    let finalLeft = left, finalTop = top;
    if (finalLeft + popoutWidth > window.innerWidth) finalLeft = window.innerWidth - popoutWidth - 16;
    if (finalTop + popoutHeight > window.innerHeight) finalTop = rect.top - popoutHeight - 8;
    if (finalTop < 16) finalTop = 16;
    if (finalLeft < 16) finalLeft = 16;
    popout.style.left = finalLeft + 'px';
    popout.style.top = finalTop + 'px';
    document.getElementById('up-name-display').textContent = 'Loading…';
    document.getElementById('up-username-display').textContent = '';
    document.getElementById('up-bio-display').textContent = '';
    const avatarEl = document.getElementById('up-avatar-large');
    avatarEl.innerHTML = '…';
    avatarEl.style.background = '#fd6671';
    try {
      const data = await api('GET', `/users/${userId}`);
      if (!data?.user) { toast('User not found'); popout.style.display = 'none'; return; }
      const user = data.user;
      document.getElementById('up-name-display').textContent = user.display_name || user.username;
      document.getElementById('up-username-display').textContent = '@' + user.username;
      document.getElementById('up-bio-display').textContent = user.bio || '';
      const bannerEl = document.getElementById('up-banner');
      if (user.banner) bannerEl.style.background = `url("${versionedMediaUrl(user.banner)}") center/cover no-repeat`;
      else if (user.banner_color) bannerEl.style.background = user.banner_color;
      else bannerEl.style.background = 'linear-gradient(135deg, var(--accent), var(--accent-hover))';
      if (user.avatar) {
        avatarEl.innerHTML = `<img src="${versionedMediaUrl(user.avatar)}" style="width:100%;height:100%;object-fit:cover;" />`;
        avatarEl.style.background = 'none';
      } else {
        const letter = (user.display_name || user.username)[0].toUpperCase();
        avatarEl.innerHTML = letter;
        avatarEl.style.background = hashColor(user.display_name || user.username);
      }
      const status = user.status || 'offline';
      const pip = document.getElementById('up-status-pip-display');
      pip.className = 'up-status-pip ' + pipClass(status);
      document.getElementById('up-status-text-display').textContent = status === 'online' ? 'Online' : 'Offline';
    } catch (err) { toast('Failed to load profile'); popout.style.display = 'none'; }
  }
  function closeUserProfilePopout() {
    document.getElementById('user-profile-popout').style.display = 'none';
    _profileUserId = null;
  }
  function startDMFromProfile() {
    if (!_profileUserId) return;
    const userId = _profileUserId;
    closeUserProfilePopout();
    const existing = dms.find(d => d._otherId === userId);
    if (existing) { openRoom(existing.id); } else {
      api('GET', `/users/${userId}`).then(data => {
        if (data?.user) {
          const name = data.user.display_name || data.user.username;
          startDM(userId, name);
        } else { toast('User not found'); }
      });
    }
  }
  document.addEventListener('click', (e) => {
    const popout = document.getElementById('user-profile-popout');
    if (popout.style.display === 'block' && !popout.contains(e.target) && !e.target.closest('.msg-author')) {
      closeUserProfilePopout();
    }
  });

  // ─── SELF PROFILE, STATUS, EDIT PROFILE ──────────────────
  const STATUS_LABELS = { online: 'Online', offline: 'Invisible' };
  const STATUS_PIP_REAL = { online: 'pip-online', offline: 'pip-offline' };
  async function setStatus(status) {
    document.getElementById('pp-status-submenu').style.display = 'none';
    document.querySelectorAll('.pp-sub-btn').forEach(b => b.classList.toggle('active', b.dataset.status === status));
    const curDot = document.getElementById('pp-cur-dot');
    if (curDot) curDot.className = `pp-dot ${STATUS_PIP_REAL[status]||'pip-offline'}`;
    document.getElementById('pp-cur-label').textContent = STATUS_LABELS[status] || 'Invisible';
    document.getElementById('up-status-pip').className = `${pipClass(status)}`;
    document.getElementById('pp-avatar-status').className = `pp-avatar-status ${pipClass(status)}`;
    localStorage.setItem('nyxie_status', status);
    currentUser._status = status;
    await api('PATCH', '/users/status', { status });
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'set_status', status }));
    toast('Status updated');
  }
  function toggleStatusMenu() {
    const sub = document.getElementById('pp-status-submenu');
    sub.style.display = sub.style.display === 'none' ? 'block' : 'none';
  }
  function toggleProfilePopout() {
    const pp = document.getElementById('profile-popout');
    if (pp.style.display === 'block') { pp.style.display = 'none'; return; }
    const name = currentUser.display_name || currentUser.username;
    const letter = name[0].toUpperCase();
    const color = hashColor(name);
    const avEl = document.getElementById('pp-avatar-letter');
    avEl.textContent = letter;
    avEl.style.background = color;
    if (currentUser.avatar) avEl.innerHTML = `<img src="${versionedMediaUrl(currentUser.avatar)}" style="width:100%;height:100%;object-fit:cover;" />`;
    else { avEl.innerHTML = letter; avEl.style.background = color; }
    document.getElementById('pp-name').textContent = name;
    document.getElementById('pp-tag').textContent = '@' + currentUser.username;
    document.getElementById('pp-bio').textContent = currentUser.bio || '';
    document.getElementById('pp-banner').style.background = `linear-gradient(135deg, ${hashColor(currentUser.username)}, #fd6671)`;
    const curStatus = currentUser._status || currentUser.status || 'online';
    const curDot = document.getElementById('pp-cur-dot');
    if (curDot) curDot.className = `pp-dot ${STATUS_PIP_REAL[curStatus]||'pip-offline'}`;
    document.getElementById('pp-cur-label').textContent = STATUS_LABELS[curStatus] || 'Invisible';
    document.querySelectorAll('.pp-sub-btn').forEach(b => b.classList.toggle('active', b.dataset.status === curStatus));
    document.getElementById('pp-avatar-status').className = `pp-avatar-status ${pipClass(curStatus)}`;
    document.getElementById('pp-status-submenu').style.display = 'none';
    pp.style.display = 'block';
  }
  function copyUserId() {
    navigator.clipboard.writeText(currentUser.id).then(() => toast('User ID copied!'));
  }
  function openEditProfileModal() {
    const modal = document.getElementById('edit-profile-modal');
    modal.style.display = 'flex';
    document.getElementById('edit-username').value = currentUser.username || '';
    document.getElementById('edit-displayname').value = currentUser.display_name || '';
    document.getElementById('edit-bio').value = currentUser.bio || '';
    const preview = document.getElementById('edit-avatar-preview');
    if (currentUser.avatar) { preview.src = versionedMediaUrl(currentUser.avatar); preview.style.display = 'block'; }
    else preview.style.display = 'none';
    document.getElementById('edit-current-password').value = '';
    document.getElementById('edit-new-password').value = '';
    document.getElementById('edit-confirm-password').value = '';
  }
  function closeEditProfileModal() {
    document.getElementById('edit-profile-modal').style.display = 'none';
  }
  // Renaming yourself only updates currentUser + the profile popout by
  // default — every message you've already sent this session keeps the
  // display_name it was rendered with, both in the DOM and in the stored
  // msg objects in window._messagesById (which reply quotes and the
  // reply-preview bar read from). Patch both so old messages pick up the
  // new name immediately instead of waiting for a reload (which re-fetches
  // messages, so the server-side display_name comes back fresh).
  function refreshOwnDisplayNameEverywhere() {
    const name = currentUser.display_name || currentUser.username;
    if (!window._messagesById) return;
    for (const msg of window._messagesById.values()) {
      if (msg.user_id === currentUser.id) msg.display_name = currentUser.display_name;
    }
    document.querySelectorAll('#messages-container [data-msg-id]').forEach(row => {
      const msg = window._messagesById.get(row.dataset.msgId);
      if (!msg || msg.user_id !== currentUser.id) return;
      const authorEl = row.querySelector('.msg-author');
      if (authorEl) authorEl.textContent = name;
    });
  }

  document.getElementById('editProfileForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const username = document.getElementById('edit-username').value.trim();
    const display_name = document.getElementById('edit-displayname').value.trim();
    const bio = document.getElementById('edit-bio').value.trim();
    const current_password = document.getElementById('edit-current-password').value;
    const new_password = document.getElementById('edit-new-password').value;
    const confirm_password = document.getElementById('edit-confirm-password').value;
    if (!username || username.length < 3 || username.length > 30 || !/^[a-zA-Z0-9_-]+$/.test(username)) { toast('Invalid username'); return; }
    if (display_name && display_name.length > 64) { toast('Display name too long'); return; }
    if (bio && bio.length > 500) { toast('Bio too long'); return; }
    if (new_password && new_password !== confirm_password) { toast('Passwords do not match'); return; }
    if (new_password && new_password.length < 8) { toast('New password must be at least 8 characters'); return; }
    if (new_password && !current_password) { toast('Current password is required to change password'); return; }
    const payload = {};
    if (username !== currentUser.username) payload.username = username;
    if (display_name !== currentUser.display_name) payload.display_name = display_name;
    if (bio !== (currentUser.bio || '')) payload.bio = bio;
    if (new_password) { payload.current_password = current_password; payload.new_password = new_password; }
    if (Object.keys(payload).length === 0) { toast('No changes made'); return; }
    const saveBtn = document.getElementById('edit-profile-save-btn');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      if (data.user) {
        currentUser.username = data.user.username;
        currentUser.display_name = data.user.display_name;
        currentUser.bio = data.user.bio;
        localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
        document.getElementById('up-name').textContent = currentUser.display_name || currentUser.username;
        document.getElementById('up-tag').textContent = '@' + currentUser.username;
        refreshOwnDisplayNameEverywhere();
        toast('Profile updated');
        closeEditProfileModal();
        renderDMList();
        if (document.getElementById('profile-popout').style.display === 'block') {
          toggleProfilePopout();
          setTimeout(toggleProfilePopout, 50);
        }
      } else { toast('Update successful'); closeEditProfileModal(); }
    } catch (err) { toast(err.message); }
    finally { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
  });
  async function uploadAvatarFromEdit(file) {
    if (!file) return;
    const formData = new FormData(); formData.append('avatar', file);
    try {
      const res = await fetch('/api/users/avatar', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: formData
      });
      const data = await res.json();
      if (data.ok) {
        currentUser.avatar = data.avatar;
        localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
        document.getElementById('edit-avatar-preview').src = versionedMediaUrl(data.avatar, true);
        document.getElementById('edit-avatar-preview').style.display = 'block';
        updateAvatarUI(data.avatar);
        toast('Avatar updated');
      } else toast(data.error || 'Upload failed');
    } catch (err) { toast('Upload error'); }
  }
  function updateAvatarUI(avatarUrl) {
    const upAv = document.getElementById('up-avatar');
    if (avatarUrl) upAv.innerHTML = `<img src="${versionedMediaUrl(avatarUrl)}" style="width:100%;height:100%;object-fit:cover;" />`;
    else { const name = currentUser.display_name || currentUser.username; upAv.textContent = name[0].toUpperCase(); upAv.style.background = hashColor(name); upAv.innerHTML = name[0].toUpperCase(); }
    const ppAv = document.getElementById('pp-avatar-letter');
    if (avatarUrl) ppAv.innerHTML = `<img src="${versionedMediaUrl(avatarUrl)}" style="width:100%;height:100%;object-fit:cover;" />`;
    else { const name = currentUser.display_name || currentUser.username; ppAv.textContent = name[0].toUpperCase(); ppAv.style.background = hashColor(name); }
  }

  // ─── FRIENDS AND DMs ──────────────────────────────────────
  function showCtxMenu(e, roomId) {
    e.preventDefault();
    ctxRoomId = roomId;
    const menu = document.getElementById('ctx-menu');
    menu.style.display = 'block';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  }
  function ctxOpen() { document.getElementById('ctx-menu').style.display = 'none'; const dm = dms.find(d => d.id === ctxRoomId); if (dm) openRoom(dm.id); }
  function ctxDelete() { document.getElementById('ctx-menu').style.display = 'none'; chatToDelete = ctxRoomId; document.getElementById('delete-chat-modal').style.display = 'flex'; }
  document.addEventListener('click', e => {
    if (!document.getElementById('ctx-menu').contains(e.target)) document.getElementById('ctx-menu').style.display = 'none';
    const pp = document.getElementById('profile-popout');
    if (pp.style.display === 'block' && !pp.contains(e.target) && !document.getElementById('user-panel').contains(e.target)) pp.style.display = 'none';
  });
  function deleteCurrentChat() { if (!currentRoom) return; chatToDelete = currentRoom.id; document.getElementById('delete-chat-modal').style.display = 'flex'; }
  async function confirmDeleteChat() {
    if (!chatToDelete) return;
    await api('POST', `/rooms/${chatToDelete}/leave`);
    document.getElementById('delete-chat-modal').style.display = 'none';
    if (currentRoom?.id === chatToDelete) { currentRoom = null; document.getElementById('chat-view').style.display = 'none'; navigateTo('home'); }
    dms = dms.filter(d => d.id !== chatToDelete);
    delete unreadCounts[chatToDelete];
    chatToDelete = null;
    renderDMList();
    toast('Conversation removed');
  }
  function showNewDmModal() {
    document.getElementById('new-dm-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('dm-search-input').focus(), 50);
    document.getElementById('dm-search-input').value = '';
    document.getElementById('dm-search-results').innerHTML = '';
  }
  async function searchUsers(q) {
    clearTimeout(_searchTimer);
    const results = document.getElementById('dm-search-results');
    if (q.length < 2) { results.innerHTML = ''; return; }
    _searchTimer = setTimeout(async () => {
      const res = await api('GET', `/users/search?q=${encodeURIComponent(q)}`);
      if (!res?.users?.length) { results.innerHTML = `<div style="color:var(--text-muted);padding:10px;font-size:.85rem;text-align:center">No users found</div>`; return; }
      results.innerHTML = res.users.map(u => {
        const name = u.display_name || u.username;
        const letter = name[0].toUpperCase();
        const avatarHtml = u.avatar ? `<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover;" />` : letter;
        return `<div class="search-result-item" onclick="startDM('${u.id}','${escapeJs(name)}')">
          <div class="mini-avatar" style="background:${hashColor(name)}">${avatarHtml}</div>
          <div>
            <div style="font-size:.88rem;font-weight:600">${escapeHtml(name)}</div>
            <div style="font-size:.75rem;color:var(--text-muted)">@${escapeHtml(u.username)}</div>
          </div>
        </div>`;
      }).join('');
    }, 280);
  }
  async function startDM(targetUserId, targetName) {
    const res = await api('POST', '/rooms/dm', { target_user_id: targetUserId });
    if (res?.error) return toast(res.error);
    document.getElementById('new-dm-modal').style.display = 'none';
    let dm = dms.find(d => d.id === res.room_id);
    if (!dm) {
      const fakeDm = { id: res.room_id, is_dm: 1, display_name: targetName, _otherId: targetUserId, _status: 'offline', _avatar: null, last_message: null, last_message_at: null };
      dms = [fakeDm, ...dms]; renderDMList(); wsJoin(res.room_id);
      await loadDMs();
      const updatedDm = dms.find(d => d.id === res.room_id);
      if (updatedDm) dm = updatedDm; else dm = dms.find(d => d.id === res.room_id) || fakeDm;
    }
    openRoom(dm.id);
  }
  async function loadFriendsData() {
    const [fRes, rRes] = await Promise.all([ api('GET', '/friends'), api('GET', '/friends/requests') ]);
    friends = fRes?.friends || [];
    friendRequests = { incoming: rRes?.incoming || [], outgoing: rRes?.outgoing || [] };
    updateFriendsBadge();
    return { friends, friendRequests };
  }
  function updateFriendsBadge() {
    const pending = friendRequests.incoming.length;
    const badge = document.getElementById('nav-friends-badge');
    if (pending > 0) { badge.style.display = 'inline'; badge.textContent = pending; } else badge.style.display = 'none';
    document.getElementById('ftab-pending-count').textContent = pending ? `(${pending})` : '';
  }
  function switchFriendsTab(tab) {
    currentFriendsTab = tab;
    document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
    document.getElementById('ftab-' + tab)?.classList.add('active');
    renderFriendsList();
  }
  function renderFriendsList() {
    const el = document.getElementById('friends-list');
    const { incoming, outgoing } = friendRequests;
    if (currentFriendsTab === 'pending') {
      if (!incoming.length && !outgoing.length) { el.innerHTML = `<div class="friends-empty">No pending requests</div>`; return; }
      let out = '';
      if (incoming.length) {
        out += `<div style="padding:6px 16px 4px;font-size:.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Incoming — ${incoming.length}</div>`;
        out += incoming.map(r => {
          const name = r.from_name || r.from_username;
          let avatarHtml = name[0].toUpperCase();
          if (r.from_avatar) avatarHtml = `<img src="${versionedMediaUrl(r.from_avatar)}" style="width:100%;height:100%;object-fit:cover;" />`;
          return `<div class="friend-row">
            <div class="fr-avatar-wrap">
              <div class="fr-avatar" style="background:${hashColor(name)}">${avatarHtml}</div>
            </div>
            <div class="fr-info">
              <div class="fr-name">${escapeHtml(name)}</div>
              <div class="fr-sub">@${escapeHtml(r.from_username)} · Incoming</div>
            </div>
            <div class="fr-actions">
              <button class="fr-btn accept" onclick="acceptFriendRequest('${r.id}','${escapeJs(name)}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </button>
              <button class="fr-btn decline" onclick="declineFriendRequest('${r.id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>`;
        }).join('');
      }
      if (outgoing.length) {
        out += `<div style="padding:6px 16px 4px;font-size:.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Outgoing — ${outgoing.length}</div>`;
        out += outgoing.map(r => {
          const name = r.to_name || r.to_username;
          let avatarHtml = name[0].toUpperCase();
          if (r.to_avatar) avatarHtml = `<img src="${versionedMediaUrl(r.to_avatar)}" style="width:100%;height:100%;object-fit:cover;" />`;
          return `<div class="friend-row">
            <div class="fr-avatar-wrap">
              <div class="fr-avatar" style="background:${hashColor(name)}">${avatarHtml}</div>
            </div>
            <div class="fr-info">
              <div class="fr-name">${escapeHtml(name)}</div>
              <div class="fr-sub">@${escapeHtml(r.to_username)} · Waiting</div>
            </div>
            <div class="fr-actions">
              <button class="fr-btn decline" onclick="cancelFriendRequest('${r.id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>`;
        }).join('');
      }
      el.innerHTML = out;
      return;
    }
    let list = [...friends];
    if (currentFriendsTab === 'online') list = list.filter(f => f.status === 'online');
    if (!list.length) { el.innerHTML = `<div class="friends-empty">${currentFriendsTab === 'online' ? 'No friends online' : 'No friends yet'}</div>`; return; }
    el.innerHTML = list.map(f => {
      const name = f.display_name || f.username;
      let avatarHtml = name[0].toUpperCase();
      if (f.avatar) avatarHtml = `<img src="${versionedMediaUrl(f.avatar)}" style="width:100%;height:100%;object-fit:cover;" />`;
      return `<div class="friend-row" onclick="messageFriend('${f.id}','${escapeJs(name)}')">
        <div class="fr-avatar-wrap">
          <div class="fr-avatar" style="background:${hashColor(name)}">${avatarHtml}</div>
          <div class="status-pip ${pipClass(f.status||'offline')}" style="border-color:var(--bg-secondary)"></div>
        </div>
        <div class="fr-info">
          <div class="fr-name">${escapeHtml(name)}</div>
          <div class="fr-sub">@${escapeHtml(f.username)} · ${f.status||'offline'}</div>
        </div>
        <div class="fr-actions">
          <button class="fr-btn" onclick="event.stopPropagation();messageFriend('${f.id}','${escapeJs(name)}')">💬</button>
          <button class="fr-btn decline" onclick="event.stopPropagation();removeFriend('${f.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>`;
    }).join('');
  }
  async function sendFriendRequest() {
    const input = document.getElementById('add-friend-input');
    const q = input.value.trim();
    if (q.length < 2) return toast('Enter a username to search');
    const res = await api('GET', `/users/search?q=${encodeURIComponent(q)}`);
    if (!res?.users?.length) return toast('User not found');
    const u = res.users[0];
    if (u.id === currentUser.id) return toast("That's you!");
    await sendFriendRequestTo(u.id, u.display_name || u.username);
  }
  async function sendFriendRequestTo(userId, displayName) {
    const res = await api('POST', '/friends/request', { to_id: userId });
    if (res?.error) return toast(res.error);
    if (res?.auto_accepted) {
      toast(`You and ${displayName} are now friends!`);
      await loadFriendsData();
      if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
      else await startDM(userId, displayName);
    } else {
      toast(`Friend request sent to ${displayName}`);
      document.getElementById('add-friend-input').value = '';
      document.getElementById('add-friend-results').innerHTML = '';
      await loadFriendsData();
      if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
    }
  }
  async function acceptFriendRequest(reqId, fromName) {
    const req = friendRequests.incoming.find(r => r.id === reqId);
    const res = await api('POST', `/friends/requests/${reqId}/accept`);
    if (res?.error) return toast(res.error);
    toast(`You and ${fromName} are now friends!`);
    await loadFriendsData();
    if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
    else if (req?.from_id) await startDM(req.from_id, fromName);
  }
  async function acceptFriendRequestByUserId(userId) {
    const req = friendRequests.incoming.find(r => r.from_id === userId);
    if (!req) return toast('Request not found');
    const fromName = req.from_name || req.from_username || 'them';
    await acceptFriendRequest(req.id, fromName);
  }
  async function declineFriendRequest(reqId) {
    await api('POST', `/friends/requests/${reqId}/decline`);
    await loadFriendsData();
    if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
    toast('Request declined');
  }
  async function cancelFriendRequest(reqId) {
    await api('DELETE', `/friends/requests/${reqId}`);
    await loadFriendsData();
    if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
    toast('Request cancelled');
  }
  async function removeFriend(userId) {
    await api('DELETE', `/friends/${userId}`);
    friends = friends.filter(f => f.id !== userId);
    if (document.getElementById('friends-panel').style.display === 'flex') renderFriendsList();
    toast('Friend removed');
  }
  async function messageFriend(userId, name) {
    document.getElementById('friends-panel').style.display = 'none';
    await startDM(userId, name);
  }
  function searchFriendUsers(q) {
    clearTimeout(_friendSearchTimer);
    const results = document.getElementById('add-friend-results');
    if (q.length < 2) { results.innerHTML = ''; return; }
    _friendSearchTimer = setTimeout(async () => {
      const res = await api('GET', `/users/search?q=${encodeURIComponent(q)}`);
      if (!res?.users?.length) { results.innerHTML = `<div style="color:var(--text-muted);padding:8px;font-size:.82rem;text-align:center">No users found</div>`; return; }
      results.innerHTML = res.users.map(u => {
        const name = u.display_name || u.username;
        const isFriend = friends.some(f => f.id === u.id);
        const hasPendingOut = friendRequests.outgoing.some(r => r.to_id === u.id);
        const hasPendingIn = friendRequests.incoming.some(r => r.from_id === u.id);
        const avatarHtml = u.avatar ? `<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover;" />` : name[0].toUpperCase();
        return `<div class="search-result-item" style="justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="mini-avatar" style="background:${hashColor(name)}">${avatarHtml}</div>
            <div>
              <div style="font-size:.85rem;font-weight:600">${escapeHtml(name)}</div>
              <div style="font-size:.75rem;color:var(--text-muted)">@${escapeHtml(u.username)}</div>
            </div>
          </div>
          ${isFriend ? `<span style="font-size:.75rem;color:var(--online);font-weight:600">Friends ✓</span>`
            : hasPendingIn ? `<button class="add-friend-btn" style="padding:4px 10px;font-size:.78rem;background:var(--online)" onclick="acceptFriendRequestByUserId('${u.id}')">Accept</button>`
            : hasPendingOut ? `<span style="font-size:.75rem;color:var(--text-muted)">Pending…</span>`
            : `<button class="add-friend-btn" style="padding:4px 10px;font-size:.78rem" onclick="sendFriendRequestTo('${u.id}','${escapeJs(name)}')">Add</button>`}
        </div>`;
      }).join('');
    }, 250);
  }
  document.getElementById('add-friend-input').addEventListener('input', function() { searchFriendUsers(this.value); });

  // ─── SELECT MODE ──────────────────────────────────────────
  function toggleDMSelect(roomId, itemEl) {
    if (!window.selectModeActive) return;
    if (selectedRoomIds.has(roomId)) { selectedRoomIds.delete(roomId); itemEl.classList.remove('selected'); }
    else { selectedRoomIds.add(roomId); itemEl.classList.add('selected'); }
    updateMSBar();
  }
  function updateMSBar() {
    const n = selectedRoomIds.size;
    document.getElementById('msb-count').textContent = n === 0 ? '0 selected' : `${n} conversation${n>1?'s':''} selected`;
    document.getElementById('msb-delete-btn').disabled = n === 0;
  }
  async function deleteSelectedChats() {
    if (!selectedRoomIds.size) return;
    const ids = [...selectedRoomIds];
    for (const id of ids) {
      await api('POST', `/rooms/${id}/leave`);
      dms = dms.filter(d => d.id !== id);
      delete unreadCounts[id];
      if (currentRoom?.id === id) { currentRoom = null; document.getElementById('chat-view').style.display = 'none'; navigateTo('home'); }
    }
    selectedRoomIds.clear();
    toggleSelectMode();
    renderDMList();
    toast(`${ids.length} conversation${ids.length>1?'s':''} removed`);
  }
  function filterSidebar(q) {
    const lq = q.toLowerCase();
    document.querySelectorAll('.dm-item').forEach(el => {
      const name = el.querySelector('.dm-name')?.textContent?.toLowerCase() || '';
      el.style.display = name.includes(lq) ? '' : 'none';
    });
  }
  function handleFileUpload(files) { /* defined above */ }
  // NOTE: the real startCall() lives in voice.js's initVoiceFeatures()
  // (window.startCall = async function... — actual WebRTC call logic).
  // There used to be a placeholder stub here that got wired up via
  // `window.startCall = startCall` below, which raced against voice.js's
  // real assignment and could permanently win if initVoiceFeatures() ever
  // failed to run before this synchronous code executed. Removed so
  // voice.js is the single source of truth for window.startCall.

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  INIT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  (async () => {
    try {
      await EmojiDB.load();
      renderEmojiPicker('');
      const me = await api('GET', '/auth/me');
      if (!me?.user) { logout(); return; }
      currentUser = me.user;
      localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
      const saved = localStorage.getItem('nyxie_status');
      if (saved && ['online', 'offline'].includes(saved)) currentUser._status = saved;
      else { currentUser._status = 'online'; localStorage.setItem('nyxie_status', 'online'); }
      const name = currentUser.display_name || currentUser.username;
      const letter = name[0].toUpperCase();
      const color = hashColor(name);
      const upAvatar = document.getElementById('up-avatar');
      if (currentUser.avatar) upAvatar.innerHTML = `<img src="${versionedMediaUrl(currentUser.avatar)}" style="width:100%;height:100%;object-fit:cover;" />`;
      else { upAvatar.textContent = letter; upAvatar.style.background = color; }
      document.getElementById('up-status-pip').className = pipClass(currentUser._status);
      document.getElementById('up-name').textContent = name;
      document.getElementById('up-tag').textContent = '@' + currentUser.username;
      try { await ensureE2EEKeys(); } catch (e) { console.error('E2EE key setup failed:', e); toast('⚠️ Encryption setup failed — messages will send unencrypted'); }
      connectWS();
      if (typeof initVoiceFeatures === 'function') { try { initVoiceFeatures(); } catch (e) { console.error('Voice feature init failed:', e); } }
      await loadDMs();
      await loadFriendsData();
      // Set by router.js's '/wallets' or '/app/rooms/:roomId' route
      // before calling initDashboardView() — lets a direct navigation,
      // page refresh, or browser back/forward land on that specific
      // section or conversation instead of always resetting to 'home'.
      if (window._initialRoomId) {
        const roomId = window._initialRoomId;
        window._initialRoomId = null;
        if (dms.find(d => d.id === roomId)) {
          openRoom(roomId, { fromRoute: true });
        } else {
          // Deep link to a conversation we don't actually have (bad
          // link, or it was left/deleted elsewhere) — fall back to home
          // rather than getting stuck on a broken room URL.
          toast('Conversation not found');
          window.history.replaceState({}, '', '/app');
          navigateTo('home');
        }
      } else {
        navigateTo(window._initialSection || 'home');
        window._initialSection = null;
      }
      _dashboardPollTimer = setInterval(async () => {
        const data = await api('GET', '/rooms');
        if (!data) return;
        const fresh = (data.rooms || []).filter(r => r.is_dm || r.is_dm === 1);
        const newOnes = fresh.filter(r => !dms.find(d => d.id === r.id));
        if (newOnes.length) {
          await Promise.all(newOnes.map(async dm => {
            let otherPublicKey = null;
            if (dm._otherId) {
              const udata = await api('GET', `/users/${dm._otherId}`);
              dm._status = udata?.user?.status || 'offline';
              dm._avatar = udata?.user?.avatar || null;
              otherPublicKey = udata?.user?.public_key || null;
            }
            if (dm.last_message_nonce) dm.last_message = await decryptDmPreview(dm.last_message, dm.last_message_nonce, dm._otherId, otherPublicKey);
          }));
          dms = [...newOnes, ...dms];
          renderDMList();
          newOnes.forEach(d => wsJoin(d.id));
        }
      }, 30000);
    } catch (err) { console.error('Init error:', err); toast('Failed to initialize – please refresh'); }
  })();

  // ─── TOGGLE SELECT MODE ──────────────────────────────────
  function toggleSelectMode() {
    selectModeActive = !selectModeActive;
    window.selectModeActive = selectModeActive;
    selectedRoomIds.clear();
    document.body.classList.toggle('select-mode', selectModeActive);
    updateMSBar();
    renderDMList();
  }

  // ─── HANDLE FILE UPLOAD ──────────────────────────────────
  function handleFileUpload(files) {
    if (!files || files.length === 0) return;
    for (const f of files) {
      pendingFiles.push(f);
    }
    renderAttachmentPreviews();
    document.getElementById('file-input').value = '';
    toast(`${files.length} file(s) ready to send`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  GLOBAL EXPOSURE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  window.selectEmoji = selectEmoji;
  window.selectShortcode = selectShortcode;
  window.selectMention = selectMention;
  window.toggleEmojiPicker = toggleEmojiPicker;
  window.clearEmojiSearch = clearEmojiSearch;
  window.renderEmojiPicker = renderEmojiPicker;
  window.setReplyTo = setReplyTo;
  window.cancelReply = cancelReply;
  window.openRoom = openRoom;
  window.hideDM = hideDM;
  window.closeDM = closeDM;
  window.editMsg = editMsg;
  window.deleteMsg = deleteMsg;
  window.toggleReactionPicker = toggleReactionPicker;
  window.openFullReactionPicker = openFullReactionPicker;
  window.closeFullReactionPicker = closeFullReactionPicker;
  window.renderReactionEmojiPicker = renderReactionEmojiPicker;
  window.clearReactionEmojiSearch = clearReactionEmojiSearch;
  window.selectReactionEmoji = selectReactionEmoji;
  window.quickReact = quickReact;
  window.toggleMoreMenu = toggleMoreMenu;
  window.closeMoreMenu = closeMoreMenu;
  window.copyMsgText = copyMsgText;
  window.searchInChat = searchInChat;
  window.closeChatSearch = closeChatSearch;
  window.chatSearchNav = chatSearchNav;
  window.filterChatMessages = filterChatMessages;
  window.showUserProfile = showUserProfile;
  window.closeUserProfilePopout = closeUserProfilePopout;
  window.startDMFromProfile = startDMFromProfile;
  window.toggleStatusMenu = toggleStatusMenu;
  window.setStatus = setStatus;
  window.toggleProfilePopout = toggleProfilePopout;
  window.copyUserId = copyUserId;
  window.openEditProfileModal = openEditProfileModal;
  window.closeEditProfileModal = closeEditProfileModal;
  window.uploadAvatarFromEdit = uploadAvatarFromEdit;
  window.showCtxMenu = showCtxMenu;
  window.ctxOpen = ctxOpen;
  window.ctxDelete = ctxDelete;
  window.deleteCurrentChat = deleteCurrentChat;
  window.confirmDeleteChat = confirmDeleteChat;
  window.showNewDmModal = showNewDmModal;
  window.searchUsers = searchUsers;
  window.startDM = startDM;
  window.switchFriendsTab = switchFriendsTab;
  window.sendFriendRequest = sendFriendRequest;
  window.sendFriendRequestTo = sendFriendRequestTo;
  window.acceptFriendRequest = acceptFriendRequest;
  window.acceptFriendRequestByUserId = acceptFriendRequestByUserId;
  window.declineFriendRequest = declineFriendRequest;
  window.cancelFriendRequest = cancelFriendRequest;
  window.removeFriend = removeFriend;
  window.messageFriend = messageFriend;
  window.searchFriendUsers = searchFriendUsers;
  window.toggleDMSelect = toggleDMSelect;
  window.deleteSelectedChats = deleteSelectedChats;
  window.toggleSelectMode = toggleSelectMode;
  window.filterSidebar = filterSidebar;
  window.handleFileUpload = handleFileUpload;
  window.logout = logout;
  window.destroyDashboardView = destroyDashboardView;
  window.navigateTo = navigateTo;
  window.toggleSidebar = toggleSidebar;
} // <--- Closes initDashboardView()