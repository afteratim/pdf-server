# Build llama.cpp and fetch one small GGUF model at image-build time.
FROM node:20-bookworm-slim AS ai-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git curl ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
RUN cmake -S llama.cpp -B llama.cpp/build \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_NATIVE=OFF \
    -DGGML_OPENMP=OFF \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_CURL=OFF \
    && cmake --build llama.cpp/build --config Release -j2 --target llama-server
RUN mkdir -p /models \
    && curl -fL --retry 5 --retry-delay 2 \
      "https://huggingface.co/QuantFactory/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf" \
      -o /models/SmolLM2-135M-Instruct-Q4_K_M.gguf

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    TEMP_DIR=/tmp/pdf-analyzer \
    MAX_UPLOAD_MB=200 \
    MAX_PAGES=100 \
    MAX_OCR_PAGES=10 \
    OCR_DPI=110 \
    MODEL_PATH=/models/SmolLM2-135M-Instruct-Q4_K_M.gguf \
    LLAMA_SERVER_PATH=/usr/local/bin/llama-server \
    LLAMA_CTX_SIZE=1024 \
    LLAMA_THREADS=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils tesseract-ocr tesseract-ocr-eng libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public ./public
COPY --from=ai-build /build/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server
COPY --from=ai-build /models/ /models/
RUN mkdir -p /tmp/pdf-analyzer/uploads && chown -R node:node /app /tmp/pdf-analyzer
USER node
EXPOSE 10000
CMD ["npm", "start"]
