"""Inspect the XLSX emitted by output_time tests with TIME_FORMAT_XLSX_PATH set."""

import math
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile


def check(path):
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    expected = [
        "0.000", "[mm]:ss.000", "[hh]:mm:ss.000", '0.000000000 "d"',
        'yyyy-mm-dd"T"hh:mm:ss.000"+08:00"', 'yyyy-mm-dd"T"hh:mm:ss.000',
        'hh:mm:ss.000"+08:00"', "hh:mm:ss.000",
    ]
    with ZipFile(path) as workbook:
        styles = ET.fromstring(workbook.read("xl/styles.xml"))
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
    formats = {item.attrib["numFmtId"]: item.attrib["formatCode"]
               for item in styles.findall("s:numFmts/s:numFmt", ns)}
    xfs = styles.findall("s:cellXfs/s:xf", ns)
    cells = {cell.attrib["r"]: cell for cell in sheet.findall("s:sheetData/s:row/s:c", ns)}
    for index, column in enumerate("ABCDEFGH"):
        values = []
        for row in (2, 3):
            cell = cells[f"{column}{row}"]
            assert cell.attrib.get("t", "n") == "n", cell.attrib
            style = xfs[int(cell.attrib["s"])]
            assert formats[style.attrib["numFmtId"]] == expected[index]
            assert cell.find("s:f", ns) is None
            values.append(float(cell.find("s:v", ns).text))
        divisor = 1 if index == 0 else 86400
        first = 90061.123 / divisor if index < 4 else 46307 + 86399.9 / 86400
        assert math.isclose(values[0], first, rel_tol=0, abs_tol=1e-10)
        assert math.isclose((values[1] - values[0]) * divisor, 0.2, rel_tol=0, abs_tol=1e-6)
    widths = sheet.findall("s:cols/s:col", ns)
    assert all(any(int(col.attrib["min"]) <= index <= int(col.attrib["max"])
                   and float(col.attrib["width"]) >= 36 for col in widths)
               for index in range(1, 9))
    print("PASS: 16 numeric time cells, 8 exact number formats, values/differences, and widths")


if __name__ == "__main__":
    check(sys.argv[1])
