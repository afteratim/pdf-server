const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_PAGES = Number(process.env.MAX_PAGES || 100);
const MAX_OCR_PAGES = Number(process.env.MAX_OCR_PAGES || 10);
const OCR_DPI = Number(process.env.OCR_DPI || 110);
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/pdf-analyzer';
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 60000);
const MODEL_ID = 'smollm';
const MODEL_PATH = process.env.MODEL_PATH || '/models/';
const PDF_STORAGE_DIR = process.env.PDF_STORAGE_DIR || path.join(TEMP_DIR, 'uploads');

if (!PASSWORD) throw new Error('APP_PASSWORD is required.');
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required. Configure a PostgreSQL database.');

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(PDF_STORAGE_DIR, { recursive: true });
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(session({
  name: 'pdf_analyzer_session',
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true, pruneSessionInterval: 15 * 60 }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireLogin(req, res, next) {
  if (req.session && req.session.authenticated === true) return next();
  return res.status(401).json({ error: 'Please login again.' });
}
function checkSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked.' });
    } catch (_) { return res.status(403).json({ error: 'Invalid request origin.' }); }
  }
  next();
}
function runCommand(command, args, timeout = 120000, maxOutput = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`${command} timed out`)); }, timeout);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    }
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > maxOutput) { child.kill('SIGKILL'); return finish(new Error('Command output limit exceeded')); }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', chunk => { if (stderr.length < 12000) stderr += chunk.toString(); });
    child.on('error', error => finish(error));
    child.on('close', code => code !== 0 ? finish(new Error(stderr || `${command} exited with code ${code}`)) : finish(null, { stdout: stdout.toString('utf8'), stderr }));
  });
}
async function removeFile(filePath) {
  if (!filePath) return;
  try { await fs.promises.rm(filePath, { force: true }); } catch (_) {}
}
function safeFilename(name) {
  return path.basename(String(name || 'document.pdf')).replace(/[\r\n\0]/g, '_').slice(0, 180) || 'document.pdf';
}
function inspectPageText(text) {
  const gstins = [...text.matchAll(/\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi)].map(m => m[0].toUpperCase());
  const dates = [...text.matchAll(/\b(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:20)?\d{2}\b/g)].map(m => m[0]);
  const billNos = [];
  const billRegex = /(?:invoice|bill|voucher)\s*(?:no\.?|number|#|num\.?|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{2,})/gi;
  for (const m of text.matchAll(billRegex)) billNos.push(m[1]);
  const amounts = [...text.matchAll(/(?:grand\s*total|invoice\s*value|net\s*amount|total\s*amount|taxable\s*value|total)\s*[:\-]?\s*(?:₹|rs\.?\s*)?([0-9][0-9,]*(?:\.\d{1,2})?)/gi)].map(m => m[1]);
  return { gstins, dates, billNos, amounts };
}
async function extractPdf(filePath) {
  const info = await runCommand('pdfinfo', [filePath], 30000, 256 * 1024);
  const pagesMatch = info.stdout.match(/^Pages:\s+(\d+)/m);
  const encryptedMatch = info.stdout.match(/^Encrypted:\s+(.+)$/m);
  const pageCount = pagesMatch ? Number(pagesMatch[1]) : 0;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error('Unable to determine PDF page count. The PDF may be damaged or encrypted.');
  if (pageCount > MAX_PAGES) throw new Error(`PDF contains ${pageCount} pages. Maximum allowed: ${MAX_PAGES}.`);
  if (encryptedMatch && !/^no/i.test(encryptedMatch[1].trim())) throw new Error('This PDF appears to be password-protected. Remove its password and upload again.');
  const result = await runCommand('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'], 180000, 15 * 1024 * 1024);
  const pageTexts = result.stdout.split('\f').slice(0, pageCount);
  const pages = [];
  let ocrCount = 0, scannedCount = 0, unreadableCount = 0;
  for (let i = 0; i < pageCount; i++) {
    let text = (pageTexts[i] || '').trim();
    let source = text.length >= 30 ? 'native' : 'unreadable';
    const pageNumber = i + 1;
    if (text.length < 30) {
      scannedCount++;
      if (ocrCount < MAX_OCR_PAGES) {
        const prefix = path.join(TEMP_DIR, crypto.randomUUID());
        const imagePath = prefix + '.png';
        try {
          await runCommand('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', String(OCR_DPI), '-scale-to', '1600', '-singlefile', '-png', filePath, prefix], 90000, 64 * 1024);
          const ocr = await runCommand('tesseract', [imagePath, 'stdout', '-l', 'eng', '--psm', '6'], 90000, 2 * 1024 * 1024);
          if (ocr.stdout.trim()) { text = ocr.stdout.trim(); source = 'ocr'; }
          ocrCount++;
        } catch (error) { console.error(`OCR failed on page ${pageNumber}:`, error.message); }
        finally { await removeFile(imagePath); }
      }
    }
    if (!text || text.length < 10) unreadableCount++;
    const fields = inspectPageText(text);
    const tableLike = text.split(/\r?\n/).filter(line => (line.match(/\s{2,}|\|/g) || []).length >= 2).length >= 3;
    pages.push({ page: pageNumber, text: text || '[No readable text detected]', source, characterCount: text.length, tableLike,
      extracted: { gstinCount: fields.gstins.length, dateCount: fields.dates.length, billNumberCount: fields.billNos.length, amountCount: fields.amounts.length },
      warnings: source === 'unreadable' ? ['No readable text was extracted from this page.'] : source === 'ocr' ? ['Text was extracted using OCR; verify important values against the page image.'] : [] });
  }
  const allText = pages.map(p => p.text).join('\n');
  const fields = inspectPageText(allText);
  const tablePages = pages.filter(p => p.tableLike).length;
  const nativePages = pages.filter(p => p.source === 'native').length;
  const ocrPages = pages.filter(p => p.source === 'ocr').length;
  const warnings = [];
  if (unreadableCount) warnings.push(`${unreadableCount} page(s) contain little or no readable text.`);
  if (scannedCount > MAX_OCR_PAGES) warnings.push(`OCR limit reached: only ${MAX_OCR_PAGES} scanned pages can be processed per document in this version.`);
  if (ocrPages) warnings.push('OCR results may contain recognition errors. Verify bill numbers, GSTINs and amounts against the original PDF.');
  if (!tablePages) warnings.push('No table-like text layout was confidently detected. This does not mean the PDF contains no tables.');
  const quality = unreadableCount > 0 || scannedCount > MAX_OCR_PAGES ? 'review' : 'good';
  return {
    pageCount, scannedPages: scannedCount, ocrPagesProcessed: ocrPages, unreadablePages: unreadableCount, nativePages, tablePages,
    report: { status: quality, pdfIntegrity: 'passed', textExtraction: nativePages + ocrPages > 0 ? 'passed' : 'review', totalPages: pageCount,
      nativePages, ocrPages, unreadablePages: unreadableCount, tableLikePages: tablePages,
      fieldCounts: { billNumbers: fields.billNos.length, gstins: fields.gstins.length, dates: fields.dates.length, labelledAmounts: fields.amounts.length }, warnings },
    pages
  };
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_documents (
      id UUID PRIMARY KEY,
      filename TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      storage_path TEXT NOT NULL UNIQUE,
      page_count INTEGER NOT NULL,
      report JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pdf_pages (
      id BIGSERIAL PRIMARY KEY,
      document_id UUID NOT NULL REFERENCES pdf_documents(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL,
      text_content TEXT NOT NULL,
      source TEXT NOT NULL,
      character_count INTEGER NOT NULL,
      table_like BOOLEAN NOT NULL DEFAULT FALSE,
      extracted JSONB NOT NULL DEFAULT '{}'::jsonb,
      warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
      UNIQUE(document_id, page_number)
    );
    CREATE INDEX IF NOT EXISTS pdf_pages_document_idx ON pdf_pages(document_id, page_number);
    CREATE TABLE IF NOT EXISTS pdf_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS pdf_chat_messages_created_idx ON pdf_chat_messages(created_at);
  `);
}

const storage = multer.diskStorage({ destination: (req, file, callback) => callback(null, TEMP_DIR), filename: (req, file, callback) => callback(null, crypto.randomUUID() + '.pdf') });
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }, fileFilter: (req, file, callback) => {
  if (!file.originalname.toLowerCase().endsWith('.pdf')) return callback(new Error('Only PDF files are accepted.'));
  callback(null, true);
} });

app.get('/api/health', async (req, res) => {
  let db = 'ok';
  try { await pool.query('SELECT 1'); } catch (_) { db = 'error'; }
  res.json({ status: db === 'ok' ? 'ok' : 'degraded', application: 'Personal PDF Analyzer', version: '3.0.0',
    uptime_seconds: Math.floor(process.uptime()), memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    database: db, file_storage: 'local_ephemeral', ai: { loaded: Boolean(aiGenerator), loading: aiLoading, model: aiGenerator ? MODEL_ID : null } });
});
app.post('/api/login', checkSameOrigin, (req, res, next) => {
  const supplied = String(req.body.password || '');
  const a = Buffer.from(PASSWORD), b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Incorrect password.' });
  req.session.authenticated = true;
  req.session.save(error => error ? next(error) : res.json({ success: true }));
});
app.post('/api/logout', requireLogin, checkSameOrigin, (req, res, next) => req.session.destroy(error => {
  if (error) return next(error);
  res.clearCookie('pdf_analyzer_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ success: true });
}));
app.get('/api/session', (req, res) => res.json({ authenticated: req.session?.authenticated === true }));

app.get('/api/state', requireLogin, async (req, res, next) => {
  try {
    const docsResult = await pool.query('SELECT * FROM pdf_documents ORDER BY created_at DESC');
    const docs = [];
    for (const doc of docsResult.rows) {
      const pagesResult = await pool.query('SELECT page_number, text_content, source, character_count, table_like, extracted, warnings FROM pdf_pages WHERE document_id=$1 ORDER BY page_number', [doc.id]);
      docs.push({ id: doc.id, filename: doc.filename, size_mb: Number((Number(doc.size_bytes) / 1048576).toFixed(2)), pageCount: doc.page_count,
        report: doc.report, pages: pagesResult.rows.map(p => ({ page: p.page_number, text: p.text_content, source: p.source, characterCount: p.character_count, tableLike: p.table_like, extracted: p.extracted, warnings: p.warnings })) });
    }
    const messages = await pool.query('SELECT id, role, content, result, created_at FROM pdf_chat_messages ORDER BY id DESC LIMIT 300');
    res.json({ documents: docs, messages: messages.rows.reverse() });
  } catch (error) { next(error); }
});

app.post('/api/analyze', requireLogin, checkSameOrigin, upload.single('pdf'), async (req, res, next) => {
  let tempFilePath;
  let savedFilePath;
  const documentId = crypto.randomUUID();
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
    tempFilePath = req.file.path;
    const handle = await fs.promises.open(tempFilePath, 'r');
    try {
      const header = Buffer.alloc(5);
      await handle.read(header, 0, 5, 0);
      if (header.toString() !== '%PDF-') throw new Error('Invalid PDF file signature.');
    } finally { await handle.close(); }

    const result = await extractPdf(tempFilePath);
    savedFilePath = path.join(PDF_STORAGE_DIR, `${documentId}.pdf`);
    await fs.promises.rename(tempFilePath, savedFilePath);
    tempFilePath = null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO pdf_documents(id,filename,size_bytes,storage_path,page_count,report) VALUES($1,$2,$3,$4,$5,$6)',
        [documentId, safeFilename(req.file.originalname), req.file.size, savedFilePath, result.pageCount, JSON.stringify(result.report)]);
      for (const page of result.pages) {
        await client.query('INSERT INTO pdf_pages(document_id,page_number,text_content,source,character_count,table_like,extracted,warnings) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [documentId, page.page, page.text, page.source, page.characterCount, page.tableLike, JSON.stringify(page.extracted), JSON.stringify(page.warnings)]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }

    res.json({ success: true, id: documentId, filename: safeFilename(req.file.originalname), size_mb: Number((req.file.size / 1048576).toFixed(2)), ...result });
  } catch (error) {
    if (savedFilePath) await removeFile(savedFilePath);
    console.error('PDF processing/storage error:', error.message);
    const clientError = /Invalid PDF|Maximum allowed|Only PDF|password-protected/i.test(error.message);
    if (!res.headersSent) res.status(clientError ? 400 : 500).json({ error: error.message || 'PDF processing failed.' });
  } finally { await removeFile(tempFilePath); }
});

app.get('/api/documents/:id/download', requireLogin, async (req, res, next) => {
  try {
    const found = await pool.query('SELECT filename,storage_path FROM pdf_documents WHERE id=$1', [req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Document not found.' });
    const filePath = path.resolve(found.rows[0].storage_path);
    const storageRoot = path.resolve(PDF_STORAGE_DIR) + path.sep;
    if (!filePath.startsWith(storageRoot)) return res.status(403).json({ error: 'Invalid document storage path.' });
    try { await fs.promises.access(filePath, fs.constants.R_OK); }
    catch (_) { return res.status(410).json({ error: 'The original PDF is no longer available. Render Free temporary storage may have been cleared; extracted text remains saved in Neon.' }); }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.rows[0].filename)}`);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) { next(error); }
});
app.delete('/api/documents/:id', requireLogin, checkSameOrigin, async (req, res, next) => {
  try {
    const found = await pool.query('SELECT storage_path FROM pdf_documents WHERE id=$1', [req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Document not found.' });
    await pool.query('DELETE FROM pdf_documents WHERE id=$1', [req.params.id]);
    await removeFile(found.rows[0].storage_path);
    res.json({ success: true });
  } catch (error) { next(error); }
});
app.delete('/api/documents', requireLogin, checkSameOrigin, async (req, res, next) => {
  try {
    const found = await pool.query('SELECT storage_path FROM pdf_documents');
    await pool.query('DELETE FROM pdf_documents');
    for (const row of found.rows) await removeFile(row.storage_path);
    res.json({ success: true });
  } catch (error) { next(error); }
});
app.delete('/api/chat', requireLogin, checkSameOrigin, async (req, res, next) => {
  try { await pool.query('DELETE FROM pdf_chat_messages'); res.json({ success: true }); } catch (error) { next(error); }
});

function tokenize(q) {
  const stop = new Set('the and for from with that this what find show give tell please document documents pdf uploaded all about where does have has are was were bill invoice number extract list every each across my your get details of is in on at to by'.split(' '));
  return String(q || '').toLowerCase().replace(/[^a-z0-9\s.-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stop.has(w)).slice(0, 18);
}
async function retrieveEvidence(question) {
  const terms = tokenize(question);
  if (!terms.length) return [];
  const query = `SELECT p.page_number,p.text_content,d.filename FROM pdf_pages p JOIN pdf_documents d ON d.id=p.document_id ORDER BY p.id`;
  const result = await pool.query(query);
  const hits = [];
  for (const row of result.rows) {
    const lines = String(row.text_content || '').split(/\r?\n/);
    for (const line of lines) {
      const lower = line.toLowerCase();
      const score = terms.reduce((n, term) => n + (lower.includes(term) ? 1 : 0), 0);
      if (score) hits.push({ filename: row.filename, page: row.page_number, snippet: line.trim().slice(0, 500), score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 12).map(({ score, ...hit }) => hit);
}

let aiGenerator = null;
let aiLoading = false;
let aiError = '';
let aiBusy = false;
async function loadServerAI() {
  if (aiGenerator) return { loaded: true, model: MODEL_ID };
  if (aiLoading) throw new Error('The AI model is already loading. Please wait.');
  aiLoading = true; aiError = '';
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.localModelPath = MODEL_PATH;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useFSCache = true;
    aiGenerator = await pipeline('text-generation', MODEL_ID, { dtype: 'q4', device: 'cpu' });
    return { loaded: true, model: MODEL_ID };
  } catch (error) {
    aiError = error.message || 'Model loading failed.';
    aiGenerator = null;
    throw error;
  } finally { aiLoading = false; }
}
app.get('/api/ai/status', requireLogin, (req, res) => res.json({ loaded: Boolean(aiGenerator), loading: aiLoading, busy: aiBusy, model: aiGenerator ? 'SmolLM2 360M' : null, error: aiError || null }));
app.post('/api/ai/load', requireLogin, checkSameOrigin, async (req, res) => {
  try { await loadServerAI(); res.json({ success: true, loaded: true, model: 'SmolLM2 360M' }); }
  catch (error) { res.status(503).json({ error: `Server-side model could not load: ${error.message}. Document search remains available.`, memory_mb: Math.round(process.memoryUsage().rss / 1048576) }); }
});
app.post('/api/ai/unload', requireLogin, checkSameOrigin, async (req, res) => {
  try { if (aiGenerator && typeof aiGenerator.dispose === 'function') await aiGenerator.dispose(); }
  catch (error) { console.error('Model unload warning:', error.message); }
  aiGenerator = null;
  if (global.gc) global.gc();
  res.json({ success: true, loaded: false });
});
app.post('/api/chat', requireLogin, checkSameOrigin, async (req, res, next) => {
  try {
    const question = String(req.body.question || '').trim().slice(0, 5000);
    const structured = req.body.structured && typeof req.body.structured === 'object' ? req.body.structured : null;
    if (!question) return res.status(400).json({ error: 'Enter a question first.' });
    let evidence = await retrieveEvidence(question);
    if (Array.isArray(structured?.rows) && structured.rows.length) {
      const headers = Array.isArray(structured.headers) ? structured.headers : [];
      const fileIndex = headers.indexOf('PDF');
      const pageIndex = headers.indexOf('Page');
      const snippetIndex = headers.indexOf('Original text snippet');
      const structuredEvidence = structured.rows.slice(0, 20).map(row => ({
        filename: fileIndex >= 0 ? String(row[fileIndex] || '') : '',
        page: pageIndex >= 0 ? String(row[pageIndex] || '') : '',
        snippet: (snippetIndex >= 0 ? String(row[snippetIndex] || '') : row.map(value => String(value ?? '')).join(' | ')).slice(0, 500)
      }));
      if (structuredEvidence.length) evidence = structuredEvidence;
    }
    let aiText = '';
    if (aiGenerator && !aiBusy) {
      aiBusy = true;
      const evidenceText = evidence.map((item, i) => `[${i + 1}] ${item.filename}, page ${item.page}: ${item.snippet}`).join('\n').slice(0, 6500);
      const prompt = `You are a careful private PDF document assistant. Answer only from the evidence below. Never invent invoice numbers, GSTINs, dates, names or financial values. If evidence is insufficient, say so. Cite the source filename and page number. Distinguish invoice date, due date and other dates. Distinguish taxable value, GST components and invoice total.\n\nQuestion: ${question}\n\nEvidence:\n${evidenceText || 'No matching evidence was found.'}\n\nAnswer:`;
      try {
        const output = await aiGenerator(prompt, { max_new_tokens: 180, do_sample: false, temperature: 0 });
        const generated = output?.[0]?.generated_text || '';
        aiText = String(generated).slice(prompt.length).trim() || 'The model returned no explanation. Review the extracted results below.';
      } catch (error) { aiText = `AI inference failed: ${error.message}. The extracted results remain available.`; }
      finally { aiBusy = false; }
    } else if (aiLoading) aiText = 'The AI model is still loading. Please try again in a moment.';
    else if (aiGenerator && aiBusy) aiText = 'The AI model is processing another question. Please try again shortly.';
    const title = structured?.title || (evidence.length ? `Found ${evidence.length} matching evidence line(s)` : 'No matching evidence found');
    const paragraph = structured?.paragraph || (evidence.length ? 'Relevant text was retrieved from your saved PDFs.' : 'No matching text was found. Try different keywords or check the extraction report.');
    const answer = { title, paragraph, headers: structured?.headers || (evidence.length ? ['PDF', 'Page', 'Original text snippet'] : undefined), rows: structured?.rows || (evidence.length ? evidence.map(e => [e.filename, e.page, e.snippet]) : undefined), name: structured?.name || 'pdf-search', aiText: aiText || undefined };
    const assistantContent = [title, paragraph, ...(answer.rows || []).map(row => row.join(' | ')), aiText ? `AI: ${aiText}` : ''].filter(Boolean).join('\n');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO pdf_chat_messages(role,content) VALUES($1,$2)', ['user', question]);
      await client.query('INSERT INTO pdf_chat_messages(role,content,result) VALUES($1,$2,$3)', ['assistant', assistantContent, JSON.stringify(answer)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    res.json({ success: true, answer, evidence, ai_loaded: Boolean(aiGenerator) });
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: status === 413 ? `Maximum upload size is ${MAX_UPLOAD_MB} MB.` : error.message });
  }
  console.error('Request error:', error.stack || error.message);
  if (!res.headersSent) res.status(500).json({ error: error.message || 'Request failed.' });
});

const configuredUrls = (process.env.PING_URLS || '').split(',').map(url => url.trim()).filter(Boolean);
const selfUrl = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/api/health` : '';
const pingUrls = configuredUrls.length ? configuredUrls : (selfUrl ? [selfUrl] : []);
let pingRunning = false;
async function pingUrlsNow() {
  if (pingRunning || !pingUrls.length) return;
  pingRunning = true;
  try {
    for (const url of pingUrls) {
      try { const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Personal-PDF-Analyzer-KeepAlive' } }); console.log(`[SELF-PING] ${url} -> ${response.status}`); await response.body?.cancel(); }
      catch (error) { console.error(`[SELF-PING] Failed: ${url} - ${error.message}`); }
    }
  } finally { pingRunning = false; }
}

(async () => {
  try {
    await fs.promises.mkdir(PDF_STORAGE_DIR, { recursive: true });
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Personal PDF Analyzer v3 running on port ${PORT}`);
      console.log(`Persistent database: connected · PDF storage: local temporary filesystem · Model path: ${MODEL_ID}`);
      console.log(`Maximum upload: ${MAX_UPLOAD_MB} MB · OCR pages: ${MAX_OCR_PAGES} · self-ping targets: ${pingUrls.length}`);
      if (pingUrls.length) setInterval(pingUrlsNow, PING_INTERVAL_MS);
    });
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
})();
