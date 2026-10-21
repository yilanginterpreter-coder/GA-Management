import { auth, db, authPersistenceReady } from "./firebase-init.js";
import { hasPerm } from "./perms.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  writeBatch,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

/* ===== Logika pembacaan & validasi Excel (tanpa Firebase / DOM) ===== */

// Logika murni untuk impor Inventory dari Excel (tanpa Firebase / DOM).

const LIMITS = {
  name: 150,
  category: 100,
  unit: 40,
  location: 150,
  specification: 200
};

const DEFAULTS = {
  unit: "pcs",
  category: "Umum",
  location: "Gudang GA",
  minimum: 10
};

// Urutan penting: kolom yang sudah dipakai field lebih awal tidak dipakai lagi.
const FIELDS = [
  {
    key: "code",
    label: "Kode Barang",
    required: true,
    pattern: /(^|\b)(kode|code|sku|item\s*(no|code)|part\s*no)\b|编码|编号|代码|料号/i
  },
  {
    key: "name",
    label: "Nama Barang",
    required: true,
    pattern: /nama|name|description|deskripsi|barang|item|品名|名称|物料/i
  },
  {
    key: "specification",
    label: "Spesifikasi",
    pattern: /spesifikasi|specification|spec|ukuran|size|warna|color|colour|规格/i
  },
  {
    key: "unit",
    label: "Satuan",
    pattern: /satuan|unit|uom|单位/i
  },
  {
    key: "category",
    label: "Kategori",
    pattern: /kategori|category|jenis|type|类别|分类/i
  },
  {
    key: "location",
    label: "Lokasi",
    pattern: /lokasi|location|gudang|warehouse|仓库|位置/i
  },
  {
    key: "minimum",
    label: "Stok Minimum",
    pattern: /minimum|\bmin\b|safety|最低|安全库存/i
  },
  {
    key: "stock",
    label: "Stok Awal",
    pattern: /stok|stock|qty|quantity|saldo|balance|jumlah|库存|数量|结存/i
  }
];

