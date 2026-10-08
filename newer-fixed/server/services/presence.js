// server/services/presence.js
//
// Nyxie has exactly four manually-selected statuses (no automatic idle —
// see server/websocket/index.js for where that's enforced). The `status`
// column on `users` is always the user's *last manually chosen preference*
// and is never rewritten by connect/disconnect — that's what lets it
// survive a page refresh or a dropped socket instead of silently resetting
// to "online".
//
// What another person is allowed to *see*, though, is different from the
// raw preference:
//   - If the user has no live WebSocket connection anywhere right now,
//     everyone (including the user's own other sessions) sees "offline" —
//     there's really nobody there.
//   - If they're connected and picked "invisible", everyone ELSE sees
//     "offline" (that's the whole point of Invisible), but their OWN
//     client still gets told "invisible" so their own UI can show the
//     status they actually picked rather than lying to them too.
//   - Otherwise, everyone sees the real picked status.
//
// Every place that hands a user's status to a client — REST routes and
// the WebSocket broadcasts alike — should go through effectiveStatus()
// instead of reading the `status` column directly, so this rule can't
// drift out of sync between the two transports.

const STATUSES = ['online', 'idle', 'dnd', 'invisible'];

function effectiveStatus(rawStatus, { connected, isSelf }) {
  const status = STATUSES.includes(rawStatus) ? rawStatus : 'online';
  if (!connected) return 'offline';
  if (status === 'invisible' && !isSelf) return 'offline';
  return status;
}

module.exports = { STATUSES, effectiveStatus };
