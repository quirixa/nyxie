# Nyxie

A Discord-style chat and social app with real-time messaging, end-to-end encrypted DMs, seed-phrase authentication, and a built-in token wallet. The backend is built from scratch on Node.js and Express, and the frontend is vanilla JavaScript with no framework.

## Features

**Messaging**
- Real-time messaging over WebSockets
- Message reactions, reply threading, inline edit and delete, and an emoji picker
- Read receipts
- Blocking across friends, rooms, and the WebSocket layer
- Route-based URL navigation (Express + History API)

**Privacy and security**
- End-to-end encrypted direct messages using ECDH (P-256) keypairs
- Keys are generated in the browser, and the server stores ciphertext only
- JWT authentication with BIP-39 seed phrase hashing

**NX wallet**
- Double-entry ledger for NX tokens
- Wallet and settings routes

**Interface**
- Full chat dashboard
- Mobile layout with a Discord-style bottom tab bar
- Multi-theme architecture shared across the dashboard and settings pages, including a Retro / Windows 95 theme

## Tech Stack

| Layer | Technology |
|-------|------------|
| Server | Node.js, Express |
| Database | SQLite via [sql.js](https://github.com/sql-js/sql.js) |
| Real-time | WebSockets |
| Auth | JWT, BIP-39 seed phrases |
| Encryption | Web Crypto API (ECDH P-256) |
| Frontend | Vanilla JS, HTML, CSS |

## Getting Started

### Prerequisites
- Node.js (LTS recommended)
- npm

### Installation

```bash
git clone <your-repo-url>
cd nyxie
npm install
```

### Configuration

Create a `.env` file in the project root:

```env
PORT=3000
JWT_SECRET=change-me
```

### Run

```bash
npm start
```

Then open `http://localhost:3000` in your browser.

## Project Structure

```
nyxie/
├── server.js            # Express app + WebSocket server
├── routes/              # API routes (auth, wallet, settings, ...)
├── public/
│   ├── dashboard.html   # Main chat UI (single-file, vanilla JS)
│   ├── settings.html    # Settings UI
│   └── themes/          # CSS themes
└── ...
```

> Adjust the layout above to match your actual folders.

## How It Works

### Authentication
Accounts are created with a BIP-39 seed phrase. The phrase is hashed for verification, and sessions are issued as JWTs.

### End-to-end encryption
Each user's browser generates an ECDH P-256 keypair. Public keys are shared through the server, and a shared secret is derived client-side for each conversation. Messages are encrypted before they leave the browser, and the server only ever stores ciphertext and nonces.

### Wallet
NX transfers are recorded as paired debit and credit entries in a double-entry ledger, so balances can always be reconstructed from the transaction history.

### Data storage
sql.js runs SQLite in-process. Messages and users live in separate databases, so schema changes need to be applied to each one (for example, the `nonce` column on encrypted messages).

## Theming

Themes are plain CSS files that override shared CSS variables, applied consistently across `dashboard.html` and `settings.html`. To add a theme, define the same variable set as an existing theme and register it in the settings page.

## Roadmap

- [ ] Add your planned features here

## License

Add your license here.