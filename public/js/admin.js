// admin.js — Admin marketplace-dispute panel. Same pattern as
// marketplace.js/wallet.js: a classic script sharing the global lexical
// environment with dashboard.js/state.js/utils.js (token, currentUser,
// api(), logout(), toast(), escapeHtml()). Talks only to
// /api/admin/marketplace, which server/routes/adminMarketplace.js gates
// with requireAuth + requireAdmin (server/middleware/auth.js) — the
// role check in initAdminPanel() below is cosmetic only (dashboard.js's
// navigateTo('admin') and router.js's 'admin' auth guard already keep a
// non-admin from getting here in the first place); every request this
// file makes is re-checked server-side regardless.
//
// The panel has two tabs: marketplace disputes (above) and Badges (bottom
// of this file), which talks to /api/admin/badges — gated the same way.

let _adminPage = 1;
let _adminHasNextPage = false;
let _adminCurrentDispute = null; // { dispute, order } most recently loaded

async function adminRequest(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function adminApi(method, path, body) { return adminRequest('/api/admin/marketplace', method, path, body); }
function adminBadgeApi(method, path, body) { return adminRequest('/api/admin/badges', method, path, body); }
function adminWalletApi(method, path, body) { return adminRequest('/api/admin/wallet', method, path, body); }

function adminShowView(id) {
  document.querySelectorAll('#admin-panel .mp-view').forEach(el => { el.style.display = 'none'; });
  document.getElementById(id).style.display = 'flex';
}

function adminDisputeStatusLabel(status) {
  const map = {
    open: 'Open',
    investigating: 'Investigating',
    resolved_buyer: 'Resolved (buyer)',
    resolved_seller: 'Resolved (seller)',
    closed: 'Closed',
  };
  return map[status] || status;
}

function adminReasonLabel(reason) {
  const map = {
    item_not_received: 'Item not received',
    item_not_as_described: 'Item not as described',
    seller_not_responding: 'Seller not responding',
    buyer_issue: 'Buyer issue',
    other: 'Other',
  };
  return map[reason] || reason;
}

// ─── Panel entry point ──────────────────────────────────────────────
async function initAdminPanel() {
  if (!currentUser || currentUser.role !== 'ADMIN') return; // see header comment
  const tab = window._adminInitialTab;
  const badgeUser = window._adminInitialBadgeUser;
  window._adminInitialTab = null;
  window._adminInitialBadgeUser = null;
  if (tab === 'badges') {
    await adminSwitchTab('badges');
    if (badgeUser) await adminOpenBadgeUser(badgeUser);
    return;
  }
  await adminSwitchTab('disputes');
}

async function adminSwitchTab(tab) {
  document.querySelectorAll('#admin-panel .admin-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  if (tab === 'badges') {
    adminShowView('admin-badges-view');
    await adminBadgesOverview();
  } else if (tab === 'wallet') {
    adminShowView('admin-wallet-view');
    await adminWalletLoadLog();
  } else {
    adminShowView('admin-disputes-view');
    _adminPage = 1;
    await adminReloadDisputes();
  }
}

// ─── Disputes list ──────────────────────────────────────────────────
const ADMIN_PAGE_SIZE = 20;

async function adminReloadDisputes() {
  const list = document.getElementById('admin-disputes-list');
  list.innerHTML = '<div class="mp-empty">Loading…</div>';
  const status = document.getElementById('admin-status-select').value;
  const params = new URLSearchParams({ page: _adminPage, limit: ADMIN_PAGE_SIZE });
  if (status) params.set('status', status);

  try {
    const data = await adminApi('GET', '/disputes?' + params.toString());
    renderDisputesList(data.disputes);
    // adminListDisputes only ever returns the raw page of rows, with no
    // total count — unlike marketplace's listing/order endpoints, there's
    // no `pagination` object to trust. Treat "got a full page" as "there
    // might be more" instead.
    _adminHasNextPage = data.disputes.length === ADMIN_PAGE_SIZE;
    const pag = document.getElementById('admin-pagination');
    pag.style.display = (_adminPage > 1 || _adminHasNextPage) ? 'flex' : 'none';
    document.getElementById('admin-page-label').textContent = `Page ${_adminPage}`;
    document.getElementById('admin-prev-page').disabled = _adminPage <= 1;
    document.getElementById('admin-next-page').disabled = !_adminHasNextPage;
  } catch (e) {
    list.innerHTML = `<div class="mp-empty">${escapeHtml(e.message || 'Failed to load disputes')}</div>`;
  }
}

function adminChangePage(delta) {
  if (delta > 0 && !_adminHasNextPage) return;
  const next = _adminPage + delta;
  if (next < 1) return;
  _adminPage = next;
  adminReloadDisputes();
}

function renderDisputesList(disputes) {
  const list = document.getElementById('admin-disputes-list');
  if (!disputes.length) {
    list.innerHTML = '<div class="mp-empty">No disputes match this filter.</div>';
    return;
  }
  list.innerHTML = disputes.map(d => `
    <div class="mp-order-row" onclick="adminOpenDispute('${d.id}')">
      <div class="mp-row-thumb">⚑</div>
      <div class="mp-row-main">
        <div class="mp-row-title">${escapeHtml(adminReasonLabel(d.reason))}</div>
        <div class="mp-row-sub">Order #${escapeHtml(String(d.order_id).slice(0, 8))} · ${new Date(d.created_at).toLocaleDateString()}</div>
      </div>
      <div class="mp-row-status ${d.status}">${adminDisputeStatusLabel(d.status)}</div>
    </div>
  `).join('');
}

function adminBackToList() {
  adminShowView('admin-disputes-view');
  adminReloadDisputes();
}

// ─── Dispute detail / resolve ───────────────────────────────────────
async function adminOpenDispute(id) {
  adminShowView('admin-dispute-view');
  const body = document.getElementById('admin-dispute-body');
  body.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    const data = await adminApi('GET', '/disputes/' + id);
    _adminCurrentDispute = data;
    await renderDisputeDetail(data);
  } catch (e) {
    body.innerHTML = `<div class="mp-empty">${escapeHtml(e.message)}</div>`;
  }
}

