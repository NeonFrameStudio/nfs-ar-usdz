FROM node:22-bookworm

# System deps
RUN apt-get update && apt-get install -y \
  blender \
  git \
  cmake \
  ninja-build \
  build-essential \
  python3 \
  python3-dev \
  python3-pip \
  libssl-dev \
  libffi-dev \
  zlib1g-dev \
  libbz2-dev \
  libreadline-dev \
  libsqlite3-dev \
  libgl1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# Build Pixar OpenUSD (minimal) to get usdzip
# Keep it lean: no imaging, no python bindings
RUN git clone --depth 1 https://github.com/PixarAnimationStudios/OpenUSD.git && \
  mkdir -p /opt/OpenUSD/build && \
  cmake -S /opt/OpenUSD -B /opt/OpenUSD/build \
    -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DPXR_BUILD_IMAGING=OFF \
    -DPXR_BUILD_USDVIEW=OFF \
    -DPXR_ENABLE_PYTHON_SUPPORT=OFF \
    -DPXR_BUILD_TESTS=OFF \
    -DPXR_BUILD_EXAMPLES=OFF \
    -DPXR_BUILD_TUTORIALS=OFF \
    -DPXR_BUILD_DOCS=OFF && \
  cmake --build /opt/OpenUSD/build --target usdzip && \
  cp /opt/OpenUSD/build/bin/usdzip /usr/local/bin/usdzip

# App directory
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
