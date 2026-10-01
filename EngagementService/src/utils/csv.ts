// RFC 4180 quoting, plus protection against spreadsheet formula injection:
// a cell starting with = + - @ (or tab/CR) is prefixed with ' so Excel/Sheets
// show it as text instead of evaluating it. Every cell is quoted.
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}