// Best-effort display name lookup via the existing /api/users/:id route
// (same one dashboard.js already uses for DM headers) — the raw dispute/
// order rows only carry ids, and this endpoint works for any user, not
// just friends/DM contacts. Never lets a lookup failure break the page.
async function adminLookupUsername(userId) {
  try {
    const data = await api('GET', '/users/' + userId);
    return data && data.user ? (data.user.display_name || data.user.username) : userId.slice(0, 8);
  } catch {
    return userId.slice(0, 8);
  }
}

async function renderDisputeDetail({ dispute, order }) {
  const body = document.getElementById('admin-dispute-body');
  const isOpen = dispute.status === 'open' || dispute.status === 'investigating';

  const [openerName, buyerName, sellerName] = await Promise.all([
    adminLookupUsername(dispute.opened_by),
    order ? adminLookupUsername(order.buyerId) : Promise.resolve('—'),
    order ? adminLookupUsername(order.sellerId) : Promise.resolve('—'),
  ]);

  const resolveForm = isOpen ? `
    <div class="admin-section-label">Resolve</div>
    <form class="mp-form" onsubmit="return adminSubmitResolve(event, '${dispute.id}')">
      <div>
        <label>Resolution</label>
        <select id="admin-resolution-select">
          <option value="resolved_buyer">Refund the buyer</option>
          <option value="resolved_seller">Release funds to the seller</option>
          <option value="closed">Close — no money movement</option>
        </select>
      </div>
      <div>
        <label>Note <span style="font-weight:400;">(optional, kept with the resolution record)</span></label>
        <textarea id="admin-resolution-note" maxlength="2000" placeholder="Why this resolution…"></textarea>
      </div>
      <div class="mp-form-hint" id="admin-resolve-error" style="color:var(--danger);"></div>
      <div class="modal-actions" style="justify-content:flex-start;">
        <button type="submit" class="btn-primary" id="admin-resolve-submit-btn">Resolve Dispute</button>
      </div>
    </form>
  ` : `
    <div class="admin-section-label">Resolution</div>
    <div class="admin-note-box">
      <div class="mp-row-status ${dispute.status}" style="display:inline-block; margin-bottom:8px;">${adminDisputeStatusLabel(dispute.status)}</div>
      <div>${dispute.resolution_note ? escapeHtml(dispute.resolution_note) : '<span class="mp-form-hint">No note was left.</span>'}</div>
      ${dispute.resolved_at ? `<div class="mp-form-hint" style="margin-top:8px;">Resolved ${new Date(dispute.resolved_at).toLocaleString()}</div>` : ''}
    </div>
  `;

  body.innerHTML = `
    <div class="admin-section-label">Dispute</div>
    <div class="mp-order-summary">
      <div class="mp-order-summary-row"><span>Status</span><span class="mp-row-status ${dispute.status}">${adminDisputeStatusLabel(dispute.status)}</span></div>
      <div class="mp-order-summary-row"><span>Reason</span><span>${escapeHtml(adminReasonLabel(dispute.reason))}</span></div>
      <div class="mp-order-summary-row"><span>Opened by</span><span>${escapeHtml(openerName)}</span></div>
      <div class="mp-order-summary-row"><span>Opened</span><span>${new Date(dispute.created_at).toLocaleString()}</span></div>
    </div>
    <div class="admin-note-box">${escapeHtml(dispute.description || '')}</div>

    <div class="admin-section-label">Order</div>
    ${order ? `
      <div class="mp-order-summary">
        <div class="mp-order-summary-row"><span>Order</span><span>#${escapeHtml(order.id.slice(0, 8))}</span></div>
        <div class="mp-order-summary-row"><span>Buyer</span><span>${escapeHtml(buyerName)}</span></div>
        <div class="mp-order-summary-row"><span>Seller</span><span>${escapeHtml(sellerName)}</span></div>
        <div class="mp-order-summary-row"><span>Quantity</span><span>${order.quantity}</span></div>
        <div class="mp-order-summary-row"><span>Total</span><span>${order.totalPriceNx} NX</span></div>
        <div class="mp-order-summary-row"><span>Order status</span><span>${escapeHtml(order.status)}</span></div>
        <div class="mp-order-summary-row"><span>Escrow</span><span>${escapeHtml(order.escrowStatus)}</span></div>
      </div>
      ${order.deliveryData ? `
        <div class="admin-section-label">Delivery data seller sent</div>
        <div class="mp-delivery-box">${escapeHtml(order.deliveryData)}</div>
      ` : ''}
    ` : '<div class="mp-empty">Order not found.</div>'}

    ${resolveForm}
  `;
}

