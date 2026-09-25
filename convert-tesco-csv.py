#!/usr/bin/env python3
"""convert-tesco-csv.py — turn the Tesco Pay workbook (or any CSV of it) into a file cents. can import.

WHY THIS EXISTS
---------------
cents. reads a Tesco Pay CSV by *column name*, so columns may be in any order
and extra columns are harmless — but the **dates** have to be in a shape it
knows: ISO (`2026-09-13`), an Excel serial (`45997`), or the sheet's own
day-first `13/09/2026`. Save the workbook as CSV from Excel or Google Sheets on
a US-locale machine and every date arrives as `09/13/2026`; cents. reads that
as day 09 of month 13, cannot place the row, and reports

    "No shifts or tax figures found in that file."

There is a second trap in this particular workbook: the shifts live on the
**Data** sheet and the tax figures on the **Summary** sheet (columns J..Q). A
CSV save of one sheet loses the other table, so the app ends up with weeks and
no payslips, or payslips and no weeks. This script reads both sheets — or a CSV
of either, or the app's own export — and writes ONE file holding both tables,
in the exact column set, order and date format the Import CSV button expects.

WHAT IT ACCEPTS
---------------
  * `Tesco Pay.xlsx` itself (read directly, no Excel and no third-party
    libraries: an .xlsx is a zip of XML, read with the standard library).
    Excel serial dates and day-fraction times are decoded as it reads.
  * Any CSV of the same data: Excel/Sheets "Save as", the app's own export, or
    a right-click-Export from a payroll portal — comma, semicolon or tab
    delimited. Dates may be ISO, day-first, month-first, serials, or long
    textual forms (`13 Sep 2026`, `Sep 13, 2026`).
  * A file holding only one of the two tables. The other is simply absent, and
    the app keeps whatever it already had.

WHAT IT WRITES
--------------
  Date, Effective Date, Week, Day, Start Time, End Time, Hours,
  Normal or Special, Total, Received?, Gross Income, Potential Tax, Pension,
  Calculated Income, Final Bank Pay, Description
  <blank line>
  Week Start Date, Pay Date, Week, PAYE, USC, PRSI, Future Fund, Total

…which is cents.'s own export format, byte-for-byte the same shapes (CRLF, the
same minimal quoting, the same leading apostrophe that keeps a note reading
`=SUM(A1)` from being executed by a spreadsheet when the file is opened).
Hours, gross and net are carried across only when the source states them: where
a cell is blank the app derives the figure from the times and your rate card,
which is what it does for its own rows.

USAGE
-----
    python convert-tesco-csv.py                    # finds "Tesco Pay.xlsx" / "Tesco Pay*.csv" here or on the Desktop
    python convert-tesco-csv.py "Tesco Pay.xlsx"
    python convert-tesco-csv.py "Tesco Pay.export.csv" -o "for cents.csv"
    python convert-tesco-csv.py sheet.csv --month-first     # dates are mm/dd/yyyy
    python convert-tesco-csv.py sheet.csv --dry-run         # report only, write nothing
    python convert-tesco-csv.py --self-test                 # check the script itself, no files needed

Then, in the app: **Tesco Pay → Import CSV** → pick the file it wrote. The
import is idempotent (re-importing the same file adds nothing twice), so a
re-run after a re-download is safe.

Exit codes: 0 converted, 2 no table found (nothing written), 1 bad input file.
"""

from __future__ import annotations

import argparse
import csv as csvmod
import io
import math
import os
import re
import sys
import zipfile
from datetime import date, timedelta
from xml.etree import ElementTree as ET

# --------------------------------------------------------------------------
# The format cents. reads and writes. Kept in this order because the app
# matches columns by name and writes them in this order.
# --------------------------------------------------------------------------
SHIFT_HEADER = [
    "Date", "Effective Date", "Week", "Day", "Start Time", "End Time", "Hours",
    "Normal or Special", "Total", "Received?", "Gross Income", "Potential Tax",
    "Pension", "Calculated Income", "Final Bank Pay", "Description",
]
PAYSLIP_HEADER = [
    "Week Start Date", "Pay Date", "Week", "PAYE", "USC", "PRSI", "Future Fund", "Total",
]

