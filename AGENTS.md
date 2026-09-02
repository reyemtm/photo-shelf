# AGENTS.md — Photo Shelf

## Role

- Implement the **Photo Shelf** app per `IDEA.yml`.
- Stack: Node 22 + `node:http` + vanilla HTML/CSS/JS. Deps: `exifr` (EXIF), `sharp` (WebP thumbnails). Storage: temp JSON store (`data/photos.json`) — SQLite later.
- PWA-enabled; share target is `/api/photos`.

## 🔒 Public repo — never commit sensitive data

This repository is **public** (github.com/reyemtm/photo-shelf). Before committing anything:

- **No env values / secrets** — never commit real `AUTH_USERNAME` / `AUTH_PASSWORD` / tokens / API keys / cookies. Real values live only in the environment (Coolify env vars or a local `.env` file, which is gitignored).
- **No IP addresses** — no real host IPs anywhere; use `localhost`/hostnames or placeholders in examples. `.freebuff/` (local run docs, logs, absolute paths) is gitignored.
- **No usernames** — no reddit (or other service) usernames/handles in code, docs, or examples.
- All configuration values come from environment variables — see `.env.sample` for the full list.

If a change would embed any of the above, refactor it to read from env instead.

## Working notes

- Keep decisions, findings, and follow-ups in **LOG.json** (structured below).
- Prefer editing existing files over creating new ones.
- Match the project's existing conventions; verify a dependency is already used before adding it.

## LOG.json schema

```json
{
  "logs": [
    {
      "timestamp": "ISO-8601",
      "type": "data | note | file",
      "summary": "short title",
      "detail": "..."
    }
  ]
}
```

- `type: data` — facts, specs, API shapes, DB schema decisions.
- `type: note` — progress, blockers, next actions.
- `type: file` — files created/changed and why.

## Communication style

- Answer in concise bullet points where possible.
- Lead with the decision or outcome; details follow only if needed.

## Current status

- See `IDEA.yml` for the original spec.
- Working app: URL → download → EXIF → WebP thumb → JSON store; gallery UI with camera filter, lightbox, delete + tombstones; basic auth via env; reddit scraper with dedupe.