async function adminSubmitResolve(event, disputeId) {
  event.preventDefault();
  const resolution = document.getElementById('admin-resolution-select').value;
  const note = document.getElementById('admin-resolution-note').value;
  const errEl = document.getElementById('admin-resolve-error');
  const btn = document.getElementById('admin-resolve-submit-btn');
  errEl.textContent = '';

  const confirmMsg = resolution === 'resolved_buyer'
    ? 'Refund the buyer? This releases the held escrow back to them and cannot be undone.'
    : resolution === 'resolved_seller'
      ? 'Release funds to the seller? This pays out the held escrow and cannot be undone.'
      : 'Close this dispute with no money movement?';
  if (!confirm(confirmMsg)) return false;

  btn.disabled = true;
  try {
    await adminApi('POST', `/disputes/${disputeId}/resolve`, { resolution, note });
    toast('Dispute resolved.');
    adminOpenDispute(disputeId);
  } catch (e) {
    errEl.textContent = e.message || 'Could not resolve dispute';
  } finally {
    btn.disabled = false;
  }
  return false;
}


// ═══════════════════════════════════════════════════════════════════
// Badges tab
// Flow: search user → open → Add / Remove. Buttons here are convenience;
// POST/DELETE /api/admin/badges/... independently verify the caller is an
// administrator, so nothing in this file is a security boundary.
// Chips are drawn by js/badges.js (Badges.chip) from the server-supplied
// definitions — this file has no per-badge knowledge.
// ═══════════════════════════════════════════════════════════════════