# Excel's 1900 date system, the same epoch tesco.js uses: serial 45997 is
# 2025-12-06, and the serial is days since 1899-12-30 (the "fictional" 1900
# leap-year bug folded in).
SERIAL_EPOCH = date(1899, 12, 30)
# A pay week starts on Sunday and the money lands 11 days later (the Thursday),
# which is the app's own pay-date formula — used only when the source does not
# state a pay date itself.
PAY_LAG_DAYS = 11
WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

# Header aliases, tried in order, matched exactly (case/punctuation folded) so
# that "Date" never picks up "Effective Date".
SHIFT_ALIASES = {
    "date": ("date",),
    "effective": ("effective date",),
    "week": ("week", "week no", "week number"),
    "start": ("start time", "start", "time in", "clock in", "from"),
    "end": ("end time", "end", "time out", "clock out", "to"),
    "hours": ("hours", "paid hours", "hrs"),
    "special": ("normal or special", "type", "shift type"),
    "total": ("total", "total pay", "gross", "gross pay"),
    "received": ("received", "received?", "paid?"),
    "grossincome": ("gross income",),
    "tax": ("potential tax",),
    "pension": ("pension", "future fund"),
    "calcincome": ("calculated income", "net income"),
    "bank": ("final bank pay", "net paid", "bank pay", "net pay"),
    "note": ("description", "note", "notes"),
}
PAYSLIP_ALIASES = {
    "weekstart": ("week start date", "week start", "week starting"),
    "paydate": ("pay date", "paid date", "date paid"),
    # "Date" is only a last resort: a tax table's own date column is the row's
    # pay-run date, which is what the app keys the row by.
    "date": ("date",),
    "week": ("week", "week no", "week number"),
    "paye": ("paye", "income tax", "tax paid"),
    "usc": ("usc",),
    "prsi": ("prsi",),
    # Not "pension": the shift table has a Pension column of its own, and a
    # tax table is identified by the tax columns it names.
    "futurefund": ("future fund", "prsi/ff"),
    "total": ("total",),
    "bank": ("final bank pay", "net paid", "bank pay", "net pay"),
}
# A tax table is only a tax table if it names a tax column; otherwise the shift
# table (which also has a "Date") would match it.
PAYSLIP_REQUIRED = ("paye", "usc", "prsi", "futurefund")