function cellText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function columnLetter(index) {
  let n = index + 1;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function columnCount(rows) {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

// Baris header = baris pertama yang berisi minimal 3 sel terisi.
function detectHeaderRow(rows) {
  const index = rows.findIndex(
    row => row.filter(cell => cellText(cell) !== "").length >= 3
  );
  return index < 0 ? 0 : index;
}

function guessMapping(headerCells, rows = [], headerIndex = 0) {
  const mapping = {};
  const used = new Set();

  for (const field of FIELDS) {
    let found = -1;

    for (let i = 0; i < headerCells.length; i++) {
      if (used.has(i)) continue;
      if (field.pattern.test(cellText(headerCells[i]))) {
        found = i;
        break;
      }
    }

    mapping[field.key] = found;
    if (found >= 0) used.add(found);
  }

  // Tidak ada header "kode"? Kolom yang isinya paling mirip kode barang.
  if (mapping.code < 0) {
    const sample = rows.slice(headerIndex + 1, headerIndex + 21);
    for (let i = 0; i < headerCells.length; i++) {
      if (used.has(i)) continue;
      const hits = sample.filter(row =>
        /^[A-Za-z0-9]+([-_/][A-Za-z0-9]+)+$/.test(cellText(row[i]))
      ).length;
      if (sample.length && hits / sample.length >= 0.6) {
        mapping.code = i;
        used.add(i);
        break;
      }
    }
  }

  return mapping;
}

// Cocokkan aturan Firestore: ^[A-Z0-9_-]{2,60}$
function sanitizeCode(raw) {
  const original = cellText(raw);
  const code = original
    .toUpperCase()
    .replace(/[\s/.\\]+/g, "-")
    .replace(/[^A-Z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return { code, changed: code !== original };
}

// "1.250" / "1,250" / 12 / "12 pcs" -> angka bulat, atau NaN.
function parseCount(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : NaN;
  }

  const text = cellText(value);
  if (!text) return NaN;

  const cleaned = text.replace(/[,\s]/g, "").replace(/[^\d.]/g, "");
  if (!/^\d+(\.0+)?$/.test(cleaned)) return NaN;

  const number = Number(cleaned);
  return Number.isSafeInteger(number) ? number : NaN;
}

function cut(text, max, notes, label) {
  if (text.length <= max) return text;
  notes.push(`${label} dipotong ${max} karakter`);
  return text.slice(0, max);
}

/**
 * rows        : array baris (array sel) dari sheet
 * headerIndex : indeks baris header (0-based)
 * mapping     : { code, name, ... } -> indeks kolom atau -1
 * defaults    : nilai bawaan bila kolom tidak dipilih / sel kosong
 * existing    : Set kode yang sudah ada di database
 */
function buildRecords(rows, headerIndex, mapping, defaults, existing) {
  const records = [];
  const seen = new Set();

  const get = (row, key) =>
    mapping[key] >= 0 ? cellText(row[mapping[key]]) : "";

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r] || [];

    const meaningful = Object.keys(mapping).some(
      key => mapping[key] >= 0 && cellText(row[mapping[key]]) !== ""
    );
    if (!meaningful) continue;

    const notes = [];
    const errors = [];

    const rawCode = get(row, "code");
    const { code, changed } = sanitizeCode(rawCode);

    if (!rawCode) errors.push("kode kosong");
    else if (code.length < 2 || code.length > 60) {
      errors.push("kode tidak valid (2–60 karakter)");
    } else if (changed) {
      notes.push(`kode disesuaikan dari "${rawCode}"`);
    }

    const name = cut(get(row, "name"), LIMITS.name, notes, "Nama");
    if (!name) errors.push("nama kosong");

    const specification = cut(
      get(row, "specification"), LIMITS.specification, notes, "Spesifikasi"
    );
    const unit = cut(
      get(row, "unit") || defaults.unit, LIMITS.unit, notes, "Satuan"
    );
    const category = cut(
      get(row, "category") || defaults.category, LIMITS.category, notes, "Kategori"
    );
    const location = cut(
      get(row, "location") || defaults.location, LIMITS.location, notes, "Lokasi"
    );

    let minimum = defaults.minimum;
    if (mapping.minimum >= 0 && get(row, "minimum") !== "") {
      const parsed = parseCount(row[mapping.minimum]);
      if (Number.isNaN(parsed)) {
        notes.push("minimum tidak valid, pakai nilai bawaan");
      } else {
        minimum = parsed;
      }
    }

    let stock = 0;
    if (mapping.stock >= 0 && get(row, "stock") !== "") {
      const parsed = parseCount(row[mapping.stock]);
      if (Number.isNaN(parsed)) {
        notes.push("stok tidak valid, dianggap 0");
      } else {
        stock = parsed;
      }
    }

    let status = "ok";
    let message = "";

    if (errors.length) {
      status = "invalid";
      message = errors.join(", ");
    } else if (existing.has(code)) {
      status = "exists";
      message = "sudah ada di database, dilewati";
    } else if (seen.has(code)) {
      status = "duplicate";
      message = "kode ganda di file, dilewati";
    } else {
      seen.add(code);
    }

    records.push({
      row: r + 1,
      code,
      name,
      specification,
      unit,
      category,
      location,
      minimum,
      stock,
      status,
      message,
      notes
    });
  }

  return records;
}

function summarize(records) {
  const count = status => records.filter(r => r.status === status).length;
  return {
    total: records.length,
    ok: count("ok"),
    exists: count("exists"),
    duplicate: count("duplicate"),
    invalid: count("invalid"),
    withStock: records.filter(r => r.status === "ok" && r.stock > 0).length
  };
}

/* ===== Akhir logika ===== */


console.info("Modul Import Excel dimuat.");

const $ = id => document.getElementById(id);

const XLSX_SOURCES = [
  "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
];

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BATCH_SIZE = 20;

let user = null;
let profile = null;
let busy = false;

// Status impor
let workbook = null;
let sheetName = "";
let rows = [];
let headerIndex = 0;
let mapping = {};
let defaults = { ...DEFAULTS };
let applyStock = true;
let existingCodes = new Set();
let records = [];

const canImport = () =>
  !!profile && ["main_admin", "ga_admin"].includes(profile.role) &&
  hasPerm(profile, "inventory");

const esc = value =>
  String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

function message(text) {
  if (typeof window.notify === "function") window.notify(text);
  else alert(text);
}

function localDate() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
}

