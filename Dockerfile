FROM node:20-alpine

WORKDIR /app

# Install production deps. Using `npm install` (not `npm ci`) so the lockfile
# doesn't need regenerating outside a node environment.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

# users.json + sessions live here; mount a persistent volume in Coolify.
ENV DATA_DIR=/data
VOLUME ["/data"]

CMD ["node", "index.js"]