PLAIN_NUMBER = re.compile(r"^-?\d+(\.\d+)?$")
FORMULA_PREFIX = re.compile(r"^\s*[+\-=@]")
ISO_DATE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})")
NUMERIC = re.compile(r"^-?\d+(\.\d+)?$")
SLASHED_DATE = re.compile(r"^(\d{1,2})[./\-](\d{1,2})[./\-](\d{2,4})")
CLOCK_TIME = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$", re.I)
DOTTED_CLOCK = re.compile(r"^(\d{1,2})\.(\d{2})(?:\s*([ap]\.?m\.?))?$", re.I)
MONTH_NAMES = {name.lower(): i + 1 for i, name in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
LONG_DATE = re.compile(r"^(\d{1,2})[\s\-]*([A-Za-z]{3,})[\s,\-]*(\d{2,4})?$")
LONG_DATE_US = re.compile(r"^([A-Za-z]{3,})[\s\-]*(\d{1,2})[\s,\-]*(\d{2,4})?$")


# --------------------------------------------------------------------------
# Reading: .xlsx and .csv both come out as [(row number, [cell, cell, …]), …]
# --------------------------------------------------------------------------
def column_index(ref: str) -> int:
    """'F186' -> 5 (0-based). Used to put a sparse row's cells in their columns."""
    letters = "".join(ch for ch in ref if ch.isalpha())
    index = 0
    for ch in letters:
        index = index * 26 + (ord(ch.upper()) - 64)
    return index - 1


def sheet_rows(archive: zipfile.ZipFile, path: str, shared: list[str]) -> list[tuple[int, list[str]]]:
    """One sheet's non-empty rows, cells placed in their real columns.

    Excel omits empty cells entirely, so column position has to come from the
    cell reference (`F186`) rather than from counting.
    """
    root = ET.fromstring(archive.read(path))
    rows: dict[int, dict[int, str]] = {}
    for row in root.iter(NS + "row"):
        cells: dict[int, str] = {}
        for cell in row.iter(NS + "c"):
            kind = cell.get("t")
            value = ""
            if kind == "inlineStr":
                value = "".join(node.text or "" for node in cell.iter(NS + "t"))
            else:
                node = cell.find(NS + "v")
                value = node.text if node is not None else ""
                if kind == "s" and value != "":
                    try:
                        value = shared[int(value)]
                    except (ValueError, IndexError):
                        value = ""
            if value not in (None, ""):
                cells[column_index(cell.get("r"))] = value
        if cells:
            try:
                rows[int(row.get("r"))] = cells
            except (TypeError, ValueError):
                continue
    out: list[tuple[int, list[str]]] = []
    for number in sorted(rows):
        cells = rows[number]
        width = max(cells) + 1
        out.append((number, [cells.get(i, "") for i in range(width)]))
    return out


def read_xlsx(path: str) -> list[tuple[str, list[tuple[int, list[str]]]]]:
    """Every worksheet in the workbook, by name, in workbook order."""
    sheets: list[tuple[str, list[tuple[int, list[str]]]]] = []
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            # Most workbooks store their text here, indexed by the cells that
            # hold it; some write it inline instead, which sheet_rows handles too.
            for si in ET.fromstring(archive.read("xl/sharedStrings.xml")).iter(NS + "si"):
                shared.append("".join(node.text or "" for node in si.iter(NS + "t")))
        book = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target") for rel in rels.iter(PKG_REL_NS + "Relationship")}
        for sheet in book.iter(NS + "sheet"):
            target = targets.get(sheet.get(REL_NS + "id"), "")
            if not target:
                continue
            inner = target.lstrip("/")
            # Targets are relative to xl/ ('worksheets/sheet1.xml'), but some
            # writers emit a package-absolute path instead.
            candidate = inner if inner.startswith("xl/") else "xl/" + inner
            if candidate not in names:
                continue
            sheets.append((sheet.get("name") or candidate, sheet_rows(archive, candidate, shared)))
    return sheets


def read_delimited(path: str) -> list[tuple[int, list[str]]]:
    """A CSV/TSV, with the delimiter sniffed and blank lines numbered but skipped."""
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        text = handle.read()
    delimiter = ","
    try:
        delimiter = csvmod.Sniffer().sniff(text[:4096], delimiters=",;\t|").delimiter
    except csvmod.Error:
        # A one-column file sniffs as a failure; a semicolon export with quoted
        # commas usually sniffs fine, so falling back to ',' is the safe default
        # unless the first line clearly uses something else.
        first = text.split("\n", 1)[0]
        for candidate in (";", "\t", "|"):
            if first.count(candidate) > first.count(","):
                delimiter = candidate
                break
    rows: list[tuple[int, list[str]]] = []
    reader = csvmod.reader(io.StringIO(text), delimiter=delimiter)
    for number, row in enumerate(reader, start=1):
        if not any(str(cell).strip() for cell in row):
            continue
        rows.append((number, [str(cell) for cell in row]))
    return rows


# --------------------------------------------------------------------------
# Header detection and cell normalising
# --------------------------------------------------------------------------
def fold(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value).strip().lower()).strip()


def find_column(header: list[str], aliases: tuple[str, ...]) -> int:
    folded = [fold(cell) for cell in header]
    for alias in aliases:
        wanted = fold(alias)
        if wanted in folded:
            return folded.index(wanted)
    return -1


def classify(header: list[str]) -> str | None:
    """'shifts', 'payslips', or None — what kind of table this header row is.

    Shifts are tested first: Date + Start Time + End Time is a signature no tax
    table carries. The reverse test is looser — a week start and a tax column —
    so it must not be allowed to claim a shift table that happens to have a
    "Pension" column.
    """
    if all(find_column(header, SHIFT_ALIASES[key]) >= 0 for key in ("date", "start", "end")):
        return "shifts"
    if any(find_column(header, PAYSLIP_ALIASES[key]) >= 0 for key in PAYSLIP_REQUIRED):
        if any(find_column(header, PAYSLIP_ALIASES[key]) >= 0 for key in ("weekstart", "date", "paydate", "week")):
            return "payslips"
    return None


