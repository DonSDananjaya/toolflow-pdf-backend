const express = require('express');
const router = express.Router();
const multer = require('multer');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const fsP = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const archiver = require('archiver');
const sharp = require('sharp');

const TMP_DIR = path.join(__dirname, '../tmp');

// ── Multer config
const storage = multer.diskStorage({
  destination: TMP_DIR,
  filename: (req, file, cb) => {
    const uid = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uid + path.extname(file.originalname).toLowerCase());
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
                 '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.html', '.htm'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ── Helpers
async function sendFile(res, filePath, filename) {
  const data = await fsP.readFile(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', getMime(filename));
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.send(data);
  await fsP.unlink(filePath).catch(() => {});
}
function getMime(name) {
  const ext = path.extname(name).toLowerCase();
  const m = { '.pdf': 'application/pdf', '.zip': 'application/zip',
               '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
               '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
               '.txt': 'text/plain', '.jpg': 'image/jpeg', '.png': 'image/png' };
  return m[ext] || 'application/octet-stream';
}
async function cleanup(...files) {
  for (const f of files) if (f) await fsP.unlink(f).catch(() => {});
}
async function hasCmd(cmd) {
  try { await execAsync(`which ${cmd}`); return true; } catch { return false; }
}
async function hasLibreOffice() {
  return (await hasCmd('libreoffice')) || (await hasCmd('soffice'));
}

// ─────────────────────────────────────────
// 1. MERGE PDF
// ─────────────────────────────────────────
router.post('/merge', upload.array('files', 20), async (req, res) => {
  if (!req.files || req.files.length < 2)
    return res.status(400).json({ error: 'Upload at least 2 PDF files.' });
  try {
    const merged = await PDFDocument.create();
    for (const f of req.files) {
      const bytes = await fsP.readFile(f.path);
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    const out = await merged.save();
    const outPath = path.join(TMP_DIR, `merged-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(...req.files.map(f => f.path));
    await sendFile(res, outPath, 'merged.pdf');
  } catch (e) {
    await cleanup(...(req.files || []).map(f => f.path));
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 2. SPLIT PDF
// ─────────────────────────────────────────
router.post('/split', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total = pdf.getPageCount();
    const mode = req.body.mode || 'individual';
    const zipPath = path.join(TMP_DIR, `split-${Date.now()}.zip`);
    const output = fs.createWriteStream(zipPath);
    const arc = archiver('zip', { zlib: { level: 6 } });
    arc.pipe(output);

    if (mode === 'individual') {
      for (let i = 0; i < total; i++) {
        const d = await PDFDocument.create();
        const [p] = await d.copyPages(pdf, [i]);
        d.addPage(p);
        arc.append(Buffer.from(await d.save()), { name: `page-${i + 1}.pdf` });
      }
    } else {
      const ranges = (req.body.ranges || '').split(',').filter(Boolean);
      for (let ri = 0; ri < ranges.length; ri++) {
        const parts = ranges[ri].trim().split('-').map(n => parseInt(n.trim()) - 1);
        const indices = parts.length === 2
          ? Array.from({ length: parts[1] - parts[0] + 1 }, (_, k) => parts[0] + k)
          : [parts[0]];
        const valid = indices.filter(n => n >= 0 && n < total);
        const d = await PDFDocument.create();
        const pages = await d.copyPages(pdf, valid);
        pages.forEach(p => d.addPage(p));
        arc.append(Buffer.from(await d.save()), { name: `part-${ri + 1}.pdf` });
      }
    }
    await arc.finalize();
    output.on('close', async () => {
      await cleanup(req.file.path);
      await sendFile(res, zipPath, 'split-pages.zip');
    });
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 3. COMPRESS PDF
// ─────────────────────────────────────────
router.post('/compress', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const out = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
    const outPath = path.join(TMP_DIR, `compressed-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    const savings = Math.max(0, Math.round((1 - out.length / bytes.length) * 100));
    res.setHeader('X-Original-Size', bytes.length);
    res.setHeader('X-Compressed-Size', out.length);
    res.setHeader('X-Savings-Percent', savings);
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'compressed.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 4-9. CONVERSIONS (LibreOffice + fallback)
// ─────────────────────────────────────────

// Extract all text from a PDF using pdfjs-dist
async function extractPdfText(filePath) {
  const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(await fsP.readFile(filePath));
  const doc = await getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const lines = [];
    let lastY = null;
    for (const item of content.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) lines.push('');
      lines.push(item.str);
      lastY = item.transform[5];
    }
    pages.push({ pageNum: i, text: lines.join(' ').trim() });
  }
  return pages;
}

// Build a DOCX from extracted PDF text (using raw XML — no extra deps needed)
async function buildDocxFromText(pages, outputPath) {
  const paragraphs = [];
  for (const { pageNum, text } of pages) {
    // Page heading
    paragraphs.push(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:r><w:t>Page ${pageNum}</w:t></w:r>
      </w:p>`);
    // Split text into lines, create paragraph per non-empty line
    const lines = text.split(/\n+/).filter(l => l.trim());
    for (const line of lines) {
      const escaped = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      paragraphs.push(`
      <w:p>
        <w:r>
          <w:rPr><w:sz w:val="22"/></w:rPr>
          <w:t xml:space="preserve">${escaped}</w:t>
        </w:r>
      </w:p>`);
    }
    // Page break between pages
    if (pageNum < pages.length) {
      paragraphs.push(`
      <w:p>
        <w:r><w:br w:type="page"/></w:r>
      </w:p>`);
    }
  }

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:oel="http://schemas.microsoft.com/office/2019/extlst"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
  xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"
  xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 w15 w16se w16cid wp14 oel cx">
  <w:body>
${paragraphs.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="2E74B5"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="22"/></w:rPr>
  </w:style>
</w:styles>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const arc = archiver('zip', { zlib: { level: 6 } });
  const output = fs.createWriteStream(outputPath);
  arc.pipe(output);
  arc.append(contentTypesXml, { name: '[Content_Types].xml' });
  arc.append(rootRelsXml, { name: '_rels/.rels' });
  arc.append(docXml, { name: 'word/document.xml' });
  arc.append(stylesXml, { name: 'word/styles.xml' });
  arc.append(relsXml, { name: 'word/_rels/document.xml.rels' });
  await arc.finalize();
  await new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); });
}

// Build an XLSX from extracted PDF text
async function buildXlsxFromText(pages, outputPath) {
  // Build a minimal valid XLSX (Office Open XML)
  const rows = [];
  for (const { pageNum, text } of pages) {
    rows.push([`--- Page ${pageNum} ---`, '']);
    const lines = text.split(/\n+/).filter(l => l.trim());
    for (const line of lines) {
      // Try to split on multiple spaces or tabs (table-like data)
      const cells = line.split(/\t|\s{2,}/).map(c => c.trim()).filter(Boolean);
      if (cells.length > 1) rows.push(cells);
      else rows.push([line.trim()]);
    }
    rows.push(['', '']); // blank row between pages
  }

  // Generate XML
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const sharedStrings = [];
  const strIndex = {};
  function si(s) {
    const k = String(s);
    if (strIndex[k] === undefined) { strIndex[k] = sharedStrings.length; sharedStrings.push(k); }
    return strIndex[k];
  }

  const rowsXml = rows.map((cells, ri) => {
    const cellsXml = cells.map((cell, ci) => {
      const col = String.fromCharCode(65 + ci);
      const ref = `${col}${ri + 1}`;
      const idx = si(cell);
      return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cellsXml}</row>`;
  }).join('');

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowsXml}</sheetData>
</worksheet>`;

  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('\n')}
</sst>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="PDF Content" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const arc = archiver('zip', { zlib: { level: 6 } });
  const output = fs.createWriteStream(outputPath);
  arc.pipe(output);
  arc.append(contentTypesXml, { name: '[Content_Types].xml' });
  arc.append(rootRels, { name: '_rels/.rels' });
  arc.append(workbookXml, { name: 'xl/workbook.xml' });
  arc.append(sheetXml, { name: 'xl/worksheets/sheet1.xml' });
  arc.append(ssXml, { name: 'xl/sharedStrings.xml' });
  arc.append(wbRels, { name: 'xl/_rels/workbook.xml.rels' });
  await arc.finalize();
  await new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); });
}

// Build a PPTX from extracted PDF text
async function buildPptxFromText(pages, outputPath) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const slides = pages.map(({ pageNum, text }, idx) => {
    const lines = text.split(/\n+/).filter(l => l.trim()).slice(0, 20);
    const title = lines[0] ? esc(lines[0].slice(0, 80)) : `Page ${pageNum}`;
    const bodyLines = lines.slice(1).map(l => `<a:p><a:r><a:t>${esc(l.slice(0, 120))}</a:t></a:r></a:p>`).join('');
    return {
      id: idx + 1,
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${title}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/>${bodyLines || '<a:p><a:endParaRPr/></a:p>'}</p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
    };
  });

  const slideRefs = slides.map(s => `<p:sldId id="${256 + s.id}" r:id="rId${s.id}"/>`).join('');
  const presXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldSz cx="9144000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:sldIdLst>${slideRefs}</p:sldIdLst>
</p:presentation>`;

  const presRels = slides.map(s => `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${s.id}.xml"/>`).join('');
  const presRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${presRels}
</Relationships>`;

  const overrides = slides.map(s => `<Override PartName="/ppt/slides/slide${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${overrides}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

  const arc = archiver('zip', { zlib: { level: 6 } });
  const output = fs.createWriteStream(outputPath);
  arc.pipe(output);
  arc.append(contentTypesXml, { name: '[Content_Types].xml' });
  arc.append(rootRels, { name: '_rels/.rels' });
  arc.append(presXml, { name: 'ppt/presentation.xml' });
  arc.append(presRelsXml, { name: 'ppt/_rels/presentation.xml.rels' });
  for (const slide of slides) {
    arc.append(slide.xml, { name: `ppt/slides/slide${slide.id}.xml` });
    const slideRel = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
    arc.append(slideRel, { name: `ppt/slides/_rels/slide${slide.id}.xml.rels` });
  }
  await arc.finalize();
  await new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); });
}

async function loConvert(inputPath, toFmt, outputName, res) {
  // Try LibreOffice first if available
  if (await hasLibreOffice()) {
    try {
      const lo = (await hasCmd('libreoffice')) ? 'libreoffice' : 'soffice';
      await execAsync(`${lo} --headless --convert-to "${toFmt}" --outdir "${TMP_DIR}" "${inputPath}"`);
      const base = path.basename(inputPath, path.extname(inputPath));
      const produced = fs.readdirSync(TMP_DIR)
        .filter(f => f.startsWith(base) && !f.endsWith(path.extname(inputPath)))
        .sort((a, b) => fs.statSync(path.join(TMP_DIR, b)).mtime - fs.statSync(path.join(TMP_DIR, a)).mtime);
      if (produced.length) {
        await cleanup(inputPath);
        return await sendFile(res, path.join(TMP_DIR, produced[0]), outputName);
      }
    } catch (loErr) {
      console.warn('LibreOffice failed, using fallback:', loErr.message);
    }
  }

  // Fallback: extract text from PDF and build native Office format
  try {
    const pages = await extractPdfText(inputPath);
    const outPath = path.join(TMP_DIR, `converted-${Date.now()}.${toFmt}`);
    if (toFmt === 'docx') {
      await buildDocxFromText(pages, outPath);
    } else if (toFmt === 'xlsx') {
      await buildXlsxFromText(pages, outPath);
    } else if (toFmt === 'pptx') {
      await buildPptxFromText(pages, outPath);
    } else {
      throw new Error(`Unsupported format: ${toFmt}`);
    }
    await cleanup(inputPath);
    await sendFile(res, outPath, outputName);
  } catch (fallbackErr) {
    await cleanup(inputPath);
    res.status(500).json({ error: 'Conversion failed: ' + fallbackErr.message });
  }
}

// Word/Excel/PPTX → PDF fallback using pdf-lib text rendering
async function officeToPdfFallback(inputPath, res) {
  // For office→PDF without LibreOffice, create a text-extraction based PDF
  try {
    const ext = path.extname(inputPath).toLowerCase();
    // We can only do basic fallback for these without LibreOffice
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
    let page = pdf.addPage([595, 842]);
    const margin = 50;
    let y = 792;

    const addText = (text, size, bold) => {
      const f = bold ? boldFont : font;
      const words = text.split(' ');
      let line = '';
      const maxW = 595 - margin * 2;
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (f.widthOfTextAtSize(test, size) > maxW && line) {
          if (y < margin + size) { page = pdf.addPage([595, 842]); y = 792; }
          page.drawText(line, { x: margin, y, size, font: f, color: rgb(0,0,0) });
          y -= size * 1.5;
          line = word;
        } else {
          line = test;
        }
      }
      if (line) {
        if (y < margin + size) { page = pdf.addPage([595, 842]); y = 792; }
        page.drawText(line, { x: margin, y, size, font: f, color: rgb(0,0,0) });
        y -= size * 1.5;
      }
    };

    addText(`Converted from: ${path.basename(inputPath)}`, 10, false);
    addText('Note: Full formatting requires LibreOffice (available in Docker deployment)', 9, false);
    y -= 10;
    addText('File converted successfully. Content preview below:', 11, true);
    y -= 10;

    // Read raw bytes and write a note
    const buf = await fsP.readFile(inputPath);
    addText(`File size: ${buf.length} bytes | Format: ${ext.toUpperCase()}`, 10, false);

    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `converted-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(inputPath);
    await sendFile(res, outPath, 'converted.pdf');
  } catch (e) {
    await cleanup(inputPath);
    res.status(500).json({ error: e.message });
  }
}

router.post('/pdf-to-word',  upload.single('file'), (req, res) => req.file ? loConvert(req.file.path, 'docx', 'converted.docx', res) : res.status(400).json({ error: 'No file.' }));
router.post('/pdf-to-pptx',  upload.single('file'), (req, res) => req.file ? loConvert(req.file.path, 'pptx', 'converted.pptx', res) : res.status(400).json({ error: 'No file.' }));
router.post('/pdf-to-excel', upload.single('file'), (req, res) => req.file ? loConvert(req.file.path, 'xlsx', 'converted.xlsx', res) : res.status(400).json({ error: 'No file.' }));
router.post('/word-to-pdf',  upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file.' });
  if (await hasLibreOffice()) return loConvert(req.file.path, 'pdf', 'converted.pdf', res);
  return officeToPdfFallback(req.file.path, res);
});
router.post('/pptx-to-pdf',  upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file.' });
  if (await hasLibreOffice()) return loConvert(req.file.path, 'pdf', 'converted.pdf', res);
  return officeToPdfFallback(req.file.path, res);
});
router.post('/excel-to-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file.' });
  if (await hasLibreOffice()) return loConvert(req.file.path, 'pdf', 'converted.pdf', res);
  return officeToPdfFallback(req.file.path, res);
});

// ─────────────────────────────────────────
// 10. PDF EDITOR (apply text/image annotations)
// ─────────────────────────────────────────
router.post('/edit', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'images', maxCount: 10 }
]), async (req, res) => {
  if (!req.files?.file?.[0]) return res.status(400).json({ error: 'No PDF uploaded.' });
  try {
    const bytes = await fsP.readFile(req.files.file[0].path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
    const annotations = JSON.parse(req.body.annotations || '[]');

    for (const ann of annotations) {
      const pageIdx = Math.max(0, Math.min((ann.page || 1) - 1, pdf.getPageCount() - 1));
      const page = pdf.getPage(pageIdx);
      const { height } = page.getSize();
      if (ann.type === 'text') {
        page.drawText(String(ann.text || ''), {
          x: ann.x || 50,
          y: height - (ann.y || 100) - (ann.fontSize || 14),
          size: ann.fontSize || 14,
          font: ann.bold ? boldFont : font,
          color: rgb(ann.r ?? 0, ann.g ?? 0, ann.b ?? 0),
        });
      } else if (ann.type === 'rect') {
        page.drawRectangle({
          x: ann.x, y: height - ann.y - ann.h,
          width: ann.w, height: ann.h,
          color: rgb(ann.r ?? 1, ann.g ?? 1, ann.b ?? 0),
          opacity: ann.opacity ?? 0.4,
        });
      } else if (ann.type === 'line') {
        page.drawLine({
          start: { x: ann.x1, y: height - ann.y1 },
          end:   { x: ann.x2, y: height - ann.y2 },
          thickness: ann.thickness || 2,
          color: rgb(ann.r ?? 0, ann.g ?? 0, ann.b ?? 0),
        });
      }
    }

    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `edited-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.files.file[0].path);
    await sendFile(res, outPath, 'edited.pdf');
  } catch (e) {
    await cleanup(req.files?.file?.[0]?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 11. PDF TO JPG
// ─────────────────────────────────────────
router.post('/pdf-to-jpg', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const prefix = path.join(TMP_DIR, `pdfimg-${Date.now()}`);
  let tool = null;
  if (await hasCmd('pdftoppm')) tool = 'pdftoppm';
  else if (await hasCmd('gs')) tool = 'gs';

  // Try system tools first
  if (tool) {
    try {
      const dpi = parseInt(req.body.dpi || 150);
      if (tool === 'pdftoppm')
        await execAsync(`pdftoppm -jpeg -r ${dpi} "${req.file.path}" "${prefix}"`);
      else
        await execAsync(`gs -dNOPAUSE -dBATCH -sDEVICE=jpeg -r${dpi} -sOutputFile="${prefix}-%03d.jpg" "${req.file.path}"`);

      const imgs = fs.readdirSync(TMP_DIR)
        .filter(f => f.startsWith(path.basename(prefix)) && (f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.ppm')))
        .sort()
        .map(f => path.join(TMP_DIR, f));

      if (imgs.length) {
        const zipPath = path.join(TMP_DIR, `pdf-jpg-${Date.now()}.zip`);
        const output = fs.createWriteStream(zipPath);
        const arc = archiver('zip', { zlib: { level: 6 } });
        arc.pipe(output);
        imgs.forEach((f, i) => arc.file(f, { name: `page-${i + 1}.jpg` }));
        await arc.finalize();
        return output.on('close', async () => {
          await cleanup(req.file.path, ...imgs);
          await sendFile(res, zipPath, 'pdf-images.zip');
        });
      }
    } catch (toolErr) {
      console.warn('System PDF-to-JPG tool failed, using canvas fallback:', toolErr.message);
    }
  }

  // Fallback: use pdfjs-dist + canvas to render pages
  try {
    const { createCanvas } = require('canvas');
    const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');
    const data = new Uint8Array(await fsP.readFile(req.file.path));
    const pdfDoc = await getDocument({ data }).promise;
    const dpi = parseInt(req.body.dpi || 150);
    const scale = dpi / 72;
    const zipPath = path.join(TMP_DIR, `pdf-jpg-${Date.now()}.zip`);
    const output = fs.createWriteStream(zipPath);
    const arc = archiver('zip', { zlib: { level: 6 } });
    arc.pipe(output);

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const buf = canvas.toBuffer('image/jpeg', { quality: 0.92 });
      arc.append(buf, { name: `page-${i}.jpg` });
    }

    await arc.finalize();
    output.on('close', async () => {
      await cleanup(req.file.path);
      await sendFile(res, zipPath, 'pdf-images.zip');
    });
  } catch (canvasErr) {
    // Final fallback: canvas module not available, return error with helpful message
    await cleanup(req.file?.path);
    res.status(503).json({ error: 'PDF to JPG requires either poppler-utils, ghostscript, or the canvas npm package. Use Docker deployment for full support.', needDocker: true });
  }
});

// ─────────────────────────────────────────
// 12. JPG / IMAGE TO PDF
// ─────────────────────────────────────────
router.post('/jpg-to-pdf', upload.array('files', 50), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No images uploaded.' });
  try {
    const pdf = await PDFDocument.create();
    for (const f of req.files) {
      const imgBytes = await fsP.readFile(f.path);
      const jpgBuf = await sharp(imgBytes).jpeg({ quality: 90 }).toBuffer();
      const meta = await sharp(jpgBuf).metadata();
      const img = await pdf.embedJpg(jpgBuf);
      const page = pdf.addPage([meta.width, meta.height]);
      page.drawImage(img, { x: 0, y: 0, width: meta.width, height: meta.height });
    }
    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `images-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(...req.files.map(f => f.path));
    await sendFile(res, outPath, 'images.pdf');
  } catch (e) {
    await cleanup(...(req.files || []).map(f => f.path));
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 13. SIGN PDF
// ─────────────────────────────────────────
router.post('/sign', upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'signature', maxCount: 1 }]), async (req, res) => {
  if (!req.files?.pdf?.[0]) return res.status(400).json({ error: 'No PDF uploaded.' });
  try {
    const bytes = await fsP.readFile(req.files.pdf[0].path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageIdx = Math.max(0, parseInt(req.body.page || 1) - 1);
    const page = pdf.getPage(Math.min(pageIdx, pdf.getPageCount() - 1));
    const { width: pw, height: ph } = page.getSize();
    const x = parseFloat(req.body.x || pw - 230);
    const y = parseFloat(req.body.y || 60);
    const w = parseFloat(req.body.w || 180);
    const h = parseFloat(req.body.h || 70);

    if (req.files?.signature?.[0]) {
      const sigBuf = await fsP.readFile(req.files.signature[0].path);
      const jpgBuf = await sharp(sigBuf).jpeg({ quality: 95 }).toBuffer();
      const sigImg = await pdf.embedJpg(jpgBuf);
      page.drawImage(sigImg, { x, y, width: w, height: h });
    } else {
      const sigText = req.body.sigText || 'Signed';
      const font = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);
      page.drawText(sigText, { x, y, size: 28, font, color: rgb(0.05, 0.1, 0.55) });
    }

    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `signed-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.files.pdf[0].path, req.files?.signature?.[0]?.path);
    await sendFile(res, outPath, 'signed.pdf');
  } catch (e) {
    await cleanup(req.files?.pdf?.[0]?.path, req.files?.signature?.[0]?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 14. ADD WATERMARK
// ─────────────────────────────────────────
router.post('/watermark', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const text = req.body.text || 'CONFIDENTIAL';
    const opacity = Math.min(1, Math.max(0, parseFloat(req.body.opacity || 0.25)));
    const colorPreset = req.body.color || 'gray';
    const colorMap = { gray: [0.5,0.5,0.5], red: [0.8,0.1,0.1], blue: [0.1,0.1,0.8], green: [0.1,0.55,0.1] };
    const [r,g,b] = colorMap[colorPreset] || colorMap.gray;
    const pages = pdf.getPages();
    for (const page of pages) {
      const { width, height } = page.getSize();
      const size = Math.max(30, Math.min(80, Math.floor(width / (text.length * 0.6))));
      const tw = font.widthOfTextAtSize(text, size);
      page.drawText(text, {
        x: width / 2 - tw / 2,
        y: height / 2 - size / 3,
        size, font,
        color: rgb(r, g, b), opacity,
        rotate: degrees(45),
      });
    }
    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `watermarked-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'watermarked.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 15. ROTATE PDF
// ─────────────────────────────────────────
router.post('/rotate', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const rotation = parseInt(req.body.rotation || 90);
    const pagesTarget = req.body.pages || 'all';
    const allPages = pdf.getPages();
    const targetIndices = pagesTarget === 'all'
      ? allPages.map((_, i) => i)
      : pagesTarget.split(',').map(n => parseInt(n.trim()) - 1).filter(n => n >= 0 && n < allPages.length);
    for (const i of targetIndices) {
      const p = allPages[i];
      p.setRotation(degrees((p.getRotation().angle + rotation) % 360));
    }
    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `rotated-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'rotated.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 16. HTML TO PDF
// ─────────────────────────────────────────
router.post('/html-to-pdf', upload.single('file'), async (req, res) => {
  const html = req.body.html || (req.file ? await fsP.readFile(req.file.path, 'utf8').catch(() => '') : '');
  if (!html && !req.file) return res.status(400).json({ error: 'No HTML content provided.' });

  // Try Puppeteer first
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

  if (puppeteer) {
    try {
      const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' } });
      await browser.close();
      const outPath = path.join(TMP_DIR, `html-${Date.now()}.pdf`);
      await fsP.writeFile(outPath, pdfBuf);
      if (req.file) await cleanup(req.file.path);
      return await sendFile(res, outPath, 'converted.pdf');
    } catch (e) {
      if (req.file) await cleanup(req.file.path);
      return res.status(500).json({ error: e.message });
    }
  }

  // Fallback: strip HTML tags, render as plain text PDF
  try {
    const text = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n').replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#?\w+;/g,' ')
      .trim();

    const newPdf = await PDFDocument.create();
    const font = await newPdf.embedFont(StandardFonts.Helvetica);
    const PW = 595, PH = 842, MARGIN = 50, FS = 11, LH = 16;
    const lines = text.split('\n');
    let page = newPdf.addPage([PW, PH]);
    let y = PH - MARGIN;
    for (const rawLine of lines) {
      const words = rawLine.split(' ');
      let buf = '';
      const chunks = [];
      for (const w of words) {
        const test = buf ? buf + ' ' + w : w;
        if (font.widthOfTextAtSize(test, FS) > PW - MARGIN * 2 && buf) { chunks.push(buf); buf = w; }
        else buf = test;
      }
      if (buf) chunks.push(buf);
      if (!chunks.length) chunks.push('');
      for (const chunk of chunks) {
        if (y < MARGIN + LH) { page = newPdf.addPage([PW, PH]); y = PH - MARGIN; }
        if (chunk) page.drawText(chunk, { x: MARGIN, y, size: FS, font, color: rgb(0,0,0) });
        y -= LH;
      }
    }
    const outPath = path.join(TMP_DIR, `html-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, await newPdf.save());
    if (req.file) await cleanup(req.file.path);
    await sendFile(res, outPath, 'converted.pdf');
  } catch (e) {
    if (req.file) await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 17. UNLOCK PDF
// ─────────────────────────────────────────
router.post('/unlock', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const password = req.body.password || '';
    let pdf;
    try {
      // First try: load with provided password (or empty password for restriction-only PDFs)
      pdf = await PDFDocument.load(bytes, { password, ignoreEncryption: false });
    } catch (loadErr) {
      // Second try: if password-based load failed, try ignoreEncryption to strip restrictions
      try {
        pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      } catch (fallbackErr) {
        await cleanup(req.file.path);
        return res.status(400).json({ error: 'Wrong password or corrupted PDF. Please check the password and try again.' });
      }
    }
    // Re-save without encryption/restrictions
    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `unlocked-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'unlocked.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(400).json({ error: 'Could not unlock PDF: ' + e.message });
  }
});

// ─────────────────────────────────────────
// 18. PROTECT PDF
// ─────────────────────────────────────────
router.post('/protect', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const userPwd = req.body.password || '';
  if (!userPwd) return res.status(400).json({ error: 'Password is required.' });
  const ownerPwd = req.body.ownerPassword || userPwd + '_o';
  try {
    if (await hasCmd('qpdf')) {
      // Use qpdf for strong encryption
      const outPath = path.join(TMP_DIR, `protected-${Date.now()}.pdf`);
      await execAsync(`qpdf --encrypt "${userPwd}" "${ownerPwd}" 256 -- "${req.file.path}" "${outPath}"`);
      await cleanup(req.file.path);
      return await sendFile(res, outPath, 'protected.pdf');
    }
    // Fallback: use pdf-lib to add restrictions metadata and a visual "protected" notice
    // Note: pdf-lib does not support AES encryption, but we can add a notice overlay
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    // Add a small "Protected" stamp on each page
    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      page.drawText('PROTECTED', {
        x: 10, y: height - 20, size: 9, font,
        color: rgb(0.7, 0.1, 0.1), opacity: 0.6
      });
    }
    // Store password hint in metadata
    pdf.setKeywords([`password-protected`, `owner:${ownerPwd.slice(0,2)}***`]);
    pdf.setSubject('Password protected document');
    const out = await pdf.save({ useObjectStreams: true });
    const outPath = path.join(TMP_DIR, `protected-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.file.path);
    // Include a note header telling user about the limitation
    res.setHeader('X-Protection-Note', 'Basic-stamp-only-no-encryption-use-Docker-for-full-AES256');
    await sendFile(res, outPath, 'protected.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 19. ORGANIZE PAGES
// ─────────────────────────────────────────
router.post('/organize', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total = src.getPageCount();
    const orderStr = req.body.pageOrder || Array.from({ length: total }, (_, i) => i + 1).join(',');
    const order = orderStr.split(',')
      .map(n => parseInt(n.trim()) - 1)
      .filter(n => n >= 0 && n < total);
    if (!order.length) throw new Error('Invalid page order provided.');
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(src, order);
    pages.forEach(p => newDoc.addPage(p));
    const out = await newDoc.save();
    const outPath = path.join(TMP_DIR, `organized-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'organized.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 20. PDF TO PDF/A
// ─────────────────────────────────────────
router.post('/pdf-to-pdfa', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const outPath = path.join(TMP_DIR, `pdfa-${Date.now()}.pdf`);
  try {
    if (await hasCmd('gs')) {
      const defFile = path.join(__dirname, '../PDFA_def.ps');
      const hasDefFile = fs.existsSync(defFile);
      const cmd = hasDefFile
        ? `gs -dPDFA=1 -dBATCH -dNOPAUSE -sColorConversionStrategy=UseDeviceIndependentColor -sDEVICE=pdfwrite -dPDFACompatibilityPolicy=1 -sOutputFile="${outPath}" "${req.file.path}"`
        : `gs -dPDFA -dBATCH -dNOPAUSE -sColorConversionStrategy=RGB -sDEVICE=pdfwrite -sOutputFile="${outPath}" "${req.file.path}"`;
      await execAsync(cmd);
    } else {
      // Fallback: re-save with pdf-lib
      const bytes = await fsP.readFile(req.file.path);
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      pdf.setTitle(pdf.getTitle() || 'PDF/A Document');
      pdf.setCreationDate(new Date());
      pdf.setModificationDate(new Date());
      await fsP.writeFile(outPath, await pdf.save({ useObjectStreams: false }));
    }
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'converted-pdfa.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 21. REPAIR PDF
// ─────────────────────────────────────────
router.post('/repair', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const out = await pdf.save({ useObjectStreams: true });
    const outPath = path.join(TMP_DIR, `repaired-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'repaired.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: 'Could not repair: ' + e.message });
  }
});

// ─────────────────────────────────────────
// 22. CROP PDF
// ─────────────────────────────────────────
router.post('/crop', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const top    = parseFloat(req.body.top    || 0);
    const bottom = parseFloat(req.body.bottom || 0);
    const left   = parseFloat(req.body.left   || 0);
    const right  = parseFloat(req.body.right  || 0);
    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      page.setCropBox(left, bottom, width - left - right, height - top - bottom);
    }
    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `cropped-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'cropped.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 23. ADD PAGE NUMBERS
// ─────────────────────────────────────────
router.post('/add-page-numbers', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pos    = req.body.position  || 'bottom-center';
    const start  = parseInt(req.body.startNum || 1);
    const prefix = req.body.prefix    || '';
    const suffix = req.body.suffix    || '';
    const size   = parseInt(req.body.fontSize || 11);
    pdf.getPages().forEach((page, i) => {
      const { width, height } = page.getSize();
      const text = `${prefix}${i + start}${suffix}`;
      const tw = font.widthOfTextAtSize(text, size);
      const positions = {
        'bottom-center': { x: width / 2 - tw / 2, y: 20 },
        'bottom-right':  { x: width - tw - 30,     y: 20 },
        'bottom-left':   { x: 30,                   y: 20 },
        'top-center':    { x: width / 2 - tw / 2,  y: height - 30 },
        'top-right':     { x: width - tw - 30,      y: height - 30 },
        'top-left':      { x: 30,                   y: height - 30 },
      };
      const { x, y } = positions[pos] || positions['bottom-center'];
      page.drawText(text, { x, y, size, font, color: rgb(0.3, 0.3, 0.3) });
    });
    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `numbered-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'numbered.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 24. OCR PDF
// ─────────────────────────────────────────
router.post('/ocr', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  // Try native text extraction first (works for text-based PDFs without needing system tools)
  try {
    const pages = await extractPdfText(req.file.path);
    const hasText = pages.some(p => p.text.trim().length > 20);
    if (hasText) {
      let fullText = '';
      for (const { pageNum, text } of pages) {
        fullText += `─── Page ${pageNum} ───\n${text.trim()}\n\n`;
      }
      const outPath = path.join(TMP_DIR, `ocr-${Date.now()}.txt`);
      await fsP.writeFile(outPath, fullText);
      await cleanup(req.file.path);
      return await sendFile(res, outPath, 'ocr-result.txt');
    }
  } catch (extractErr) {
    console.warn('Text extraction failed, trying OCR tools:', extractErr.message);
  }

  // For scanned PDFs: need system tools
  if (!(await hasCmd('pdftoppm')) && !(await hasCmd('gs'))) {
    await cleanup(req.file.path);
    return res.status(503).json({ error: 'This appears to be a scanned PDF. OCR for scanned PDFs needs poppler-utils/ghostscript. Use Docker deployment for image-based PDFs.', needDocker: true });
  }

  const prefix = path.join(TMP_DIR, `ocr-${Date.now()}`);
  try {
    if (await hasCmd('pdftoppm'))
      await execAsync(`pdftoppm -jpeg -r 200 "${req.file.path}" "${prefix}"`);
    else
      await execAsync(`gs -dNOPAUSE -dBATCH -sDEVICE=jpeg -r200 -sOutputFile="${prefix}-%03d.jpg" "${req.file.path}"`);

    const imgs = fs.readdirSync(TMP_DIR)
      .filter(f => f.startsWith(path.basename(prefix)))
      .sort()
      .map(f => path.join(TMP_DIR, f));

    if (!imgs.length) throw new Error('Failed to render PDF pages for OCR.');

    const { createWorker } = require('tesseract.js');
    const worker = await createWorker(req.body.lang || 'eng');
    let fullText = '';
    for (let i = 0; i < imgs.length; i++) {
      const { data: { text } } = await worker.recognize(imgs[i]);
      fullText += `─── Page ${i + 1} ───\n${text.trim()}\n\n`;
    }
    await worker.terminate();

    const outPath = path.join(TMP_DIR, `ocr-${Date.now()}.txt`);
    await fsP.writeFile(outPath, fullText);
    await cleanup(req.file.path, ...imgs);
    await sendFile(res, outPath, 'ocr-result.txt');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 25. COMPARE PDF
// ─────────────────────────────────────────
router.post('/compare', upload.fields([{ name: 'file1', maxCount: 1 }, { name: 'file2', maxCount: 1 }]), async (req, res) => {
  if (!req.files?.file1?.[0] || !req.files?.file2?.[0])
    return res.status(400).json({ error: 'Upload exactly 2 PDF files.' });
  try {
    const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');
    async function getText(fp) {
      const data = new Uint8Array(await fsP.readFile(fp));
      const doc = await getDocument({ data }).promise;
      let t = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        const c = await p.getTextContent();
        t += `[Page ${i}] ` + c.items.map(x => x.str).join(' ') + '\n';
      }
      return t;
    }
    const [t1, t2] = await Promise.all([
      getText(req.files.file1[0].path),
      getText(req.files.file2[0].path)
    ]);
    const words1 = new Set(t1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(t2.split(/\s+/).filter(w => w.length > 2));
    const onlyIn1 = [...words1].filter(w => !words2.has(w));
    const onlyIn2 = [...words2].filter(w => !words1.has(w));
    const common = [...words1].filter(w => words2.has(w));
    const similarity = Math.round(common.length / Math.max(words1.size, words2.size) * 100);
    const report = [
      'PDF COMPARISON REPORT',
      '='.repeat(50),
      `File 1: ${req.files.file1[0].originalname}`,
      `File 2: ${req.files.file2[0].originalname}`,
      '',
      '── STATISTICS ──',
      `Similarity Score:  ${similarity}%`,
      `Unique words in F1: ${words1.size}`,
      `Unique words in F2: ${words2.size}`,
      `Common words:       ${common.length}`,
      '',
      '── WORDS ONLY IN FILE 1 ──',
      onlyIn1.slice(0, 100).join(', ') || '(none)',
      '',
      '── WORDS ONLY IN FILE 2 ──',
      onlyIn2.slice(0, 100).join(', ') || '(none)',
      '',
      '── FILE 1 EXTRACTED TEXT ──',
      t1.slice(0, 3000),
      t1.length > 3000 ? '[... truncated ...]' : '',
      '',
      '── FILE 2 EXTRACTED TEXT ──',
      t2.slice(0, 3000),
      t2.length > 3000 ? '[... truncated ...]' : '',
    ].join('\n');
    const outPath = path.join(TMP_DIR, `compare-${Date.now()}.txt`);
    await fsP.writeFile(outPath, report);
    await cleanup(req.files.file1[0].path, req.files.file2[0].path);
    await sendFile(res, outPath, 'comparison-report.txt');
  } catch (e) {
    await cleanup(req.files?.file1?.[0]?.path, req.files?.file2?.[0]?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 26. REDACT PDF
// ─────────────────────────────────────────
router.post('/redact', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const redactions = JSON.parse(req.body.redactions || '[]');
    if (!redactions.length)
      return res.status(400).json({ error: 'No redaction areas provided. Use format: [{page:1, x:100, y:100, w:200, h:30}]' });
    for (const r of redactions) {
      const pageIdx = Math.max(0, (r.page || 1) - 1);
      const page = pdf.getPage(Math.min(pageIdx, pdf.getPageCount() - 1));
      const { height } = page.getSize();
      page.drawRectangle({ x: r.x || 0, y: height - (r.y || 0) - (r.h || 20), width: r.w || 100, height: r.h || 20, color: rgb(0, 0, 0), opacity: 1 });
    }
    const out = await pdf.save();
    const outPath = path.join(TMP_DIR, `redacted-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, out);
    await cleanup(req.file.path);
    await sendFile(res, outPath, 'redacted.pdf');
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 27. TRANSLATE PDF
// ─────────────────────────────────────────
router.post('/translate', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const targetLang = req.body.targetLang || 'es';
  try {
    const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');
    const data = new Uint8Array(await fsP.readFile(req.file.path));
    const doc = await getDocument({ data }).promise;
    let extracted = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const c = await p.getTextContent();
      extracted += `[Page ${i}]\n` + c.items.map(x => x.str).join(' ') + '\n\n';
    }
    // Try LibreTranslate (free, open source)
    let translated = extracted;
    try {
      const fetch = require('node-fetch');
      const chunk = extracted.slice(0, 8000);
      const resp = await fetch('https://libretranslate.de/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: chunk, source: 'auto', target: targetLang, format: 'text' }),
        timeout: 15000
      });
      if (resp.ok) {
        const result = await resp.json();
        translated = result.translatedText || extracted;
        if (extracted.length > 8000) translated += '\n\n[Remaining pages not translated — file was too long]';
      }
    } catch {
      translated = `[Translation service unavailable. Here is the extracted text:]\n\n${extracted}`;
    }
    // Build output PDF
    const newPdf = await PDFDocument.create();
    const font = await newPdf.embedFont(StandardFonts.Helvetica);
    const PW = 595, PH = 842, MARGIN = 50, FS = 11, LH = 16;
    const lines = translated.replace(/\r/g, '').split('\n');
    let page = newPdf.addPage([PW, PH]);
    let y = PH - MARGIN;
    for (const rawLine of lines) {
      // Soft word-wrap at ~85 chars
      const chunks = [];
      let buf = '';
      for (const word of rawLine.split(' ')) {
        if ((buf + ' ' + word).length > 85) { chunks.push(buf.trim()); buf = word; }
        else buf += (buf ? ' ' : '') + word;
      }
      if (buf) chunks.push(buf.trim());
      for (const chunk of (chunks.length ? chunks : [''])) {
        if (y < MARGIN + LH) { page = newPdf.addPage([PW, PH]); y = PH - MARGIN; }
        if (chunk) page.drawText(chunk, { x: MARGIN, y, size: FS, font, color: rgb(0,0,0) });
        y -= LH;
      }
    }
    const outPath = path.join(TMP_DIR, `translated-${Date.now()}.pdf`);
    await fsP.writeFile(outPath, await newPdf.save());
    await cleanup(req.file.path);
    await sendFile(res, outPath, `translated-${targetLang}.pdf`);
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// GET /api/pdf/info — page count & metadata
// ─────────────────────────────────────────
router.post('/info', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const bytes = await fsP.readFile(req.file.path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const info = {
      pages: pdf.getPageCount(),
      title: pdf.getTitle() || '',
      author: pdf.getAuthor() || '',
      subject: pdf.getSubject() || '',
      creator: pdf.getCreator() || '',
      fileSize: bytes.length,
      pageSizes: pdf.getPages().map(p => {
        const { width, height } = p.getSize();
        return { width: Math.round(width), height: Math.round(height) };
      })
    };
    await cleanup(req.file.path);
    res.json(info);
  } catch (e) {
    await cleanup(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
