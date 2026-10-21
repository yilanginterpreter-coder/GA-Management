// Data induk (Vendor, Kendaraan) + Import/Export Excel untuk semua menu.
import { auth, db, authPersistenceReady } from "./firebase-init.js";
import { hasPerm } from "./perms.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

(window.__gaModules ||= {}).masterdata = true;

const $ = id => document.getElementById(id);
const STAFF_ROLES = ["main_admin", "ga_admin", "admin_operational"];

let user = null;
let profile = null;
let generation = 0;
let busy = false;

const esc = value =>
  String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

function message(text) {
  if (typeof window.notify === "function") window.notify(text);
  else alert(text);
}

function errorText(error) {
  if (error?.code === "permission-denied") {
    return "Rules menolak tindakan ini. Pastikan firestore.rules terbaru sudah dipublikasikan dan akun punya akses menu ini.";
  }
  return error?.message || "Terjadi kesalahan.";
}

async function excel() {
  try {
    return await import("./xlsx-util.js");
  } catch (error) {
    throw new Error("File xlsx-util.js belum diunggah ke GitHub, jadi fitur Excel belum bisa dipakai.");
  }
}

const norm = v => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const isStaff = () => !!profile && STAFF_ROLES.includes(profile.role);

/* ---------- Modal ---------- */

function closeModal() {
  $("masterModal")?.remove();
}

const fieldHTML = (label, control, full = false) =>
  `<div class="field ${full ? "full" : ""}"><label>${esc(label)}</label>${control}</div>`;