def split_tables(rows: list[tuple[int, list[str]]]) -> list[tuple[str, int, list[int]]]:
    """Every table in the file: (kind, header position, data row positions).

    Rows run from the line after a header until the next header line, so a file
    holding the shift table above the tax table (the app's own export) is read
    as the two tables it is.
    """
    headers = [(i, classify(cells)) for i, (_, cells) in enumerate(rows)]
    headers = [(i, kind) for i, kind in headers if kind]
    tables: list[tuple[str, int, list[int]]] = []
    for n, (index, kind) in enumerate(headers):
        stop = headers[n + 1][0] if n + 1 < len(headers) else len(rows)
        data = [i for i in range(index + 1, stop) if any(str(c).strip() for c in rows[i][1])]
        tables.append((kind, index, data))
    return tables


def to_date(raw: str, month_first: bool) -> tuple[str | None, bool]:
    """('YYYY-MM-DD' | None, ambiguous?) — ISO, serial, day-first, month-first, long form."""
    text = str(raw if raw is not None else "").strip()
    if not text:
        return None, False
    match = ISO_DATE.match(text)
    if match:
        year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
        return _iso(year, month, day), False
    if NUMERIC.match(text):
        serial = float(text)
        # Anything in Excel's plausible date range is a serial; a bare year
        # ("2026") is not, and neither is a small number.
        if 20000 < serial < 80000:
            return (SERIAL_EPOCH + timedelta(days=int(serial))).isoformat(), False
        return None, False
    match = SLASHED_DATE.match(text)
    if match:
        first, second, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
        year = year + 2000 if year < 100 else year
        # 13/09 is day-first whatever the flag says; 09/13 can only be
        # month-first. Only a genuinely ambiguous cell follows the flag.
        ambiguous = first <= 12 and second <= 12
        if first > 12:
            month_first = False
        elif second > 12:
            month_first = True
        day, month = (second, first) if month_first else (first, second)
        return _iso(year, month, day), ambiguous
    # 'Sep 13, 2026' and '13 Sep 2026' — a spelled month takes the ambiguity out.
    for pattern, month_group, day_group in ((LONG_DATE_US, 1, 2), (LONG_DATE, 2, 1)):
        match = pattern.match(text)
        if not match:
            continue
        month = MONTH_NAMES.get(match.group(month_group)[:3].lower())
        day_text, year_text = match.group(day_group), match.group(3)
        year = int(year_text) if year_text else date.today().year
        if year < 100:
            year += 2000
        if month and day_text.isdigit():
            return _iso(year, month, int(day_text)), False
    return None, False


def _iso(year: int, month: int, day: int) -> str | None:
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def weekday_name(iso: str) -> str:
    """The sheet's Day column, Sunday-first."""
    return WEEKDAY_NAMES[(date.fromisoformat(iso).weekday() + 1) % 7]


def to_time(raw: str) -> str | None:
    """'HH:MM' from a clock string, an Excel day fraction, or '7.30'."""
    text = str(raw if raw is not None else "").strip()
    if not text:
        return None
    match = CLOCK_TIME.match(text)
    if match:
        hours, minutes = int(match.group(1)), int(match.group(2))
        suffix = (match.group(4) or "").replace(".", "").lower()
        if suffix == "pm" and hours < 12:
            hours += 12
        if suffix == "am" and hours == 12:
            hours = 0
        return f"{hours:02d}:{minutes:02d}" if hours <= 23 and minutes <= 59 else None
    if NUMERIC.match(text):
        value = float(text)
        if 0 <= value < 1:                      # Excel's fraction of a day
            minutes = round(value * 1440)
            return f"{minutes // 60:02d}:{minutes % 60:02d}" if minutes < 1440 else None
        if value < 24:                          # '13.30' style clock
            hours, hundredths = int(value), round((value - int(value)) * 100)
            if 0 <= hundredths <= 59:
                return f"{hours:02d}:{hundredths:02d}"
        return None
    match = DOTTED_CLOCK.match(text)
    if match:
        hours, minutes = int(match.group(1)), int(match.group(2))
        return f"{hours:02d}:{minutes:02d}" if hours <= 23 and minutes <= 59 else None
    return None


def r2(value: float) -> float:
    """Two decimals, half away from zero — the rounding tesco.js applies.

    Python's round() is half-to-even, so the sheet's stored 157.034999… becomes
    157.03 where the app's own export (and its r2, with the same 1e-7 guard
    against binary wobble) says 157.04. A pay figure that differs by a cent
    between the file and the app is exactly the kind of thing this file gets
    checked for.
    """
    sign = -1 if value < 0 else 1
    return sign * math.floor(abs(value) * 100 + 1e-7 + 0.5) / 100


