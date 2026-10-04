import { collapseWhitespace, paragraphs, sentences, truncate, words } from '../core/textkit.js';
import { round } from '../core/mathx.js';

/** Format-specific extraction. Every path lands on the same shape, so the rest
 *  of the pipeline never needs to know where the content came from. */

export type SourceKind = 'text' | 'markdown' | 'html' | 'pdf' | 'image' | 'audio' | 'video' | 'csv' | 'url';

export interface ExtractedBlock {
  kind: 'heading' | 'prose' | 'list' | 'formula' | 'table' | 'caption' | 'question' | 'code' | 'definition';
  level?: number;
  text: string;
  /** Position in the original document, for citing back. */
  index: number;
  meta?: Record<string, unknown>;
}

export interface Extraction {
  title: string;
  kind: SourceKind;
  text: string;
  blocks: ExtractedBlock[];
  wordCount: number;
  warnings: string[];
  /** What a richer pipeline would add here (OCR, ASR) - stated, never faked. */
  unsupported: string[];
}

/* --------------------------------- markdown ------------------------------- */

export function extractMarkdown(src: string): Extraction {
  const blocks: ExtractedBlock[] = [];
  const warnings: string[] = [];
  const lines = src.split(/\r?\n/);
  let title = '';
  let buffer: string[] = [];
  let inCode = false;
  let codeBuffer: string[] = [];
  let index = 0;

  const flushProse = () => {
    const text = collapseWhitespace(buffer.join(' '));
    if (text) blocks.push({ kind: 'prose', text, index: index++ });
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');

    if (/^\s*```/.test(line)) {
      if (inCode) {
        blocks.push({ kind: 'code', text: codeBuffer.join('\n'), index: index++ });
        codeBuffer = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) { codeBuffer.push(line); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushProse();
      const text = heading[2].replace(/[#*`]/g, '').trim();
      if (!title && heading[1].length <= 2) title = text;
      blocks.push({ kind: 'heading', level: heading[1].length, text, index: index++ });
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushProse();
      blocks.push({ kind: 'table', text: line.trim(), index: index++ });
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushProse();
      blocks.push({ kind: 'list', text: line.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim(), index: index++ });
      continue;
    }
    if (/^\s*\$\$|^\s*\\\[/.test(line)) {
      flushProse();
      blocks.push({ kind: 'formula', text: line.replace(/\$\$|\\\[|\\\]/g, '').trim(), index: index++ });
      continue;
    }
    if (!line.trim()) { flushProse(); continue; }
    buffer.push(line.replace(/[*_`]/g, '').trim());
  }
  flushProse();
  if (inCode) warnings.push('unterminated code fence - the tail was treated as prose');

  const text = blocks.filter((b) => b.kind !== 'code').map((b) => b.text).join('\n\n');
  return {
    title: title || deriveTitle(text),
    kind: 'markdown',
    text,
    blocks: classify(blocks),
    wordCount: words(text).length,
    warnings,
    unsupported: [],
  };
}

/* ----------------------------------- html --------------------------------- */

const BLOCK_TAGS =
  /<\/?(p|div|section|article|br|hr|li|ul|ol|tr|td|th|table|thead|tbody|h[1-6]|blockquote|figure|figcaption|pre|header|footer|nav|main|aside|body|html|head|title|form|label)\b[^>]*>/gi;

export function extractHtml(src: string): Extraction {
  const warnings: string[] = [];
  let html = src;

  // Strip anything that is not content before any tag handling.
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<(script|style|noscript|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ');

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : '';
  // <head> is metadata, not content: keep the title we just took and drop the rest.
  html = html.replace(/<head\b[\s\S]*?<\/head>/gi, ' ');

  const blocks: ExtractedBlock[] = [];
  let index = 0;

  // Headings keep their level, which is the document's own structure.
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const marked = html.replace(headingRe, (_m, lvl: string, inner: string) => `\n\u0001H${lvl}\u0001${stripTags(inner)}\u0001\n`);

  const listRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  const withLists = marked.replace(listRe, (_m, inner: string) => `\n\u0001L\u0001${stripTags(inner)}\u0001\n`);

  const flat = decodeEntities(withLists.replace(BLOCK_TAGS, '\n').replace(/<[^>]+>/g, ' '));

  for (const chunk of flat.split('\n')) {
    const t = collapseWhitespace(chunk);
    if (!t) continue;
    const h = t.match(/^\u0001H([1-6])\u0001(.*?)\u0001?$/);
    if (h) {
      blocks.push({ kind: 'heading', level: Number(h[1]), text: collapseWhitespace(h[2]), index: index++ });
      continue;
    }
    const l = t.match(/^\u0001L\u0001(.*?)\u0001?$/);
    if (l) {
      blocks.push({ kind: 'list', text: collapseWhitespace(l[1]), index: index++ });
      continue;
    }
    const clean = t.replace(/\u0001/g, ' ').trim();
    if (clean.length > 1) blocks.push({ kind: 'prose', text: clean, index: index++ });
  }

  if (!blocks.length) warnings.push('no readable text found in the HTML');
  const text = blocks.map((b) => b.text).join('\n\n');
  return {
    title: title || deriveTitle(text),
    kind: 'html',
    text,
    blocks: classify(blocks),
    wordCount: words(text).length,
    warnings,
    unsupported: [],
  };
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, ' ');

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', deg: '°',
  times: '×', divide: '÷', plusmn: '±', le: '≤', ge: '≥', ne: '≠', radic: '√', pi: 'π', alpha: 'α', beta: 'β',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/* ----------------------------------- csv ---------------------------------- */

/** A worksheet exported as CSV: each row becomes a question block. */
export function extractCsv(src: string): Extraction {
  const rows = parseCsv(src);
  const warnings: string[] = [];
  if (!rows.length) {
    return { title: 'Worksheet', kind: 'csv', text: '', blocks: [], wordCount: 0, warnings: ['empty CSV'], unsupported: [] };
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const qCol = header.findIndex((h) => /question|prompt|stem|task/.test(h));
  const aCol = header.findIndex((h) => /answer|solution|key/.test(h));

  const blocks: ExtractedBlock[] = [];
  let index = 0;
  if (qCol < 0) warnings.push('no question column found - treating every cell as prose');

  for (const row of rows.slice(1)) {
    if (!row.some((c) => c.trim())) continue;
    if (qCol >= 0) {
      const q = row[qCol]?.trim();
      if (!q) continue;
      blocks.push({
        kind: 'question',
        text: q,
        index: index++,
        meta: aCol >= 0 && row[aCol] ? { answer: row[aCol].trim() } : undefined,
      });
    } else {
      const joined = row.filter(Boolean).join(' — ').trim();
      if (joined) blocks.push({ kind: 'prose', text: joined, index: index++ });
    }
  }

  const text = blocks.map((b) => b.text).join('\n');
  return {
    title: 'Worksheet',
    kind: 'csv',
    text,
    blocks,
    wordCount: words(text).length,
    warnings,
    unsupported: [],
  };
}

/** RFC4180-ish CSV: quotes, escaped quotes and embedded newlines. */
export function parseCsv(src: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0]?.trim());
}

/* ------------------------------- plain text -------------------------------- */

export function extractText(src: string): Extraction {
  const blocks: ExtractedBlock[] = [];
  let index = 0;
  for (const p of paragraphs(src)) {
    const line = collapseWhitespace(p);
    if (!line) continue;
    // A short line with no terminal punctuation, in a document with longer
    // paragraphs, is almost always a heading.
    const isHeading = words(line).length <= 9 && !/[.!?:;,]$/.test(line) && line.length < 70;
    blocks.push({ kind: isHeading ? 'heading' : 'prose', level: isHeading ? 2 : undefined, text: line, index: index++ });
  }
  const text = blocks.map((b) => b.text).join('\n\n');
  return {
    title: blocks.find((b) => b.kind === 'heading')?.text ?? deriveTitle(text),
    kind: 'text',
    text,
    blocks: classify(blocks),
    wordCount: words(text).length,
    warnings: [],
    unsupported: [],
  };
}

/* ----------------------------------- pdf ----------------------------------- */

/** Extracts text from the uncompressed text operators of a PDF.
 *
 *  Deliberately honest: this handles PDFs whose text streams are not
 *  compressed, and SAYS SO when it cannot. A silent empty result would be far
 *  worse than a stated limitation - a teacher would think the upload worked. */
export function extractPdf(buffer: Buffer | Uint8Array): Extraction {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const raw = bytes.toString('latin1');
  const warnings: string[] = [];
  const unsupported: string[] = [];

  if (!raw.startsWith('%PDF')) {
    return {
      title: 'Document', kind: 'pdf', text: '', blocks: [], wordCount: 0,
      warnings: ['this does not look like a PDF'], unsupported: [],
    };
  }

  const compressed = /\/Filter\s*\/(FlateDecode|LZWDecode|DCTDecode)/.test(raw);
  const pieces: string[] = [];

  // Text-showing operators: (string) Tj, [(a) -2 (b)] TJ, and ' / "
  const tjRe = /\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")/g;
  const tjArrRe = /\[((?:\s*\((?:\\.|[^\\()])*\)\s*-?[\d.]*)+)\]\s*TJ/g;

  for (const m of raw.matchAll(tjArrRe)) {
    const inner = [...m[1].matchAll(/\((?:\\.|[^\\()])*\)/g)].map((x) => unescapePdf(x[0].slice(1, -1)));
    pieces.push(inner.join(''));
  }
  for (const m of raw.matchAll(tjRe)) {
    pieces.push(unescapePdf(m[0].replace(/\s*(Tj|'|")$/, '').slice(1, -1)));
  }

  const text = collapseWhitespace(pieces.join(' ').replace(/\s{2,}/g, ' '));
  const pageCount = (raw.match(/\/Type\s*\/Page\b/g) ?? []).length;

  if (!text || words(text).length < 20) {
    if (compressed) {
      unsupported.push(
        'This PDF stores its text in compressed streams, which this extractor cannot read. '
        + 'Paste the text directly, or export the PDF as text or HTML first.',
      );
    } else {
      unsupported.push('No readable text layer found. If this is a scan, it needs OCR before it can be made accessible.');
    }
  } else if (compressed) {
    warnings.push('Some of this PDF is compressed, so parts of the text may be missing.');
  }

  const base = extractText(text);
  return {
    ...base,
    kind: 'pdf',
    warnings: [...base.warnings, ...warnings],
    unsupported,
    blocks: base.blocks,
    title: base.title || 'Document',
    meta: { pageCount },
  } as Extraction & { meta: Record<string, unknown> };
}

function unescapePdf(s: string): string {
  return s
    .replace(/\\(\d{1,3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ')
    .replace(/\\([()\\])/g, '$1');
}

/* --------------------------- unsupported media ----------------------------- */

/** Images and audio need OCR/ASR, which this build does not ship.
 *  It says so plainly rather than returning an empty document. */
export function describeUnsupported(kind: SourceKind, hint?: string): Extraction {
  const need = kind === 'image' ? 'optical character recognition (OCR)'
    : kind === 'audio' || kind === 'video' ? 'automatic speech recognition (ASR)'
    : 'a dedicated parser';
  return {
    title: hint ?? `Uploaded ${kind}`,
    kind,
    text: '',
    blocks: [],
    wordCount: 0,
    warnings: [],
    unsupported: [
      `${kind} input needs ${need}, which is not enabled in this deployment. `
      + `Supply the text directly and every other transformation will run normally.`,
    ],
  };
}

/* -------------------------------- shared ---------------------------------- */

const FORMULA = /[=≈≠≤≥±×÷√∑∫∞π]|\b\d+\s*[\/^]\s*\d+\b|\b[a-z]\s*=\s*[-\d(]/i;
const DEFINITION = /\b(is called|is defined as|means that|refers to|is known as|we call|, that is,)\b/i;
const QUESTION = /\?\s*$|^\s*(what|why|how|when|where|which|who|explain|describe|calculate|find|show that|prove)\b/i;

/** Re-label prose blocks that are really formulas, definitions or questions.
 *  The label drives how each block is later presented. */
export function classify(blocks: ExtractedBlock[]): ExtractedBlock[] {
  return blocks.map((b) => {
    // Exercises are usually numbered lists, so list items get the same
    // question test as prose - otherwise a whole exercise set is invisible.
    if (b.kind === 'list' && QUESTION.test(b.text) && words(b.text).length < 45) {
      return { ...b, kind: 'question' };
    }
    if (b.kind !== 'prose') return b;
    const t = b.text;
    if (QUESTION.test(t) && words(t).length < 45) return { ...b, kind: 'question' };
    if (DEFINITION.test(t)) return { ...b, kind: 'definition' };
    const symbolDensity = (t.match(FORMULA) ?? []).length;
    if (symbolDensity > 0 && words(t).length < 14) return { ...b, kind: 'formula' };
    return b;
  });
}

function deriveTitle(text: string): string {
  const first = sentences(text)[0] ?? text;
  return truncate(collapseWhitespace(first).replace(/[.!?]$/, ''), 70) || 'Untitled';
}

/** Dispatch on declared kind, sniffing when the caller is unsure. */
export function extract(
  input: string | Buffer | Uint8Array,
  kind: SourceKind | 'auto' = 'auto',
  hint?: string,
): Extraction {
  if (typeof input !== 'string') {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (kind === 'pdf' || bytes.subarray(0, 4).toString('latin1') === '%PDF') return extractPdf(bytes);
    if (kind === 'image' || kind === 'audio' || kind === 'video') return describeUnsupported(kind, hint);
    return extract(bytes.toString('utf8'), kind === 'auto' ? 'auto' : kind, hint);
  }

  const src = input;
  if (kind === 'image' || kind === 'audio' || kind === 'video') return describeUnsupported(kind, hint);
  if (kind === 'html') return extractHtml(src);
  if (kind === 'markdown') return extractMarkdown(src);
  if (kind === 'csv') return extractCsv(src);
  if (kind === 'text') return extractText(src);

  // auto: sniff.
  if (/^\s*%PDF/.test(src)) return extractPdf(Buffer.from(src, 'latin1'));
  if (/<\/?(html|body|div|p|h[1-6]|table)\b/i.test(src)) return extractHtml(src);
  if (/^#{1,6}\s|\n#{1,6}\s|^\s*[-*+]\s|\n\s*[-*+]\s|```/.test(src)) return extractMarkdown(src);
  const lines = src.split(/\r?\n/).filter(Boolean).slice(0, 5);
  if (lines.length > 1 && lines.every((l) => (l.match(/,/g) ?? []).length >= 1)
      && new Set(lines.map((l) => (l.match(/,/g) ?? []).length)).size <= 2) {
    return extractCsv(src);
  }
  return extractText(src);
}

/** Readability-independent structural stats, for the ingestion report. */
export function structureReport(e: Extraction) {
  const byKind: Record<string, number> = {};
  for (const b of e.blocks) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
  const proseLengths = e.blocks.filter((b) => b.kind === 'prose').map((b) => words(b.text).length);
  return {
    blocks: e.blocks.length,
    byKind,
    hasHeadings: (byKind.heading ?? 0) > 0,
    avgParagraphWords: proseLengths.length ? round(proseLengths.reduce((a, b) => a + b, 0) / proseLengths.length, 1) : 0,
    longestParagraphWords: proseLengths.length ? Math.max(...proseLengths) : 0,
    questions: byKind.question ?? 0,
    formulas: byKind.formula ?? 0,
    definitions: byKind.definition ?? 0,
  };
}
