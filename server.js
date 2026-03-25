require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();

// ── CORS: allow your Netlify site + localhost
const allowedOrigins = [
  'https://toolflow-pro.netlify.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  '*'
];
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition', 'X-Original-Size', 'X-Compressed-Size', 'X-Savings-Percent']
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ── Ensure tmp dir exists
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Routes
app.use('/api/pdf', require('./routes/pdf'));

// ── Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ToolFlow PDF API is running ✅',
    version: '1.0.0',
    endpoints: [
      '/api/pdf/merge', '/api/pdf/split', '/api/pdf/compress',
      '/api/pdf/pdf-to-word', '/api/pdf/pdf-to-pptx', '/api/pdf/pdf-to-excel',
      '/api/pdf/word-to-pdf', '/api/pdf/pptx-to-pdf', '/api/pdf/excel-to-pdf',
      '/api/pdf/pdf-to-jpg', '/api/pdf/jpg-to-pdf',
      '/api/pdf/rotate', '/api/pdf/watermark', '/api/pdf/sign',
      '/api/pdf/protect', '/api/pdf/unlock',
      '/api/pdf/organize', '/api/pdf/add-page-numbers',
      '/api/pdf/crop', '/api/pdf/repair',
      '/api/pdf/html-to-pdf', '/api/pdf/pdf-to-pdfa',
      '/api/pdf/ocr', '/api/pdf/compare',
      '/api/pdf/redact', '/api/pdf/translate'
    ]
  });
});

// ── Auto-cleanup tmp files older than 2 hours
setInterval(() => {
  try {
    const files = fs.readdirSync(TMP_DIR);
    const now = Date.now();
    files.forEach(file => {
      const fp = path.join(TMP_DIR, file);
      if (file === '.gitkeep') return;
      const stat = fs.statSync(fp);
      if (now - stat.mtime.getTime() > 7200000) fs.unlinkSync(fp);
    });
  } catch (e) { /* ignore */ }
}, 3600000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ToolFlow PDF API running on port ${PORT}`));
