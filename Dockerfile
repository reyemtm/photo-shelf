# ---------- Stage 1: install dependencies ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# exifr (pure JS) + sharp (ships prebuilt musl binaries) — no build tools needed
RUN npm ci --omit=dev

# ---------- Stage 2: runtime — plain Alpine + node from apk ----------
# Nothing native remains, so a bare Alpine image with the nodejs package is the
# smallest correct base (node:22-alpine is roughly 2x bigger).
FROM alpine:3.22
RUN apk add --no-cache nodejs su-exec \
  && addgroup -S app && adduser -S -G app -u 1001 app
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Per IDEA.yml: DB (temp JSON for now) at /data, images at /data/images/
ENV DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY index.js ./
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
# Note: /app stays root-owned (world-readable) — only /data needs to be
# writable, and the entrypoint chowns that at runtime. chowning /app here
# would duplicate the ~31MB node_modules layer in the image.

# The entrypoint runs as root once — it ensures the (possibly bind-mounted)
# /data directory is writable, then drops privileges before starting node.
# There is deliberately no USER directive: the drop happens inside the
# entrypoint so volumes can be chowned on every start.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "index.js"]

EXPOSE 3000