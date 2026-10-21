// Pustaka Excel bersama (dimuat saat dibutuhkan) + unduh file .xlsx.

const XLSX_SOURCES = [
  "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error(`Gagal memuat ${src}`));
    };
    document.head.appendChild(script);
  });
}

export async function loadXLSX() {
  if (window.XLSX) return window.XLSX;

  for (const src of XLSX_SOURCES) {
    try {
      await loadScript(src);
      if (window.XLSX) return window.XLSX;
    } catch (error) {
      console.warn(error.message);
    }
  }

  throw new Error("Pustaka Excel gagal dimuat. Periksa koneksi internet lalu coba lagi.");
}

// sheets: [{ name, rows: [[header...], [row...]], widths?: [number...] }]
export async function downloadXlsx(filename, sheets) {
  const XLSX = await loadXLSX();
  const book = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    if (sheet.widths) ws["!cols"] = sheet.widths.map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(book, ws, String(sheet.name).slice(0, 31));
  }

  XLSX.writeFile(book, filename);
}

export const stamp = () => {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
};
