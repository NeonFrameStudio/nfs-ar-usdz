FROM node:22-bookworm

# Install Blender
RUN apt-get update && apt-get install -y blender && rm -rf /var/lib/apt/lists/*

# App directory
WORKDIR /app

# Copy files
COPY package.json ./
RUN npm install

COPY . .

# Render uses PORT env var
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
