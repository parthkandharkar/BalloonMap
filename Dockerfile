# ---- deps (install all to build client) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ---- build client (Vite) ----
FROM deps AS client-build
WORKDIR /app
COPY . .
# Produces /app/dist
RUN npm run build

# ---- runtime (only prod deps) ----
FROM node:22-alpine AS runner
ENV NODE_ENV=production

WORKDIR /app
# Install only production deps for the server
COPY package*.json ./
RUN npm ci --omit=dev

# Server source
COPY server ./server
# Built client from previous stage
COPY --from=client-build /app/dist ./dist

# Defaults (overridable)
ENV PORT=3000
ENV ENRICH=0

EXPOSE 3000
CMD ["node", "server/index.js"]
