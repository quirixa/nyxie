# Nyxie E2EE Attachments

Adds client-side end-to-end encryption for Nyxie attachments.

## What's Included

* Client-side encryption for image and file attachments
* E2EE voice messages
* Per-attachment encryption keys
* Encrypted attachment metadata
* Authenticated encryption with nonce protection
* Server stores encrypted attachment ciphertext instead of plaintext
* Existing E2EE text messaging remains unchanged
* Attachment encryption and decryption tests

## Attachment Flow

```text
File
  |
  v
Client generates random encryption key
  |
  v
Client encrypts file
  |
  v
Encrypted ciphertext uploaded
  |
  v
Server stores ciphertext
  |
  v
E2EE message contains attachment metadata
  |
  v
Recipient downloads ciphertext
  |
  v
Recipient decrypts locally
  |
  v
Original file
```

## Security Model

The server should never have access to:

* Plaintext attachment contents
* Attachment encryption keys
* Plaintext E2EE message contents

Attachments are encrypted before they are uploaded.

> This implementation has not been independently audited and should be considered experimental. Do not use it for highly sensitive communications until the cryptographic design has been professionally reviewed.

## Testing

Run locally with:

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

Test with two separate accounts and verify:

1. Text messages still work.
2. Images can be encrypted, uploaded, downloaded, and decrypted.
3. Voice messages work.
4. Uploaded files are ciphertext on the server.
5. Tampering with an encrypted attachment causes authentication or decryption to fail.
6. The recipient can decrypt attachments while the server cannot.

## Environment

Create a `.env` file containing the required server secrets:

```env
PORT=3000
JWT_SECRET=your-secret-here
NODE_ENV=development
```

Never commit `.env` or plaintext uploaded data to the repository.

## Status

**Experimental — E2EE attachment implementation**

This commit focuses on making Nyxie's media and attachment pipeline E2EE while preserving the existing application architecture.
