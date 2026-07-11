# --- builder ---
FROM node:22-alpine AS builder
WORKDIR /app

# Install only production deps in a separate layer to maximize cache hits
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json next.config.mjs drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle

# Build the Next.js standalone bundle
RUN npm run build

# --- runner ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy only what's needed at runtime
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts
COPY package.json ./

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# Apply migrations on boot, then start the server.
CMD ["sh", "-c", "node --import tsx/esm scripts/migrate.ts && node server.js"]