def to_number(raw: str) -> float | None:
    """A money/hour figure, '€1,234.56' and '-56.08' both included."""
    text = str(raw if raw is not None else "").strip()
    if text == "":
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", text)
    if cleaned in ("", "-", ".", "-."):
        return None
    try:
        return r2(float(cleaned))
    except ValueError:
        return None


def money(value: float | None) -> str:
    return "" if value is None else f"{value:.2f}"


def week_number(raw: str) -> str:
    """The sheet's own 1..53 count, or blank so the app derives it."""
    text = str(raw if raw is not None else "").strip()
    if not text:
        return ""
    try:
        number = int(float(re.sub(r"[^0-9.\-]", "", text)))
    except ValueError:
        return ""
    return str(number) if 1 <= number <= 53 else ""


# --------------------------------------------------------------------------
# Source → the app's two tables
# --------------------------------------------------------------------------
def parse_shifts(rows, table, month_first):
    _, header_at, data_at = table
    header = rows[header_at][1]
    col = {key: find_column(header, aliases) for key, aliases in SHIFT_ALIASES.items()}
    cell = lambda row, key: row[col[key]] if col[key] >= 0 and col[key] < len(row) else ""  # noqa: E731

    shifts, skipped, ambiguous = [], [], 0
    for index in data_at:
        number, row = rows[index]
        # The workbook keeps a "Monthly Stats" block beside the top of the shift
        # table, so rows with nothing in the Date column are another block's, not
        # a broken shift — they are passed over silently. A row that *does* name
        # a date but in a shape nothing can read is reported instead.
        raw_date = cell(row, "date")
        if not str(raw_date).strip():
            continue
        iso, was_ambiguous = to_date(raw_date, month_first)
        if not iso:
            skipped.append((number, f"date {raw_date!r} is not a date"))
            continue
        ambiguous += 1 if was_ambiguous else 0
        start = to_time(cell(row, "start"))
        end = to_time(cell(row, "end"))
        hours = to_number(cell(row, "hours"))
        # A row with neither clock times nor hours is not a shift; the sheet's
        # "full week off" row has hours and no times and must be kept.
        if start is None and end is None and hours is None:
            skipped.append((number, "no clock times and no hours"))
            continue
        effective, _ = to_date(cell(row, "effective"), month_first)
        # 'Normal'/'Special' is what the app writes and reads back; its own rule
        # is "starts with s or bh means the premium rate", so the sheet's "BH"
        # for a bank holiday lands on the same side of it.
        special = "Special" if re.match(r"^(s|bh)", str(cell(row, "special")).strip(), re.I) else "Normal"
        note = re.sub(r"\s+", " ", str(cell(row, "note")).strip())[:120]
        shifts.append({
            "Date": iso,
            "Effective Date": effective or iso,
            "Week": week_number(cell(row, "week")),
            "Day": weekday_name(iso),
            "Start Time": start or "",
            "End Time": end or "",
            "Hours": money(hours),
            "Normal or Special": special,
            "Total": money(to_number(cell(row, "total"))),
            "Received?": str(cell(row, "received")).strip(),
            "Gross Income": money(to_number(cell(row, "grossincome"))),
            "Potential Tax": money(to_number(cell(row, "tax"))),
            "Pension": money(to_number(cell(row, "pension"))),
            "Calculated Income": money(to_number(cell(row, "calcincome"))),
            "Final Bank Pay": money(to_number(cell(row, "bank"))),
            "Description": note,
        })
    # Newest first, the way the app's own export reads.
    shifts.sort(key=lambda s: (s["Date"], s["Start Time"]), reverse=True)
    return shifts, skipped, ambiguous, rows[header_at][0]


