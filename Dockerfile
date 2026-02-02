FROM node:22-bookworm

# Install system deps:
# - blender: to export USD
# - zip: to package .usdz (no compression)
RUN apt-get update && apt-get install -y \
  blender \
  zip \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
