FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  blender \
  python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
