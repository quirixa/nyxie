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

let _adminPage = 1;
let _adminHasNextPage = false;
let _adminCurrentDispute = null; // { dispute, order } most recently loaded

async function adminApi(method, path, body) {
  const res = await fetch('/api/admin/marketplace' + path, {
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
  adminShowView('admin-disputes-view');
  _adminPage = 1;
  await adminReloadDisputes();
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
