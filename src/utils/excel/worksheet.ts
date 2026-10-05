import * as XLSX from 'xlsx';

export function formatWorksheet(ws: XLSX.WorkSheet, data: any[][], headerRowIndex = 0, isTabular = true): void {
  const colWidths: number[] = [];

  data.forEach((row) => {
    row.forEach((cell, colIndex) => {
      const cellLen = cell === null || cell === undefined ? 0 : String(cell).length;
      colWidths[colIndex] = Math.max(colWidths[colIndex] || 12, Math.min(cellLen + 4, 60));
    });
  });

  ws['!cols'] = colWidths.map((width) => ({ wch: Math.max(width, 12) }));

  if (isTabular && data.length > headerRowIndex + 1) {
    const numCols = Math.max(...data.map((row) => row.length));
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: headerRowIndex, c: 0 },
        e: { r: data.length - 1, c: Math.max(0, numCols - 1) }
      })
    };
  }

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let row = range.s.r; row <= range.e.r; ++row) {
    for (let col = range.s.c; col <= range.e.c; ++col) {
      const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = ws[cellRef];
      if (!cell || cell.t !== 'n') continue;
      if (cell.v % 1 !== 0) cell.z = '#,##0.00';
      else if (Math.abs(cell.v) >= 1000) cell.z = '#,##0';
    }
  }
}
