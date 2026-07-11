# Lattix Wiki source

These Markdown files are the **GitHub Wiki** for Lattix. A GitHub wiki is a
separate git repository (`<repo>.wiki.git`), so these pages are kept here in the
main repo for version control and reviewed changes, then published to the wiki.

## Pages

| File | Wiki page |
|------|-----------|
| `Home.md` | Landing page |
| `_Sidebar.md` | Navigation sidebar (special file) |
| `_Footer.md` | Page footer (special file) |
| `Getting-Started.md` | Install & first run |
| `Features.md` | Full feature tour |
| `Architecture.md` | How the system fits together |
| `Cryptography.md` | Algorithms & envelope scheme |
| `Security-and-Trust-Model.md` | Threat model & limitations |
| `Configuration.md` | Environment variables |
| `API-Reference.md` | REST + WebSocket API |
| `Self-Hosting-and-Deployment.md` | Hosting it publicly |
| `Desktop-Apps-and-Extension.md` | Installers & Chrome extension |
| `Development-and-Contributing.md` | Dev setup & contributing |
| `FAQ.md` | Common questions |

File names map to page titles: hyphens become spaces (e.g.
`Getting-Started.md` → **Getting Started**). Internal links use the hyphenated
name without the extension, e.g. `[Features](Features)`.

## Publishing to the GitHub wiki

The wiki repo doesn't exist until the wiki has at least one page:

1. On GitHub, open the repo → **Settings → Features** and ensure **Wikis** is
   enabled. Then open the **Wiki** tab and click **Create the first page**
   (any content — it's overwritten in the next step). This initializes
   `Lattix.wiki.git`.
2. Clone the wiki repo and copy these files into it:
   ```bash
   git clone https://github.com/aingram702/Lattix.wiki.git
   cp Lattix/wiki/*.md Lattix.wiki/
   cd Lattix.wiki
   git add .
   git commit -m "Publish wiki"
   git push
   ```
3. Visit the repo's **Wiki** tab — Home, the sidebar, and all pages will render.

To keep the wiki in sync later, edit the files here, then repeat the copy/commit/
push in step 2. (If you prefer automation, a small GitHub Actions job can push
`Lattix/wiki/*.md` to the wiki repo on change.)
