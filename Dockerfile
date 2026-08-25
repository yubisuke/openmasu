FROM node:22.18.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/runtime/package.json apps/runtime/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/attribution-core/package.json packages/attribution-core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm install --global npm@11.6.2 && npm ci

COPY . .

EXPOSE 8080
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