def parse_payslips(rows, table, month_first):
    _, header_at, data_at = table
    header = rows[header_at][1]
    col = {key: find_column(header, aliases) for key, aliases in PAYSLIP_ALIASES.items()}
    cell = lambda row, key: row[col[key]] if col[key] >= 0 and col[key] < len(row) else ""  # noqa: E731

    payslips, skipped, ambiguous = [], [], 0
    for index in data_at:
        number, row = rows[index]
        # Same rule as the shifts: a row with nothing in the date column belongs
        # to a neighbouring block, while a total row (which does name something
        # there) is worth saying out loud — it is a figure the app will not show.
        raw_week = cell(row, "weekstart") or cell(row, "date")
        if not str(raw_week).strip():
            continue
        week_start, was_ambiguous = to_date(raw_week, month_first)
        if not week_start:
            skipped.append((number, f"week start {raw_week!r} is not a date"))
            continue
        ambiguous += 1 if was_ambiguous else 0
        figures = {key: to_number(cell(row, key)) for key in ("paye", "usc", "prsi", "futurefund")}
        stated_total = to_number(cell(row, "total"))
        total = r2(sum(value for value in figures.values() if value is not None))
        if stated_total is not None and not any(value is not None for value in figures.values()):
            total = stated_total
        stated_pay, _ = to_date(cell(row, "paydate"), month_first)
        week = week_number(cell(row, "week"))
        payslips.append({
            "Week Start Date": week_start,
            "Pay Date": stated_pay or (date.fromisoformat(week_start) + timedelta(days=PAY_LAG_DAYS)).isoformat(),
            "Week": week,
            "PAYE": money(figures["paye"]),
            "USC": money(figures["usc"]),
            "PRSI": money(figures["prsi"]),
            "Future Fund": money(figures["futurefund"]),
            "Total": money(total),
        })
    # Oldest first, the way the app's own export reads.
    payslips.sort(key=lambda p: p["Week Start Date"])
    return payslips, skipped, ambiguous, rows[header_at][0]


def drop_duplicate_payslips(payslips):
    """The app skips an identical row on import; dropping it here keeps the file honest."""
    seen, out = set(), []
    for row in payslips:
        key = tuple(row.values())
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


# --------------------------------------------------------------------------
# Writing: the app's own CSV dialect
# --------------------------------------------------------------------------
def csv_cell(value) -> str:
    text = "" if value is None else str(value)
    # A leading apostrophe is how a spreadsheet is told "this is text" — the
    # same guard the app's exporter applies, so a note reading "=SUM(A1)" or
    # "=cmd|…" cannot execute when the file is opened. A plain number is left
    # alone: the apostrophe would turn -56.08 into text.
    if text and not PLAIN_NUMBER.match(text) and FORMULA_PREFIX.match(text):
        text = "'" + text
    if re.search(r'[",\n\r]', text) or text != text.strip():
        text = '"' + text.replace('"', '""') + '"'
    return text


def render(shifts, payslips) -> str:
    lines = [",".join(csv_cell(name) for name in SHIFT_HEADER)]
    for row in shifts:
        lines.append(",".join(csv_cell(row[name]) for name in SHIFT_HEADER))
    if payslips:
        lines.append("")
        lines.append(",".join(csv_cell(name) for name in PAYSLIP_HEADER))
        for row in payslips:
            lines.append(",".join(csv_cell(row[name]) for name in PAYSLIP_HEADER))
    return "\r\n".join(lines) + "\r\n"


def verify(text: str) -> dict:
    """Re-read what was written: the app reads it back, so the script does too."""
    rows = [(n, cells) for n, cells in read_delimited_rows(text)]
    tables = split_tables(rows)
    counts = {"shifts": 0, "payslips": 0}
    for kind, _, data in tables:
        counts[kind] = counts.get(kind, 0) + len(data)
    return counts


def read_delimited_rows(text: str):
    reader = csvmod.reader(io.StringIO(text), delimiter=",")
    for number, row in enumerate(reader, start=1):
        if any(str(cell).strip() for cell in row):
            yield number, [str(cell) for cell in row]


# --------------------------------------------------------------------------
# Finding the input, and the CLI
# --------------------------------------------------------------------------
CANDIDATE_GLOBS = ("Tesco Pay.xlsx", "Tesco Pay.xlsm")


def find_input() -> str | None:
    """'Tesco Pay*' next to this script, in the working directory, or on the Desktop."""
    here = os.path.dirname(os.path.abspath(__file__))
    folders = [os.getcwd(), here]
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    if os.path.isdir(desktop):
        folders.append(desktop)
    for folder in folders:
        for name in CANDIDATE_GLOBS:
            candidate = os.path.join(folder, name)
            if os.path.isfile(candidate):
                return candidate
    for folder in folders:
        matches = [os.path.join(folder, name) for name in os.listdir(folder)
                   if name.lower().startswith("tesco pay") and name.lower().endswith(".csv")]
        if matches:
            return max(matches, key=os.path.getmtime)
    return None


