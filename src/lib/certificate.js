import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import env from '../config/env.js';

const BRAND = '#0f766e';
const INK = '#0f172a';
const MUTED = '#64748b';

export function generateSerial(issuedAt = new Date()) {
  const year = issuedAt.getUTCFullYear();
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `KA-${year}-${random}`;
}

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const formatDate = (date) =>
  new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** Wrap long course titles so they don't overflow the SVG canvas. */
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 3);
}

export function renderCertificateSvg(cert) {
  const titleLines = wrap(cert.courseTitle, 34);
  const verifyUrl = `${env.APP_URL}/verify/${cert.serial}`;

  const LINE_HEIGHT = 42;
  const titleTop = 348;
  const afterTitle = titleTop + (titleLines.length - 1) * LINE_HEIGHT;

  const title = titleLines
    .map(
      (line, i) =>
        `<text x="500" y="${titleTop + i * LINE_HEIGHT}" text-anchor="middle" font-size="34" font-weight="700" fill="${INK}">${escapeXml(line)}</text>`,
    )
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="707" viewBox="0 0 1000 707" role="img" aria-label="Certificate of completion">
  <rect width="1000" height="707" fill="#ffffff"/>
  <rect x="24" y="24" width="952" height="659" fill="none" stroke="${BRAND}" stroke-width="3"/>
  <rect x="36" y="36" width="928" height="635" fill="none" stroke="${BRAND}" stroke-width="1" opacity="0.45"/>
  <text x="500" y="120" text-anchor="middle" font-size="20" letter-spacing="6" fill="${BRAND}" font-weight="600">KAISTRUM ACADEMY</text>
  <text x="500" y="188" text-anchor="middle" font-size="40" font-weight="700" fill="${INK}">Certificate of Completion</text>
  <line x1="380" y1="212" x2="620" y2="212" stroke="${BRAND}" stroke-width="2"/>
  <text x="500" y="256" text-anchor="middle" font-size="17" fill="${MUTED}">This is to certify that</text>
  <text x="500" y="298" text-anchor="middle" font-size="30" font-weight="600" fill="${BRAND}">${escapeXml(cert.learnerName)}</text>
  <text x="500" y="326" text-anchor="middle" font-size="17" fill="${MUTED}">has successfully completed</text>
  ${title}
  <text x="500" y="${afterTitle + 44}" text-anchor="middle" font-size="16" fill="${MUTED}">${escapeXml(cert.hours)} hours of instruction &#183; ${escapeXml(formatDate(cert.issuedAt))}</text>
  <text x="150" y="592" font-size="18" font-weight="600" fill="${INK}">${escapeXml(cert.instructorName ?? 'Kaistrum Academy')}</text>
  <line x1="150" y1="600" x2="390" y2="600" stroke="${MUTED}" stroke-width="1"/>
  <text x="150" y="620" font-size="14" fill="${MUTED}">Instructor</text>
  <text x="850" y="592" text-anchor="end" font-size="18" font-weight="600" fill="${INK}">${escapeXml(cert.serial)}</text>
  <line x1="610" y1="600" x2="850" y2="600" stroke="${MUTED}" stroke-width="1"/>
  <text x="850" y="620" text-anchor="end" font-size="14" fill="${MUTED}">Serial</text>
  <text x="500" y="666" text-anchor="middle" font-size="12" fill="${MUTED}">Verify at ${escapeXml(verifyUrl)}</text>
</svg>`;
}

export function renderCertificatePdf(cert) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;

    doc.rect(0, 0, W, H).fill('#ffffff');
    doc.lineWidth(3).strokeColor(BRAND).rect(20, 20, W - 40, H - 40).stroke();
    doc.lineWidth(1).strokeColor(BRAND).opacity(0.45).rect(30, 30, W - 60, H - 60).stroke();
    doc.opacity(1);

    doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND).text('KAISTRUM ACADEMY', 0, 70, {
      align: 'center',
      characterSpacing: 4,
    });

    doc.font('Helvetica-Bold').fontSize(30).fillColor(INK).text('Certificate of Completion', 0, 110, {
      align: 'center',
    });

    doc.font('Helvetica').fontSize(12).fillColor(MUTED).text('This is to certify that', 0, 165, {
      align: 'center',
    });

    doc.font('Helvetica-Bold').fontSize(24).fillColor(BRAND).text(cert.learnerName, 0, 190, {
      align: 'center',
    });

    doc.font('Helvetica').fontSize(12).fillColor(MUTED).text('has successfully completed', 0, 230, {
      align: 'center',
    });

    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(cert.courseTitle, 80, 255, {
      align: 'center',
      width: W - 160,
    });

    doc
      .font('Helvetica')
      .fontSize(12)
      .fillColor(MUTED)
      .text(`${cert.hours} hours of instruction  ·  ${formatDate(cert.issuedAt)}`, 0, 320, {
        align: 'center',
      });

    const baseline = H - 120;
    doc.lineWidth(1).strokeColor(MUTED);
    doc.moveTo(90, baseline).lineTo(300, baseline).stroke();
    doc.moveTo(W - 300, baseline).lineTo(W - 90, baseline).stroke();

    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
      .text(cert.instructorName ?? 'Kaistrum Academy', 90, baseline - 20, { width: 210 });
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text('Instructor', 90, baseline + 8, { width: 210 });

    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
      .text(cert.serial, W - 300, baseline - 20, { width: 210, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text('Serial', W - 300, baseline + 8, { width: 210, align: 'right' });

    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text(`Verify at ${env.APP_URL}/verify/${cert.serial}`, 0, H - 60, { align: 'center' });

    doc.end();
  });
}
