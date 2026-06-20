# ── BUILD STAGE ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install openssl for Prisma engines
RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies including devDependencies for build
RUN npm install --legacy-peer-deps

# Copy source code and config
COPY tsconfig.json ./
COPY src ./src/

# Generate Prisma Client and compile TypeScript to JavaScript
RUN npx prisma generate
RUN npm run build

# Install only production dependencies to keep the final image minimal
RUN npm prune --production

# ── RUNNER STAGE ───────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Install openssl for Prisma runtime
RUN apk add --no-cache openssl

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy built code and dependencies
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/prisma ./prisma

# Expose Web UI port
EXPOSE 3000

# Expose auth directory for volume persistence (Crucial for WhatsApp QR Code session preservation)
VOLUME ["/usr/src/app/auth_info"]

# Start the application
CMD ["node", "dist/index.js"]