def default_output(source: str) -> str:
    """'Tesco Pay.xlsx' -> 'Tesco Pay - for cents.csv', beside the input.

    A file already carrying that name (the app's own export) would otherwise be
    its own output, so the suffix is added rather than refusing the whole run.
    """
    folder = os.path.dirname(os.path.abspath(source))
    stem = os.path.splitext(os.path.basename(source))[0]
    stem = re.sub(r"\s*-\s*for cents.*$", "", stem, flags=re.I)
    target = os.path.join(folder, f"{stem} - for cents.csv")
    if os.path.abspath(target).lower() == os.path.abspath(source).lower():
        target = os.path.join(folder, f"{stem} - for cents (converted).csv")
    return target


class NoTableFound(Exception):
    """Neither table is in the file: said out loud, nothing written."""


def convert(source: str, month_first: bool, report=print) -> tuple[str, dict, list[tuple[str, str]]]:
    """Read the source, return (csv text, table counts, warnings)."""
    warnings: list[tuple[str, str]] = []
    extension = os.path.splitext(source)[1].lower()
    if extension in (".xlsx", ".xlsm"):
        sheets = read_xlsx(source)
        if not sheets:
            raise SystemExit(f"convert-tesco-csv: {source} has no worksheets.")
        report(f"  reading   {source}  (sheets: {', '.join(name for name, _ in sheets)})")
        groups = [(name, rows) for name, rows in sheets]
    else:
        report(f"  reading   {source}")
        groups = [("", read_delimited(source))]

    shifts, payslips = [], []
    all_headers = []
    first_rows: list[str] = []
    for name, rows in groups:
        # Kept for the "found nothing" message: naming the columns the file
        # actually opens with is what turns that into something fixable.
        for number, cells in rows[:3]:
            label = f"{name} row {number}" if name else f"row {number}"
            first_rows.append(f"{label}: {', '.join(str(c) for c in cells[:10] if str(c).strip())}")
        for table in split_tables(rows):
            kind, header_at, data_at = table
            where = f"{name + ' ' if name else ''}row {rows[header_at][0]}"
            all_headers.append((where, rows[header_at][1]))
            if not data_at:
                continue
            if kind == "shifts":
                found, skipped, ambiguous, _ = parse_shifts(rows, table, month_first)
                shifts.extend(found)
                report(f"  shifts    {where}: {len(found)} row(s)")
                for number, why in skipped:
                    warnings.append((f"{name + ' ' if name else ''}row {number}", f"skipped - {why}"))
                if ambiguous:
                    warnings.append((f"{name + ' ' if name else ''}column Date",
                                     f"{ambiguous} date(s) read day-first; use --month-first if they are m/d/y"))
            else:
                found, skipped, ambiguous, _ = parse_payslips(rows, table, month_first)
                payslips.extend(found)
                report(f"  payslips  {where}: {len(found)} row(s)")
                for number, why in skipped:
                    warnings.append((f"{name + ' ' if name else ''}row {number}", f"skipped - {why}"))
                if ambiguous:
                    warnings.append((f"{name + ' ' if name else ''}column Week Start Date",
                                     f"{ambiguous} date(s) read day-first; use --month-first if they are m/d/y"))
    if not shifts and not payslips:
        detail = "; ".join(f"{where}: {', '.join(header[:8])}" for where, header in all_headers[:4])
        raise NoTableFound(
            "no shift table and no tax table found in this file.\n"
            "  A shift table needs Date + Start Time + End Time columns; a tax table needs\n"
            "  PAYE / USC / PRSI / Future Fund.\n"
            "  Tables recognised:\n    " + (detail or "(none)")
            + "\n  The file opens with:\n    " + "\n    ".join(first_rows or ["(nothing at all)"])
        )

    # A shift row repeated across sheets, or the same week twice, would double
    # the hours in the app; the app itself de-duplicates payslips on import.
    seen, unique_shifts = set(), []
    for row in shifts:
        key = (row["Date"], row["Start Time"], row["End Time"], row["Hours"])
        if key in seen:
            continue
        seen.add(key)
        unique_shifts.append(row)
    duplicates = len(shifts) - len(unique_shifts)
    if duplicates:
        warnings.append(("shift table", f"{duplicates} duplicate row(s) dropped"))
    payslips = drop_duplicate_payslips(payslips)
    return render(unique_shifts, payslips), {"shifts": len(unique_shifts), "payslips": len(payslips)}, warnings


