# Download only the quantized ONNX model and tokenizer assets at image-build time.
# The model is NOT loaded into RAM until the user presses "Load server model".
FROM python:3.11-slim AS model-fetch
RUN pip install --no-cache-dir "huggingface_hub[hf_xet]>=0.30,<1.0"
RUN python - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="onnx-community/SmolLM2-360M-Instruct-ONNX",
    local_dir="/models/smollm",
    allow_patterns=[
        "*.json",
        "*.txt",
        "onnx/model_q4.onnx"
    ],
    ignore_patterns=["*.md", ".gitattributes"]
)
PY

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    TEMP_DIR=/tmp/pdf-analyzer \
    MODEL_PATH=/models/ \
    MAX_UPLOAD_MB=200 \
    MAX_PAGES=100 \
    MAX_OCR_PAGES=10 \
    OCR_DPI=110
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    libgomp1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public ./public
COPY --from=model-fetch /models/smollm /models/smollm
RUN mkdir -p /tmp/pdf-analyzer/uploads && chown -R node:node /app /tmp/pdf-analyzer
USER node
EXPOSE 10000
CMD ["npm", "start"]
