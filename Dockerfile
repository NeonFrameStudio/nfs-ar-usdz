FROM node:22-bookworm

# ---- install deps ----
RUN apt-get update && apt-get install -y \
  wget \
  tar \
  xz-utils \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# ---- install Blender 3.6 LTS ----
WORKDIR /opt
RUN wget https://download.blender.org/release/Blender3.6/blender-3.6.5-linux-x64.tar.xz \
  && tar -xf blender-3.6.5-linux-x64.tar.xz \
  && rm blender-3.6.5-linux-x64.tar.xz

ENV PATH="/opt/blender-3.6.5-linux-x64:${PATH}"

# ---- app ----
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
