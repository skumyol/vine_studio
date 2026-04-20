# --- Build Stage ---
FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm via standalone installer (force IPv4 for flaky networks)
RUN apt-get -o Acquire::ForceIPv4=true update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL --ipv4 https://get.pnpm.io/install.sh | sh - && \
    mv /root/.local/share/pnpm/pnpm /usr/local/bin/pnpm && \
    rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY package*.json ./
RUN pnpm install

# Copy source code
COPY . .

# Build frontend and backend
RUN pnpm run build

# --- Production Stage ---
FROM mcr.microsoft.com/playwright:v1.49.1-noble AS runner

# Noble is Ubuntu 24.04, which is modern and stable.
# We use the playwright image because it has all system dependencies for Chromium.

WORKDIR /app

# Install curl for healthcheck and pnpm (force IPv4)
RUN apt-get -o Acquire::ForceIPv4=true update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL --ipv4 https://get.pnpm.io/install.sh | sh - && \
    mv /root/.local/share/pnpm/pnpm /usr/local/bin/pnpm && \
    rm -rf /var/lib/apt/lists/*

# Copy package files for production install
COPY package*.json ./

# Install production dependencies
RUN pnpm install --prod

# Install only the chromium browser for Playwright to save space
RUN pnpm exec playwright install chromium

# Copy the built artifacts from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/tessdata ./tessdata
# Copy any other static assets if needed, though vite usually puts them in dist

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["pnpm", "start"]
