FROM node:22-bookworm

# Install system deps + Blender
RUN apt-get update && apt-get install -y \
  blender \
  curl \
  unzip \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Google USD tools (usdzconvert)
WORKDIR /opt
RUN curl -L https://github.com/google/usd_from_gltf/releases/download/v0.2/usd_from_gltf_linux.zip -o usd.zip \
  && unzip usd.zip \
  && chmod +x usdzconvert \
  && mv usdzconvert /usr/local/bin/usdzconvert \
  && rm -rf usd.zip

# App setup
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Render uses PORT
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
