# ---------- Stage 1: get usd_from_gltf tool ----------
FROM leon/usd-from-gltf:latest AS usdtools

# ---------- Stage 2: your actual web service ----------
FROM node:22-bookworm

# System deps (curl/xz for blender download, zip for usdz, certs)
RUN apt-get update && apt-get install -y \
  ca-certificates \
  curl \
  xz-utils \
  zip \
  && rm -rf /var/lib/apt/lists/*

# ---- Install OFFICIAL Blender (includes USD exporter) ----
# Pick a stable LTS-ish version. 4.x is fine; 3.6 LTS is also fine.
ENV BLENDER_VERSION=4.1.1
RUN curl -L "https://download.blender.org/release/Blender4.1/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
  -o /tmp/blender.tar.xz \
  && tar -xJf /tmp/blender.tar.xz -C /opt \
  && ln -s "/opt/blender-${BLENDER_VERSION}-linux-x64/blender" /usr/local/bin/blender \
  && rm -f /tmp/blender.tar.xz

# Copy usd_from_gltf tool + runtime bits (optional but kept)
COPY --from=usdtools /usr/local /usr/local

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
