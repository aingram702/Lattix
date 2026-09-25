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
the wrong public key for a contact. Lattix computes safety codes itself, pins
each contact's key, and warns you if a verified contact's key changes — verify
the contacts that matter by scanning their QR code or comparing codes. See
[Security & Trust Model](Security-and-Trust-Model).

### A red banner says a contact's safety code changed. What do I do?

Ask them — over a call or in person — whether they reinstalled Lattix, moved
device, or created a new account. If they did, compare the new code (**Review**)
and mark them verified again, or **Accept new code**. If they didn't, don't send
anything sensitive: someone, possibly the relay, may be substituting keys.
Sending to them stays paused until you decide.

### Can the relay see my file names?

Not since 2.2. Names, types and sizes are encrypted along with the file. Files
sent from 2.1 or earlier had their names stored in plain text.

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
a background sweep, so they don't come back on reload. File messages take their
encrypted file with them. The timer is enforced by the relay, so a hostile relay
could keep messages. As with any messaging app,
a determined recipient could still screenshot or copy content before it expires.

### Why no push notifications to my phone number?

Real SMS/phone push would require storing phone numbers and routing through a
third-party gateway — leaking metadata and breaking the zero-knowledge model.
Lattix instead offers **in-app tones and desktop notifications** while the app is
open. See [Features](Features).

### I'm upgrading from 1.x — is there anything to do?

No. [2.0](Release-Notes) changes the interface, not the cryptography or the wire
format. Your keys, chats, groups and settings carry over untouched — there's no
database migration, no vault re-encryption, and no re-registration. Update the
relay and reload the client. Old and new clients also interoperate on the same
relay while you're rolling it out.

### Can I use Lattix with a keyboard only, or with a screen reader?

Yes. Every control is keyboard-operable, dialogs trap focus and return it when
they close, and the UI carries ARIA roles, labels and live regions. Every theme
passes an automated axe-core WCAG 2.1 A/AA audit with no serious or critical
violations. Shortcuts are listed in **Settings → Keyboard**. See
[Features](Features#accessibility--keyboard).

### Are inline image previews safe?

They're only ever applied to a message whose **ML-DSA signature verified** — a
forged or tampered envelope stays an inert file card you have to open
deliberately. The image is decrypted locally like any other file; nothing is
fetched from a third party. SVG is never previewed. Previews are **on by
default**; turn them off under **Settings → Media**.

### Does it stay usable with thousands of messages?

Yes. Renders are batched into one animation frame rather than running per arriving
message, and the conversation renders a capped window with a **Load earlier**
button instead of putting the whole history in the DOM. Nothing is dropped —
only what's rendered is limited. See [Architecture](Architecture#rendering).

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
keys carry over. Key pins (which contacts you verified) are per browser, so
re-verify important contacts on the new device.

### Where can I report a bug or a security issue?

Open a GitHub issue for bugs. Report security vulnerabilities privately via the
repository's security advisory feature.
