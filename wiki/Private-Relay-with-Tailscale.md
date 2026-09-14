# Private Relay with Tailscale

The simplest **and** safest way to run a Lattix relay for a trusted group
(family, a team). Your server never touches the public internet — no open ports,
no domain to buy, no certificate to manage — yet everyone reaches it from
anywhere over real HTTPS.

**What you get:** the relay runs bound to `localhost` on some always-on machine;
[Tailscale](https://tailscale.com) puts that machine on your private network and
serves it at `https://<machine>.<your-tailnet>.ts.net`, reachable only by devices
you've added to your tailnet. Tailscale's WireGuard tunnel wraps everything,
*underneath* Lattix's own end-to-end encryption.

```
 your phone ─┐
 your laptop ─┼─(WireGuard / Tailscale)─► https://lattix.<tailnet>.ts.net ─► 127.0.0.1:8000 (Lattix)
 grandma's PC ┘                                   (no public ports, valid TLS cert)
```

## Prerequisites

- An **always-on machine** to be the server: a Raspberry Pi, a mini-PC, an old
  laptop, or a cheap VPS. (These steps assume Linux; Tailscale also runs on
  macOS/Windows.) Because Tailscale traverses NAT, a machine **at home works
  without opening any router ports.**
- A free **Tailscale account** (https://tailscale.com — "Personal" plan is fine).
- The **Tailscale app** on each person's device (iOS, Android, macOS, Windows,
  Linux).

---

## Step 1 — Run the relay, bound to localhost

Run Lattix so it listens only on `127.0.0.1:8000` (never directly exposed) with a
persistent database. Pick one:

**Option A — Docker (recommended).** From a clone of the repo:

```bash
git clone https://github.com/aingram702/Lattix.git
cd Lattix/Lattix
docker build -t lattix .
docker run -d --name lattix --restart unless-stopped \
  -p 127.0.0.1:8000:8000 \
  -v lattix-data:/data \
  lattix
```

The `-p 127.0.0.1:8000:8000` binds to loopback only, and `-v lattix-data:/data`
persists everything (the image already sets `LATTIX_DB=/data/lattix.db`).
*(Once the repo's `docker-image` workflow has published a package you can skip the
build and use `ghcr.io/aingram702/lattix:latest` instead.)*

**Option B — Linux installer.** Install the `.run`
([Desktop Apps & Extension](Desktop-Apps-and-Extension)); it runs the relay on
`127.0.0.1:8000` and stores data in `~/.local/share/lattix`. Best when the server
is a desktop you log into.

**Option C — from source, as a service.** `pip install -r requirements.txt`, then
run `python run.py --no-browser` under a process manager (a systemd unit) so it
restarts on boot. It binds `127.0.0.1:8000` by default.

**Verify it's up locally:**

```bash
curl http://127.0.0.1:8000/api/health
# -> {"status":"ok","version":"1.1.0"}
```

---

## Step 2 — Install Tailscale on the server

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the printed URL to authenticate the machine into your tailnet. Confirm and
note its name:

```bash
tailscale status        # shows this machine's name, e.g. "lattix"
```

---

## Step 3 — Enable MagicDNS and HTTPS

In the Tailscale **admin console** (https://login.tailscale.com/admin/dns):

1. Enable **MagicDNS** (gives each machine a `*.ts.net` name).
2. Enable **HTTPS Certificates** (lets Tailscale issue a valid Let's Encrypt cert
   for that name — this is what makes the browser crypto work).

---

## Step 4 — Serve Lattix over HTTPS on your tailnet

One command publishes your local `:8000` as HTTPS across the tailnet:

```bash
sudo tailscale serve --bg 8000
```

Then confirm the URL:

```bash
tailscale serve status
# https://lattix.<your-tailnet>.ts.net  ->  http://127.0.0.1:8000
```

> Needs a recent Tailscale (v1.60+). If your version's syntax differs, run
> `tailscale serve --help`; the older form is
> `sudo tailscale serve https / http://127.0.0.1:8000`.

`--bg` runs it in the background and persists across reboots (the `tailscaled`
service comes back automatically).

**Test it:** from another device already on your tailnet, open
`https://lattix.<your-tailnet>.ts.net` — you should get the padlock and the
Lattix welcome screen.

---

## Step 5 — Add the people who'll use it

1. On each person's phone/laptop, install the **Tailscale app** and sign in.
2. Get them onto **your** tailnet — either invite them from the admin console
   (**Users → Invite**), or have them share/join per your setup. Approve new
   devices if device approval is on.
3. If you've customized **ACLs**, make sure tailnet users are allowed to reach the
   server node on port 443. (A default personal tailnet allows this already.)
4. Give them the URL `https://lattix.<your-tailnet>.ts.net`. In the **Chrome
   extension**, they set it under **Settings → Relay server**.

Each person then **creates their own account** in Lattix and you chat as normal —
including [groups](Features#group-chats). Remember to **verify safety codes** with
each contact ([Security & Trust Model](Security-and-Trust-Model)).

---

## Optional — let non-Tailscale people in (Tailscale Funnel)

If you need someone who *won't* install Tailscale to reach the relay, **Funnel**
exposes it to the public internet (still with valid HTTPS):

```bash
sudo tailscale funnel --bg 8000
```

This trades away the "no public exposure" safety benefit — anyone with the URL
can reach the login page (though Lattix's own auth and rate limiting still apply).
Enable Funnel for the node in the admin console first; it only works on ports
443/8443/10000. If you find yourself wanting broad public access, the
[VPS + Caddy](Self-Hosting-and-Deployment#option-a--your-own-server-with-docker--automatic-https-recommended)
path is a better fit.

---

## Keeping it running and safe

- **Always on:** Docker `--restart unless-stopped` (or a systemd unit) keeps the
  relay up; `tailscale serve --bg` and `tailscaled` survive reboots.
- **Updates:** `docker pull`/rebuild and `docker compose`/`docker run` again for
  Lattix; `sudo tailscale update` for Tailscale. Keep the host patched.
- **Backups:** everything is one SQLite file. With the Docker setup:
  ```bash
  docker run --rm -v lattix-data:/data -v "$PWD":/backup alpine \
    cp /data/lattix.db /backup/lattix-backup-$(date +%F).db
  ```
- **Handy commands:**
  ```bash
  tailscale status          # who's on the tailnet
  tailscale serve status    # what's being served
  sudo tailscale serve --bg=false 8000   # stop serving (or: tailscale serve reset)
  ```
- **Why this is safe:** no inbound ports are open, the relay isn't on the public
  internet, and traffic is WireGuard-encrypted on top of Lattix's E2E encryption.
  Even so, the relay only ever holds ciphertext — verify safety codes to defeat
  key substitution.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Browser warns "not secure" / crypto errors | HTTPS Certificates aren't enabled (Step 3), or you opened the machine's raw IP/`:8000` instead of the `https://…ts.net` name. |
| `tailscale serve` says HTTPS unavailable | Enable **HTTPS Certificates** and **MagicDNS** in the admin console, then retry. |
| Can't reach the URL from another device | That device isn't on the tailnet (Step 5), or ACLs block it. Check `tailscale status` on both ends. |
| Page loads but messages don't arrive live | WebSockets: `tailscale serve` proxies them fine, but confirm the app is actually on `127.0.0.1:8000` (`curl` the health endpoint on the server). |
| Everyone shares one login rate-limit | Expected: the app sees connections from localhost via serve, so per-IP limits are shared. Fine for a trusted group. |
| URL works only while you're SSH'd in | The relay process stopped. Use `--restart unless-stopped` (Docker) or a systemd unit so it runs independently. |

See also [Self-Hosting & Deployment](Self-Hosting-and-Deployment) for public
hosting options and [Configuration](Configuration) for environment variables.