/* ---------- Pustaka Excel (dimuat saat dibutuhkan) ---------- */

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

async function loadXLSX() {
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

/* ---------- Tombol & modal ---------- */

function ensureButton() {
  const page = $("page-inventory");
  if (!page) return;

  let button = $("importInventoryBtn");

  if (!button) {
    button = document.createElement("button");
    button.id = "importInventoryBtn";
    button.type = "button";
    button.className = "secondary-button";
    button.innerHTML = '<i class="fa-solid fa-file-excel"></i> Import Excel';
    button.addEventListener("click", openImport);

    const heading = page.querySelector(".page-heading");
    if (heading) heading.appendChild(button);
    else page.prepend(button);
  }

  button.hidden = !canImport();

  let exportBtn = $("exportInventoryBtn");
  if (!exportBtn) {
    exportBtn = document.createElement("button");
    exportBtn.id = "exportInventoryBtn";
    exportBtn.type = "button";
    exportBtn.className = "secondary-button";
    exportBtn.innerHTML = '<i class="fa-solid fa-file-export"></i> Export Excel';
    exportBtn.style.marginLeft = "8px";
    exportBtn.addEventListener("click", exportInventoryExcel);

    const heading = page.querySelector(".page-heading");
    if (heading) heading.appendChild(exportBtn);
    else page.prepend(exportBtn);
  }

  exportBtn.hidden = !canImport();
}

async function exportInventoryExcel() {
  try {
    const XLSX = await loadXLSX();
    const snapshot = await getDocs(collection(db, "inventory"));
    const items = snapshot.docs.map(d => d.data());
    if (!items.length) return message("Tidak ada data inventory untuk diexport.");

    const data = items.map(i => ({
      "Kode Barang": i.code || "",
      "Nama Barang": i.name || "",
      "Spesifikasi": i.specification || "",
      "Kategori": i.category || "",
      "Satuan": i.unit || "",
      "Lokasi": i.location || "",
      "Stok Minimum": i.minimum ?? 0,
      "Stok Saat Ini": i.stock ?? 0
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Inventory");
    XLSX.writeFile(wb, `inventory-${localDate()}.xlsx`);
    message("Inventory berhasil diexport ke Excel.");
  } catch (err) {
    console.error(err);
    message("Gagal export inventory ke Excel.");
  }
}

function closeImport() {
  if (busy) return;
  $("importModal")?.remove();
}

function resetState() {
  workbook = null;
  sheetName = "";
  rows = [];
  headerIndex = 0;
  mapping = {};
  defaults = { ...DEFAULTS };
  applyStock = true;
  existingCodes = new Set();
  records = [];
}

async function openImport() {
  if (!canImport()) return message("Akun ini tidak memiliki izin import.");
  if (busy) return;

  resetState();
  $("importModal")?.remove();

  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "importModal";
  modal.innerHTML = `
    <div class="modal-card import-card">
      <div class="modal-heading">
        <div>
          <span class="eyebrow">GA MANAGEMENT</span>
          <h2>Import Barang dari Excel</h2>
        </div>
        <button type="button" class="icon-button" data-import-close aria-label="Tutup">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div class="field full">
        <label for="importFile">File Excel (.xlsx, .xls, .csv)</label>
        <input id="importFile" type="file"
          accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv">
        <small class="import-hint">
          Foto di dalam Excel tidak ikut diimpor; foto diisi lewat Edit Barang.
          Barang dengan kode yang sudah ada akan dilewati, tidak ditimpa.
        </small>
      </div>

      <div id="importBody"></div>
    </div>`;

  modal.addEventListener("click", event => {
    if (event.target === modal || event.target.closest("[data-import-close]")) {
      closeImport();
    }
  });

  modal.querySelector("#importFile").addEventListener("change", onFileChosen);
  document.body.appendChild(modal);
}

/* ---------- Membaca file ---------- */

async function onFileChosen(event) {
  const file = event.target.files?.[0];
  const body = $("importBody");
  if (!file || !body) return;

  if (file.size > MAX_FILE_BYTES) {
    body.innerHTML = `<p class="import-error">File terlalu besar (maksimal 10 MB).</p>`;
    return;
  }

  body.innerHTML = `<p class="import-hint">Membaca file...</p>`;

  try {
    const [XLSX, buffer, snapshot] = await Promise.all([
      loadXLSX(),
      file.arrayBuffer(),
      getDocs(collection(db, "inventory"))
    ]);

    existingCodes = new Set(snapshot.docs.map(d => d.id));

    workbook = XLSX.read(buffer, { type: "array" });

    if (!workbook.SheetNames.length) throw new Error("File tidak berisi sheet.");

    // Utamakan sheet bernama "ITEM"; selain itu sheet pertama.
    sheetName =
      workbook.SheetNames.find(name => /^item/i.test(name.trim())) ||
      workbook.SheetNames[0];

    loadSheet();
    renderImport();
  } catch (error) {
    console.error("Gagal membaca Excel:", error);
    body.innerHTML = `<p class="import-error">${esc(error.message || "File tidak dapat dibaca.")}</p>`;
  }
}

function loadSheet() {
  const XLSX = window.XLSX;

  rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: "",
    raw: true,
    blankrows: true
  });

  headerIndex = detectHeaderRow(rows);
  mapping = guessMapping(rows[headerIndex] || [], rows, headerIndex);
  recompute();
}

function recompute() {
  records = buildRecords(rows, headerIndex, mapping, defaults, existingCodes);
}

/* ---------- Tampilan pratinjau ---------- */

function columnOptions(selected) {
  const count = columnCount(rows);
  const header = rows[headerIndex] || [];
  let html = `<option value="-1" ${selected < 0 ? "selected" : ""}>— tidak ada —</option>`;

  for (let i = 0; i < count; i++) {
    const title = cellText(header[i]) || "(kosong)";
    html += `<option value="${i}" ${selected === i ? "selected" : ""}>${columnLetter(i)} — ${esc(title.slice(0, 40))}</option>`;
  }
  return html;
}

const STATUS_LABEL = {
  ok: ["Baru", ""],
  exists: ["Sudah ada", "neutral"],
  duplicate: ["Kode ganda", "warning"],
  invalid: ["Tidak valid", "danger"]
};

function previewRow(r) {
  const [label, cls] = STATUS_LABEL[r.status];
  const note = [r.message, ...r.notes].filter(Boolean).join("; ");

  return `
    <tr>
      <td>${r.row}</td>
      <td>${esc(r.code || "-")}</td>
      <td>${esc(r.name || "-")}</td>
      <td>${esc(r.specification || "-")}</td>
      <td>${esc(r.unit)}</td>
      <td>${esc(r.stock)}</td>
      <td><span class="status-badge ${cls}">${label}</span>${note ? `<br><small>${esc(note)}</small>` : ""}</td>
    </tr>`;
}

function renderImport() {
  const body = $("importBody");
  if (!body) return;

  const s = summarize(records);
  const problems = records.filter(r => r.status !== "ok").slice(0, 10);
  const sample = records.slice(0, 8);

  const sheetPicker = workbook.SheetNames.length > 1
    ? `<div class="field">
         <label>Sheet</label>
         <select id="importSheet">
           ${workbook.SheetNames.map(name =>
             `<option ${name === sheetName ? "selected" : ""} value="${esc(name)}">${esc(name)}</option>`
           ).join("")}
         </select>
       </div>`
    : "";

  const mappingHTML = FIELDS.map(field => `
    <div class="field">
      <label>${esc(field.label)}${field.required ? " *" : ""}</label>
      <select data-map="${field.key}">${columnOptions(mapping[field.key] ?? -1)}</select>
    </div>`).join("");

  const canStart = s.ok > 0 && mapping.code >= 0 && mapping.name >= 0;

  body.innerHTML = `
    <div class="import-section">
      <h3>1. Pilih kolom</h3>
      <div class="form-fields">
        ${sheetPicker}
        <div class="field">
          <label>Baris header</label>
          <input id="importHeaderRow" type="number" min="1" max="${Math.max(rows.length, 1)}" step="1" value="${headerIndex + 1}">
        </div>
        ${mappingHTML}
      </div>
    </div>

    <div class="import-section">
      <h3>2. Nilai bawaan <small>(dipakai bila kolom tidak dipilih atau selnya kosong)</small></h3>
      <div class="form-fields">
        <div class="field"><label>Satuan</label><input id="defUnit" maxlength="40" value="${esc(defaults.unit)}"></div>
        <div class="field"><label>Kategori</label><input id="defCategory" maxlength="100" value="${esc(defaults.category)}"></div>
        <div class="field"><label>Lokasi</label><input id="defLocation" maxlength="150" value="${esc(defaults.location)}"></div>
        <div class="field"><label>Stok minimum</label><input id="defMinimum" type="number" min="0" step="1" value="${esc(defaults.minimum)}"></div>
      </div>
      ${mapping.stock >= 0 ? `
        <label class="import-check">
          <input type="checkbox" id="importApplyStock" ${applyStock ? "checked" : ""}>
          Isi stok awal dari kolom Excel (dicatat sebagai transaksi Masuk "Stok awal (import Excel)")
        </label>` : ""}
    </div>

    <div class="import-section">
      <h3>3. Periksa hasil</h3>
      <p class="import-summary">
        <strong>${s.total}</strong> baris terbaca ·
        <strong class="ok">${s.ok}</strong> akan diimpor ·
        ${s.exists} sudah ada ·
        ${s.duplicate} kode ganda ·
        <strong class="bad">${s.invalid}</strong> tidak valid
        ${applyStock && mapping.stock >= 0 ? ` · ${s.withStock} barang dengan stok awal` : ""}
      </p>

      <div class="table-wrap">
        <table>
          <thead><tr><th>Baris</th><th>Kode</th><th>Nama</th><th>Spesifikasi</th><th>Satuan</th><th>Stok</th><th>Status</th></tr></thead>
          <tbody>${sample.length ? sample.map(previewRow).join("") : `<tr><td colspan="7" class="empty-cell">Tidak ada data di bawah baris header.</td></tr>`}</tbody>
        </table>
      </div>

      ${problems.length ? `
        <details class="import-problems" open>
          <summary>Baris yang dilewati / bermasalah (${problems.length}${s.total - s.ok > 10 ? " pertama" : ""})</summary>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Baris</th><th>Kode</th><th>Nama</th><th>Spesifikasi</th><th>Satuan</th><th>Stok</th><th>Status</th></tr></thead>
              <tbody>${problems.map(previewRow).join("")}</tbody>
            </table>
          </div>
        </details>` : ""}
    </div>

    <div class="modal-actions">
      <button type="button" class="secondary-button" data-import-close>Batal</button>
      <button type="button" class="primary-button" id="importStart" ${canStart ? "" : "disabled"}>
        <i class="fa-solid fa-file-import"></i> Impor ${s.ok} barang
      </button>
    </div>`;

  bindControls();
}

function bindControls() {
  $("importSheet")?.addEventListener("change", event => {
    sheetName = event.target.value;
    loadSheet();
    renderImport();
  });

  $("importHeaderRow")?.addEventListener("change", event => {
    const value = Math.floor(Number(event.target.value));
    headerIndex = Number.isFinite(value) && value >= 1 ? value - 1 : 0;
    mapping = guessMapping(rows[headerIndex] || [], rows, headerIndex);
    recompute();
    renderImport();
  });

  document.querySelectorAll("#importBody [data-map]").forEach(select => {
    select.addEventListener("change", () => {
      mapping[select.dataset.map] = Number(select.value);
      recompute();
      renderImport();
    });
  });

  const readDefaults = () => {
    const minimum = Math.floor(Number($("defMinimum")?.value));
    defaults = {
      unit: cellText($("defUnit")?.value) || DEFAULTS.unit,
      category: cellText($("defCategory")?.value) || DEFAULTS.category,
      location: cellText($("defLocation")?.value) || DEFAULTS.location,
      minimum: Number.isFinite(minimum) && minimum >= 0 ? minimum : DEFAULTS.minimum
    };
    recompute();
    renderImport();
  };

  ["defUnit", "defCategory", "defLocation", "defMinimum"].forEach(id => {
    $(id)?.addEventListener("change", readDefaults);
  });

  $("importApplyStock")?.addEventListener("change", event => {
    applyStock = event.target.checked;
    renderImport();
  });

  $("importStart")?.addEventListener("click", runImport);
}

/* ---------- Menyimpan ke Firestore ---------- */

function setProgress(html) {
  const body = $("importBody");
  if (body) body.innerHTML = html;
}

function progressHTML(title, done, total, extra = "") {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return `
    <div class="import-progress">
      <h3>${esc(title)}</h3>
      <div class="import-bar"><span style="width:${percent}%"></span></div>
      <p>${done} / ${total} (${percent}%)</p>
      ${extra}
      <p class="import-hint">Jangan menutup atau me-refresh halaman sampai selesai.</p>
    </div>`;
}

function inventoryData(r) {
  return {
    code: r.code,
    name: r.name,
    category: r.category,
    unit: r.unit,
    location: r.location,
    minimum: r.minimum,
    specification: r.specification,
    stock: 0,
    photoData: "",
    createdBy: user.uid,
    createdByName: profile.name,
    createdByRole: profile.role,
    createdAt: serverTimestamp()
  };
}

async function createChunk(chunk, failures) {
  const created = [];

  try {
    const batch = writeBatch(db);
    chunk.forEach(r => batch.set(doc(db, "inventory", r.code), inventoryData(r)));
    await batch.commit();
    created.push(...chunk);
  } catch (batchError) {
    // Satu baris bermasalah menggagalkan seluruh batch: ulangi satu per satu.
    console.warn("Batch gagal, mencoba satu per satu:", batchError);

    for (const r of chunk) {
      try {
        const batch = writeBatch(db);
        batch.set(doc(db, "inventory", r.code), inventoryData(r));
        await batch.commit();
        created.push(r);
      } catch (error) {
        failures.push({
          code: r.code,
          step: "membuat barang",
          error: error.code === "permission-denied"
            ? "ditolak Rules"
            : (error.message || "gagal")
        });
      }
    }
  }

  return created;
}

async function applyInitialStock(r) {
  const itemRef = doc(db, "inventory", r.code);
  const trxRef = doc(collection(db, "transactions"));

  await runTransaction(db, async tx => {
    const snapshot = await tx.get(itemRef);
    if (!snapshot.exists()) throw new Error("barang belum tersimpan");

    const item = snapshot.data();
    if (item.stock !== 0) throw new Error("stok sudah terisi");

    tx.update(itemRef, {
      stock: r.stock,
      lastTransactionId: trxRef.id,
      lastStockBefore: 0
    });

    tx.set(trxRef, {
      itemId: r.code,
      code: item.code,
      name: item.name,
      type: "Masuk",
      quantity: r.stock,
      stockBefore: 0,
      stockAfter: r.stock,
      date: localDate(),
      note: "Stok awal (import Excel)",
      createdBy: user.uid,
      createdByName: profile.name,
      createdByRole: profile.role,
      createdAt: serverTimestamp(),
      testOnly: false
    });
  });
}

async function runImport() {
  if (busy || !canImport() || !user) return;

  const toCreate = records.filter(r => r.status === "ok");
  if (!toCreate.length) return;

  const withStock = applyStock && mapping.stock >= 0
    ? toCreate.filter(r => r.stock > 0)
    : [];

  busy = true;
  const failures = [];
  const created = [];

  try {
    // Tahap 1: buat barang (stok 0, sesuai Rules).
    let done = 0;
    setProgress(progressHTML("Membuat barang...", 0, toCreate.length));

    for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
      const chunk = toCreate.slice(i, i + BATCH_SIZE);
      created.push(...await createChunk(chunk, failures));
      done += chunk.length;
      setProgress(progressHTML("Membuat barang...", done, toCreate.length));
    }

    // Tahap 2: stok awal lewat transaksi Masuk (satu per barang).
    let stockDone = 0;
    let stockApplied = 0;

    const createdCodes = new Set(created.map(r => r.code));
    const stockTargets = withStock.filter(r => createdCodes.has(r.code));

    for (const r of stockTargets) {
      setProgress(progressHTML("Mengisi stok awal...", stockDone, stockTargets.length));

      try {
        await applyInitialStock(r);
        stockApplied++;
      } catch (error) {
        failures.push({
          code: r.code,
          step: "mengisi stok awal",
          error: error.code === "permission-denied"
            ? "ditolak Rules"
            : (error.message || "gagal")
        });
      }

      stockDone++;
    }

    window.refreshFirestoreInventory?.();

    setProgress(`
      <div class="import-progress">
        <h3>Impor selesai</h3>
        <p><strong>${created.length}</strong> barang berhasil dibuat${
          withStock.length ? `, <strong>${stockApplied}</strong> stok awal terisi` : ""
        }.</p>
        ${failures.length ? `
          <p class="import-error">${failures.length} langkah gagal:</p>
          <ul class="import-failures">
            ${failures.slice(0, 30).map(f =>
              `<li>${esc(f.code)} — ${esc(f.step)}: ${esc(f.error)}</li>`
            ).join("")}
          </ul>
          ${failures.some(f => f.step === "mengisi stok awal")
            ? `<p class="import-hint">Untuk barang yang stok awalnya gagal, isi lewat menu Transaksi Stok.</p>`
            : ""}` : ""}
        <div class="modal-actions">
          <button type="button" class="primary-button" data-import-close>Tutup</button>
        </div>
      </div>`);
  } catch (error) {
    console.error("Impor gagal:", error);
    setProgress(`<p class="import-error">Impor berhenti: ${esc(error.message || error)}</p>
      <div class="modal-actions"><button type="button" class="primary-button" data-import-close>Tutup</button></div>`);
  } finally {
    busy = false;
  }
}

/* ---------- Auth ---------- */

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeImport();
});

await authPersistenceReady;

onAuthStateChanged(auth, async current => {
  user = null;
  profile = null;
  $("importModal")?.remove();
  ensureButton();

  if (!current) return;

  try {
    await current.reload();
    if (!current.emailVerified) return;

    const snapshot = await getDoc(doc(db, "users", current.uid));
    if (!snapshot.exists() || snapshot.data().active !== true) return;

    user = current;
    profile = snapshot.data();
    ensureButton();
  } catch (error) {
    console.error("Gagal memuat modul import:", error);
  }
});
