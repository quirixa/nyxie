// invite.js — the /invite/:code landing page (Discord-style invite screen).
//
// Anyone with a link, logged in or not, sees the server's name, icon and
// member count. A logged-in user can accept right on the page; a logged-out
// user is sent through login/register and brought straight back here
// (rememberPendingInvite / postAuthPath — auth.js calls postAuthPath after a
// successful login or registration).
//
// All server-supplied text (name, icon URL) goes in via textContent / img.src,
// never innerHTML, since server names are user-controlled.

(function () {
  const PENDING_KEY = 'nyxie_pending_invite';
  const PENDING_TTL_MS = 30 * 60 * 1000;
  let originalTitle = null;

  // ── "Where do I go after logging in?" ─────────────────────────────
  function rememberPendingInvite(code) {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ code, t: Date.now() })); } catch (_) {}
  }
  function clearPendingInvite() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
  }
  // Consumes the pending invite: '/invite/<code>' if one was left in the last
  // 30 minutes, otherwise '/app'.
  function postAuthPath() {
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch (_) {}
    clearPendingInvite();
    if (pending && /^[A-Za-z0-9_-]{4,16}$/.test(pending.code || '') && Date.now() - (pending.t || 0) < PENDING_TTL_MS) {
      return '/invite/' + encodeURIComponent(pending.code);
    }
    return '/app';
  }
  window.rememberPendingInvite = rememberPendingInvite;
  window.postAuthPath = postAuthPath;

  // ── tiny DOM helpers ──────────────────────────────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(label, className, onClick) {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function firstChar(word) { return Array.from(word || '')[0] || ''; }
  function initials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    const out = words.length > 1 ? firstChar(words[0]) + firstChar(words[1]) : Array.from(words[0]).slice(0, 2).join('');
    return out.toUpperCase();
  }
  function avatar(server) {
    const wrap = el('div', 'invite-avatar');
    const src = server && server.icon && typeof versionedMediaUrl === 'function' ? versionedMediaUrl(server.icon) : '';
    if (src) {
      const img = document.createElement('img');
      img.alt = '';
      img.addEventListener('error', () => { img.remove(); wrap.textContent = initials(server.name); });
      img.src = src;
      wrap.appendChild(img);
    } else {
      wrap.textContent = initials(server && server.name);
    }
    return wrap;
  }
  function memberLine(count) {
    const n = Number(count) || 0;
    const row = el('div', 'invite-stats');
    row.appendChild(el('span', 'invite-dot'));
    row.appendChild(el('span', null, n.toLocaleString() + (n === 1 ? ' Member' : ' Members')));
    return row;
  }

  // ── view ──────────────────────────────────────────────────────────
  async function initInviteView(code) {
    const view = document.getElementById('view-invite');
    const card = document.getElementById('invite-card');
    if (!view || !card) return;
    originalTitle = document.title;
    const alive = () => document.getElementById('view-invite') === view;
    const enc = encodeURIComponent(code);

    function show(...nodes) { if (alive()) card.replaceChildren(...nodes); }

    function renderMessage(title, text, actions, muted) {
      const av = el('div', 'invite-avatar invite-avatar-muted', muted || '?');
      show(av, el('h1', 'invite-title', title), el('p', 'invite-text', text), actions);
    }

    function homeButton() {
      const dest = isLoggedIn() ? '/app' : '/';
      return button(isLoggedIn() ? 'Continue to Nyxie' : 'Back to Nyxie', 'invite-btn invite-btn-secondary', () => router.navigate(dest));
    }

    async function accept(btn, errorEl) {
      btn.disabled = true;
      btn.textContent = 'Joining…';
      errorEl.textContent = '';
      try {
        const r = await fetch(`/api/invites/${enc}/join`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token }
        });
        if (r.status === 401) { clearSession(); rememberPendingInvite(code); return load(); }
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.error || 'Failed to join server');
        if (!alive()) return;
        clearPendingInvite();
        router.navigate('/servers/' + encodeURIComponent(data.server_id));
      } catch (e) {
        if (!alive()) return;
        errorEl.textContent = e.message || 'Failed to join server';
        btn.disabled = false;
        btn.textContent = 'Accept Invite';
      }
    }

    function renderInvite(server, me) {
      document.title = `Invite to ${server.name} — Nyxie`;
      const parts = [
        el('div', 'invite-eyebrow', "You've been invited to join"),
        avatar(server),
        el('h1', 'invite-title', server.name),
        memberLine(server.member_count)
      ];

      const actions = el('div', 'invite-actions');
      const error = el('div', 'invite-error');
      error.setAttribute('role', 'alert');

      if (!me) {
        parts.push(el('p', 'invite-text', 'Log in or create an account to accept this invite.'));
        actions.appendChild(button('Log in to join', 'invite-btn invite-btn-primary', () => { rememberPendingInvite(code); router.navigate('/login'); }));
        actions.appendChild(button('Create an account', 'invite-btn invite-btn-secondary', () => { rememberPendingInvite(code); router.navigate('/register'); }));
      } else if (me.banned) {
        parts.push(el('p', 'invite-text invite-text-danger', 'You are banned from this server.'));
        actions.appendChild(homeButton());
      } else if (me.already_member) {
        parts.push(el('p', 'invite-text', "You're already a member of this server."));
        actions.appendChild(button('Go to Server', 'invite-btn invite-btn-primary', () => router.navigate('/servers/' + encodeURIComponent(me.server_id))));
      } else {
        const acceptBtn = button('Accept Invite', 'invite-btn invite-btn-primary', () => accept(acceptBtn, error));
        actions.appendChild(acceptBtn);
      }

      parts.push(actions, error);

      if (me) {
        const who = currentUser && (currentUser.display_name || currentUser.username);
        const switchRow = el('div', 'invite-switch');
        switchRow.appendChild(document.createTextNode(who ? `Joining as ${who} · ` : ''));
        const link = el('button', 'invite-link', 'Not you?');
        link.type = 'button';
        link.addEventListener('click', () => { clearSession(); rememberPendingInvite(code); load(); });
        switchRow.appendChild(link);
        parts.push(switchRow);
      }
      show(...parts);
    }

    async function load() {
      show(el('div', 'invite-spinner'), el('p', 'invite-text', 'Loading invite…'));

      let pub = null, status = 0;
      try {
        const r = await fetch(`/api/invites/${enc}/public`, { cache: 'no-store' });
        status = r.status;
        pub = await r.json().catch(() => null);
      } catch (_) { /* fall through to the network-error screen */ }
      if (!alive()) return;

      if (!pub) {
        return renderMessage("Couldn't load this invite", 'Check your connection and try again.',
          button('Try again', 'invite-btn invite-btn-primary', load), '!');
      }
      if (status === 429 || status >= 500) {
        return renderMessage('Please try again in a moment', pub.error || 'Something went wrong.',
          button('Try again', 'invite-btn invite-btn-primary', load), '!');
      }
      if (!pub.valid || !pub.server) {
        document.title = 'Invite Invalid — Nyxie';
        return renderMessage('Invite Invalid', 'This invite is invalid or has expired. Ask the person who sent it for a new one.', homeButton());
      }

      // Logged in? Ask the authenticated endpoint for the per-user bits
      // (already a member / banned) and the server id for "Go to Server".
      let me = null;
      if (isLoggedIn()) {
        me = { already_member: false, banned: false, server_id: null };
        try {
          const r = await fetch(`/api/invites/${enc}`, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
          if (r.status === 401) {
            clearSession();   // stale/revoked token — treat as logged out
            me = null;
          } else {
            const d = await r.json().catch(() => null);
            if (d && d.server) me = { already_member: !!d.already_member, banned: !!d.banned, server_id: d.server.id };
          }
        } catch (_) { /* keep the defaults; joining will surface any real error */ }
        if (!alive()) return;
      }
      renderInvite(pub.server, me);
    }

    load();
  }

  function destroyInviteView() {
    if (originalTitle != null) document.title = originalTitle;
    originalTitle = null;
  }

  window.initInviteView = initInviteView;
  window.destroyInviteView = destroyInviteView;
})();