let _adminBadgeDefs = null;    // [{ id, name, description, icon, color, tier, order, hidden, assignable, derived }]
let _adminBadgeUser = null;    // user currently open in the detail view
let _adminBadgeSearchSeq = 0;  // drops out-of-order search responses

async function adminLoadBadgeDefs() {
  if (!_adminBadgeDefs) _adminBadgeDefs = (await adminBadgeApi('GET', '/definitions')).badges;
  return _adminBadgeDefs;
}
const adminBadgeDef = id => (_adminBadgeDefs || []).find(d => d.id === id);

function adminBadgeVisible(viewId) {
  const el = document.getElementById(viewId);
  return !!el && el.style.display !== 'none';
}

async function adminBadgesOverview() {
  try {
    await adminLoadBadgeDefs();
  } catch (err) {
    toast(err.message, true);
    return;
  }
  document.getElementById('admin-badge-types').innerHTML = _adminBadgeDefs.map(d => `
    <div class="admin-badge-type">
      ${Badges.chip(d, { size: 'md' })}
      <div class="mp-row-main">
        <div class="mp-row-title">${escapeHtml(d.name)}</div>
        <div class="mp-row-sub">${escapeHtml(d.description || '')}</div>
      </div>
      ${d.derived ? '<span class="admin-flag" title="Awarded automatically from the user\'s role">Automatic</span>' : ''}
      ${d.hidden ? '<span class="admin-flag" title="Only administrators can see this badge">Hidden</span>' : ''}
    </div>
  `).join('') || '<div class="mp-empty">No badges are defined.</div>';
  adminBadgeRenderResults(); // re-run any current search so chips are fresh
  adminBadgeSearchNow();
  adminBadgeLoadLog();
}

// ── Search ──────────────────────────────────────────────────────────
const adminBadgeSearchInput = debounce(() => adminBadgeSearchNow(), 250);
let _adminBadgeResults = [];

async function adminBadgeSearchNow() {
  const q = document.getElementById('admin-badge-search').value.trim();
  const seq = ++_adminBadgeSearchSeq;
  if (!q) { _adminBadgeResults = []; adminBadgeRenderResults(); return; }
  try {
    const data = await adminBadgeApi('GET', '/users?q=' + encodeURIComponent(q));
    if (seq !== _adminBadgeSearchSeq) return;
    _adminBadgeResults = data.users;
    adminBadgeRenderResults(q);
  } catch (err) {
    if (seq === _adminBadgeSearchSeq) toast(err.message, true);
  }
}

function adminBadgeThumb(u) {
  const letter = escapeHtml((u.display_name || u.username || '?').charAt(0).toUpperCase());
  return u.avatar
    ? `<div class="mp-row-thumb"><img src="${escapeHtml(versionedMediaUrl(u.avatar))}" alt="" class="admin-badge-avatar" /></div>`
    : `<div class="mp-row-thumb">${letter}</div>`;
}

function adminBadgeChips(ids) {
  return ids.map(id => Badges.chip(adminBadgeDef(id), { size: 'md' })).join('');
}

function adminBadgeRenderResults(q) {
  const box = document.getElementById('admin-badge-results');
  const typed = document.getElementById('admin-badge-search').value.trim();
  if (!typed) { box.innerHTML = ''; return; }
  if (!_adminBadgeResults.length) {
    box.innerHTML = q ? '<div class="mp-empty">No users match that search.</div>' : '';
    return;
  }
  box.innerHTML = '<div class="admin-section-label">Users</div>' + _adminBadgeResults.map(u => `
    <div class="mp-order-row" data-id="${escapeHtml(u.id)}" onclick="adminOpenBadgeUser(this.dataset.id)">
      ${adminBadgeThumb(u)}
      <div class="mp-row-main">
        <div class="mp-row-title">${escapeHtml(u.display_name || u.username)}</div>
        <div class="mp-row-sub">@${escapeHtml(u.username)}${u.disabled ? ' · disabled' : ''}</div>
      </div>
      <div class="admin-badge-chips">${adminBadgeChips(u.badges) || '<span class="admin-muted">No badges</span>'}</div>
    </div>
  `).join('');
}

