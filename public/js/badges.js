// badges.js — reusable user-badge rendering for every part of the UI.
//
// This is the vanilla-JS equivalent of a <BadgeList userId={id} /> component:
// Nyxie has no framework/build step, so instead of a component you drop a
// *slot* into any markup and it fills itself in:
//
//   `<span class="msg-author">…</span>${Badges.slot(msg.user_id, { size: 'sm' })}`
//
// The slot carries only a user id. Which badges that user owns comes from
// the server (GET /api/badges/users), how each badge looks comes from the
// server's badge definitions (GET /api/badges/definitions) — nothing about
// badge ownership or appearance is hardcoded in any view. Adding a badge
// type is a server-side config change (server/config/badge_definitions.json);
// no UI code needs to change.
//
// How it works:
//   • A MutationObserver hydrates any `[data-badge-user]` element that
//     appears anywhere in the page, so views don't have to call anything
//     after inserting HTML.
//   • Lookups are batched (one request per burst of slots) and cached per
//     user; the server pushes a `badges_updated` WebSocket event when an
//     admin changes someone's badges and dashboard.js calls
//     Badges.invalidate(userId), so open screens update without a refresh.
//   • One shared floating tooltip (never clipped by overflow:hidden rows)
//     shows the badge name + description on hover/focus; click/tap pins it.
//
// Classic script (shares the global scope with utils.js/state.js — it uses
// escapeHtml() and the session `token`).

