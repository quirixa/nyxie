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
  // ─── Servers & Group Chats state ───────────────────────────
  let servers = [];              // servers I'm a member of, from GET /servers
  let currentServerId = null;    // server currently shown in the sidebar, or null (DM view)
  let serverChannels = [];       // channels of currentServerId, from GET /servers/:id/channels
  let currentServerRoles = [];   // roles of currentServerId, cached for the members/role picker
  let joinPreviewInvite = null;  // last invite preview shown in the "Join a Server" tab
  // ─── Server Discovery state ────────────────────────────────
  let discoverCategories = [];       // cached from GET /servers/categories
  let discoverCategoriesLoaded = false;
  let discoverActiveCategory = '';   // '' = Home (all categories)
  let discoverActiveQuery = '';
  let discoverPage = 1;
  let discoverHasMore = false;
  let discoverResults = [];          // accumulated across "Load more" pages
  let inDiscoverView = false;
  let _discoverLoadToken = 0;
  let _discoverDebounceTimer = null;
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
  const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
  const PRESENCE_PIP_CLASS = { online: 'pip-online', idle: 'pip-idle', dnd: 'pip-dnd', invisible: 'pip-offline', offline: 'pip-offline' };
  function pipClass(status) { return PRESENCE_PIP_CLASS[status] || 'pip-offline'; }
  const PRESENCE_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible', offline: 'Offline' };
  function presenceLabel(status) { return PRESENCE_LABEL[status] || 'Offline'; }
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
    inDiscoverView = false;
    document.getElementById('discover-panel').style.display = 'none';
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-' + section)?.classList.add('active');
    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('friends-panel').style.display = 'none';
    document.getElementById('wallet-panel').style.display = 'none';
    document.getElementById('marketplace-panel').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'none';
    document.getElementById('chat-view').style.display = 'none';
    renderServerRail();
    if (section === 'home') {
      document.getElementById('welcome-view').style.display = 'flex';
      showMobileList();
    } else if (section === 'friends') {
      document.getElementById('friends-panel').style.display = 'flex';
      await loadFriendsData();
      renderFriendsList();
      showMobileDetail();
    } else if (section === 'wallet') {
      document.getElementById('wallet-panel').style.display = 'flex';
      if (typeof initWalletPanel === 'function') initWalletPanel();
      showMobileDetail();
    } else if (section === 'marketplace') {
      document.getElementById('marketplace-panel').style.display = 'flex';
      if (typeof initMarketplacePanel === 'function') initMarketplacePanel();
      showMobileDetail();
    } else if (section === 'admin') {
      // Cosmetic gate, mirroring router.js's 'admin' auth guard — this
      // covers the case where something calls navigateTo('admin')
      // directly (e.g. stale UI state) rather than through a route
      // change. The real enforcement is server-side (requireAdmin in
      // server/middleware/auth.js); every /api/admin/marketplace call
      // this panel makes is re-checked there regardless of this check.
      if (!currentUser || currentUser.role !== 'ADMIN') {
        toast('Admin access required', true);
        return navigateTo('home');
      }
      document.getElementById('admin-panel').style.display = 'flex';
      if (typeof initAdminPanel === 'function') initAdminPanel();
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
    // Marketplace gets the same '/marketplace' treatment as '/wallets',
    // and admin gets the same treatment via '/admin/disputes'.
    const path = window.location.pathname;
    const onWalletUrl = path === '/wallets';
    const onMarketplaceUrl = path === '/marketplace';
    const onAdminUrl = path === '/admin/disputes';
    const onRoomUrl = path.startsWith('/app/rooms/');
    const onServerUrl = path.startsWith('/servers/');
    const onDiscoverUrl = path.startsWith('/discover');
    if (section === 'wallet' && !onWalletUrl) {
      window.history.replaceState({}, '', '/wallets');
    } else if (section === 'marketplace' && !onMarketplaceUrl) {
      window.history.replaceState({}, '', '/marketplace');
    } else if (section === 'admin' && !onAdminUrl) {
      window.history.replaceState({}, '', '/admin/disputes');
    } else if (section !== 'wallet' && section !== 'marketplace' && section !== 'admin' && (onWalletUrl || onMarketplaceUrl || onAdminUrl || onRoomUrl || onServerUrl || onDiscoverUrl)) {
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
    document.getElementById('wallet-panel').style.display = 'none';
    // Added as requested: ensure wallet-panel and notifications-panel are hidden
    document.getElementById('wallet-panel').style.display = 'none';
    document.getElementById('notifications-panel').style.display = 'none';
    document.getElementById('marketplace-panel').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'none';
    document.getElementById('chat-view').style.display = 'flex';
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    showMobileDetail();

    // DMs and group chats have no server-wide member list to show.
    document.getElementById('member-list-toggle-btn').style.display = 'none';
    document.getElementById('member-list-toggle-btn').classList.remove('active');
    document.getElementById('member-list-panel').style.display = 'none';
    document.getElementById('member-list-panel').classList.remove('force-open');

    wsJoin(room.id);

    const name = room.display_name || room.name || 'Unknown';
    const chAvatar = document.getElementById('ch-avatar');
    chAvatar.textContent = name[0].toUpperCase();
    chAvatar.style.background = hashColor(name);
    chAvatar.innerHTML = '';
    chAvatar.textContent = name[0].toUpperCase();
    chAvatar.style.background = hashColor(name);
    document.getElementById('chat-room-name-text').textContent = room.is_group ? name : ('@' + name);
    document.getElementById('msg-input').placeholder = 'Message ' + (room.is_group ? name : ('@' + name));

    if (room._otherId) {
      api('GET', `/users/${room._otherId}`).then(udata => {
        if (loadToken !== _roomLoadToken) return; // a newer room open superseded this one
        if (udata?.user) {
          const status = udata.user.status || 'offline';
          const dot = document.getElementById('ch-status-dot');
          if (dot) dot.className = `ch-status-dot ${pipClass(status)}`;
          const statusText = status === 'offline' ? (udata.user.last_seen ? `last seen ${fmtLastSeen(udata.user.last_seen)}` : 'offline') : presenceLabel(status).toLowerCase();
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
                  ? 'Voice message'
                  : await decryptDmPreview(m.content, m.nonce, dm._otherId, null, dm.id, m.key_envelopes, m.user_id);
                if (!preview && m.attachments && m.attachments.length) {
                  preview = 'Attachment';
                }
                dm.last_message = preview || 'Attachment';
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
          const cached = window._messagesById.get(msg.message_id);
          const apply = async () => {
            let plaintext = msg.content;
            if (msg.nonce) {
              const opened = await decryptRoomText(msg.content, msg.nonce, msg.key_envelopes, msg.room_id, msg.user_id);
              plaintext = opened !== null ? opened : '🔒 Failed to decrypt';
            }
            if (cached) { cached.content = plaintext; cached.nonce = msg.nonce; cached.key_envelopes = msg.key_envelopes; cached.edited_at = msg.edited_at; }
            const el = document.querySelector(`[data-msg-id="${msg.message_id}"] .msg-text`);
            if (el) el.innerHTML = escapeHtml(plaintext) + '<span class="edited-tag">(edited)</span>';
          };
          apply().catch(() => {});
          break;
        }

        case 'message_deleted': {
          const row = document.querySelector(`[data-msg-id="${msg.message_id}"]`);
          const cached = window._messagesById.get(msg.message_id);
          // Attachment/image messages are always removed completely. The
          // server only sends keep_placeholder for text messages that have replies.
          const keepPlaceholder = !!msg.keep_placeholder && !(cached?.attachments?.length);
          if (cached) {
            cached.deleted = true;
            cached.content = '[deleted]';
            cached.nonce = null;
            cached.attachments = null;
          }
          if (row) {
            const container = document.getElementById('messages-container');
            const wasNearBottom = container ? isNearBottom(container) : false;
            if (keepPlaceholder) {
              const textEl = row.querySelector('.msg-text');
              if (textEl) { textEl.textContent = 'Message deleted'; textEl.classList.add('deleted'); }
              const attachments = row.querySelector('.msg-attachments');
              if (attachments) attachments.remove();
              const acts = row.querySelector('.msg-actions');
              if (acts) acts.remove();
              row.classList.add('deleted');
            } else {
              revokeRowObjectUrls(row);
              row.remove();
              window._messagesById.delete(msg.message_id);
              if (container && wasNearBottom) scrollToBottom();
              if (container && !container.querySelector('.msg-row')) {
                const otherName = currentRoom?.display_name || currentRoom?.name || 'Unknown';
                container.innerHTML = `<div class="conversation-start"><div class="start-header"><h3>This is the start of your legendary conversation with</h3><h1>@${escapeHtml(otherName)}.</h1></div></div>`;
                _roomHasMessages = false;
              }
            }
          }
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

        case 'badges_updated': {
          // An admin changed someone's badges: re-fetch so every chat
          // header / list / popout showing that user updates in place.
          Badges.invalidate(msg.user_id);
          if (typeof adminOnBadgesUpdated === 'function') adminOnBadgesUpdated(msg.user_id);
          break;
        }

        case 'self_status': {
          // One of this user's OTHER sessions changed status (or the
          // server pushed back the persisted preference after a
          // reconnect) — sync this session's UI without re-broadcasting.
          applySelfStatus(msg.status);
          break;
        }

        case 'room_state': {
          if (msg.room_id === currentRoom?.id) {
            currentRoomMembers = msg.members.map(m => ({ id: m.id, username: m.username, display_name: m.display_name, avatar: m.avatar, public_key: m.public_key || null }));
          if (currentRoom?.id === msg.room_id) { _roomMembersCache.delete(msg.room_id); document.querySelectorAll('#messages-container [data-msg-id]').forEach(row => { const cached = window._messagesById.get(row.dataset.msgId); if (cached?.attachments?.some(a => a.encrypted)) decryptAttachmentForRow(cached, row).catch(() => {}); }); }
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
            playNotificationSound();
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
          if (f) { playNotificationSound(); toast(`✅ ${f.display_name || f.username} accepted your friend request`); }
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
          // The server is the source of truth for the manually-chosen
          // status preference and doesn't reset it on reconnect anymore —
          // sync it in here so a refresh can't drift this session's UI
          // away from what's actually persisted (e.g. showing "Online"
          // locally right after a refresh when DND was what was saved).
          if (msg.user?.status) applySelfStatus(msg.user.status);
          break;

        // ─── Servers ───────────────────────────────────────
        case 'server_joined': {
          loadServers();
          break;
        }
        case 'server_member_joined': {
          if (currentServerId === msg.server_id) renderServerMembersIfOpen();
          break;
        }
        case 'server_updated': {
          const idx = servers.findIndex(s => s.id === msg.server.id);
          if (idx !== -1) servers[idx] = { ...servers[idx], ...msg.server };
          renderServerRail();
          if (currentServerId === msg.server.id) {
            document.getElementById('server-panel-name').textContent = msg.server.name;
          }
          break;
        }
        case 'server_deleted':
        case 'server_left': {
          servers = servers.filter(s => s.id !== msg.server_id);
          renderServerRail();
          if (currentServerId === msg.server_id) { showDMView(); toast('You are no longer in that server'); }
          break;
        }
        case 'server_member_left':
        case 'server_member_kicked':
        case 'server_member_banned': {
          if (msg.user_id === currentUser.id && msg.server_id) {
            servers = servers.filter(s => s.id !== msg.server_id);
            renderServerRail();
            if (currentServerId === msg.server_id) {
              showDMView();
              toast(msg.type === 'server_member_kicked' ? 'You were kicked from that server' : msg.type === 'server_member_banned' ? 'You were banned from that server' : 'You left that server');
            }
          } else if (currentServerId === msg.server_id) {
            renderServerMembersIfOpen();
          }
          break;
        }
        case 'server_member_updated': {
          if (currentServerId === msg.server_id) renderServerMembersIfOpen();
          break;
        }
        case 'server_role_created':
        case 'server_role_updated':
        case 'server_role_deleted': {
          if (currentServerId === msg.server_id) loadServerRoles();
          break;
        }
        case 'channel_created': {
          if (currentServerId === msg.server_id && !serverChannels.find(c => c.id === msg.channel.id)) {
            serverChannels = [...serverChannels, msg.channel].sort((a, b) => (a.position || 0) - (b.position || 0));
            renderChannelList();
          }
          break;
        }
        case 'channel_updated': {
          if (currentServerId === msg.server_id) {
            const ci = serverChannels.findIndex(c => c.id === msg.channel.id);
            if (ci !== -1) { serverChannels[ci] = { ...serverChannels[ci], ...msg.channel }; renderChannelList(); }
            if (currentRoom?.id === msg.channel.id) {
              document.getElementById('chat-room-name-text').textContent = '# ' + msg.channel.name;
            }
          }
          break;
        }
        case 'channel_deleted': {
          if (currentServerId === msg.server_id) {
            serverChannels = serverChannels.filter(c => c.id !== msg.channel_id);
            renderChannelList();
            if (currentRoom?.id === msg.channel_id) {
              currentRoom = null;
              document.getElementById('chat-view').style.display = 'none';
            }
          }
          break;
        }

        // ─── Group chats ───────────────────────────────────
        case 'group_created': {
          if (!dms.find(d => d.id === msg.group.id)) {
            dms = [{ ...msg.group, id: msg.group.id, is_dm: 1, is_group: 1, display_name: msg.group.name, _avatar: msg.group.icon || null }, ...dms];
            renderDMList();
            wsJoin(msg.group.id);
            toast(`Added to group "${msg.group.name}"`);
          }
          break;
        }
        case 'group_updated': {
          const idx = dms.findIndex(d => d.id === msg.group.id);
          if (idx !== -1) {
            dms[idx] = { ...dms[idx], name: msg.group.name, display_name: msg.group.name, icon: msg.group.icon, _avatar: msg.group.icon || null };
            renderDMList();
          }
          if (currentRoom?.id === msg.group.id) {
            _roomMembersCache.delete(msg.group.id);
            wsJoin(msg.group.id);
            document.getElementById('chat-room-name-text').textContent = msg.group.name;
          }
          break;
        }
        case 'group_member_added':
        case 'group_member_removed':
        case 'group_member_left': {
          _roomMembersCache.delete(msg.group_id);
          if (currentRoom?.id === msg.group_id) wsJoin(msg.group_id);
          if (msg.type !== 'group_member_added' && msg.user_id === currentUser.id) {
            dms = dms.filter(d => d.id !== msg.group_id);
            renderDMList();
            if (currentRoom?.id === msg.group_id) { currentRoom = null; document.getElementById('chat-view').style.display = 'none'; }
            toast('You left the group');
          }
          break;
        }
        case 'group_deleted': {
          dms = dms.filter(d => d.id !== msg.group_id);
          renderDMList();
          if (currentRoom?.id === msg.group_id) { currentRoom = null; document.getElementById('chat-view').style.display = 'none'; toast('This group was deleted'); }
          break;
        }
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
  const _roomMembersCache = new Map();

  async function getRoomEncryptionMembers(roomId) {
    if (_roomMembersCache.has(roomId)) return _roomMembersCache.get(roomId);
    let members = [];
    if (currentRoom?.id === roomId && currentRoomMembers.length) {
      members = currentRoomMembers.slice();
    } else {
      const room = dms.find(d => d.id === roomId);
      if (room?.is_group) {
        const data = await api('GET', `/groups/${roomId}`);
        members = data?.group?.members || [];
      } else if (room?._otherId) {
        const u = await api('GET', `/users/${room._otherId}`);
        members = u?.user ? [{ id: u.user.id, username: u.user.username, display_name: u.user.display_name, avatar: u.user.avatar, public_key: u.user.public_key }] : [];
      }
    }
    const myPublic = localStorage.getItem('nyxie_public_key_' + currentUser.id);
    const normalized = members.map(m => ({ ...m, public_key: m.public_key || null }));
    if (!normalized.some(m => m.id === currentUser.id)) {
      normalized.push({ id: currentUser.id, username: currentUser.username, display_name: currentUser.display_name, public_key: myPublic });
    } else {
      const mine = normalized.find(m => m.id === currentUser.id);
      if (mine && !mine.public_key) mine.public_key = myPublic;
    }
    _roomMembersCache.set(roomId, normalized);
    return normalized;
  }

  function getEnvelopeForUser(envelopes, userId) {
    const env = envelopes && typeof envelopes === 'object' ? envelopes[userId] : null;
    if (!env?.ciphertext || !env?.nonce) return null;
    return env;
  }

  async function createKeyEnvelopes(roomId, secretKeyBytes) {
    const members = await getRoomEncryptionMembers(roomId);
    const myPrivB64 = localStorage.getItem('nyxie_private_key_' + currentUser.id);
    if (!myPrivB64) throw new Error('Your encryption key is unavailable on this device');
    const myPriv = base64ToUint8Array(myPrivB64);
    if (!myPriv) throw new Error('Your encryption key is invalid');
    const envelopes = {};
    for (const member of members) {
      if (!member.public_key) throw new Error(`Encryption key unavailable for ${member.display_name || member.username || 'a group member'}`);
      const pub = base64ToUint8Array(member.public_key);
      if (!pub) throw new Error('A recipient has an invalid encryption key');
      const shared = nacl.box.before(pub, myPriv);
      const nonce = nacl.randomBytes(24);
      const wrapped = nacl.secretbox(secretKeyBytes, nonce, shared);
      envelopes[member.id] = { ciphertext: uint8ArrayToBase64(wrapped), nonce: uint8ArrayToBase64(nonce) };
    }
    return envelopes;
  }

  async function unwrapRoomKey(roomId, envelopes, senderId = currentUser.id) {
    const env = getEnvelopeForUser(envelopes, currentUser.id);
    if (!env) return null;
    const myPrivB64 = localStorage.getItem('nyxie_private_key_' + currentUser.id);
    if (!myPrivB64) return null;
    const myPriv = base64ToUint8Array(myPrivB64);
    const members = await getRoomEncryptionMembers(roomId);
    const sender = members.find(m => m.id === senderId) || members.find(m => m.id === currentUser.id);
    if (!sender?.public_key) return null;
    const senderPub = base64ToUint8Array(sender.public_key);
    if (!senderPub || !myPriv) return null;
    const shared = deriveSharedKey(senderPub, myPriv);
    return nacl.secretbox.open(base64ToUint8Array(env.ciphertext), base64ToUint8Array(env.nonce), shared) || null;
  }

  async function encryptRoomText(plaintext, roomId) {
    const key = nacl.randomBytes(32);
    const nonce = nacl.randomBytes(24);
    const encrypted = nacl.secretbox(nacl.util.decodeUTF8(plaintext), nonce, key);
    const key_envelopes = await createKeyEnvelopes(roomId, key);
    return { ciphertext: uint8ArrayToBase64(encrypted), nonce: uint8ArrayToBase64(nonce), key_envelopes };
  }

  async function decryptRoomText(ciphertextB64, nonceB64, keyEnvelopes, roomId, senderId = currentUser.id) {
    if (!ciphertextB64 || !nonceB64) return null;
    if (keyEnvelopes) {
      const key = await unwrapRoomKey(roomId, keyEnvelopes, senderId);
      if (key) {
        const opened = nacl.secretbox.open(base64ToUint8Array(ciphertextB64), base64ToUint8Array(nonceB64), key);
        if (opened) return nacl.util.encodeUTF8(opened);
      }
    }
    // Backward compatibility for older 1-to-1 messages that used the
    // original static Diffie-Hellman room key scheme.
    const sharedKey = await getSharedKeyForRoomLegacy(roomId);
    return sharedKey ? decryptMessage(ciphertextB64, nonceB64, sharedKey) : null;
  }

  async function getSharedKeyForRoomLegacy(roomId) {
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

  async function getSharedKeyForRoom(roomId) {
    return getSharedKeyForRoomLegacy(roomId);
  }
  window.nyxieGetRoomEncryptionMembers = getRoomEncryptionMembers;

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

  async function decryptDmPreview(content, nonce, otherId, otherPublicKey, roomId, keyEnvelopes, senderId) {
    if (!content) return '';
    if (!nonce) return content;
    const roomIdToUse = roomId || currentRoom?.id;
    if (keyEnvelopes && roomIdToUse) {
      const decrypted = await decryptRoomText(content, nonce, keyEnvelopes, roomIdToUse, senderId || otherId || currentUser.id);
      if (decrypted !== null) return decrypted;
    }
    const pub = otherPublicKey || (otherId ? await getPublicKey(otherId) : null);
    const priv = localStorage.getItem('nyxie_private_key_' + currentUser.id);
    if (!pub || !priv) return 'Encrypted message';
    const sharedKey = deriveSharedKey(pub, priv);
    if (!sharedKey) return 'Shared key failed';
    const decrypted = decryptMessage(content, nonce, sharedKey);
    return decrypted !== null ? decrypted : 'Encrypted message';
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
      } else if (dm.is_group) {
        dm._avatar = dm.icon || null;
      }
      if (dm.last_message_nonce) {
        let preview = await decryptDmPreview(dm.last_message, dm.last_message_nonce, dm._otherId, otherPublicKey, dm.id, dm.last_message_key_envelopes, dm.last_message_user_id);
        if (!preview) preview = 'Attachment';
        dm.last_message = preview;
      } else if (dm.last_message_at) {
        // There was a last message but it has no content (e.g. attachment-only)
        dm.last_message = dm.last_message || 'Attachment';
      }
    }));
    dms = fresh;
    renderDMList();
    dms.forEach(d => wsJoin(d.id));
  }

  // Small stroke-style icon prefixes for the fixed status labels that
  // stand in for dm.last_message (see loadDMs / decryptDmPreview / the
  // WS handler above) when there's no plaintext to show — matched
  // exactly, not by substring, so real message text starting with the
  // same words is never mistaken for one of these.
  const DM_PREVIEW_ICONS = {
    'Voice message': '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"/><path d="M19 11a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.92V20H9a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2h-2v-2.08A7 7 0 0 0 19 11z"/></svg>',
    'Attachment': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 1 1 4.24 4.24L9.41 17.41a1 1 0 0 1-1.41-1.41l8.49-8.49"/></svg>',
    'Encrypted message': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    'Shared key failed': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
  };

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
      const previewIcon = dm.last_message ? DM_PREVIEW_ICONS[dm.last_message] : null;
      const preview = dm.last_message
        ? (previewIcon
          ? `<span style="display:inline-flex;align-items:center;gap:4px;">${previewIcon}${escapeHtml(dm.last_message)}</span>`
          : escapeHtml(dm.last_message.slice(0, 50)))
        : '<i style="color:var(--text-muted)">No messages yet</i>';
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
          ${dm.is_group ? '' : `<div class="status-pip ${pipClass(status)}" data-uid-pip="${dm._otherId||''}"></div>`}
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
      if (text) text.textContent = status === 'offline' ? 'offline' : presenceLabel(status).toLowerCase();
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
          ${isImage ? `<img src="${thumb}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;" />` : `<span style="display:inline-flex;color:var(--text-muted);"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 1 1 4.24 4.24L9.41 17.41a1 1 0 0 1-1.41-1.41l8.49-8.49"/></svg></span>`}
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

  function highlightJumpTarget(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('search-current');
    setTimeout(() => el.classList.remove('search-current'), 1200);
  }

  // Jumping to a reply's original message. The happy path (original is
  // already rendered — it's recent, or arrived live over the websocket
  // since) is synchronous. When it isn't in the DOM — it's older than the
  // page of messages the room loaded with — we page backwards from the
  // original's own timestamp (carried on every reply preview, see
  // resolveReplyTo server-side) until it's loaded, then jump. No reload
  // needed either way.
  let _jumpToken = 0;
  async function jumpToMessage(msgId) {
    const existing = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (existing) { highlightJumpTarget(existing); return; }

    const anchor = window._messagesById.get(msgId);
    if (!currentRoom || !anchor || !anchor.created_at) {
      toast('Original message not loaded');
      return;
    }

    if (_loadingOlder) { toast('Already jumping to a message…'); return; }
    const token = ++_jumpToken;
    toast('Jumping to message…');
    const found = await loadOlderMessagesUntil(msgId, anchor.created_at);
    if (token !== _jumpToken) return; // superseded by a newer jump/room switch

    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (el) highlightJumpTarget(el);
    else toast(found === null ? 'Could not load original message' : 'Original message not loaded');
  }

  // Pages backwards (server's `before` cursor, see GET /rooms/:id/messages)
  // from just after the target's timestamp, prepending each batch above
  // whatever's currently loaded, until the target message shows up or
  // there's nothing older left. Returns true if found, false if the room
  // ran out of history, or null on a request failure.
  let _loadingOlder = false;
  async function loadOlderMessagesUntil(targetId, targetCreatedAt) {
    if (_loadingOlder) return false;
    _loadingOlder = true;
    const roomId = currentRoom.id;
    try {
      let before = targetCreatedAt + 1;
      for (let i = 0; i < 10; i++) { // safety cap: ~500 messages of backscroll
        if (!currentRoom || currentRoom.id !== roomId) return false; // room changed under us
        const data = await api('GET', `/rooms/${roomId}/messages?before=${before}&limit=50`);
        if (!data?.messages) return null;
        const batch = data.messages;
        if (!batch.length) return false;
        await prependMessages(batch);
        if (batch.some(m => m.id === targetId)) return true;
        before = batch[0].created_at;
      }
      return false;
    } finally {
      _loadingOlder = false;
    }
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

    // Encrypt the text first so a missing recipient key cannot leave
    // orphaned encrypted uploads on the server.
    let payload = {};
    if (plaintext) {
      try {
        payload = await encryptRoomText(plaintext, currentRoom.id);
      } catch (e) {
        toast(`Encryption failed: ${e.message || 'recipient key unavailable'}`);
        input.value = plaintext;
        return;
      }
    }

    // ─── Encrypt and upload pending files ─────────────────────
    // Private DMs/groups and server channels all upload ciphertext. The
    // file key is random per attachment and wrapped separately for every
    // current room member. The upload endpoint therefore never receives
    // the original file bytes.
    const uploadedFiles = [];
    for (const file of pendingFiles) {
      try {
        const raw = new Uint8Array(await file.arrayBuffer());
        const fileKey = nacl.randomBytes(32);
        const fileNonce = nacl.randomBytes(24);
        const encryptedBytes = nacl.secretbox(raw, fileNonce, fileKey);
        const key_envelopes = await createKeyEnvelopes(currentRoom.id, fileKey);
        const encryptedBlob = new Blob([encryptedBytes], { type: 'application/octet-stream' });
        const formData = new FormData();
        formData.append('file', encryptedBlob, `${file.name}.nx`);
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: formData
        });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || 'Upload failed');
        uploadedFiles.push({
          name: file.name,
          url: data.url,
          type: file.type || 'application/octet-stream',
          encrypted: true,
          nonce: uint8ArrayToBase64(fileNonce),
          key_envelopes
        });
      } catch (e) {
        console.error('[E2EE upload] Error:', e);
        toast(`Encrypted upload failed for ${file.name}: ${e.message || 'unknown error'}`);
      }
    }
    pendingFiles = [];
    renderAttachmentPreviews();

    // ─── Build message payload ──────────────────────────────────
    if (uploadedFiles.length) payload.attachments = uploadedFiles;

    // Resolved from the plaintext we just encrypted (or the plain content,
    // in an unencrypted room) — sent as its own field since the server
    // can't parse @mentions out of ciphertext itself. See resolveMentions().
    if (plaintext) {
      const mentionIds = resolveMentions(plaintext);
      if (mentionIds.length) payload.mentions = mentionIds;
    }

    // Only the id goes over the wire — the server resolves the author and
    // content itself (and stores just the id), so a reply never requires
    // shipping a plaintext snippet of an otherwise end-to-end-encrypted
    // message.
    if (replyingTo) {
      payload.reply_to_id = replyingTo.id;
    }

    console.log('[Send] Payload:', payload);
    const res = await api('POST', `/rooms/${currentRoom.id}/messages`, payload);
    if (res?.error) { toast(res.error); return; }
    if (res.message?.id) sentMsgIds.add(res.message.id);
    // res.message already carries the server-resolved reply_to_id/reply_to
    // (see POST /rooms/:id/messages) — no client-side patching needed.
    if (!_roomHasMessages) {
      document.getElementById('messages-container').innerHTML = '';
      _roomHasMessages = true;
    }
    cancelReply();
    await appendMessage(res.message);
    scrollToBottom();
    const dmObj = dms.find(d => d.id === currentRoom.id);
    if (dmObj) {
      dmObj.last_message = plaintext || 'Attachment';
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
    // Prefer the live cached copy — it reflects anything that's happened
    // to that message since (edits, deletes) — and fall back to the
    // server-resolved snapshot that came down attached to this message
    // (msg.reply_to) for when the original isn't otherwise loaded. Both
    // are already decrypted by this point (see the appendMessage
    // wrapper), so this never touches raw ciphertext.
    const original = window._messagesById.get(msg.reply_to_id) || msg.reply_to;
    const author = original ? (original.display_name || original.username || 'Unknown') : 'Unknown';
    const snippet = original ? (original.deleted ? 'Message deleted' : (original.content || 'Original message')) : 'Original message';
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

  function openImageLightbox(src, alt = 'Image') {
    if (!src) return;
    let modal = document.getElementById('nyxie-image-lightbox');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'nyxie-image-lightbox';
      modal.className = 'nyxie-image-lightbox';
      modal.innerHTML = `
        <button class="nyxie-image-lightbox-close" type="button" aria-label="Close image">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <div class="nyxie-image-lightbox-backdrop"></div>
        <img class="nyxie-image-lightbox-img" alt="" />`;
      document.body.appendChild(modal);
      const close = () => {
        modal.classList.remove('open');
        document.body.classList.remove('image-lightbox-open');
      };
      modal.querySelector('.nyxie-image-lightbox-close').addEventListener('click', close);
      modal.querySelector('.nyxie-image-lightbox-backdrop').addEventListener('click', close);
      modal.querySelector('.nyxie-image-lightbox-img').addEventListener('click', e => e.stopPropagation());
      modal._close = close;
    }
    const image = modal.querySelector('.nyxie-image-lightbox-img');
    image.src = src;
    image.alt = alt || 'Image';
    modal.classList.add('open');
    document.body.classList.add('image-lightbox-open');
  }

  function closeImageLightbox() {
    const modal = document.getElementById('nyxie-image-lightbox');
    if (modal?._close) modal._close();
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeImageLightbox();
  });

  function buildAttachmentsHtml(msg) {
    if (msg.deleted || !msg.attachments || !msg.attachments.length) return '';
    let html = '<div class="msg-attachments" style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">';
    msg.attachments.forEach((a, i) => {
      if (a.encrypted) {
        html += `<div class="msg-attachment-e2ee" data-attachment-index="${i}" style="min-height:48px;display:flex;align-items:center;color:var(--text-muted);font-size:.85rem;">Decrypting encrypted attachment…</div>`;
        return;
      }
      if (a.type && a.type.startsWith('image/')) {
        html += `<img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}" loading="lazy" decoding="async" style="max-width:320px;max-height:240px;min-height:48px;min-width:48px;border-radius:8px;object-fit:cover;background:var(--bg-tertiary);cursor:pointer;" onload="handleMsgImageSettled(this)" onerror="handleMsgImageError(this)" onclick="openImageLightbox(this.src, this.alt); event.stopPropagation();" />`;
      } else {
        html += `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:.85rem;display:inline-flex;align-items:center;gap:4px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 1 0 4.24 4.24L9.41 17.41a1 1 0 1 0-1.41-1.41l8.49-8.49"/></svg>${escapeHtml(a.name)}</a>`;
      }
    });
    html += '</div>';
    return html;
  }

  async function decryptAttachmentForRow(msg, row) {
    if (!msg.attachments?.length || msg.deleted) return;
    const holder = row.querySelector('.msg-attachments');
    if (!holder) return;
    row._objectUrls = row._objectUrls || [];
    for (let i = 0; i < msg.attachments.length; i++) {
      const a = msg.attachments[i];
      if (!a.encrypted) continue;
      const slot = holder.querySelector(`[data-attachment-index="${i}"]`);
      if (!slot) continue;
      try {
        const key = await unwrapRoomKey(msg.room_id, a.key_envelopes, msg.user_id);
        if (!key) throw new Error('key unavailable');
        const response = await fetch(a.url, { cache: 'force-cache' });
        if (!response.ok) throw new Error('download failed');
        const ciphertext = new Uint8Array(await response.arrayBuffer());
        const plaintext = nacl.secretbox.open(ciphertext, base64ToUint8Array(a.nonce), key);
        if (!plaintext) throw new Error('decrypt failed');
        const blob = new Blob([plaintext], { type: a.type || 'application/octet-stream' });
        const objectUrl = URL.createObjectURL(blob);
        row._objectUrls.push(objectUrl);
        if (a.type?.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = objectUrl;
          img.alt = a.name || 'Image';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.style.cssText = 'max-width:320px;max-height:240px;min-height:48px;min-width:48px;border-radius:8px;object-fit:cover;background:var(--bg-tertiary);cursor:pointer;';
          img.addEventListener('load', () => handleMsgImageSettled(img));
          img.addEventListener('error', () => handleMsgImageError(img));
          img.addEventListener('click', e => { e.stopPropagation(); openImageLightbox(objectUrl, a.name || 'Image'); });
          slot.replaceWith(img);
        } else {
          const link = document.createElement('a');
          link.href = objectUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = a.name || 'Download attachment';
          link.style.cssText = 'color:var(--accent);font-size:.85rem;display:inline-flex;align-items:center;gap:4px;';
          slot.replaceWith(link);
        }
      } catch (e) {
        slot.textContent = 'Unable to decrypt attachment';
        slot.style.color = 'var(--text-muted)';
      }
    }
  }

  function revokeRowObjectUrls(row) {
    if (!row?._objectUrls) return;
    for (const url of row._objectUrls) URL.revokeObjectURL(url);
    row._objectUrls = [];
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

  // Builds the row element for one message (assumes msg.content /
  // msg.reply_to.content are already decrypted). Shared by the bottom-
  // append path (new/initial messages) and the top-prepend path (older
  // messages paged in via jumpToMessage) so both render identically.
  function buildMessageRowEl(msg, compact) {
    const isOwn = msg.user_id === currentUser.id;
    const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const fullTime = new Date(msg.created_at).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
    if (compact) {
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
            ${Badges.slot(msg.user_id, { size: 'sm' })}
            <span class="msg-timestamp" title="${fullTime}">${timeStr}</span>
          </div>
          ${replyHtml}
          <span class="msg-text${msg.deleted ? ' deleted' : ''}">${textHtml}</span>
          ${attachmentsHtml}
          ${reactionsHtml}
        </div>
        ${actionsHtml}`;
    }
    return row;
  }

  function buildDateDividerEl(label) {
    const div = document.createElement('div');
    div.className = 'msg-date-divider';
    div.innerHTML = `<span>${label}</span>`;
    return div;
  }

  function dateLabelFor(ts) {
    const d = new Date(ts).toDateString();
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    return d === today ? 'Today' : d === yesterday ? 'Yesterday' : new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  appendMessage = function (msg) {
    const container = document.getElementById('messages-container');
    if (msg.id && container.querySelector(`[data-msg-id="${msg.id}"]`)) return;
    window._messagesById.set(msg.id, msg);
    const msgDate = new Date(msg.created_at).toDateString();
    if (msgDate !== window._lastMsgDate) {
      window._lastMsgDate = msgDate;
      container.appendChild(buildDateDividerEl(dateLabelFor(msg.created_at)));
      window._lastMsgUserId = null;
    }
    const now = msg.created_at;
    const compact = msg.user_id === window._lastMsgUserId && (now - window._lastMsgTime) < 5 * 60 * 1000 && !msg.reply_to_id;
    window._lastMsgUserId = msg.user_id;
    window._lastMsgTime = now;
    const row = buildMessageRowEl(msg, compact);
    container.appendChild(row);
    decryptAttachmentForRow(msg, row).catch(() => {});
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
  // Decrypts msg.content and msg.reply_to.content in place. Shared by the
  // bottom-append path and prependMessages (used when paging in older
  // messages to jump to a reply target) so both decrypt identically.
  async function decryptMsgForDisplay(msg, retry = false) {
    let displayContent = msg.content;
    if (msg.nonce) {
      const decrypted = await decryptRoomText(msg.content, msg.nonce, msg.key_envelopes, msg.room_id, msg.user_id);
      if (decrypted !== null) displayContent = decrypted;
      else if (!retry) {
        await new Promise(r => setTimeout(r, 300));
        const decrypted2 = await decryptRoomText(msg.content, msg.nonce, msg.key_envelopes, msg.room_id, msg.user_id);
        displayContent = decrypted2 !== null ? decrypted2 : '🔒 Failed to decrypt';
      } else displayContent = '🔒 Failed to decrypt';
    }
    // Leave msg.content set to the decrypted plaintext (don't revert to
    // ciphertext) — the message object is stored by reference in
    // window._messagesById (see originalAppendMessage / prependMessages),
    // and other code that looks it up later — reply quotes, the
    // reply-preview bar, editing — all read msg.content expecting
    // plaintext.
    msg.content = displayContent;

    // msg.reply_to (server-resolved, see POST/GET /rooms/:id/messages)
    // carries the *original* message's own content+nonce — decrypt it
    // the same way, in place, so buildReplyQuoteHtml can just read
    // msg.reply_to.content like any other decrypted message, whether or
    // not the original happens to already be in window._messagesById.
    if (msg.reply_to && msg.reply_to.nonce) {
      const replyDecrypted = await decryptRoomText(msg.reply_to.content, msg.reply_to.nonce, msg.reply_to.key_envelopes, msg.room_id, msg.reply_to.user_id);
      msg.reply_to.content = replyDecrypted !== null ? replyDecrypted : '🔒 Failed to decrypt';
    }
    // Cache a stub for the replied-to message so jumpToMessage has a
    // created_at anchor to page backwards from even when the original
    // itself has never been loaded into this room yet.
    if (msg.reply_to && msg.reply_to.id && !window._messagesById.has(msg.reply_to.id)) {
      window._messagesById.set(msg.reply_to.id, msg.reply_to);
    }
    return msg;
  }

  let _appendMsgQueue = Promise.resolve();
  appendMessage = function(msg, retry = false) {
    const run = async () => {
      await decryptMsgForDisplay(msg, retry);
      originalAppendMessage.call(this, msg);
    };
    // .then(run, run) so one failed append doesn't wedge every append after it.
    _appendMsgQueue = _appendMsgQueue.then(run, run);
    return _appendMsgQueue;
  };

  // Pages older messages in at the TOP of the container (see
  // loadOlderMessagesUntil, used by jumpToMessage). `batch` is oldest→
  // newest, matching what GET /rooms/:id/messages returns. Grouping
  // (date dividers, compact same-author rows) is computed locally within
  // the batch — it doesn't reach back into window._lastMsgDate/_lastMsgUserId,
  // since those track the *bottom* of the timeline and prepending happens
  // at the top; the only seam this can miss is the boundary row right
  // below the inserted batch not being retroactively marked compact,
  // which is a cosmetic no-op, not a correctness issue.
  async function prependMessages(batch) {
    const container = document.getElementById('messages-container');
    const fresh = [];
    for (const raw of batch) {
      if (container.querySelector(`[data-msg-id="${raw.id}"]`)) continue; // already loaded
      await decryptMsgForDisplay(raw);
      fresh.push(raw);
    }
    if (!fresh.length) return;

    const frag = document.createDocumentFragment();
    let lastDate = null, lastUserId = null, lastTime = 0;
    for (const msg of fresh) {
      const msgDate = new Date(msg.created_at).toDateString();
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        frag.appendChild(buildDateDividerEl(dateLabelFor(msg.created_at)));
        lastUserId = null;
      }
      const compact = msg.user_id === lastUserId && (msg.created_at - lastTime) < 5 * 60 * 1000 && !msg.reply_to_id;
      lastUserId = msg.user_id;
      lastTime = msg.created_at;
      const row = buildMessageRowEl(msg, compact);
      frag.appendChild(row);
      decryptAttachmentForRow(msg, row).catch(() => {});
      window._messagesById.set(msg.id, msg);
    }
    // Preserve scroll position: without this, inserting content above the
    // viewport would yank the visible messages downward.
    const prevHeight = container.scrollHeight;
    const prevTop = container.scrollTop;
    container.insertBefore(frag, container.firstChild);
    container.scrollTop = prevTop + (container.scrollHeight - prevHeight);
  }

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
        let patchPayload = { content: newContent };
        try { patchPayload = await encryptRoomText(newContent, currentRoom.id); } catch (e) { toast(`Encryption failed: ${e.message || 'recipient key unavailable'}`); return; }
        if (msg) { msg.content = newContent; msg.nonce = patchPayload.nonce; msg.key_envelopes = patchPayload.key_envelopes; }
        const span = document.createElement('span');
        span.className = 'msg-text';
        span.innerHTML = `${escapeHtml(newContent)}<span class="edited-tag">(edited)</span>`;
        wrapper.replaceWith(span);
        await api('PATCH', `/rooms/${currentRoom.id}/messages/${msgId}`, patchPayload);
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
  // Ctrl/Cmd+V with an image on the clipboard (e.g. a screenshot) never
  // had a handler — the browser has nowhere to put image data inside a
  // text <input>, so it silently did nothing. Route any pasted image(s)
  // through the same pendingFiles/handleFileUpload path as the file-input
  // and drag-and-drop attachments use, so they show up as an attachment
  // chip ready to send. Pasted text is left completely alone.
  document.getElementById('msg-input').addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length) {
      e.preventDefault();
      handleFileUpload(imageFiles);
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
    _profileUserId = userId;
    const rect = event.target.getBoundingClientRect();
    const popoutWidth = 300;
    const popoutHeight = 360; // rough estimate; clamped against viewport below
    let finalLeft = rect.left;
    let finalTop = rect.bottom + 8;
    if (finalLeft + popoutWidth > window.innerWidth - 16) finalLeft = window.innerWidth - popoutWidth - 16;
    if (finalTop + popoutHeight > window.innerHeight - 16) {
      // Not enough room below — try opening upward from the trigger instead.
      const above = rect.top - popoutHeight - 8;
      finalTop = above >= 16 ? above : Math.max(16, window.innerHeight - popoutHeight - 16);
    }
    if (finalLeft < 16) finalLeft = 16;
    popout.style.left = finalLeft + 'px';
    popout.style.top = finalTop + 'px';
    popout.style.display = 'block';
    popout.classList.remove('pp-open'); void popout.offsetWidth; popout.classList.add('pp-open');
    document.getElementById('up-name-display').textContent = 'Loading…';
    document.getElementById('up-username-display').textContent = '';
    document.getElementById('up-bio-display').style.display = 'none';
    document.getElementById('up-pronouns-display').style.display = 'none';
    document.getElementById('up-badges-display').style.display = 'none';
    const avatarEl = document.getElementById('up-avatar-large');
    avatarEl.innerHTML = '…';
    avatarEl.style.background = '#fd6671';
    try {
      const data = await api('GET', `/users/${userId}`);
      if (!data?.user) { toast('User not found'); closeUserProfilePopout(); return; }
      const user = data.user;
      document.getElementById('up-name-display').textContent = user.display_name || user.username;
      document.getElementById('up-username-display').textContent = '@' + user.username;
      const bioEl = document.getElementById('up-bio-display');
      if (user.bio) { bioEl.textContent = user.bio; bioEl.style.display = 'block'; } else { bioEl.style.display = 'none'; bioEl.textContent = ''; }
      const pronounsEl = document.getElementById('up-pronouns-display');
      if (user.pronouns) { pronounsEl.textContent = user.pronouns; pronounsEl.style.display = 'inline'; } else { pronounsEl.style.display = 'none'; pronounsEl.textContent = ''; }
      renderProfileBadges(document.getElementById('up-badges-display'), user);
      Badges.refresh(user.id); // always current when a profile is opened
      // Cosmetic only — the /api/admin/badges endpoints enforce admin server-side.
      document.getElementById('up-manage-badges-btn').style.display = currentUser.role === 'ADMIN' ? '' : 'none';
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
      pip.className = 'up-avatar-status ' + pipClass(status);
      pip.setAttribute('aria-label', presenceLabel(status));
    } catch (err) { toast('Failed to load profile'); closeUserProfilePopout(); }
  }
  function closeUserProfilePopout() {
    const popout = document.getElementById('user-profile-popout');
    popout.style.display = 'none';
    popout.classList.remove('pp-open');
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const up = document.getElementById('user-profile-popout');
    if (up.style.display === 'block') { closeUserProfilePopout(); return; }
    const pp = document.getElementById('profile-popout');
    if (pp.style.display === 'block') {
      const sub = document.getElementById('pp-status-submenu');
      if (sub.style.display === 'block') { toggleStatusMenu(); return; }
      toggleProfilePopout();
    }
  });

  // Profile badge row (self + other-user popouts). Ownership and appearance
  // both come from the badge system (js/badges.js ← /api/badges/*), which is
  // server-controlled — nothing about who has which badge is decided here.
  // The row collapses when the user has none, as before.
  function renderProfileBadges(container, user) {
    Badges.renderInto(container, user.id, { size: 'md', container: true });
  }

  // ─── SELF PROFILE, STATUS, EDIT PROFILE ──────────────────
  // Keeps the bottom-left user panel in sync with the chosen status: the pip
  // on the avatar plus a text label under the name, so you can see your
  // status without opening the profile popout.
  function updateUserPanelStatus(status) {
    const pip = document.getElementById('up-status-pip');
    if (pip) { pip.className = pipClass(status); pip.setAttribute('aria-label', presenceLabel(status)); }
    const tag = document.getElementById('up-tag');
    if (tag) tag.textContent = presenceLabel(status);
    const info = document.getElementById('up-info');
    if (info && currentUser) info.title = '@' + currentUser.username;
  }
  async function setStatus(status) {
    document.getElementById('pp-status-submenu').style.display = 'none';
    document.getElementById('pp-status-menu-row').setAttribute('aria-expanded', 'false');
    document.querySelectorAll('.pp-sub-btn').forEach(b => {
      const active = b.dataset.status === status;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
    const curDot = document.getElementById('pp-cur-dot');
    if (curDot) curDot.className = `pp-dot ${pipClass(status)}`;
    document.getElementById('pp-cur-label').textContent = presenceLabel(status);
    updateUserPanelStatus(status);
    document.getElementById('pp-avatar-status').className = `pp-avatar-status ${pipClass(status)}`;
    localStorage.setItem('nyxie_status', status);
    currentUser._status = status;
    currentUser.status = status;
    await api('PATCH', '/users/status', { status });
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'set_status', status }));
    toast('Status updated');
  }
  // Applies a status change that arrived from elsewhere — another one of
  // this user's own open tabs/devices, via the 'self_status' WS message —
  // without re-sending it back out. Keeps this session's UI in sync
  // (showing "Invisible" rather than the "offline" other people see)
  // without a refresh.
  function applySelfStatus(status) {
    currentUser._status = status;
    currentUser.status = status;
    localStorage.setItem('nyxie_status', status);
    const curDot = document.getElementById('pp-cur-dot');
    if (curDot) curDot.className = `pp-dot ${pipClass(status)}`;
    const curLabel = document.getElementById('pp-cur-label');
    if (curLabel) curLabel.textContent = presenceLabel(status);
    document.querySelectorAll('.pp-sub-btn').forEach(b => {
      const active = b.dataset.status === status;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
    updateUserPanelStatus(status);
    const ppAvatarStatus = document.getElementById('pp-avatar-status');
    if (ppAvatarStatus) ppAvatarStatus.className = `pp-avatar-status ${pipClass(status)}`;
  }
  function toggleStatusMenu() {
    const sub = document.getElementById('pp-status-submenu');
    const row = document.getElementById('pp-status-menu-row');
    const open = sub.style.display !== 'block';
    sub.style.display = open ? 'flex' : 'none';
    row.setAttribute('aria-expanded', String(open));
  }
  function toggleProfilePopout() {
    const pp = document.getElementById('profile-popout');
    if (pp.style.display === 'block') { pp.style.display = 'none'; pp.classList.remove('pp-open'); return; }
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
    const pronounsEl = document.getElementById('pp-pronouns');
    if (currentUser.pronouns) { pronounsEl.textContent = currentUser.pronouns; pronounsEl.style.display = 'inline'; } else { pronounsEl.style.display = 'none'; pronounsEl.textContent = ''; }
    renderProfileBadges(document.getElementById('pp-badges'), currentUser);
    const bioEl = document.getElementById('pp-bio');
    if (currentUser.bio) { bioEl.textContent = currentUser.bio; bioEl.style.display = 'block'; } else { bioEl.style.display = 'none'; bioEl.textContent = ''; }
    const bannerEl = document.getElementById('pp-banner');
    if (currentUser.banner) bannerEl.style.background = `url("${versionedMediaUrl(currentUser.banner)}") center/cover no-repeat`;
    else if (currentUser.banner_color) bannerEl.style.background = currentUser.banner_color;
    else bannerEl.style.background = `linear-gradient(135deg, ${hashColor(currentUser.username)}, #fd6671)`;
    const curStatus = currentUser._status || currentUser.status || 'online';
    const curDot = document.getElementById('pp-cur-dot');
    if (curDot) curDot.className = `pp-dot ${pipClass(curStatus)}`;
    document.getElementById('pp-cur-label').textContent = presenceLabel(curStatus);
    document.querySelectorAll('.pp-sub-btn').forEach(b => {
      const active = b.dataset.status === curStatus;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
    document.getElementById('pp-avatar-status').className = `pp-avatar-status ${pipClass(curStatus)}`;
    document.getElementById('pp-status-submenu').style.display = 'none';
    document.getElementById('pp-status-menu-row').setAttribute('aria-expanded', 'false');
    pp.style.display = 'block';
    pp.classList.remove('pp-open'); void pp.offsetWidth; pp.classList.add('pp-open');
  }
  function copyUserId(id) {
    navigator.clipboard.writeText(id || currentUser.id).then(() => toast('User ID copied!'));
  }
  // Inline onclick attributes run in global scope and can't see
  // _profileUserId (a closure-scoped variable in this IIFE), so the
  // "Copy User ID" button on another user's popout goes through this
  // small wrapper instead of referencing _profileUserId directly.
  function copyProfileUserId() { copyUserId(_profileUserId); }
  // Admin shortcut: profile → Manage Badges. Opens the Admin panel's Badges
  // tab with this user already selected (see initAdminPanel in admin.js).
  function manageBadgesFromProfile() {
    if (!_profileUserId || currentUser.role !== 'ADMIN') return;
    window._adminInitialTab = 'badges';
    window._adminInitialBadgeUser = _profileUserId;
    closeUserProfilePopout();
    navigateTo('admin');
  }
  function openEditProfileModal() {
    const modal = document.getElementById('edit-profile-modal');
    modal.style.display = 'flex';
    document.getElementById('edit-username').value = currentUser.username || '';
    document.getElementById('edit-displayname').value = currentUser.display_name || '';
    document.getElementById('edit-pronouns').value = currentUser.pronouns || '';
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
    const pronouns = document.getElementById('edit-pronouns').value.trim();
    const bio = document.getElementById('edit-bio').value.trim();
    const current_password = document.getElementById('edit-current-password').value;
    const new_password = document.getElementById('edit-new-password').value;
    const confirm_password = document.getElementById('edit-confirm-password').value;
    if (!username || username.length < 3 || username.length > 30 || !/^[a-zA-Z0-9_-]+$/.test(username)) { toast('Invalid username'); return; }
    if (display_name && display_name.length > 64) { toast('Display name too long'); return; }
    if (pronouns && pronouns.length > 40) { toast('Pronouns too long (max 40 chars)'); return; }
    if (bio && bio.length > 500) { toast('Bio too long'); return; }
    if (new_password && new_password !== confirm_password) { toast('Passwords do not match'); return; }
    if (new_password && new_password.length < 8) { toast('New password must be at least 8 characters'); return; }
    if (new_password && !current_password) { toast('Current password is required to change password'); return; }
    const payload = {};
    if (username !== currentUser.username) payload.username = username;
    if (display_name !== currentUser.display_name) payload.display_name = display_name;
    if (pronouns !== (currentUser.pronouns || '')) payload.pronouns = pronouns;
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
        currentUser.pronouns = data.user.pronouns;
        currentUser.bio = data.user.bio;
        localStorage.setItem('nyxie_user', JSON.stringify(currentUser));
        document.getElementById('up-name').textContent = currentUser.display_name || currentUser.username;
        updateUserPanelStatus(currentUser._status || currentUser.status || 'online');
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
    // "Online" means visible/available — everyone who isn't Invisible (or
    // truly disconnected). The server already masks a friend's status to
    // 'offline' in exactly those two cases (see effectiveStatus in
    // server/services/presence.js), so Idle and DND friends correctly
    // stay in this tab; only literally-offline/invisible friends drop out.
    if (currentFriendsTab === 'online') list = list.filter(f => (f.status || 'offline') !== 'offline');
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
          <div class="fr-name-row">
            <div class="fr-name">${escapeHtml(name)}</div>
            ${Badges.slot(f.id, { size: 'xs', max: 3 })}
          </div>
          <div class="fr-sub">@${escapeHtml(f.username)} · ${presenceLabel(f.status||'offline').toLowerCase()}</div>
        </div>
        <div class="fr-actions">
          <button class="fr-btn" onclick="event.stopPropagation();messageFriend('${f.id}','${escapeJs(name)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
          </button>
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
      // The server's persisted preference is authoritative (see
      // server/services/presence.js) — trust it over whatever's cached in
      // localStorage, which was only ever meant as an optimistic local
      // copy. This is what lets a manually-picked DND/Idle/Invisible
      // survive a page refresh instead of quietly reverting to Online.
      currentUser._status = STATUSES.includes(currentUser.status) ? currentUser.status : 'online';
      localStorage.setItem('nyxie_status', currentUser._status);
      const name = currentUser.display_name || currentUser.username;
      const letter = name[0].toUpperCase();
      const color = hashColor(name);
      const upAvatar = document.getElementById('up-avatar');
      if (currentUser.avatar) upAvatar.innerHTML = `<img src="${versionedMediaUrl(currentUser.avatar)}" style="width:100%;height:100%;object-fit:cover;" />`;
      else { upAvatar.textContent = letter; upAvatar.style.background = color; }
      document.getElementById('up-name').textContent = name;
      updateUserPanelStatus(currentUser._status);
      // Cosmetic only — hides the nav link for non-admins so it doesn't
      // invite clicks that just bounce back (see router.js's 'admin'
      // auth guard and navigateTo('admin') above for the actual gate).
      document.getElementById('nav-admin').style.display = currentUser.role === 'ADMIN' ? 'flex' : 'none';
      try { await ensureE2EEKeys(); } catch (e) { console.error('E2EE key setup failed:', e); toast('⚠️ Encryption setup failed — messages will send unencrypted'); }
      connectWS();
      if (typeof initVoiceFeatures === 'function') { try { initVoiceFeatures(); } catch (e) { console.error('Voice feature init failed:', e); } }
      await loadDMs();
      await loadFriendsData();
      await loadServers();
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
      } else if (window._initialServerId) {
        // Set by router.js's '/servers/:serverId' or
        // '/servers/:serverId/channels/:channelId' route — lets a direct
        // navigation, page refresh, or browser back/forward land back on
        // that exact guild/channel instead of resetting to home.
        const serverId = window._initialServerId;
        const channelId = window._initialChannelId;
        window._initialServerId = null;
        window._initialChannelId = null;
        if (servers.find(s => s.id === serverId)) {
          selectServer(serverId, { fromRoute: true, initialChannelId: channelId });
        } else {
          // Deep link to a server we're not a member of (or that no
          // longer exists) — fall back to home rather than getting stuck
          // on a broken server URL.
          toast('Server not found');
          window.history.replaceState({}, '', '/app');
          navigateTo('home');
        }
      } else {
        if (window._initialSection === 'discover') {
          const cat = window._initialDiscoverCategory;
          window._initialDiscoverCategory = null;
          window._initialSection = null;
          showDiscoverView({ fromRoute: true, category: cat });
        } else {
          navigateTo(window._initialSection || 'home');
          window._initialSection = null;
        }
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
            if (dm.last_message_nonce) dm.last_message = await decryptDmPreview(dm.last_message, dm.last_message_nonce, dm._otherId, otherPublicKey, dm.id, dm.last_message_key_envelopes, dm.last_message_user_id);
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
  // Reply quotes' onclick (see buildReplyQuoteHtml) calls this directly —
  // it has to be reachable from global scope like every other inline
  // onclick handler here, or clicking a quote silently no-ops.
  window.jumpToMessage = jumpToMessage;
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
  window.copyProfileUserId = copyProfileUserId;
  window.manageBadgesFromProfile = manageBadgesFromProfile;
  // Lets notifications.js (a separate, non-module script that has no
  // access to this IIFE's closure) check the current manually-picked
  // status without duplicating any state — used to mute the one-shot
  // notification sound while Do Not Disturb is selected.
  window.getCurrentUserStatus = function() { return (currentUser && (currentUser._status || currentUser.status)) || 'online'; };
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
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SERVERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // Inline SVG crown shown next to a server's owner in the member list —
  // driven purely by member.is_owner, which the server derives from
  // servers.owner_id (see GET /servers/:id/members), never from role
  // name, array position, or anything client-side.
  function ownerCrownSvg() {
    return `<svg class="owner-crown" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-label="Server owner" role="img"><title>Server owner</title><path d="M3 19h18v2H3v-2zm.4-2 1.2-9L9 12l3-7 3 7 4.4-4L21 17H3.4z"/></svg>`;
  }

  async function loadServers() {
    const data = await api('GET', '/servers');
    if (!data) return;
    servers = data.servers || [];
    renderServerRail();
  }

  function renderServerRail() {
    const list = document.getElementById('server-rail-list');
    if (!list) return;
    list.innerHTML = servers.map(s => {
      const initials = (s.name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
      const inner = s.icon ? `<img src="${versionedMediaUrl(s.icon)}" />` : initials;
      return `<div class="server-pill${currentServerId === s.id ? ' active' : ''}" data-server-id="${s.id}"
        onclick="selectServer('${s.id}')" title="${escapeHtml(s.name)}">${inner}</div>`;
    }).join('');
    document.getElementById('server-pill-home').classList.toggle('active', !currentServerId && !inDiscoverView);
    document.getElementById('server-pill-discover')?.classList.toggle('active', inDiscoverView);
  }

  function showDMView() {
    currentServerId = null;
    currentRoom = null;
    inDiscoverView = false;
    document.getElementById('discover-panel').style.display = 'none';
    document.getElementById('server-panel').classList.add('hidden');
    document.getElementById('conv-header').classList.remove('hidden');
    document.getElementById('search-wrap').classList.remove('hidden');
    document.getElementById('dm-section').style.display = '';
    document.getElementById('chat-view').style.display = 'none';
    // Restore the normal global sidebar nav (Home/Friends/Marketplace/
    // Wallet/Admin) that selectServer() hides — see the .in-server-view
    // rule in dashboard.css.
    document.getElementById('sidebar').classList.remove('in-server-view');
    renderServerRail();
    if (window.location.pathname.startsWith('/servers/') || window.location.pathname.startsWith('/discover')) {
      window.history.replaceState({}, '', '/app');
    }
    navigateTo('home');
  }

  // `fromRoute: true` means router.js already matched '/servers/:serverId'
  // or '/servers/:serverId/channels/:channelId' and mounted the dashboard
  // for it (page load, refresh, or browser back/forward) — the address
  // bar is already correct, so this and openChannel() below skip pushing
  // a new history entry. Every other caller (clicking a server pill) is a
  // real navigation and should push its own URL, same pattern as
  // openRoom()'s fromRoute for DMs.
  async function selectServer(serverId, { fromRoute = false, initialChannelId = null } = {}) {
    inDiscoverView = false;
    document.getElementById('discover-panel').style.display = 'none';
    currentServerId = serverId;
    currentRoom = null;
    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('friends-panel').style.display = 'none';
    document.getElementById('wallet-panel').style.display = 'none';
    document.getElementById('notifications-panel').style.display = 'none';
    document.getElementById('chat-view').style.display = 'none';
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

    document.getElementById('conv-header').classList.add('hidden');
    document.getElementById('search-wrap').classList.add('hidden');
    document.getElementById('dm-section').style.display = 'none';
    document.getElementById('server-panel').classList.remove('hidden');
    // Server view gets its own nav (server rail + channel list); the
    // global sidebar-nav has no place inside it, so hide it for as long
    // as a server is active. Restored by showDMView().
    document.getElementById('sidebar').classList.add('in-server-view');
    renderServerRail();

    const server = servers.find(s => s.id === serverId);
    if (!server) {
      toast('Server not found');
      return showDMView();
    }
    document.getElementById('server-panel-name').textContent = server.name;
    document.getElementById('channel-list').innerHTML = `<div style="padding:10px;color:var(--text-muted);font-size:0.85rem">Loading…</div>`;

    await loadServerChannels(serverId);
    await loadServerRoles();

    const wanted = initialChannelId && serverChannels.find(c => c.id === initialChannelId);
    if (wanted) {
      openChannel(wanted.id, { fromRoute });
    } else if (serverChannels.length) {
      openChannel(serverChannels[0].id, { fromRoute });
    } else if (!fromRoute) {
      window.history.pushState({}, '', `/servers/${serverId}`);
    }
  }

  async function loadServerChannels(serverId) {
    const data = await api('GET', `/servers/${serverId}/channels`);
    serverChannels = data?.channels || [];
    serverChannels.forEach(c => (c.server_id = serverId));
    renderChannelList();
    serverChannels.forEach(c => wsJoin(c.id));
  }

  async function loadServerRoles() {
    if (!currentServerId) return;
    const data = await api('GET', `/servers/${currentServerId}/roles`);
    currentServerRoles = data?.roles || [];
  }

  function renderChannelList() {
    const list = document.getElementById('channel-list');
    if (!serverChannels.length) {
      list.innerHTML = `<div style="padding:10px;color:var(--text-muted);font-size:0.85rem">No channels yet</div>`;
      return;
    }
    list.innerHTML = serverChannels.map(c => `
      <div class="channel-item${currentRoom?.id === c.id ? ' active' : ''}" data-channel-id="${c.id}" onclick="openChannel('${c.id}')">
        <span class="channel-hash">#</span><span>${escapeHtml(c.name)}</span>
      </div>
    `).join('');
  }

  function openChannel(channelId, { fromRoute = false } = {}) {
    const channel = serverChannels.find(c => c.id === channelId);
    if (!channel) return toast('Channel not found');
    const loadToken = ++_roomLoadToken;
    // Leave the previously active channel's WebSocket subscription (if
    // any) before joining the new one, so live events (new messages,
    // typing, presence) are scoped to the channel actually being viewed
    // rather than accumulating across every channel ever opened this
    // session. DMs/groups are unaffected — they stay joined for
    // notifications regardless of which view is open.
    if (currentRoom && currentRoom.server_id && currentRoom.id !== channelId && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave_room', room_id: currentRoom.id }));
    }
    currentRoom = channel;
    currentRoomMembers = [];
    closeMentionSuggest();

    const targetPath = `/servers/${channel.server_id}/channels/${channel.id}`;
    if (!fromRoute && window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }

    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    const el = document.querySelector(`[data-channel-id="${channelId}"]`);
    if (el) el.classList.add('active');

    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('friends-panel').style.display = 'none';
    document.getElementById('wallet-panel').style.display = 'none';
    document.getElementById('notifications-panel').style.display = 'none';
    document.getElementById('chat-view').style.display = 'flex';
    showMobileDetail();

    document.getElementById('member-list-toggle-btn').style.display = 'flex';
    document.getElementById('member-list-toggle-btn').classList.add('active');
    document.getElementById('member-list-panel').style.display = 'flex';
    document.getElementById('member-list-panel').classList.remove('force-open');
    loadChannelMemberList();

    wsJoin(channel.id);

    const chAvatar = document.getElementById('ch-avatar');
    chAvatar.innerHTML = '#';
    chAvatar.style.background = hashColor(channel.name);
    document.getElementById('chat-room-name-text').textContent = '# ' + channel.name;
    document.getElementById('chat-status-text').textContent = channel.description || 'Text channel';
    document.getElementById('ch-status-dot').className = 'ch-status-dot';
    document.getElementById('ch-status-dot').style.display = 'none';
    document.getElementById('msg-input').placeholder = 'Message #' + channel.name;

    const container = document.getElementById('messages-container');
    container.innerHTML = `<div style="color:var(--text-muted);padding:32px;text-align:center">Loading...</div>`;
    api('GET', `/channels/${channel.id}/messages`).then(async data => {
      if (loadToken !== _roomLoadToken) return;
      container.innerHTML = '';
      window._lastMsgUserId = null;
      window._lastMsgTime = 0;
      window._lastMsgDate = null;
      if (data?.messages?.length) {
        _roomHasMessages = true;
        for (const m of data.messages) {
          if (loadToken !== _roomLoadToken) return;
          await appendMessage(m);
        }
        scrollToBottom();
      } else {
        container.innerHTML = `
          <div class="conversation-start">
            <div class="start-header">
              <h3>Welcome to the beginning of</h3>
              <h1>#${escapeHtml(channel.name)}</h1>
            </div>
          </div>
        `;
        _roomHasMessages = false;
      }
    });
  }

  function showAddServerModal() {
    document.getElementById('add-server-modal').style.display = 'flex';
    ensureDiscoverCategoriesLoaded().then(populateCategorySelects);
    switchAddServerTab('create');
  }

  function switchAddServerTab(tab) {
    document.getElementById('as-tab-create').classList.toggle('active', tab === 'create');
    document.getElementById('as-tab-join').classList.toggle('active', tab === 'join');
    document.getElementById('as-pane-create').style.display = tab === 'create' ? '' : 'none';
    document.getElementById('as-pane-join').style.display = tab === 'join' ? '' : 'none';
  }

  async function submitCreateServer() {
    const name = document.getElementById('create-server-name').value.trim();
    const description = document.getElementById('create-server-desc').value.trim();
    const category = document.getElementById('create-server-category').value || null;
    const isDiscoverable = document.getElementById('create-server-discoverable').checked;
    if (!name) return toast('Server name required');
    const data = await api('POST', '/servers', { name, description, category, is_discoverable: isDiscoverable });
    if (!data?.server) return toast(data?.error || 'Failed to create server');
    document.getElementById('add-server-modal').style.display = 'none';
    document.getElementById('create-server-name').value = '';
    document.getElementById('create-server-desc').value = '';
    document.getElementById('create-server-category').value = '';
    document.getElementById('create-server-discoverable').checked = false;
    await loadServers();
    selectServer(data.server.id);
    toast(`Server "${data.server.name}" created`);
  }

  async function joinDiscoveredServer(serverId, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Joining…'; }
    const data = await api('POST', `/servers/${serverId}/join`);
    if (!data?.ok) {
      toast(data?.error || 'Failed to join server');
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Join'; }
      return;
    }
    if (btnEl) btnEl.textContent = 'Joined';
    await loadServers();
    const card = btnEl?.closest('.discover-card');
    if (card) card.classList.add('joined');
    toast('Joined server');
    selectServer(serverId);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SERVER DISCOVERY — its own rail button + dedicated page.
  //  Everything here is backend/database-driven (GET /servers/discover,
  //  GET /servers/categories) — never a client-side filter/sort over
  //  servers already sitting in the browser.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async function ensureDiscoverCategoriesLoaded() {
    if (discoverCategoriesLoaded) return discoverCategories;
    const data = await api('GET', '/servers/categories');
    discoverCategories = data?.categories || [];
    discoverCategoriesLoaded = true;
    return discoverCategories;
  }

  // Fills the two <select> elements (create-server modal + server
  // settings overview) with the canonical category list, preserving
  // whatever value was already selected.
  function populateCategorySelects() {
    ['create-server-category', 'ss-category-input'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const current = el.value;
      el.innerHTML = `<option value="">No category</option>` +
        discoverCategories.map(c => `<option value="${c.key}">${escapeHtml(c.label)}</option>`).join('');
      el.value = current;
    });
  }

  function renderDiscoverCategoryTabs() {
    const wrap = document.getElementById('discover-category-tabs');
    if (!wrap) return;
    const tabs = [{ key: '', label: 'Home' }, ...discoverCategories];
    wrap.innerHTML = tabs.map(c => `
      <button class="discover-cat-tab${discoverActiveCategory === c.key ? ' active' : ''}" onclick="switchDiscoverCategory('${c.key}')">${escapeHtml(c.label)}</button>
    `).join('');
  }

  function switchDiscoverCategory(key) {
    if (discoverActiveCategory === key) return;
    discoverActiveCategory = key;
    renderDiscoverCategoryTabs();
    const path = key ? `/discover/${key}` : '/discover';
    if (window.location.pathname !== path) window.history.replaceState({}, '', path);
    loadDiscoverResults({ reset: true });
  }

  function onDiscoverSearchInput(value) {
    clearTimeout(_discoverDebounceTimer);
    _discoverDebounceTimer = setTimeout(() => {
      discoverActiveQuery = value.trim();
      loadDiscoverResults({ reset: true });
    }, 300);
  }

  function discoverCardHtml(s) {
    const initials = (s.name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const iconHtml = s.icon ? `<img src="${versionedMediaUrl(s.icon)}" />` : initials;
    // No banner image support yet (see server settings) — fall back to a
    // deterministic gradient derived from the server name, same idea as
    // the initials-avatar fallback, so every card still looks intentional
    // instead of leaving a blank rectangle.
    const bannerColor = hashColor(s.name || s.id);
    const categoryLabel = discoverCategories.find(c => c.key === s.category)?.label;
    const joinBtn = s.already_member
      ? `<button class="discover-join-btn" disabled>Joined</button>`
      : `<button class="discover-join-btn" onclick="event.stopPropagation();joinDiscoveredServer('${s.id}', this)">Join</button>`;
    return `<div class="discover-card${s.already_member ? ' joined' : ''}" onclick="if(${s.already_member ? 'true' : 'false'})selectServer('${s.id}')">
      <div class="discover-card-banner" style="background:${bannerColor}"></div>
      <div class="discover-card-body">
        <div class="discover-card-head">
          <div class="discover-card-icon">${iconHtml}</div>
          <div class="discover-card-name">${escapeHtml(s.name)}</div>
        </div>
        ${s.description ? `<div class="discover-card-desc">${escapeHtml(s.description)}</div>` : ''}
        <div class="discover-card-meta">
          <span class="discover-card-members"><span class="discover-dot online"></span>${s.member_count.toLocaleString()} member${s.member_count === 1 ? '' : 's'}</span>
          ${categoryLabel ? `<span class="discover-card-category">${escapeHtml(categoryLabel)}</span>` : ''}
        </div>
        ${joinBtn}
      </div>
    </div>`;
  }

  async function loadDiscoverResults({ reset = false } = {}) {
    const grid = document.getElementById('discover-grid');
    const statusArea = document.getElementById('discover-status-area');
    const loadMoreBtn = document.getElementById('discover-load-more');
    const token = ++_discoverLoadToken;
    if (reset) {
      discoverPage = 1;
      discoverResults = [];
      grid.innerHTML = `<div class="discover-skeleton-grid">${'<div class="discover-skeleton-card"></div>'.repeat(6)}</div>`;
      statusArea.innerHTML = '';
      loadMoreBtn.style.display = 'none';
    } else {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'Loading…';
    }

    let data;
    try {
      const params = new URLSearchParams({ page: String(discoverPage), page_size: '20' });
      if (discoverActiveCategory) params.set('category', discoverActiveCategory);
      if (discoverActiveQuery) params.set('query', discoverActiveQuery);
      data = await api('GET', `/servers/discover?${params.toString()}`);
    } catch (e) {
      data = null;
    }
    if (token !== _discoverLoadToken) return; // a newer load superseded this one

    if (!data) {
      grid.innerHTML = '';
      statusArea.innerHTML = `<div class="discover-status discover-error">Couldn't load servers. <button class="discover-retry-btn" onclick="loadDiscoverResults({reset:true})">Try again</button></div>`;
      loadMoreBtn.style.display = 'none';
      return;
    }

    const results = data.servers || [];
    discoverResults = reset ? results : discoverResults.concat(results);
    discoverHasMore = !!data.has_more;

    if (!discoverResults.length) {
      grid.innerHTML = '';
      statusArea.innerHTML = `<div class="discover-empty">
        <div class="discover-empty-title">No communities found.</div>
        <div class="discover-empty-sub">Try another search or category.</div>
      </div>`;
      loadMoreBtn.style.display = 'none';
      return;
    }

    grid.innerHTML = discoverResults.map(discoverCardHtml).join('');
    statusArea.innerHTML = '';
    loadMoreBtn.style.display = discoverHasMore ? '' : 'none';
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Load more';
  }

  function loadMoreDiscoverResults() {
    if (!discoverHasMore) return;
    discoverPage += 1;
    loadDiscoverResults({ reset: false });
  }

  // Opens the dedicated Discovery page — the server rail's own
  // "Discover" pill, never a modal tab, and never accidentally selects
  // one of the user's existing servers.
  async function showDiscoverView({ fromRoute = false, category = null } = {}) {
    inDiscoverView = true;
    currentServerId = null;
    currentRoom = null;
    document.getElementById('server-panel').classList.add('hidden');
    document.getElementById('conv-header').classList.add('hidden');
    document.getElementById('search-wrap').classList.add('hidden');
    document.getElementById('dm-section').style.display = 'none';
    document.getElementById('chat-view').style.display = 'none';
    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('friends-panel').style.display = 'none';
    document.getElementById('wallet-panel').style.display = 'none';
    document.getElementById('marketplace-panel').style.display = 'none';
    document.getElementById('admin-panel')?.style && (document.getElementById('admin-panel').style.display = 'none');
    document.getElementById('notifications-panel').style.display = 'none';
    document.getElementById('discover-panel').style.display = 'flex';
    document.getElementById('sidebar').classList.remove('in-server-view');
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    renderServerRail();
    showMobileDetail();

    const validCategory = await ensureDiscoverCategoriesLoaded().then(cats =>
      category && cats.some(c => c.key === category) ? category : ''
    );
    discoverActiveCategory = validCategory;
    document.getElementById('discover-search-input').value = '';
    discoverActiveQuery = '';
    renderDiscoverCategoryTabs();
    populateCategorySelects();

    const path = discoverActiveCategory ? `/discover/${discoverActiveCategory}` : '/discover';
    if (!fromRoute && window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
    loadDiscoverResults({ reset: true });
  }

  function extractInviteCode(input) {
    const trimmed = (input || '').trim();
    const match = trimmed.match(/([A-Za-z0-9_-]{4,16})\/?$/);
    return match ? match[1] : trimmed;
  }

  async function onJoinCodeInput(value) {
    clearTimeout(_searchTimer);
    const code = extractInviteCode(value);
    const preview = document.getElementById('join-server-preview');
    if (!code) { preview.innerHTML = ''; joinPreviewInvite = null; return; }
    _searchTimer = setTimeout(async () => {
      const data = await api('GET', `/invites/${encodeURIComponent(code)}`);
      if (!data?.server) { preview.innerHTML = `<div style="color:var(--danger);font-size:0.82rem;margin-top:6px">Invite not found</div>`; joinPreviewInvite = null; return; }
      joinPreviewInvite = { code, ...data };
      if (data.banned) {
        preview.innerHTML = `<div style="color:var(--danger);font-size:0.82rem;margin-top:6px">You are banned from this server</div>`;
      } else if (!data.valid) {
        preview.innerHTML = `<div style="color:var(--danger);font-size:0.82rem;margin-top:6px">${escapeHtml(data.error || 'This invite is no longer valid')}</div>`;
      } else {
        preview.innerHTML = `<div class="picker-row" style="margin-top:8px">
          <div class="picker-avatar">${data.server.icon ? `<img src="${versionedMediaUrl(data.server.icon)}" />` : escapeHtml((data.server.name||'?')[0].toUpperCase())}</div>
          <div class="picker-info">
            <div class="picker-name">${escapeHtml(data.server.name)}</div>
            <div class="picker-sub">${data.server.member_count} member${data.server.member_count === 1 ? '' : 's'}${data.already_member ? ' · already a member' : ''}</div>
          </div>
        </div>`;
      }
    }, 300);
  }

  async function submitJoinServer() {
    const code = extractInviteCode(document.getElementById('join-server-code').value);
    if (!code) return toast('Enter an invite code or link');
    const data = await api('POST', `/invites/${encodeURIComponent(code)}/join`);
    if (!data?.ok) return toast(data?.error || 'Failed to join server');
    document.getElementById('add-server-modal').style.display = 'none';
    document.getElementById('join-server-code').value = '';
    document.getElementById('join-server-preview').innerHTML = '';
    await loadServers();
    if (data.server_id) selectServer(data.server_id);
    toast('Joined server');
  }

  function showCreateChannelModal() {
    document.getElementById('create-channel-name').value = '';
    document.getElementById('create-channel-topic').value = '';
    document.getElementById('create-channel-modal').style.display = 'flex';
  }

  async function submitCreateChannel() {
    const name = document.getElementById('create-channel-name').value.trim();
    const description = document.getElementById('create-channel-topic').value.trim();
    if (!name) return toast('Channel name required');
    if (!currentServerId) return;
    const data = await api('POST', `/servers/${currentServerId}/channels`, { name, description });
    if (!data?.channel) return toast(data?.error || 'Failed to create channel');
    document.getElementById('create-channel-modal').style.display = 'none';
    data.channel.server_id = currentServerId;
    if (!serverChannels.find(c => c.id === data.channel.id)) {
      serverChannels = [...serverChannels, data.channel];
      renderChannelList();
    }
    openChannel(data.channel.id);
  }

  // ─── Server Settings (overview / members / invites) ─────────

  async function showServerSettingsModal() {
    if (!currentServerId) return;
    const server = servers.find(s => s.id === currentServerId);
    if (!server) return;
    document.getElementById('ss-server-name').textContent = server.name;
    document.getElementById('ss-name-input').value = server.name;
    document.getElementById('ss-desc-input').value = server.description || '';
    await ensureDiscoverCategoriesLoaded();
    populateCategorySelects();
    document.getElementById('ss-category-input').value = server.category || '';
    document.getElementById('ss-discoverable-input').checked = !!server.is_discoverable;
    document.getElementById('ss-delete-btn').style.display = server.is_owner ? '' : 'none';
    document.getElementById('ss-leave-btn').style.display = server.is_owner ? 'none' : '';
    document.getElementById('server-settings-modal').style.display = 'flex';
    switchServerSettingsTab('overview');
  }

  function switchServerSettingsTab(tab) {
    ['overview', 'members', 'invites'].forEach(t => {
      document.getElementById(`ss-tab-${t}`).classList.toggle('active', t === tab);
      document.getElementById(`ss-pane-${t}`).style.display = t === tab ? '' : 'none';
    });
    if (tab === 'members') renderServerMembers();
    if (tab === 'invites') renderServerInvites();
  }

  async function renderServerMembersIfOpen() {
    if (document.getElementById('server-settings-modal').style.display === 'flex' &&
        document.getElementById('ss-pane-members').style.display !== 'none') {
      renderServerMembers();
    }
    if (currentRoom?.server_id === currentServerId) loadChannelMemberList();
  }

  // ─── Right-side member list (persistent, not the settings modal's
  // management list above) — shown whenever a server channel is open.
  // Grouped ONLINE/OFFLINE like a typical Discord-style roster; DMs and
  // group chats have no server roster so this stays hidden for those
  // (see openRoom()/showDMView()).
  async function loadChannelMemberList() {
    const container = document.getElementById('member-list');
    const countEl = document.getElementById('member-list-count');
    const serverId = currentServerId;
    if (!serverId) return;
    const data = await api('GET', `/servers/${serverId}/members`);
    if (currentServerId !== serverId) return; // switched servers while loading
    const members = data?.members || [];
    countEl.textContent = `${members.length} Member${members.length === 1 ? '' : 's'}`;

    const online = members.filter(m => m._status !== 'offline' && m.status !== 'offline');
    const offline = members.filter(m => m._status === 'offline' || m.status === 'offline');

    function row(m) {
      const status = m.status || 'offline';
      const isOffline = status === 'offline';
      const avatarHtml = m.avatar
        ? `<img src="${versionedMediaUrl(m.avatar)}" />`
        : escapeHtml((m.display_name || m.username || '?')[0].toUpperCase());
      return `<div class="ml-row ${isOffline ? 'offline' : ''}" onclick="showUserProfile(event, '${m.id}')">
        <div class="ml-avatar">
          ${avatarHtml}
          <span class="ml-status-dot pip-${isOffline ? 'offline' : 'online'}"></span>
        </div>
        <div class="ml-info">
          <div class="ml-name-row">
            <div class="ml-name">${escapeHtml(m.display_name || m.username)}${m.is_owner ? ownerCrownSvg() : ''}</div>
            ${Badges.slot(m.id, { size: 'xs', max: 3 })}
          </div>
          <div class="ml-sub">${escapeHtml(m.role?.name || 'Member')}</div>
        </div>
      </div>`;
    }

    container.innerHTML =
      (online.length ? `<div class="ml-group-label">Online — ${online.length}</div>${online.map(row).join('')}` : '') +
      (offline.length ? `<div class="ml-group-label">Offline — ${offline.length}</div>${offline.map(row).join('')}` : '') ||
      `<div style="padding:10px;color:var(--text-muted)">No members</div>`;
  }

  // Toggles the member list panel. On wide layouts it's a normal flex
  // sibling (CSS handles show/hide via display:none by default until
  // this sets 'flex'); below the 1100px breakpoint (see dashboard.css)
  // it's hidden by default and this instead adds .force-open, which the
  // media query turns into a floating overlay panel.
  function toggleMemberList() {
    const panel = document.getElementById('member-list-panel');
    const btn = document.getElementById('member-list-toggle-btn');
    const narrow = window.innerWidth <= 1100;
    if (narrow) {
      const open = panel.classList.toggle('force-open');
      panel.style.display = open ? 'flex' : 'none';
      btn.classList.toggle('active', open);
    } else {
      const open = panel.style.display !== 'flex';
      panel.style.display = open ? 'flex' : 'none';
      btn.classList.toggle('active', open);
    }
  }

  async function renderServerMembers() {
    const container = document.getElementById('ss-member-list');
    container.innerHTML = `<div style="padding:10px;color:var(--text-muted)">Loading…</div>`;
    const server = servers.find(s => s.id === currentServerId);
    const [membersData] = await Promise.all([api('GET', `/servers/${currentServerId}/members`), loadServerRoles()]);
    const members = membersData?.members || [];
    const canManage = server && (server.is_owner || (server.my_permissions & 16) /* MANAGE_MEMBERS */);
    const canKick = server && (server.is_owner || (server.my_permissions & 64));
    const roleOptions = currentServerRoles.slice().sort((a, b) => b.position - a.position);

    container.innerHTML = members.map(m => {
      const avatarHtml = m.avatar ? `<img src="${versionedMediaUrl(m.avatar)}" />` : escapeHtml((m.display_name || '?')[0].toUpperCase());
      const roleSelect = (canManage && !m.is_owner)
        ? `<select class="picker-role-select" onchange="submitMemberRoleChange('${m.id}', this.value)">
             ${roleOptions.map(r => `<option value="${r.id}" ${m.role?.id === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
           </select>`
        : `<span class="picker-sub">${escapeHtml(m.role?.name || 'Member')}</span>`;
      const kickBtn = (canKick && !m.is_owner && m.id !== currentUser.id)
        ? `<button class="picker-action-btn" onclick="confirmKickMember('${m.id}', ${JSON.stringify(m.display_name || m.username).replace(/"/g, '&quot;')})">Kick</button>`
        : '';
      return `<div class="picker-row">
        <div class="picker-avatar">${avatarHtml}</div>
        <div class="picker-info">
          <div class="picker-name">${escapeHtml(m.display_name || m.username)}${m.is_owner ? ' <span class="picker-owner-tag">Owner</span>' : ''}</div>
          <div class="picker-sub">@${escapeHtml(m.username)}</div>
        </div>
        ${roleSelect}
        ${kickBtn}
      </div>`;
    }).join('') || `<div style="padding:10px;color:var(--text-muted)">No members</div>`;
  }

  async function submitMemberRoleChange(userId, roleId) {
    const data = await api('PATCH', `/servers/${currentServerId}/members/${userId}`, { role_id: roleId });
    if (!data?.ok) { toast(data?.error || 'Failed to change role'); renderServerMembers(); return; }
    toast('Role updated');
  }

  function confirmKickMember(userId, name) {
    if (!confirm(`Kick ${name} from this server?`)) return;
    api('DELETE', `/servers/${currentServerId}/members/${userId}`).then(data => {
      if (!data?.ok) return toast(data?.error || 'Failed to kick member');
      toast(`${name} was kicked`);
      renderServerMembers();
    });
  }

  async function renderServerInvites() {
    const container = document.getElementById('ss-invite-list');
    container.innerHTML = `<div style="padding:10px;color:var(--text-muted)">Loading…</div>`;
    const data = await api('GET', `/servers/${currentServerId}/invites`);
    const invites = data?.invites || [];
    container.innerHTML = invites.map(inv => {
      const meta = [
        inv.max_uses ? `${inv.uses}/${inv.max_uses} uses` : `${inv.uses} uses`,
        inv.expires_at ? `expires ${new Date(inv.expires_at).toLocaleDateString()}` : 'never expires',
        inv.revoked ? 'revoked' : ''
      ].filter(Boolean).join(' · ');
      return `<div class="invite-row">
        <div>
          <div class="invite-code">${escapeHtml(inv.code)}</div>
          <div class="invite-meta">${escapeHtml(meta)}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="picker-action-btn" onclick="copyInviteCode('${inv.code}')">Copy</button>
          ${!inv.revoked ? `<button class="picker-action-btn" onclick="revokeInvite('${inv.code}')">Revoke</button>` : ''}
        </div>
      </div>`;
    }).join('') || `<div style="padding:10px;color:var(--text-muted)">No invites yet</div>`;
  }

  function copyInviteCode(code) {
    const url = `${location.origin}/invite/${code}`;
    navigator.clipboard?.writeText(url);
    toast('Invite link copied');
  }

  async function revokeInvite(code) {
    const data = await api('DELETE', `/invites/${code}`);
    if (!data?.ok) return toast(data?.error || 'Failed to revoke invite');
    toast('Invite revoked');
    renderServerInvites();
  }

  async function submitCreateInvite() {
    const data = await api('POST', `/servers/${currentServerId}/invites`, {});
    if (!data?.invite) return toast(data?.error || 'Failed to create invite');
    renderServerInvites();
  }

  async function submitServerOverview() {
    const name = document.getElementById('ss-name-input').value.trim();
    const description = document.getElementById('ss-desc-input').value.trim();
    const category = document.getElementById('ss-category-input').value || null;
    const is_discoverable = document.getElementById('ss-discoverable-input').checked;
    if (!name) return toast('Server name required');
    const data = await api('PATCH', `/servers/${currentServerId}`, { name, description, category, is_discoverable });
    if (!data?.server) return toast(data?.error || 'Failed to update server');
    await loadServers();
    document.getElementById('server-panel-name').textContent = data.server.name;
    document.getElementById('ss-server-name').textContent = data.server.name;
    toast('Server updated');
  }

  function confirmDeleteServer() {
    const server = servers.find(s => s.id === currentServerId);
    if (!confirm(`Delete "${server?.name}"? This cannot be undone — all channels and messages will be lost.`)) return;
    api('DELETE', `/servers/${currentServerId}`).then(data => {
      if (!data?.ok) return toast(data?.error || 'Failed to delete server');
      document.getElementById('server-settings-modal').style.display = 'none';
      servers = servers.filter(s => s.id !== currentServerId);
      showDMView();
      toast('Server deleted');
    });
  }

  function confirmLeaveServer() {
    if (!confirm('Leave this server?')) return;
    api('POST', `/servers/${currentServerId}/leave`).then(data => {
      if (!data?.ok) return toast(data?.error || 'Failed to leave server');
      document.getElementById('server-settings-modal').style.display = 'none';
      servers = servers.filter(s => s.id !== currentServerId);
      showDMView();
      toast('Left server');
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  GROUP CHATS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function showNewGroupModal() {
    document.getElementById('new-group-name').value = '';
    const list = document.getElementById('new-group-friend-list');
    if (!friends.length) {
      list.innerHTML = `<div style="padding:10px;color:var(--text-muted)">Add some friends first to start a group.</div>`;
    } else {
      list.innerHTML = friends.map(f => `
        <label class="picker-row" style="cursor:pointer">
          <input type="checkbox" value="${f.id}" class="new-group-friend-check" style="margin-right:2px" />
          <div class="picker-avatar">${f.avatar ? `<img src="${versionedMediaUrl(f.avatar)}" />` : escapeHtml((f.display_name || f.username || '?')[0].toUpperCase())}</div>
          <div class="picker-info">
            <div class="picker-name">${escapeHtml(f.display_name || f.username)}</div>
            <div class="picker-sub">@${escapeHtml(f.username)}</div>
          </div>
        </label>
      `).join('');
    }
    document.getElementById('new-group-modal').style.display = 'flex';
  }

  async function submitCreateGroup() {
    const name = document.getElementById('new-group-name').value.trim();
    const memberIds = Array.from(document.querySelectorAll('.new-group-friend-check:checked')).map(el => el.value);
    if (!name) return toast('Group name required');
    if (!memberIds.length) return toast('Select at least one friend');
    const data = await api('POST', '/groups', { name, member_ids: memberIds });
    if (!data?.group) return toast(data?.error || 'Failed to create group');
    document.getElementById('new-group-modal').style.display = 'none';
    if (!dms.find(d => d.id === data.group.id)) {
      dms = [{ id: data.group.id, is_dm: 1, is_group: 1, display_name: data.group.name, name: data.group.name, icon: data.group.icon, _avatar: data.group.icon || null, last_message: null, last_message_at: null }, ...dms];
      renderDMList();
      wsJoin(data.group.id);
    }
    openRoom(data.group.id);
    toast(`Group "${data.group.name}" created`);
  }

  // Called from the chat header's ch-info click — dispatches to the
  // right "info" surface depending on what's currently open: a group
  // chat's member list, or nothing for a channel/1:1 DM (which already
  // has its own profile popout elsewhere).
  function openRoomInfo(event) {
    if (currentRoom?.is_group) return openGroupInfoModal(currentRoom.id);
    if (currentRoom?.server_id) return; // channels: no per-channel info surface yet
    if (currentRoom?._otherId) return showUserProfile(event, currentRoom._otherId);
  }

  async function openGroupInfoModal(groupId) {
    const data = await api('GET', `/groups/${groupId}`);
    if (!data?.group) return toast('Group not found');
    const group = data.group;
    document.getElementById('group-info-title').textContent = group.name;
    const isCreator = group.created_by === currentUser.id;
    const memberIds = new Set(group.members.map(m => m.user_id));
    const addable = friends.filter(f => !memberIds.has(f.id));

    const memberRows = group.members.map(m => `
      <div class="picker-row">
        <div class="picker-avatar">${m.avatar ? `<img src="${versionedMediaUrl(m.avatar)}" />` : escapeHtml((m.display_name || m.username || '?')[0].toUpperCase())}</div>
        <div class="picker-info">
          <div class="picker-name">${escapeHtml(m.display_name || m.username)}${m.user_id === group.created_by ? ' <span class="picker-owner-tag">Creator</span>' : ''}</div>
          <div class="picker-sub">@${escapeHtml(m.username)}</div>
        </div>
        ${(isCreator && m.user_id !== group.created_by) ? `<button class="picker-action-btn" onclick="removeGroupMember('${groupId}','${m.user_id}')">Remove</button>` : ''}
      </div>
    `).join('');

    const addSection = addable.length ? `
      <div style="margin-top:14px">
        <label>Add friends</label>
        <div class="picker-list">
          ${addable.map(f => `
            <label class="picker-row" style="cursor:pointer">
              <input type="checkbox" value="${f.id}" class="group-add-friend-check" style="margin-right:2px" />
              <div class="picker-avatar">${f.avatar ? `<img src="${versionedMediaUrl(f.avatar)}" />` : escapeHtml((f.display_name || f.username || '?')[0].toUpperCase())}</div>
              <div class="picker-info"><div class="picker-name">${escapeHtml(f.display_name || f.username)}</div></div>
            </label>
          `).join('')}
        </div>
        <button class="btn-primary" style="margin-top:8px" onclick="submitAddGroupMembers('${groupId}')">Add Selected</button>
      </div>` : '';

    document.getElementById('group-info-body').innerHTML = `
      <div class="picker-sub" style="margin-bottom:8px">${group.member_count} member${group.member_count === 1 ? '' : 's'}</div>
      <div class="picker-list">${memberRows}</div>
      ${addSection}
    `;
    document.getElementById('group-leave-btn').onclick = () => confirmLeaveGroupById(groupId);
    document.getElementById('group-info-modal').style.display = 'flex';
  }

  async function submitAddGroupMembers(groupId) {
    const ids = Array.from(document.querySelectorAll('.group-add-friend-check:checked')).map(el => el.value);
    if (!ids.length) return toast('Select at least one friend');
    const data = await api('POST', `/groups/${groupId}/members`, { user_ids: ids });
    if (!data?.group) return toast(data?.error || 'Failed to add members');
    toast('Members added');
    openGroupInfoModal(groupId);
  }

  function removeGroupMember(groupId, userId) {
    if (!confirm('Remove this member from the group?')) return;
    api('DELETE', `/groups/${groupId}/members/${userId}`).then(data => {
      if (!data?.ok) return toast(data?.error || 'Failed to remove member');
      openGroupInfoModal(groupId);
    });
  }

  function confirmLeaveGroup() {
    if (currentRoom?.is_group) confirmLeaveGroupById(currentRoom.id);
  }

  function confirmLeaveGroupById(groupId) {
    if (!confirm('Leave this group?')) return;
    api('DELETE', `/groups/${groupId}/members/${currentUser.id}`).then(data => {
      if (!data?.ok) return toast(data?.error || 'Failed to leave group');
      document.getElementById('group-info-modal').style.display = 'none';
      dms = dms.filter(d => d.id !== groupId);
      renderDMList();
      if (currentRoom?.id === groupId) { currentRoom = null; document.getElementById('chat-view').style.display = 'none'; showDMView(); }
      toast('Left group');
    });
  }

  window.loadServers = loadServers;
  window.selectServer = selectServer;
  window.showDMView = showDMView;
  window.openChannel = openChannel;
  window.toggleMemberList = toggleMemberList;
  window.showAddServerModal = showAddServerModal;
  window.switchAddServerTab = switchAddServerTab;
  window.submitCreateServer = submitCreateServer;
  window.joinDiscoveredServer = joinDiscoveredServer;
  window.showDiscoverView = showDiscoverView;
  window.switchDiscoverCategory = switchDiscoverCategory;
  window.onDiscoverSearchInput = onDiscoverSearchInput;
  window.loadMoreDiscoverResults = loadMoreDiscoverResults;
  window.onJoinCodeInput = onJoinCodeInput;
  window.submitJoinServer = submitJoinServer;
  window.showCreateChannelModal = showCreateChannelModal;
  window.submitCreateChannel = submitCreateChannel;
  window.showServerSettingsModal = showServerSettingsModal;
  window.switchServerSettingsTab = switchServerSettingsTab;
  window.submitMemberRoleChange = submitMemberRoleChange;
  window.confirmKickMember = confirmKickMember;
  window.copyInviteCode = copyInviteCode;
  window.revokeInvite = revokeInvite;
  window.submitCreateInvite = submitCreateInvite;
  window.submitServerOverview = submitServerOverview;
  window.confirmDeleteServer = confirmDeleteServer;
  window.confirmLeaveServer = confirmLeaveServer;
  window.showNewGroupModal = showNewGroupModal;
  window.submitCreateGroup = submitCreateGroup;
  window.openRoomInfo = openRoomInfo;
  window.submitAddGroupMembers = submitAddGroupMembers;
  window.removeGroupMember = removeGroupMember;
  window.confirmLeaveGroup = confirmLeaveGroup;

  window.toggleSelectMode = toggleSelectMode;
  window.filterSidebar = filterSidebar;
  window.handleFileUpload = handleFileUpload;
  window.openImageLightbox = openImageLightbox;
  window.closeImageLightbox = closeImageLightbox;
  window.logout = logout;
  window.destroyDashboardView = destroyDashboardView;
  window.navigateTo = navigateTo;
  window.toggleSidebar = toggleSidebar;
  // Exposed so settings.js — the /settings page's own separate "edit
  // profile" form, a different module entirely from this file's
  // edit-profile-modal — can also refresh already-rendered messages when
  // it's the one that changes your display name.
  window.refreshOwnDisplayNameEverywhere = refreshOwnDisplayNameEverywhere;
} // <--- Closes initDashboardView()