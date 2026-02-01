FROM node:22-bookworm

# ---------------- Linux deps ----------------
RUN apt-get update && apt-get install -y \
  wget \
  unzip \
  python3 \
  ca-certificates \
  libxxf86vm1 \
  libx11-6 \
  libxext6 \
  libxi6 \
  libxrender1 \
  libxfixes3 \
  libxkbcommon0 \
  libgl1 \
  libglib2.0-0 \
  libsm6 \
  libice6 \
  libxrandr2 \
  libxinerama1 \
  libxcursor1 \
  libasound2 \
  libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/*

# ---------------- Blender 3.6 ----------------
WORKDIR /opt
RUN wget https://download.blender.org/release/Blender3.6/blender-3.6.5-linux-x64.tar.xz \
  && tar -xf blender-3.6.5-linux-x64.tar.xz \
  && rm blender-3.6.5-linux-x64.tar.xz

ENV PATH="/opt/blender-3.6.5-linux-x64:${PATH}"

# ---------------- USDZ converter ----------------
WORKDIR /opt
RUN wget https://github.com/google/usd_from_gltf/releases/download/v0.2/usd_from_gltf_linux.zip \
  && unzip usd_from_gltf_linux.zip \
  && chmod +x usdzconvert \
  && mv usdzconvert /usr/local/bin/usdzconvert \
  && rm usd_from_gltf_linux.zip

# ---------------- App ----------------
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
