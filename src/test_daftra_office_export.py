import sys
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from daftra_office_export import export, safe_text, validate

class OfficeExportTests(unittest.TestCase):
    def setUp(self):
        self.payload = {
            'records': [{'id': '001', 'client': 'شركة <نبراس>', 'amount': '=1+2'}],
            'columns': ['id', 'client', 'amount'],
            'metadata': {'title': 'كشف حساب'}
        }

    def test_formula_injection_and_ids(self):
        self.assertEqual(safe_text('=1+2'), "'=1+2")
        self.assertEqual(safe_text(' +SUM(2)'), "' +SUM(2)")
        self.assertEqual(safe_text('001'), '001')

    def test_valid_zip_xml_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            for fmt, part in [('xlsx', 'xl/worksheets/sheet1.xml'), ('docx', 'word/document.xml')]:
                path = Path(folder) / ('test.' + fmt)
                result = export(self.payload, fmt, path)
                self.assertEqual(result['record_count'], 1)
                with ZipFile(path) as z:
                    for name in z.namelist():
                        if name.endswith('.xml'):
                            ElementTree.fromstring(z.read(name))
                    xml = z.read(part).decode('utf-8')
                    self.assertIn('001', xml)
                    self.assertIn('شركة &lt;نبراس&gt;', xml)
                    self.assertIn("'=1+2", xml)
                with self.assertRaises(FileExistsError):
                    export(self.payload, fmt, path)

    def test_rejects_bad_input(self):
        with self.assertRaises(ValueError):
            validate({'records': [], 'columns': ['../secret']})
        with self.assertRaises(ValueError):
            validate({'records': [], 'columns': ['id', 'id']})
        with self.assertRaises(ValueError):
            validate({'records': [{}] * 10001, 'columns': ['id']})
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                export(self.payload, 'xlsx', Path(folder) / 'not-a-xlsx.docx')

if __name__ == '__main__':
    unittest.main()