function openModal(title, bodyHTML, submitLabel, onSubmit) {
  closeModal();
  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "masterModal";
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-heading">
        <div><span class="eyebrow">GA MANAGEMENT</span><h2>${esc(title)}</h2></div>
        <button type="button" class="icon-button" data-close aria-label="Tutup"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <form>
        <div class="form-fields">${bodyHTML}</div>
        <div class="modal-actions">
          <button type="button" class="secondary-button" data-close>Batal</button>
          ${onSubmit ? `<button type="submit" class="primary-button">${esc(submitLabel)}</button>` : ""}
        </div>
      </form>
    </div>`;

  modal.addEventListener("click", event => {
    if (event.target === modal || event.target.closest("[data-close]")) closeModal();
  });

  modal.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!onSubmit || busy) return;
    busy = true;
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const result = await onSubmit(Object.fromEntries(new FormData(event.currentTarget)));
      closeModal();
      if (result) message(result);
    } catch (error) {
      console.error(error);
      message(errorText(error));
      if (submit) submit.disabled = false;
    } finally {
      busy = false;
    }
  });

  document.body.appendChild(modal);
  modal.querySelector("input:not([readonly]), select, textarea")?.focus();
}

/* ======================================================================
   Pengelola data induk (Vendor, Kendaraan)
   ====================================================================== */

const VENDOR_CATEGORIES = ["ATK", "Kebersihan", "Perbaikan", "Transportasi", "Katering", "Akomodasi", "Lainnya"];
const VENDOR_STATUSES = ["Aktif", "Nonaktif", "Evaluasi"];
const VEHICLE_TYPES = ["Mobil", "Motor", "Pickup", "Bus", "Truk", "Lainnya"];
const VEHICLE_STATUSES = ["Tersedia", "Digunakan", "Servis", "Tidak Aktif"];

// [key, label, type, options, required, max, lebarExcel, nama kolom dikenali]
const CONFIGS = [
  {
    page: "vendors",
    collection: "vendors",
    perms: ["vendors", "procurement"],
    eyebrow: "PARTNER MANAGEMENT",
    title: "Vendor",
    subtitle: "Daftar vendor yang dipakai untuk Purchase Order dan layanan GA.",
    singular: "vendor",
    file: "Vendor",
    keyField: null, // id otomatis
    matchField: "name",
    statusField: "status",
    statusOptions: VENDOR_STATUSES,
    fields: [
      ["name", "Nama Vendor", "text", null, true, 100, 30, ["nama vendor", "nama", "vendor", "name", "company", "供应商"]],
      ["category", "Kategori", "select", VENDOR_CATEGORIES, true, 40, 16, ["kategori", "category"]],
      ["contact", "Nama Kontak (PIC)", "text", null, false, 100, 22, ["nama kontak", "kontak", "pic", "contact", "contact person"]],
      ["phone", "Telepon / Email", "text", null, false, 100, 24, ["telepon / email", "telepon", "email", "phone", "no hp", "hp", "kontak vendor"]],
      ["status", "Status", "select", VENDOR_STATUSES, true, 20, 12, ["status"]],
      ["note", "Catatan", "textarea", null, false, 300, 36, ["catatan", "note", "keterangan"]]
    ],
    defaults: { category: "Lainnya", status: "Aktif" },
    sample: ["PT Contoh Sejahtera", "ATK", "Bu Ani", "0812-0000-0000", "Aktif", "Vendor ATK langganan"]
  },
  {
    page: "vehicles",
    collection: "vehicles",
    perms: ["vehicles"],
    eyebrow: "FLEET MANAGEMENT",
    title: "Data Kendaraan",
    subtitle: "Daftar armada, lokasi, pengguna, dan status pemakaiannya.",
    singular: "kendaraan",
    file: "Kendaraan",
    keyField: "plate",
    matchField: "plate",
    statusField: "status",
    statusOptions: VEHICLE_STATUSES,
    fields: [
      ["plate", "Nomor Polisi", "text", null, true, 20, 16, ["nomor polisi", "no polisi", "plat", "plat nomor", "plate", "no pol"]],
      ["type", "Jenis Kendaraan", "select", VEHICLE_TYPES, true, 20, 16, ["jenis kendaraan", "jenis", "type", "tipe"]],
      ["model", "Merek / Model", "text", null, true, 100, 24, ["merek / model", "merek", "model", "merk"]],
      ["location", "Lokasi", "text", null, false, 100, 20, ["lokasi", "location"]],
      ["user", "Pengguna", "text", null, false, 100, 20, ["pengguna", "user", "pemakai"]],
      ["status", "Status", "select", VEHICLE_STATUSES, true, 20, 14, ["status"]]
    ],
    defaults: { type: "Lainnya", status: "Tersedia" },
    sample: ["B 1234 XYZ", "Mobil", "Toyota Avanza", "Kantor Pusat", "Tim GA", "Tersedia"]
  }
];

const plateId = plate => String(plate).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

function makeManager(cfg) {
  let rows = [];
  let loaded = false;
  let shown = 200;

  const page = () => $("page-" + cfg.page);
  const q = id => $(`${cfg.page}-${id}`);
  const canManage = () => !!profile && cfg.perms.some(k => hasPerm(profile, k));
  const isMain = () => profile?.role === "main_admin";

  /* --- markup --- */
  function build() {
    const section = page();
    if (!section) return;
    section.innerHTML = `
      <div class="page-heading">
        <div><span class="eyebrow">${esc(cfg.eyebrow)}</span><h1>${esc(cfg.title)}</h1><p>${esc(cfg.subtitle)}</p></div>
        <div class="heading-actions">
          <button type="button" class="primary-button" id="${cfg.page}-add"><i class="fa-solid fa-plus"></i> Tambah</button>
          <button type="button" class="secondary-button" id="${cfg.page}-import"><i class="fa-solid fa-file-import"></i> Import Excel</button>
          <button type="button" class="secondary-button" id="${cfg.page}-export"><i class="fa-solid fa-file-export"></i> Export Excel</button>
          <button type="button" class="secondary-button" id="${cfg.page}-template"><i class="fa-solid fa-download"></i> Template</button>
          <input type="file" id="${cfg.page}-file" accept=".xlsx,.xls,.csv" hidden>
        </div>
      </div>
      <article class="panel">
        <div class="toolbar">
          <input id="${cfg.page}-search" type="search" placeholder="Cari ${esc(cfg.singular)}..." autocomplete="off">
          <select id="${cfg.page}-status" style="max-width:190px"><option value="">Semua status</option>${cfg.statusOptions.map(s => `<option>${esc(s)}</option>`).join("")}</select>
        </div>
        <p class="meal-summary" id="${cfg.page}-summary"></p>
        <div class="table-wrap"><table><thead><tr>${cfg.fields.map(f => `<th>${esc(f[1])}</th>`).join("")}<th>Aksi</th></tr></thead><tbody id="${cfg.page}-table"><tr><td colspan="${cfg.fields.length + 1}" class="empty-cell">Memuat data...</td></tr></tbody></table></div>
        <button type="button" class="secondary-button" id="${cfg.page}-more" hidden style="margin-top:12px">Tampilkan lebih banyak</button>
      </article>`;

    q("add").addEventListener("click", () => openForm());
    q("import").addEventListener("click", () => q("file").click());
    q("export").addEventListener("click", doExport);
    q("template").addEventListener("click", doTemplate);
    q("file").addEventListener("change", onFile);
    q("search").addEventListener("input", () => { shown = 200; render(); });
    q("status").addEventListener("change", () => { shown = 200; render(); });
    q("more").addEventListener("click", () => { shown += 200; render(); });
    q("table").addEventListener("click", event => {
      const edit = event.target.closest("[data-edit]");
      const del = event.target.closest("[data-del]");
      if (edit) openForm(edit.dataset.edit);
      else if (del) askDelete(del.dataset.del);
    });
  }

  /* --- data --- */
  async function load() {
    if (!user || !profile || !isStaff()) return;
    const current = generation;
    try {
      const snap = await getDocs(collection(db, cfg.collection));
      if (current !== generation) return;
      rows = snap.docs.map(d => ({ ...d.data(), id: d.id }))
        .sort((a, b) => String(a[cfg.matchField]).localeCompare(String(b[cfg.matchField]), "id"));
      loaded = true;
    } catch (error) {
      if (current !== generation) return;
      console.error(error);
      message(`Gagal memuat data ${cfg.singular}. Periksa izin akses dan firestore.rules.`);
    }
    render();
  }

  function filtered() {
    const term = (q("search")?.value || "").trim().toLocaleLowerCase("id-ID");
    const status = q("status")?.value || "";
    return rows.filter(r => {
      if (status && r[cfg.statusField] !== status) return false;
      if (!term) return true;
      return cfg.fields.map(f => r[f[0]]).join(" ").toLocaleLowerCase("id-ID").includes(term);
    });
  }

  function render() {
    const body = q("table");
    if (!body) return;
    const list = filtered();
    const visible = list.slice(0, shown);
    const manage = canManage();

    if (q("add")) q("add").hidden = !manage;
    if (q("import")) q("import").hidden = !manage;
    if (q("template")) q("template").hidden = !manage;
    if (q("summary")) q("summary").textContent = `${rows.length} data · menampilkan ${visible.length} dari ${list.length} hasil`;

    body.innerHTML = visible.length
      ? visible.map(r => `<tr>${cfg.fields.map(f => {
          const v = r[f[0]];
          return f[0] === cfg.statusField
            ? `<td data-label="${esc(f[1])}"><span class="status-badge ${["Nonaktif", "Tidak Aktif"].includes(v) ? "neutral" : ["Evaluasi", "Servis"].includes(v) ? "warning" : ""}">${esc(v || "-")}</span></td>`
            : `<td data-label="${esc(f[1])}">${esc(v || "-")}</td>`;
        }).join("")}<td data-label="Aksi">${manage
          ? `<div class="row-actions"><button type="button" class="small-action" data-edit="${esc(r.id)}">Edit</button>${isMain() ? `<button type="button" class="small-action delete" data-del="${esc(r.id)}">Hapus</button>` : ""}</div>`
          : "-"}</td></tr>`).join("")
      : `<tr><td colspan="${cfg.fields.length + 1}" class="empty-cell">${loaded ? `Belum ada data ${esc(cfg.singular)}. Klik Tambah atau Import Excel.` : "Memuat data..."}</td></tr>`;

    if (q("more")) q("more").hidden = list.length <= shown;
  }

  /* --- form --- */
  function controlFor(f, rec, editing) {
    const [key, label, type, options, required, max] = f;
    const value = rec[key] ?? cfg.defaults[key] ?? "";
    const readonly = editing && key === cfg.keyField ? "readonly" : "";
    if (type === "select") {
      return `<select name="${key}" ${required ? "required" : ""}>${options.map(o => `<option ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    }
    if (type === "textarea") {
      return `<textarea name="${key}" maxlength="${max}">${esc(value)}</textarea>`;
    }
    return `<input name="${key}" maxlength="${max}" ${required ? "required" : ""} ${readonly} value="${esc(value)}">`;
  }

  function openForm(id = null) {
    if (!canManage()) return message("Anda tidak memiliki akses mengubah data ini.");
    const rec = id ? rows.find(r => r.id === id) : null;
    if (id && !rec) return message("Data tidak ditemukan.");

    openModal(
      rec ? `Edit ${cfg.singular}` : `Tambah ${cfg.singular}`,
      cfg.fields.map(f => fieldHTML(f[1] + (f[4] ? " *" : ""), controlFor(f, rec || {}, !!rec), f[2] === "textarea")).join(""),
      "Simpan",
      async data => {
        const record = clean(data);
        const problem = validate(record);
        if (problem) throw new Error(problem);
        const docId = idFor(record, rec);
        if (!rec && cfg.keyField) {
          const exists = await getDoc(doc(db, cfg.collection, docId));
          if (exists.exists()) throw new Error(`${cfg.fields[0][1]} ${record[cfg.keyField]} sudah terdaftar.`);
        }
        await setDoc(doc(db, cfg.collection, docId), stamp(record, rec));
        await load();
        document.dispatchEvent(new Event("ga:data-changed"));
        return rec ? "Data diperbarui." : "Data ditambahkan.";
      }
    );
  }

  function askDelete(id) {
    const rec = rows.find(r => r.id === id);
    if (!rec) return;
    openModal(
      "Hapus data",
      fieldHTML("", `<div>Hapus <strong>${esc(rec[cfg.matchField])}</strong>? Tindakan ini tidak dapat dibatalkan.</div>`, true),
      "Hapus",
      async () => {
        await deleteDoc(doc(db, cfg.collection, id));
        await load();
        return "Data dihapus.";
      }
    );
  }

  /* --- normalisasi --- */
  function clean(input) {
    const out = {};
    for (const f of cfg.fields) {
      let v = String(input[f[0]] ?? "").trim();
      if (f[2] === "select") {
        const hit = f[3].find(o => norm(o) === norm(v));
        v = hit || cfg.defaults[f[0]] || "";
      }
      out[f[0]] = v;
    }
    if (cfg.keyField === "plate") out.plate = out.plate.toUpperCase().replace(/\s+/g, " ");
    return out;
  }

  function validate(rec) {
    for (const f of cfg.fields) {
      if (f[4] && !rec[f[0]]) return `${f[1]} wajib diisi.`;
      if (rec[f[0]].length > f[5]) return `${f[1]} maksimal ${f[5]} karakter.`;
    }
    if (cfg.keyField && !plateId(rec[cfg.keyField])) return "Nomor polisi tidak valid.";
    return "";
  }

  const idFor = (rec, existing) =>
    existing?.id || (cfg.keyField ? plateId(rec[cfg.keyField]) : doc(collection(db, cfg.collection)).id);

  const stamp = (rec) => ({
    ...rec,
    updatedBy: user.uid,
    updatedByName: profile.name,
    updatedAt: serverTimestamp()
  });

  /* --- Excel --- */
  const header = () => cfg.fields.map(f => f[1]);

  async function doExport(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { downloadXlsx, stamp: day } = await excel();
      await downloadXlsx(`${cfg.file}-${day()}.xlsx`, [{
        name: cfg.title,
        widths: cfg.fields.map(f => f[6]),
        rows: [header()].concat(rows.map(r => cfg.fields.map(f => r[f[0]] || "")))
      }]);
      message("File Excel diunduh.");
    } catch (error) {
      message(error.message || "Export gagal.");
    } finally {
      button.disabled = false;
    }
  }

  async function doTemplate() {
    try {
      const { downloadXlsx } = await excel();
      await downloadXlsx(`Template-${cfg.file}.xlsx`, [{
        name: cfg.title, widths: cfg.fields.map(f => f[6]), rows: [header(), cfg.sample]
      }]);
    } catch (error) {
      message(error.message || "Gagal membuat template.");
    }
  }

  async function onFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    try {
      const sheetRows = await readSheet(file);
      const { records, skipped, problems } = mapRows(sheetRows, cfg.fields, clean, validate);
      if (!records.length) throw new Error(problems[0] || "Tidak ada data yang bisa diimpor.");

      const idOf = r => cfg.keyField ? plateId(r[cfg.keyField]) : null;
      const existingIds = new Map(rows.map(r => [cfg.keyField ? r.id : norm(r[cfg.matchField]), r.id]));
      const keyOf = r => cfg.keyField ? idOf(r) : norm(r[cfg.matchField]);
      const updates = records.filter(r => existingIds.has(keyOf(r))).length;

      openModal(
        `Import ${cfg.title}`,
        fieldHTML("", `<div>
          <p><strong>${records.length}</strong> data siap diimpor (${records.length - updates} baru, ${updates} memperbarui data yang sudah ada).</p>
          ${skipped ? `<p>${skipped} baris dilewati.</p><small>${problems.map(esc).join("<br>")}</small>` : ""}
        </div>`, true),
        "Import Sekarang",
        async () => {
          for (let i = 0; i < records.length; i += 400) {
            const batch = writeBatch(db);
            records.slice(i, i + 400).forEach(r => {
              const existingId = existingIds.get(keyOf(r));
              const docId = existingId || (cfg.keyField ? idOf(r) : doc(collection(db, cfg.collection)).id);
              batch.set(doc(db, cfg.collection, docId), stamp(r));
            });
            await batch.commit();
          }
          await load();
          return `${records.length} data diimpor.`;
        }
      );
    } catch (error) {
      console.error(error);
      message(error.message || "Import gagal.");
    }
  }

  return { cfg, build, load, render, page };
}

/* ---------- Baca Excel & petakan kolom (dipakai semua pengimpor) ---------- */

async function readSheet(file) {
  const { loadXLSX } = await excel();
  const XLSX = await loadXLSX();
  const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
}

function mapRows(sheetRows, fields, clean, validate) {
  if (!sheetRows.length) return { records: [], skipped: 0, problems: [] };

  const head = sheetRows[0].map(norm);
  const columns = new Map();
  for (const f of fields) {
    const aliases = [norm(f[1]), ...(f[7] || [])];
    const index = head.findIndex(h => aliases.includes(h));
    if (index >= 0) columns.set(f[0], index);
  }
  const missing = fields.filter(f => f[4] && !columns.has(f[0])).map(f => f[1]);
  if (missing.length) throw new Error(`Kolom wajib tidak ditemukan di baris pertama: ${missing.join(", ")}.`);

  const records = [];
  const problems = [];
  const seen = new Set();
  let skipped = 0;

  sheetRows.slice(1).forEach((cells, i) => {
    if (!cells || cells.every(c => String(c ?? "").trim() === "")) return;
    const raw = {};
    for (const [key, index] of columns) raw[key] = cells[index];
    const rec = clean(raw);
    const problem = validate(rec);
    if (problem) { skipped++; if (problems.length < 5) problems.push(`Baris ${i + 2}: ${problem}`); return; }
    const dupKey = JSON.stringify(rec[fields[0][0]]).toLowerCase();
    if (seen.has(dupKey)) { skipped++; if (problems.length < 5) problems.push(`Baris ${i + 2}: data ganda di file.`); return; }
    seen.add(dupKey);
    records.push(rec);
  });

  return { records, skipped, problems };
}

/* ======================================================================
   Import Aset (aset memakai aturan khusus: hanya Main Admin & GA Admin)
   ====================================================================== */

const ASSET_CATEGORIES = ["Laptop", "Komputer", "AC", "Meja & Kursi", "Printer", "Kendaraan", "Peralatan", "Lainnya"];
const ASSET_CONDITIONS = ["Baik", "Perlu Perbaikan", "Rusak"];
const ASSET_STATUSES = ["Aktif", "Dipinjam", "Dalam Perbaikan", "Tidak Aktif"];

const ASSET_FIELDS = [
  ["code", "Kode Aset", "text", null, true, 60, 16, ["kode aset", "kode", "code", "no aset"]],
  ["name", "Nama Aset", "text", null, true, 150, 30, ["nama aset", "nama", "name"]],
  ["category", "Kategori", "select", ASSET_CATEGORIES, true, 40, 16, ["kategori", "category"]],
  ["location", "Lokasi", "text", null, true, 150, 22, ["lokasi", "location"]],
  ["owner", "Penanggung Jawab", "text", null, false, 150, 22, ["penanggung jawab", "pj", "owner", "pemilik"]],
  ["condition", "Kondisi", "select", ASSET_CONDITIONS, true, 20, 16, ["kondisi", "condition"]],
  ["status", "Status", "select", ASSET_STATUSES, true, 20, 16, ["status"]],
  ["date", "Tanggal Perolehan", "text", null, false, 10, 18, ["tanggal perolehan", "tanggal", "date"]],
  ["value", "Nilai Perolehan (Rp)", "text", null, false, 20, 20, ["nilai perolehan (rp)", "nilai perolehan", "nilai", "value"]]
];

function pickOption(options, raw, fallback) {
  const hit = options.find(o => norm(o) === norm(raw));
  return hit || fallback;
}

function parseDate(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  let m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return "";
}

function assetClean(input) {
  const code = String(input.code ?? "").trim().toUpperCase().replace(/\s+/g, "-");
  const valueText = String(input.value ?? "").replace(/[^\d.]/g, "");
  return {
    code,
    name: String(input.name ?? "").trim(),
    category: pickOption(ASSET_CATEGORIES, input.category, "Lainnya"),
    location: String(input.location ?? "").trim(),
    owner: String(input.owner ?? "").trim(),
    condition: pickOption(ASSET_CONDITIONS, input.condition, "Baik"),
    status: pickOption(ASSET_STATUSES, input.status, "Aktif"),
    date: parseDate(input.date),
    value: Number(valueText) || 0
  };
}

function assetValidate(rec) {
  if (!/^[A-Z0-9_-]{2,60}$/.test(rec.code)) return "Kode aset 2-60 karakter: huruf, angka, strip, garis bawah.";
  if (!rec.name || rec.name.length > 150) return "Nama aset wajib, maksimal 150 karakter.";
  if (!rec.location || rec.location.length > 150) return "Lokasi wajib, maksimal 150 karakter.";
  if (rec.owner.length > 150) return "Penanggung jawab maksimal 150 karakter.";
  return "";
}

const assetCanWrite = () =>
  !!profile && profile.active === true &&
  ["main_admin", "ga_admin"].includes(profile.role) && hasPerm(profile, "assets");

function setupAssetImport() {
  const heading = $("page-assets")?.querySelector(".page-heading");
  if (!heading || $("assets-import")) return;

  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".xlsx,.xls,.csv";
  file.hidden = true;
  file.id = "assets-file";

  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.id = "assets-import";
  importButton.className = "secondary-button";
  importButton.innerHTML = '<i class="fa-solid fa-file-import"></i> Import Excel';

  const templateButton = document.createElement("button");
  templateButton.type = "button";
  templateButton.id = "assets-template";
  templateButton.className = "secondary-button";
  templateButton.innerHTML = '<i class="fa-solid fa-download"></i> Template';

  heading.append(importButton, templateButton, file);

  importButton.addEventListener("click", () => {
    if (!assetCanWrite()) return message("Hanya Main Admin atau GA Admin dengan akses Aset yang bisa import.");
    file.click();
  });

  templateButton.addEventListener("click", async () => {
    try {
      const { downloadXlsx } = await excel();
      await downloadXlsx("Template-Aset.xlsx", [{
        name: "Aset", widths: ASSET_FIELDS.map(f => f[6]),
        rows: [ASSET_FIELDS.map(f => f[1]), ["AST-001", "Laptop Kantor 1", "Laptop", "Kantor GA", "Budi", "Baik", "Aktif", "2026-01-15", 9500000]]
      }]);
    } catch (error) {
      message(error.message);
    }
  });

  file.addEventListener("change", async event => {
    const f = event.target.files?.[0];
    event.target.value = "";
    if (!f || busy) return;
    try {
      const { records, skipped, problems } = mapRows(await readSheet(f), ASSET_FIELDS, assetClean, assetValidate);
      if (!records.length) throw new Error(problems[0] || "Tidak ada data yang bisa diimpor.");

      const existing = new Set((await getDocs(collection(db, "assets"))).docs.map(d => d.id));
      const updates = records.filter(r => existing.has(r.code)).length;

      openModal(
        "Import Aset",
        fieldHTML("", `<div>
          <p><strong>${records.length}</strong> aset siap diimpor (${records.length - updates} baru, ${updates} memperbarui aset dengan kode yang sama).</p>
          ${skipped ? `<p>${skipped} baris dilewati.</p><small>${problems.map(esc).join("<br>")}</small>` : ""}
        </div>`, true),
        "Import Sekarang",
        async () => {
          for (let i = 0; i < records.length; i += 400) {
            const batch = writeBatch(db);
            records.slice(i, i + 400).forEach(r => {
              const ref = doc(db, "assets", r.code);
              if (existing.has(r.code)) {
                const { code, ...rest } = r;
                batch.update(ref, rest);
              } else {
                batch.set(ref, {
                  ...r,
                  createdBy: user.uid,
                  createdByName: profile.name,
                  createdByRole: profile.role,
                  createdAt: serverTimestamp()
                });
              }
            });
            await batch.commit();
          }
          document.dispatchEvent(new CustomEvent("ga:page", { detail: "assets" }));
          if (typeof window.renderAll === "function") window.renderAll();
          return `${records.length} aset diimpor. Muat ulang halaman bila daftar belum berubah.`;
        }
      );
    } catch (error) {
      console.error(error);
      message(error.message || "Import gagal.");
    }
  });
}

/* ======================================================================
   Export Excel untuk semua menu (mengambil tabel yang sedang tampil)
   ====================================================================== */

const EXPORT_PAGES = {
  assets: "Aset",
  repairs: "Perbaikan",
  requests: "Permintaan-Barang",
  "vehicle-requests": "Permintaan-Kendaraan",
  procurement: "Pengadaan",
  canteen: "Pesan-Makan"
};

const cleanCell = text => String(text ?? "").replace(/\s+/g, " ").trim();

function tableToSheet(table, fallbackName) {
  const heads = [...table.querySelectorAll("thead th")].map(th => cleanCell(th.textContent));
  const skip = heads.map(h => /^aksi$/i.test(h));
  const rows = [...table.querySelectorAll("tbody tr")]
    .filter(tr => ![...tr.children].some(td => td.colSpan > 1))
    .map(tr => [...tr.children].filter((_, i) => !skip[i]).map(td => cleanCell(td.textContent)));
  const head = heads.filter((_, i) => !skip[i]);
  const title = cleanCell(table.closest(".panel")?.querySelector("h3")?.textContent) || fallbackName;
  return { name: title, head, rows };
}

async function exportPage(pageId, label, button) {
  const section = $("page-" + pageId);
  if (!section) return;
  button.disabled = true;
  try {
    const tables = [...section.querySelectorAll(".table-wrap table")]
      .filter(t => !t.closest("[hidden]"));
    const used = new Set();
    const sheets = tables.map((t, i) => {
      const s = tableToSheet(t, `${label} ${i + 1}`);
      let name = s.name.replace(/[\\/?*\[\]:]/g, " ").slice(0, 28) || `Data ${i + 1}`;
      while (used.has(name.toLowerCase())) name = `${name.slice(0, 25)} ${i + 1}`;
      used.add(name.toLowerCase());
      return { name, rows: [s.head].concat(s.rows), widths: s.head.map(() => 22), count: s.rows.length };
    });
    if (!sheets.some(s => s.count > 0)) {
      message("Belum ada data untuk diexport.");
      return;
    }
    const { downloadXlsx, stamp } = await excel();
    await downloadXlsx(`${label}-${stamp()}.xlsx`, sheets);
    message("File Excel diunduh.");
  } catch (error) {
    console.error(error);
    message(error.message || "Export gagal.");
  } finally {
    button.disabled = false;
  }
}

function setupExportButtons() {
  for (const [pageId, label] of Object.entries(EXPORT_PAGES)) {
    const heading = $("page-" + pageId)?.querySelector(".page-heading");
    if (!heading || heading.querySelector("[data-export-page]")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.dataset.exportPage = pageId;
    button.innerHTML = '<i class="fa-solid fa-file-export"></i> Export Excel';
    button.addEventListener("click", () => exportPage(pageId, label, button));
    heading.appendChild(button);
  }
}

function refreshExportVisibility() {
  document.querySelectorAll("[data-export-page]").forEach(b => { b.hidden = !isStaff(); });
  if ($("assets-import")) $("assets-import").hidden = !assetCanWrite();
  if ($("assets-template")) $("assets-template").hidden = !assetCanWrite();
}

/* ---------- Pasang ---------- */

const managers = CONFIGS.map(makeManager);
managers.forEach(m => m.build());
setupExportButtons();
setupAssetImport();
refreshExportVisibility();

document.addEventListener("ga:page", event => {
  const m = managers.find(x => x.cfg.page === event.detail);
  if (m) m.load();
  refreshExportVisibility();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
});

await authPersistenceReady;

onAuthStateChanged(auth, async current => {
  const thisGeneration = ++generation;

  user = null;
  profile = null;
  closeModal();
  managers.forEach(m => m.render());
  refreshExportVisibility();

  if (!current) return;

  try {
    await current.reload();
    if (thisGeneration !== generation || !current.emailVerified) return;

    const snapshot = await getDoc(doc(db, "users", current.uid));
    if (thisGeneration !== generation || !snapshot.exists()) return;

    const data = snapshot.data();
    if (data.active !== true) return;

    user = current;
    profile = data;
    refreshExportVisibility();

    const active = document.querySelector(".page.active")?.id || "";
    managers.forEach(m => { if (active === "page-" + m.cfg.page) m.load(); else m.render(); });
  } catch (error) {
    if (thisGeneration !== generation) return;
    console.error("Gagal memuat data induk:", error);
  }
});
