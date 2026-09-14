# FAQ

### What does "quantum-resistant" actually mean here?

Lattix uses NIST's post-quantum algorithms — **ML-KEM-768** (FIPS 203) for
key exchange and **ML-DSA-65** (FIPS 204) for signatures — plus AES-256-GCM,
which stays strong against quantum attacks. So even an adversary with a large
quantum computer can't decrypt captured traffic or forge messages. See
[Cryptography](Cryptography).

### Can the server read my messages?

No. Everything is encrypted in your browser before it's sent. The server stores
only ciphertext and public keys. It also can't forge messages, because it holds
no one's signing key. The one thing a malicious server could *try* is handing you
the wrong public key for a contact — which **safety-code verification** detects.
See [Security & Trust Model](Security-and-Trust-Model).

### I forgot my password. Can I get my account back?

No. Your keys are sealed with your password into a local vault that never leaves
your device, and it can't be recovered. Keep an **encrypted backup** and/or an
exported **vault** file (Settings) so you can restore. If the vault is truly
lost, create a new account.

### Does it work without internet / CDNs?

The frontend has zero external dependencies and works offline; the post-quantum
library is vendored locally. You still need to reach a relay server for delivery.

### Why does it need HTTPS to be hosted?

Browsers only expose the Web Crypto API in a **secure context**. Off `localhost`,
that means `https://`. Every deployment option terminates TLS for you. See
[Self-Hosting & Deployment](Self-Hosting-and-Deployment).

### Can I run it for my whole company / scale it up?

It's built as a **single instance** (sessions and real-time delivery are held in
memory), which is perfect for a family or a team. It is not designed for
horizontal autoscaling; doing that would require moving sessions and pub/sub into
Redis. See [Architecture](Architecture).

### Are group chats really end-to-end encrypted?

Yes. The content key is wrapped separately for every member, and signatures are
bound to the group so an envelope can't be replayed elsewhere. The relay still
only sees ciphertext.

### Do disappearing messages really get deleted?

They're removed from the UI when the timer elapses and purged from the server by
a background sweep, so they don't come back on reload. As with any messaging app,
a determined recipient could still screenshot or copy content before it expires.

### Why no push notifications to my phone number?

Real SMS/phone push would require storing phone numbers and routing through a
third-party gateway — leaking metadata and breaking the zero-knowledge model.
Lattix instead offers **in-app tones and desktop notifications** while the app is
open. See [Features](Features).

### Is my profile picture encrypted?

Profile images are shared through the directory so other users can see them, so
they are **not** end-to-end encrypted (unlike your messages and files). Keep that
in mind when choosing one.

### Is Lattix audited / production-ready?

It's a careful **reference implementation**, not a formally audited product. It's
great for learning and for small trusted groups. Get a professional review before
trusting it with lives. See [Security & Trust Model](Security-and-Trust-Model).

### How do I move to a new device?

Export your **vault** (Settings → Export vault) on the old device and **Import a
vault** on the new one, or restore an **encrypted backup**. Your username and
keys carry over.

### Where can I report a bug or a security issue?

Open a GitHub issue for bugs. Report security vulnerabilities privately via the
repository's security advisory feature.
