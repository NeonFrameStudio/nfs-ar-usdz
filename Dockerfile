FROM node:22-bookworm

# -----------------------------
# System deps
# -----------------------------
RUN apt-get update && apt-get install -y \
  blender \
  python3 \
  wget \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# -----------------------------
# Install Pixar USD (includes usdzip)
# -----------------------------
WORKDIR /opt
RUN wget https://github.com/PixarAnimationStudios/USD/releases/download/v23.11/usd-linux-x86_64-release.zip \
  && unzip usd-linux-x86_64-release.zip \
  && rm usd-linux-x86_64-release.zip

ENV PATH="/opt/usd/bin:${PATH}"

# -----------------------------
# App directory
# -----------------------------
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
