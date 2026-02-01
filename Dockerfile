FROM node:22-bookworm

# -----------------------------
# Install system deps
# -----------------------------
RUN apt-get update && apt-get install -y \
  blender \
  usd-utils \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# -----------------------------
# App directory
# -----------------------------
WORKDIR /app

# -----------------------------
# Install node deps
# -----------------------------
COPY package.json ./
RUN npm install

# -----------------------------
# Copy app
# -----------------------------
COPY . .

# -----------------------------
# Render config
# -----------------------------
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
