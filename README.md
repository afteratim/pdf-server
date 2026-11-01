# Personal PDF Analyzer — Neon + temporary Render storage

This branch uses Neon PostgreSQL for persistent document metadata, extracted page text, chat history and PostgreSQL-backed login sessions. Original PDF files are stored on the Render service's local temporary filesystem. Cloudflare R2 has been completely removed.

## Important storage limitation

Render Free has an ephemeral filesystem. Original PDFs stored in `PDF_STORAGE_DIR` can be lost after a restart, redeploy or spin-down. Extracted text and chat history remain in Neon, subject to your Neon plan limits. If a PDF disappears, its extracted text remains searchable but the original cannot be downloaded. This is a temporary arrangement, not permanent PDF backup.

## Required Render environment variables

- `APP_PASSWORD`: private workspace password
- `SESSION_SECRET`: random secret of at least 32 characters
- `DATABASE_URL`: Neon pooled PostgreSQL connection string
- `NODE_ENV`: `production`

Optional settings are documented in `.env.example`. No `R2_*` variables or Cloudflare account are required.

## Deploy

1. Push this project to your separate GitHub branch.
2. In Render, create a new **Docker Web Service** from that branch. Do not replace the existing service.
3. Add `APP_PASSWORD`, `SESSION_SECRET`, and `DATABASE_URL` in Render Environment.
4. Deploy. The app creates its PostgreSQL tables automatically at startup.
5. Open `/api/health` and confirm `database` is `ok`.
6. Log in, upload a small PDF, refresh, and verify the document and chat history remain.
7. Test downloading the original PDF while the service is still running.

## AI model note

The Docker build downloads a quantized SmolLM2 360M model. The model is loaded into server RAM only when requested. Render Free has 512 MB RAM, so model loading may fail or restart the service. PDF extraction and database-backed document search should remain available if AI cannot load.

## Security

Keep `DATABASE_URL`, `APP_PASSWORD` and `SESSION_SECRET` private. Never commit `.env` or credentials to GitHub. The app uses HTTP-only server sessions stored in PostgreSQL.
