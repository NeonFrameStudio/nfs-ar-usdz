FROM node:22-bookworm

# Blender + basic libs (Render-friendly)
RUN apt-get update && apt-get install -y \
  blender \
  ca-certificates \
  wget \
  unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