const Badges = (() => {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  // The server already validates icons against this same allow-list when it
  // loads the definitions; checking again here means a bad icon can never
  // reach innerHTML even if the server-side check is ever bypassed.
  const ICON_RE = /^(<(path|circle|rect|line|polyline|polygon|ellipse)( [a-z-]+="[^"<>]*")*\/>)+$/;
  const SIZES = ['xs', 'sm', 'md', 'lg'];
  const TIERS = ['staff', 'special', 'common'];

  const CACHE_TTL_MS = 5 * 60 * 1000;
  const RETRY_AFTER_MS = 15 * 1000;
  const BATCH_SIZE = 100;
  const FLUSH_DELAY_MS = 30;

  let defs = new Map();      // badge id -> definition
  let defsLoaded = false;
  let defsPromise = null;
  let defsFailedAt = 0;
  const owners = new Map();  // user id -> { ids: [badge ids], at: timestamp }
  const failed = new Map();  // user id -> timestamp of the last failed lookup
  const pending = new Set(); // user ids waiting for the next batched request
  const inflight = new Set(); // user ids whose request is on the wire (their slots repaint when it lands)
  const dirty = new Set();    // invalidated while in flight: the answer may predate the change, so re-fetch
  let flushTimer = null;
  let epoch = 0;             // bumped by reset(); responses from an older epoch are dropped

  // ── Network ───────────────────────────────────────────────────────
  async function getJson(path) {
    if (typeof token === 'undefined' || !token) throw new Error('signed out');
    const res = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function loadDefinitions() {
    if (defsLoaded) return Promise.resolve();
    if (defsPromise) return defsPromise;
    if (Date.now() - defsFailedAt < RETRY_AFTER_MS) return Promise.resolve();
    const myEpoch = epoch;
    defsPromise = getJson('/api/badges/definitions')
      .then(data => {
        if (myEpoch !== epoch) return;
        defs = new Map((data.badges || []).map(b => [b.id, b]));
        defsLoaded = true;
      })
      .catch(() => { defsFailedAt = Date.now(); })
      .then(() => { defsPromise = null; });
    return defsPromise;
  }

  function isFresh(userId) {
    const e = owners.get(userId);
    return !!e && Date.now() - e.at < CACHE_TTL_MS;
  }

  function queue(userId) {
    if (!ID_RE.test(userId) || inflight.has(userId)) return;
    const f = failed.get(userId);
    if (f && Date.now() - f < RETRY_AFTER_MS) return;
    pending.add(userId);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  async function flush() {
    flushTimer = null;
    const ids = [...pending];
    pending.clear();
    if (!ids.length || typeof token === 'undefined' || !token) return;
    const myEpoch = epoch;
    ids.forEach(id => inflight.add(id));
    await loadDefinitions();
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      try {
        const data = await getJson('/api/badges/users?ids=' + chunk.join(','));
        if (myEpoch !== epoch) return;
        const now = Date.now();
        for (const id of chunk) {
          owners.set(id, { ids: (data.badges && Array.isArray(data.badges[id])) ? data.badges[id] : [], at: now });
          failed.delete(id);
        }
      } catch (_) {
        if (myEpoch !== epoch) return;
        for (const id of chunk) failed.set(id, Date.now());
      }
      chunk.forEach(id => { inflight.delete(id); if (dirty.delete(id)) { owners.delete(id); queue(id); } });
      chunk.forEach(paintUser);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────
  // HTML for one badge chip. Also used directly by the admin UI, which
  // renders from definitions rather than from a user's ownership.
  function chip(def, opts = {}) {
    if (!def || !COLOR_RE.test(def.color || '') || !ICON_RE.test(def.icon || '')) return '';
    const size = SIZES.includes(opts.size) ? opts.size : 'sm';
    const tier = TIERS.includes(def.tier) ? def.tier : 'common';
    const label = def.description ? `${def.name} — ${def.description}` : def.name;
    // Only the larger, profile-style chips are keyboard-focusable; making
    // every chat-message badge a tab stop would bury the message list.
    const focusable = (size === 'md' || size === 'lg') ? ' tabindex="0"' : '';
    return `<span class="nyx-badge" data-size="${size}" data-tier="${tier}" data-badge="${escapeHtml(def.id)}"` +
      ` data-badge-name="${escapeHtml(def.name)}" data-badge-desc="${escapeHtml(def.description || '')}"` +
      ` role="img"${focusable} aria-label="${escapeHtml(label)}" style="--badge-color:${def.color}">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${def.icon}</svg></span>`;
  }

  // Placeholder to embed in any HTML string. Hydrates itself.
  function slot(userId, opts = {}) {
    if (!ID_RE.test(String(userId || ''))) return '';
    const size = SIZES.includes(opts.size) ? opts.size : 'sm';
    const max = Number.isInteger(opts.max) && opts.max > 0 ? ` data-badge-max="${opts.max}"` : '';
    return `<span class="nyx-badges" data-badge-user="${userId}" data-badge-size="${size}"${max}></span>`;
  }

  function paintSlot(el) {
    const userId = el.getAttribute('data-badge-user');
    const entry = owners.get(userId);
    if (!entry || !defsLoaded) return false;

    const size = el.getAttribute('data-badge-size') || 'sm';
    const max = parseInt(el.getAttribute('data-badge-max'), 10) || 0;
    const items = entry.ids.map(id => defs.get(id)).filter(Boolean);
    const shown = max && items.length > max ? items.slice(0, max) : items;

    let html = shown.map(d => chip(d, { size })).join('');
    if (shown.length < items.length) {
      html += `<span class="nyx-badge-more" data-size="${size}">+${items.length - shown.length}</span>`;
    }
    const emptyText = el.getAttribute('data-badge-empty');
    if (!html && emptyText) html = `<span class="nyx-badges-none">${escapeHtml(emptyText)}</span>`;

    // Skip identical repaints so a hover tooltip isn't torn down by a rescan.
    if (el.__nyxSig !== html) {
      if (tipOwner && el.contains(tipOwner)) hideTip(); // the badge under the cursor is about to be replaced
      el.__nyxSig = html;
      el.innerHTML = html;
    }
    // Profile-style containers collapse entirely when there's nothing to show.
    if (el.hasAttribute('data-badge-container')) el.style.display = html ? 'flex' : 'none';
    return true;
  }

  function paintUser(userId) {
    if (!ID_RE.test(userId)) return;
    document.querySelectorAll('[data-badge-user="' + userId + '"]').forEach(paintSlot);
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    const slots = root.matches('[data-badge-user]') ? [root] : [];
    root.querySelectorAll('[data-badge-user]').forEach(s => slots.push(s));
    if (!slots.length) return;
    const need = new Set();
    for (const el of slots) {
      const userId = el.getAttribute('data-badge-user');
      paintSlot(el); // shows cached data right away if we have it
      if (!isFresh(userId)) need.add(userId); // …and (re)fetches when missing or stale
    }
    need.forEach(queue);
    if (!defsLoaded) loadDefinitions().then(() => { if (defsLoaded) scan(root.isConnected ? document.body : root); });
  }

  // Turn an existing element (e.g. a popout's badge row) into a live slot for
  // `userId`. Clears whatever it showed for the previous user immediately.
  function renderInto(el, userId, opts = {}) {
    if (!el) return;
    el.classList.add('nyx-badges');
    el.setAttribute('data-badge-size', SIZES.includes(opts.size) ? opts.size : 'md');
    if (Number.isInteger(opts.max) && opts.max > 0) el.setAttribute('data-badge-max', String(opts.max));
    else el.removeAttribute('data-badge-max');
    if (opts.empty) el.setAttribute('data-badge-empty', opts.empty); else el.removeAttribute('data-badge-empty');
    if (opts.container) el.setAttribute('data-badge-container', '');
    el.__nyxSig = null;
    el.innerHTML = '';
    if (opts.container) el.style.display = 'none';
    if (!ID_RE.test(String(userId || ''))) { el.removeAttribute('data-badge-user'); return; }
    el.setAttribute('data-badge-user', userId);
    scan(el);
  }

  // ── Cache control ─────────────────────────────────────────────────
  // Someone's badges changed (WebSocket 'badges_updated'): forget them and
  // re-fetch so every slot showing that user updates in place.
  function invalidate(userId) {
    if (!ID_RE.test(String(userId || ''))) return;
    owners.delete(userId);
    failed.delete(userId);
    if (inflight.has(userId)) dirty.add(userId); else queue(userId);
  }

  // Force-refresh (e.g. when opening a profile) without waiting for the TTL.
  function refresh(userId) { invalidate(userId); }

  // Session ended / changed: drop everything so the next user never sees
  // the previous one's cached data (or hidden badges an admin could see).
  function reset() {
    epoch++;
    defs = new Map();
    defsLoaded = false;
    defsPromise = null;
    defsFailedAt = 0;
    owners.clear();
    failed.clear();
    pending.clear();
    inflight.clear();
    dirty.clear();
    clearTimeout(flushTimer);
    flushTimer = null;
    hideTip();
  }

  // Definitions the current user may see, in display order (for other UI).
  function definitions() { return [...defs.values()].sort((a, b) => a.order - b.order); }

  // ── Tooltip (hover/focus) and pin (click/tap) ─────────────────────
  let tip = null;
  let tipOwner = null;
  let pinned = false;

  function ensureTip() {
    if (tip && tip.isConnected) return tip;
    tip = document.createElement('div');
    tip.id = 'nyx-badge-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    return tip;
  }

  function showTip(badgeEl) {
    const t = ensureTip();
    const name = badgeEl.getAttribute('data-badge-name') || '';
    const desc = badgeEl.getAttribute('data-badge-desc') || '';
    if (!name) return;
    t.innerHTML = `<div class="nyx-tip-name">${escapeHtml(name)}</div>` +
      (desc ? `<div class="nyx-tip-desc">${escapeHtml(desc)}</div>` : '');
    t.style.display = 'block';
    t.style.left = '0px';
    t.style.top = '0px';
    const r = badgeEl.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    let top = r.top - tr.height - 8;
    if (top < 8) top = r.bottom + 8; // no room above → flip below
    t.style.left = Math.round(left) + 'px';
    t.style.top = Math.round(top) + 'px';
    tipOwner = badgeEl;
  }

  function hideTip() {
    pinned = false;
    tipOwner = null;
    if (tip) tip.style.display = 'none';
  }

  const badgeOf = target => (target && target.closest) ? target.closest('.nyx-badge') : null;

  document.addEventListener('mouseover', e => {
    const b = badgeOf(e.target);
    if (b && !pinned) showTip(b);
  });
  document.addEventListener('mouseout', e => {
    const b = badgeOf(e.target);
    if (!b || pinned) return;
    if (e.relatedTarget && b.contains(e.relatedTarget)) return;
    hideTip();
  });
  document.addEventListener('focusin', e => {
    const b = badgeOf(e.target);
    if (b && !pinned) showTip(b);
  });
  document.addEventListener('focusout', e => {
    if (badgeOf(e.target) && !pinned) hideTip();
  });

  // Click / tap: pins the tooltip (the only way to read it on touch
  // screens). Captured and stopped so a badge inside a clickable row
  // (friend row → opens a DM, member row → opens a profile) doesn't also
  // trigger that row's action.
  document.addEventListener('click', e => {
    const b = badgeOf(e.target);
    if (b) {
      e.stopPropagation();
      e.preventDefault();
      if (pinned && tipOwner === b) hideTip();
      else { showTip(b); pinned = true; }
      return;
    }
    if (pinned) hideTip();
  }, true);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && tip && tip.style.display === 'block') { hideTip(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && badgeOf(e.target)) {
      e.preventDefault();
      const b = badgeOf(e.target);
      if (pinned && tipOwner === b) hideTip();
      else { showTip(b); pinned = true; }
    }
  });
  // Positions go stale on scroll/resize; simply dismiss.
  window.addEventListener('scroll', () => { if (tipOwner) hideTip(); }, true);
  window.addEventListener('resize', () => { if (tipOwner) hideTip(); });

  // ── Auto-hydration ────────────────────────────────────────────────
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan(document.body);

  return { slot, chip, renderInto, invalidate, refresh, reset, scan, definitions, loadDefinitions };
})();
