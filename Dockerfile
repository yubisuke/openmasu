FROM node:22.18.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/runtime/package.json apps/runtime/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/redirector/package.json apps/redirector/package.json
COPY packages/attribution-core/package.json packages/attribution-core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/meta-install-referrer/package.json packages/meta-install-referrer/package.json
COPY packages/redirector-core/package.json packages/redirector-core/package.json
RUN npm install --global npm@11.6.2 && npm ci

COPY . .

EXPOSE 8080 8090
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
