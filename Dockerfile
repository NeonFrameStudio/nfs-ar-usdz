# Base image that already includes a working USDZ converter setup
# (contains the python-based usdzconvert tooling + USD libs)
FROM jysgro/usdzconvert:0.66-usd-22.05b

# Install Node.js 22 + Blender
RUN apt-get update && apt-get install -y \
    curl gnupg ca-certificates \
    blender \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