// ── Audit log ───────────────────────────────────────────────────────
async function adminBadgeLoadLog() {
  const box = document.getElementById('admin-badge-log');
  try {
    const { entries } = await adminBadgeApi('GET', '/log?limit=15');
    box.innerHTML = entries.length ? entries.map(e => `
      <div class="admin-log-row">
        <span class="admin-log-text">
          <b>${escapeHtml(e.actorName || 'Admin')}</b> ${e.action === 'added' ? 'added' : 'removed'}
          <b>${escapeHtml(e.badgeName)}</b> ${e.action === 'added' ? 'to' : 'from'}
          <b>@${escapeHtml(e.targetName || e.targetId)}</b>
        </span>
        <span class="admin-log-time">${new Date(e.createdAt).toLocaleString()}</span>
      </div>`).join('') : '<div class="mp-empty">No badge changes yet.</div>';
  } catch (err) {
    box.innerHTML = '<div class="mp-empty">Couldn\'t load recent changes.</div>';
  }
}

// ── One user ────────────────────────────────────────────────────────
async function adminOpenBadgeUser(userId) {
  try {
    await adminLoadBadgeDefs();
    const { user } = await adminBadgeApi('GET', '/users/' + encodeURIComponent(userId));
    _adminBadgeUser = user;
    adminShowView('admin-badge-user-view');
    adminRenderBadgeUser();
  } catch (err) {
    toast(err.message, true);
  }
}

function adminBackToBadges() {
  _adminBadgeUser = null;
  adminShowView('admin-badges-view');
  adminBadgesOverview();
}

function adminRenderBadgeUser(errorMsg) {
  const u = _adminBadgeUser;
  if (!u) return;
  const body = document.getElementById('admin-badge-user-body');
  const owned = u.badges.map(adminBadgeDef).filter(Boolean);
  const available = _adminBadgeDefs.filter(d => d.assignable && !u.badges.includes(d.id));

  const ownedRows = owned.length ? owned.map(d => `
    <div class="admin-badge-row">
      ${Badges.chip(d, { size: 'md' })}
      <div class="mp-row-main">
        <div class="mp-row-title">${escapeHtml(d.name)}${d.hidden ? ' <span class="admin-flag">Hidden</span>' : ''}</div>
        <div class="mp-row-sub">${escapeHtml(d.description || '')}</div>
      </div>
      ${d.assignable
        ? `<button type="button" class="btn-cancel admin-badge-remove" data-badge="${escapeHtml(d.id)}" onclick="adminRemoveBadge(this.dataset.badge)">Remove</button>`
        : '<span class="admin-flag" title="Awarded automatically from the user\'s role">Automatic</span>'}
    </div>`).join('') : '<div class="mp-empty" style="padding:18px 0;">No badges yet.</div>';

  const addForm = available.length ? `
    <form class="mp-form" onsubmit="return adminAddBadge(event)">
      <div>
        <label for="admin-badge-add-select">Badge</label>
        <select id="admin-badge-add-select">
          ${available.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions" style="justify-content:flex-start;">
        <button type="submit" class="btn-primary" id="admin-badge-add-btn">Add badge</button>
      </div>
    </form>`
    : '<div class="mp-empty" style="padding:18px 0;">This user already has every assignable badge.</div>';

  body.innerHTML = `
    <div class="admin-badge-user">
      ${adminBadgeThumb(u)}
      <div class="mp-row-main">
        <div class="mp-row-title">${escapeHtml(u.display_name || u.username)}</div>
        <div class="mp-row-sub">@${escapeHtml(u.username)} · <span class="admin-badge-id">${escapeHtml(u.id)}</span></div>
      </div>
    </div>
    ${errorMsg ? `<div class="admin-badge-error" role="alert">${escapeHtml(errorMsg)}</div>` : ''}
    <div class="admin-section-label">Current badges</div>
    ${ownedRows}
    <div class="admin-section-label">Add a badge</div>
    ${addForm}
  `;
}