PIPELINE_SAMPLE = """Date,Start Time,End Time,Hours,Normal or Special,Description
09/13/2026,7:00,15:00,7,Normal,week of 13th
09/14/2026,0.5,0.75,5,,Late shift
"""


def self_test() -> int:
    """A US-style date, an Excel fraction time and a blank flag, end to end."""
    rows = list(read_delimited_rows(PIPELINE_SAMPLE))
    tables = split_tables(rows)
    if len(tables) != 1 or tables[0][0] != "shifts":
        print("self-test: FAILED - shift table not detected", file=sys.stderr)
        return 1
    shifts, _, _, _ = parse_shifts(rows, tables[0], False)
    checks = [
        ("dates normalise", [s["Date"] for s in shifts], ["2026-09-14", "2026-09-13"]),
        ("fraction time", shifts[0]["Start Time"], "12:00"),
        ("fraction end", shifts[0]["End Time"], "18:00"),
        ("blank flag is normal", shifts[0]["Normal or Special"], "Normal"),
        ("weekday derived", shifts[1]["Day"], "Sunday"),
        ("note kept", shifts[1]["Description"], "week of 13th"),
    ]
    failed = [name for name, got, want in checks if got != want]
    text = render(shifts, [])
    if not text.startswith(",".join(SHIFT_HEADER)):
        failed.append("header line")
    if "\r\n" not in text:
        failed.append("CRLF line endings")
    if verify(text)["shifts"] != 2:
        failed.append("re-read count")
    if failed:
        print("self-test: FAILED - " + ", ".join(failed), file=sys.stderr)
        return 1
    print("self-test: OK - dates, times, headers and re-read all check out.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert the Tesco Pay workbook (or a CSV of it) into a file cents. can import.")
    parser.add_argument("input", nargs="?", help="the .xlsx or .csv to read (default: find Tesco Pay*)")
    parser.add_argument("-o", "--output", help="where to write (default: '<input> - for cents.csv')")
    parser.add_argument("--month-first", action="store_true",
                        help="read ambiguous dates as mm/dd/yyyy (default: day-first, the sheet's own order)")
    parser.add_argument("--dry-run", action="store_true", help="report what would be written, write nothing")
    parser.add_argument("--force", action="store_true", help="overwrite the output file if it exists")
    parser.add_argument("--self-test", action="store_true", help="check the script itself; needs no files")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    source = args.input or find_input()
    if not source:
        print("convert-tesco-csv: no input file given and no 'Tesco Pay*' file found here or on the "
              "Desktop.\n  Pass one explicitly, e.g.  python convert-tesco-csv.py \"Tesco Pay.xlsx\"",
              file=sys.stderr)
        return 1
    if not os.path.isfile(source):
        print(f"convert-tesco-csv: {source} is not a file.", file=sys.stderr)
        return 1

    print("convert-tesco-csv")
    try:
        text, counts, warnings = convert(source, args.month_first)
    except NoTableFound as problem:
        print(f"convert-tesco-csv: {problem}", file=sys.stderr)
        return 2

    target = args.output or default_output(source)
    if os.path.abspath(target) == os.path.abspath(source):
        print("convert-tesco-csv: output would overwrite the input; pass -o.", file=sys.stderr)
        return 1
    if os.path.exists(target) and not (args.force or args.dry_run):
        print(f"convert-tesco-csv: {target} already exists - pass --force to overwrite it.",
              file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"  would write  {target}  ({counts['shifts']} shift row(s), {counts['payslips']} payslip row(s))")
    else:
        with open(target, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        reread = verify(text)
        print(f"  wrote     {target}")
        print(f"  contains  {reread['shifts']} shift row(s) and {reread['payslips']} payslip row(s)")
        if reread != counts:
            print("  WARNING   the file did not read back the same way it was written", file=sys.stderr)
        print("  next      cents. -> Tesco Pay -> Import CSV -> pick that file")

    for where, note in warnings[:20]:
        print(f"  note      {where}: {note}")
    if len(warnings) > 20:
        print(f"  note      ... and {len(warnings) - 20} more")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
