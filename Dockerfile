# ---------- Stage 1: get usd_from_gltf tool ----------
FROM leon/usd-from-gltf:latest AS usdtools

# ---------- Stage 2: your actual web service ----------
FROM node:22-bookworm

# System deps:
# - curl/xz-utils to download/extract Blender
# - zip to package USDZ
# - a few libs Blender needs even headless
RUN apt-get update && apt-get install -y \
  ca-certificates \
  curl \
  xz-utils \
  zip \
  libx11-6 \
  libxext6 \
  libxrender1 \
  libxfixes3 \
  libxi6 \
  libxxf86vm1 \
  libxkbcommon0 \
  libglib2.0-0 \
  libsm6 \
  libice6 \
  libgl1 \
  libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/*

# ---- Install OFFICIAL Blender (includes USD exporter) ----
ENV BLENDER_VERSION=4.1.1
RUN set -eux; \
  curl -L "https://download.blender.org/release/Blender4.1/blender-${BLENDER_VERSION}-linux-x64.tar.xz" -o /tmp/blender.tar.xz; \
  tar -xJf /tmp/blender.tar.xz -C /opt; \
  ln -sf "/opt/blender-${BLENDER_VERSION}-linux-x64/blender" /usr/local/bin/blender; \
  rm -f /tmp/blender.tar.xz; \
  which blender; \
  blender --version

# Copy usd_from_gltf tool + runtime bits (optional)
COPY --from=usdtools /usr/local /usr/local

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
