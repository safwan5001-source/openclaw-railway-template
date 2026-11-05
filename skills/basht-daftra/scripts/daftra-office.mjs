// Dependency-free XLSX and DOCX writers (ZIP + OOXML) for Daftra exports. No API calls.
import { deflateRawSync } from 'node:zlib';
import { cellString, detectRtl, numericLiteral, safeCell } from './daftra-cells.mjs';

export const MAX_CELL_CHARS = 32767;

// ---------- ZIP ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [[name, string|Buffer], ...]. Deterministic output (fixed DOS timestamp).
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);            // time 00:00
    local.writeUInt16LE(0x0021, 12);       // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(useDeflate ? 8 : 0, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0x0021, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------- shared helpers ----------
export function xmlText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function checkTable(records, columns, maxRows) {
  if (!Array.isArray(records) || records.length > maxRows) throw Error('Invalid record count');
  if (!Array.isArray(columns) || !columns.length || columns.length > 100 || columns.some((c) => typeof c !== 'string' || !/^[a-zA-Z0-9_]+$/.test(c))
    || new Set(columns).size !== columns.length) throw Error('Invalid columns');
}

function checkedText(value) {
  const text = safeCell(value);
  if (text.length > MAX_CELL_CHARS) throw Error('Cell too long');
  return text;
}

function infoRows(metadata = {}) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw Error('Invalid metadata');
  return Object.entries(metadata).map(([k, v]) => [k, cellString(v)]);
}

export function validateSheetName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 31 || /[\[\]:*?/\\]/.test(name) || /^'|'$/.test(name))
    throw Error('Invalid sheet name');
  if (name.toLowerCase() === 'info') throw Error('Sheet name "Info" is reserved');
  return name;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// ---------- XLSX ----------
function sheetXml(rows, { rtl, widths, header }) {
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows.map((cells, r) => `<row r="${r + 1}">` + cells.map((cell, c) => {
    const ref = colName(c + 1) + (r + 1);
    if (cell.n !== undefined) return `<c r="${ref}" s="2"><v>${cell.n}</v></c>`;
    const style = header && r === 0 ? ' s="1"' : '';
    return cell.t === '' ? `<c r="${ref}"${style}/>` : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.t)}</t></is></c>`;
  }).join('') + '</row>').join('');
  const pane = header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '';
  return XML_HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetViews><sheetView${rtl ? ' rightToLeft="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

function widthsFor(rows, ncols) {
  return Array.from({ length: ncols }, (_, c) => {
    let max = 8;
    for (const row of rows.slice(0, 500)) max = Math.max(max, Math.min((row[c].t ?? String(row[c].n)).length, 60));
    return Math.min(max + 2, 50);
  });
}

export function toXlsx(records, columns, opts = {}) {
  const { title, metadata = {}, numericColumns = [], sheetName = 'Daftra', maxRows = 50000 } = opts;
  checkTable(records, columns, maxRows);
  validateSheetName(sheetName);
  const numeric = new Set(numericColumns);
  const rtl = opts.rtl ?? detectRtl(title, columns, records);
  const dataRows = [columns.map((c) => ({ t: c }))];
  for (const record of records) {
    dataRows.push(columns.map((c) => {
      const value = record?.[c];
      if (numeric.has(c)) { const n = numericLiteral(value); if (n !== null) return { n }; }
      return { t: checkedText(value) };
    }));
  }
  const info = [['title', title ?? ''], ...infoRows(metadata), ['rows', String(records.length)]]
    .map(([k, v]) => [{ t: checkedText(k) }, { t: checkedText(v) }]);
  const styles = XML_HEAD + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return zip([
    ['[Content_Types].xml', XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', XML_HEAD + `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', XML_HEAD + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OD}"><sheets>`
      + `<sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/><sheet name="Info" sheetId="2" r:id="rId2"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', XML_HEAD + `<Relationships xmlns="${REL_NS}">`
      + `<Relationship Id="rId1" Type="${OD}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${OD}/worksheet" Target="worksheets/sheet2.xml"/>`
      + `<Relationship Id="rId3" Type="${OD}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', sheetXml(dataRows, { rtl, widths: widthsFor(dataRows, columns.length), header: true })],
    ['xl/worksheets/sheet2.xml', sheetXml(info, { rtl, widths: [24, 60], header: false })],
  ]);
}

// ---------- DOCX ----------
function paragraph(text, { rtl, style, bold } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const runs = lines.map((l, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${xmlText(l)}</w:t>`).join('');
  const pPr = (style ? `<w:pStyle w:val="${style}"/>` : '') + (rtl ? '<w:bidi/>' : '');
  const rPr = (bold ? '<w:b/><w:bCs/>' : '') + (rtl ? '<w:rtl/>' : '');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${runs}</w:r></w:p>`;
}

export function toDocx(records, columns, opts = {}) {
  const { title = 'Daftra Export', metadata = {}, maxRows = 10000 } = opts;
  checkTable(records, columns, maxRows);
  const rtl = opts.rtl ?? detectRtl(title, columns, records);
  const landscape = columns.length > 5;
  const width = landscape ? 14000 : 9000;
  const grid = columns.map(() => `<w:gridCol w:w="${Math.floor(width / columns.length)}"/>`).join('');
  const cell = (text, header) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(width / columns.length)}" w:type="dxa"/>`
    + (header ? '<w:shd w:val="clear" w:color="auto" w:fill="E7E6E6"/>' : '') + '</w:tcPr>'
    + paragraph(checkedText(text), { rtl, bold: header }) + '</w:tc>';
  const row = (values, header) => `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${values.map((v) => cell(v, header)).join('')}</w:tr>`;
  const table = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${width}" w:type="dxa"/>${rtl ? '<w:bidiVisual/>' : ''}`
    + '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`).join('') + '</w:tblBorders>'
    + '<w:tblLayout w:type="fixed"/></w:tblPr>' + `<w:tblGrid>${grid}</w:tblGrid>`
    + row(columns, true) + records.map((r) => row(columns.map((c) => r?.[c]), false)).join('') + '</w:tbl>';
  const meta = infoRows(metadata).map(([k, v]) => paragraph(checkedText(k + ': ' + v), { rtl })).join('');
  const body = paragraph(checkedText(title), { rtl, style: 'Title' }) + meta + paragraph('Rows: ' + records.length, { rtl }) + table
    + `<w:sectPr>${landscape ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' : '<w:pgSz w:w="11906" w:h="16838"/>'}`
    + '<w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr>';
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return zip([
    ['[Content_Types].xml', XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
    ['_rels/.rels', XML_HEAD + `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/_rels/document.xml.rels', XML_HEAD + `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OD}/styles" Target="styles.xml"/></Relationships>`],
    ['word/styles.xml', XML_HEAD + `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>`
      + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>'
      + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>'
      + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('')
      + '</w:tblBorders></w:tblPr></w:style></w:styles>'],
    ['word/document.xml', XML_HEAD + `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`],
  ]);
}
