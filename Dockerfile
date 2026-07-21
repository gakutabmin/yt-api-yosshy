FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PATH="/opt/venv/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U pip \
    && /opt/venv/bin/pip install --no-cache-dir -U yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

USER node

EXPOSE 3000

CMD ["npm", "start"]
