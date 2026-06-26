FROM node:22-alpine

# System deps: Docker CLI (to control host Docker), rsync, git
RUN apk add --no-cache docker-cli rsync git curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright + Chromium
RUN npx playwright install chromium --with-deps 2>/dev/null || \
    npx playwright install chromium

COPY . .

RUN mkdir -p workspace

EXPOSE 4000

CMD ["node", "server/index.js"]
