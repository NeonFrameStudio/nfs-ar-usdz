FROM node:22-bookworm

# System deps + Blender
RUN apt-get update && apt-get install -y \
  blender \
  curl \
  unzip \
  file \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install usdzconvert from google/usd_from_gltf (robust)
WORKDIR /opt
RUN set -eux; \
  URL="https://github.com/google/usd_from_gltf/releases/download/v0.2/usd_from_gltf_linux.zip"; \
  curl -fL "$URL" -o usd.zip; \
  file usd.zip; \
  # Make sure it's actually a zip:
  unzip -t usd.zip; \
  unzip usd.zip; \
  chmod +x usdzconvert; \
  mv usdzconvert /usr/local/bin/usdzconvert; \
  rm -rf usd.zip

# App
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
