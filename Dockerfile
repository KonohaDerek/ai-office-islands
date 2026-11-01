FROM node:22-bookworm-slim

ENV NODE_ENV=development \
    HOME=/home/node \
    CODEX_HOME=/home/node/.codex

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && npm install --global @anthropic-ai/claude-code @openai/codex \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-package-lock --no-audit --no-fund

COPY --chown=node:node . .
RUN mkdir -p /app/.docker-data /home/node/.claude /home/node/.codex \
    && chown -R node:node /app /home/node/.claude /home/node/.codex

USER node

EXPOSE 4173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4173"]
