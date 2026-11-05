"""Export validated Daftra data to basic XLSX/DOCX files, without dependencies."""
import argparse
import json
import re
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

MAX_ROWS = 10000
MAX_COLS = 100
DANGEROUS = re.compile(r'^[\s\x00-\x1f]*[=+@-]')

def safe_text(value):
    if value is None:
        return ''
    if isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False)
    value = ''.join(c for c in str(value) if c in '\t\n\r' or ord(c) >= 32)
    if len(value) > 32767:
        raise ValueError('Cell too long')
    return "'" + value if DANGEROUS.match(value) else value

def validate(data):
    if not isinstance(data, dict):
        raise ValueError('Invalid payload')
    rows, columns = data.get('records'), data.get('columns')
    if not isinstance(rows, list) or len(rows) > MAX_ROWS or any(not isinstance(row, dict) for row in rows):
        raise ValueError('Invalid records')
    if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_COLS or any(not isinstance(c, str) or not re.fullmatch(r'[A-Za-z0-9_]+', c) for c in columns) or len(set(columns)) != len(columns):
        raise ValueError('Invalid columns')
    return rows, columns

def col_name(n):
    s = ''
    while n:
        n, r = divmod(n-1, 26)
        s = chr(65+r) + s
    return s

def xlsx_parts(rows, columns):
    def row_xml(idx, values):
        cells = []
        for i, value in enumerate(values, 1):
            value = escape(safe_text(value))
            cells.append(f'<c r="{col_name(i)}{idx}" t="inlineStr"><is><t xml:space="preserve">{value}</t></is></c>')
        return f'<row r="{idx}">' + ''.join(cells) + '</row>'
    sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + row_xml(1, columns) + ''.join(row_xml(i+2, [r.get(c) for c in columns]) for i, r in enumerate(rows)) + '</sheetData></worksheet>'
    return {
      '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Daftra" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': sheet,
    }

def docx_parts(rows, columns, metadata):
    def paragraph(value):
        return '<w:p><w:r><w:t xml:space="preserve">' + escape(safe_text(value)) + '</w:t></w:r></w:p>'
    def table_row(values):
        return '<w:tr>' + ''.join('<w:tc>' + paragraph(value) + '</w:tc>' for value in values) + '</w:tr>'
    body = paragraph(metadata.get('title', 'Daftra Export')) + ''.join(paragraph(f'{key}: {value}') for key, value in metadata.items() if key != 'title') + paragraph(f'Rows: {len(rows)}')
    body += '<w:tbl>' + table_row(columns) + ''.join(table_row([r.get(c) for c in columns]) for r in rows) + '</w:tbl>'
    return {
      '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '<w:sectPr/></w:body></w:document>',
    }

def export(data, fmt, output):
    rows, cols = validate(data)
    metadata = data.get('metadata', {})
    if not isinstance(metadata, dict):
        raise ValueError('Invalid metadata')
    path = Path(output).resolve()
    if fmt not in ('xlsx', 'docx') or path.suffix.lower() != '.' + fmt or not path.parent.is_dir():
        raise ValueError('Invalid output')
    parts = xlsx_parts(rows, cols) if fmt == 'xlsx' else docx_parts(rows, cols, metadata)
    with path.open('xb') as f:
        with ZipFile(f, 'w', ZIP_DEFLATED) as archive:
            for name, xml in parts.items():
                archive.writestr(name, xml.encode('utf-8'))
    return {'path': str(path), 'format': fmt, 'record_count': len(rows)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('format', choices=['xlsx', 'docx'])
    parser.add_argument('input_json')
    parser.add_argument('output_file')
    args = parser.parse_args()
    with open(args.input_json, encoding='utf-8') as source:
        payload = json.load(source)
    print(json.dumps(export(payload, args.format, args.output_file), ensure_ascii=False))