async function adminAddBadge(event) {
  if (event) event.preventDefault();
  const u = _adminBadgeUser;
  const select = document.getElementById('admin-badge-add-select');
  if (!u || !select) return false;
  const btn = document.getElementById('admin-badge-add-btn');
  btn.disabled = true;
  try {
    const { user } = await adminBadgeApi('POST', '/users/' + encodeURIComponent(u.id) + '/badges', { badge_id: select.value });
    _adminBadgeUser = user;
    Badges.invalidate(user.id);
    toast(`${adminBadgeDef(select.value).name} badge added`);
    adminRenderBadgeUser();
  } catch (err) {
    // e.g. 409 if another admin just added the same badge → resync
    await adminReloadBadgeUser(err.message);
  }
  return false;
}

async function adminRemoveBadge(badgeId) {
  const u = _adminBadgeUser;
  const def = adminBadgeDef(badgeId);
  if (!u || !def) return;
  if (!confirm(`Remove the ${def.name} badge from @${u.username}?`)) return;
  try {
    const { user } = await adminBadgeApi('DELETE', '/users/' + encodeURIComponent(u.id) + '/badges/' + encodeURIComponent(badgeId));
    _adminBadgeUser = user;
    Badges.invalidate(user.id);
    toast(`${def.name} badge removed`);
    adminRenderBadgeUser();
  } catch (err) {
    await adminReloadBadgeUser(err.message);
  }
}

async function adminReloadBadgeUser(errorMsg) {
  if (!_adminBadgeUser) return;
  try {
    const { user } = await adminBadgeApi('GET', '/users/' + encodeURIComponent(_adminBadgeUser.id));
    _adminBadgeUser = user;
  } catch (_) { /* keep what we have */ }
  adminRenderBadgeUser(errorMsg);
}

// Called from dashboard.js on the 'badges_updated' WebSocket event so a
// second admin's change shows up without reopening the screen.
function adminOnBadgesUpdated(userId) {
  if (!currentUser || currentUser.role !== 'ADMIN') return;
  if (_adminBadgeUser && _adminBadgeUser.id === userId && adminBadgeVisible('admin-badge-user-view')) {
    adminReloadBadgeUser();
  } else if (adminBadgeVisible('admin-badges-view')) {
    adminBadgeSearchNow();
    adminBadgeLoadLog();
  }
}

// ─── Wallet tab: grant funds ──────────────────────────────────────────
// POST /api/admin/wallet/grant, gated server-side by requireAdmin —
// unlike the dev-only faucet (js/wallet.js / /api/dev/faucet), this
// credits *any* user's wallet and works in production.
async function adminSubmitGrantFunds(event) {
  if (event) event.preventDefault();
  const usernameEl = document.getElementById('admin-grant-username');
  const amountEl = document.getElementById('admin-grant-amount');
  const noteEl = document.getElementById('admin-grant-note');
  const btn = document.getElementById('admin-grant-submit-btn');

  const username = usernameEl.value.trim().replace(/^@/, '');
  const amount = amountEl.value;
  const note = noteEl.value.trim();
  if (!username || !amount) return false;

  btn.disabled = true;
  try {
    const { user, wallet } = await adminWalletApi('POST', '/grant', { username, amount, note: note || undefined });
    toast(`Granted ${amount} NX to @${user.username} (new balance: ${wallet.balanceDisplay})`);
    usernameEl.value = '';
    amountEl.value = '';
    noteEl.value = '';
    await adminWalletLoadLog();
  } catch (err) {
    toast(err.message || 'Failed to grant funds', true);
  }
  btn.disabled = false;
  return false;
}

async function adminWalletLoadLog() {
  const box = document.getElementById('admin-wallet-log');
  box.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    const { entries } = await adminWalletApi('GET', '/log?limit=15');
    box.innerHTML = entries.length ? entries.map(e => `
      <div class="admin-log-row">
        <span class="admin-log-text">
          <b>${escapeHtml(e.actorUsername || 'Admin')}</b> granted
          <b>${escapeHtml(e.amountDisplay)} NX</b> to
          <b>@${escapeHtml(e.targetUsername || e.targetUserId || 'unknown')}</b>
        </span>
        <span class="admin-log-time">${new Date(e.createdAt).toLocaleString()}</span>
      </div>`).join('') : '<div class="mp-empty">No grants yet.</div>';
  } catch (err) {
    box.innerHTML = '<div class="mp-empty">Couldn\'t load recent grants.</div>';
  }
}
