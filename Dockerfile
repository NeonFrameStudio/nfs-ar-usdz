# ---------- Stage 1: get usd_from_gltf tool ----------
FROM leon/usd-from-gltf:latest AS usdtools

# ---------- Stage 2: your actual web service ----------
FROM node:22-bookworm

# Blender for GLB generation + certs
RUN apt-get update && apt-get install -y \
  blender \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy usd_from_gltf tool + its runtime bits from the tools image
# (copying /usr/local is the most reliable “just works” approach)
COPY --from=usdtools /usr/local /usr/local

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
