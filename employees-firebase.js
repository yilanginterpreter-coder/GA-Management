import { auth, db, authPersistenceReady } from "./firebase-init.js";
import { hasPerm } from "./perms.js";
import { loadXLSX, downloadXlsx, stamp } from "./xlsx-util.js";

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

const $ = id => document.getElementById(id);

const COLLECTION = "employeeMaster";
const PAGE_SIZE = 200;
const STATUSES = ["Tetap", "Kontrak"];

// key, label, lebar kolom Excel, nama kolom yang dikenali saat import
const FIELDS = [
  ["name", "Nama", 28, ["nama", "name", "nama karyawan", "姓名"]],
  ["idCardNo", "No ID Card", 16, ["no id card", "id card", "idcard", "no id", "nik", "no karyawan", "工号"]],
  ["position", "Jabatan", 22, ["jabatan", "position", "posisi", "职位"]],
  ["department", "Departemen", 20, ["departemen", "department", "bagian", "部门"]],
  ["workLocation", "Lokasi Kerja", 22, ["lokasi kerja", "lokasi", "location", "work location", "工作地点"]],
  ["blockNo", "No Blok", 10, ["no blok", "blok", "block"]],
  ["jobDetail", "Detail Pekerjaan", 40, ["detail pekerjaan", "detail", "deskripsi pekerjaan", "job detail", "工作内容"]],
  ["team", "Tim", 16, ["tim", "team", "班组"]],
  ["supervisor", "Atasan", 22, ["atasan", "supervisor", "上级"]],
  ["employmentStatus", "Status Karyawan", 16, ["status karyawan", "status", "status kerja", "合同类型"]]
];

const LIMITS = {
  name: 100, idCardNo: 30, position: 100, department: 100, workLocation: 80,
  blockNo: 20, jobDetail: 300, team: 80, supervisor: 100
};

let user = null;
let profile = null;
let rows = [];
let shown = PAGE_SIZE;
let loaded = false;
let busy = false;
let generation = 0;

const canManage = () => !!profile && hasPerm(profile, "employees");
const isMain = () => profile?.role === "main_admin";

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
    return "Rules menolak tindakan ini. Pastikan firestore.rules terbaru sudah dipublikasikan dan akun punya akses Master Karyawan.";
  }
  return error?.message || "Terjadi kesalahan.";
}

/* ---------- Normalisasi ---------- */

function normStatus(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return "";
  if (["tetap", "permanent", "pkwtt", "正式", "正式工"].includes(v)) return "Tetap";
  if (["kontrak", "contract", "pkwt", "合同", "合同工"].includes(v)) return "Kontrak";
  return "";
}

function cleanRecord(input) {
  const out = {};
  for (const [key] of FIELDS) {
    out[key] = String(input[key] ?? "").trim();
  }
  out.employmentStatus = normStatus(out.employmentStatus) || (STATUSES.includes(out.employmentStatus) ? out.employmentStatus : "");
  return out;
}

function validate(rec) {
  if (!rec.name) return "Nama wajib diisi.";
  if (!/^[A-Za-z0-9._-]{1,30}$/.test(rec.idCardNo)) {
    return "No ID Card wajib diisi (maks 30: huruf, angka, titik, garis bawah, strip).";
  }
  for (const [key, max] of Object.entries(LIMITS)) {
    if (rec[key].length > max) return `${FIELDS.find(f => f[0] === key)[1]} maksimal ${max} karakter.`;
  }
  return "";
}

/* ---------- Modal ---------- */

function closeModal() {
  $("employeeModal")?.remove();
}

function openModal(title, bodyHTML, submitLabel, onSubmit) {
  closeModal();
  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "employeeModal";
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-heading">
        <div><span class="eyebrow">MASTER KARYAWAN</span><h2>${esc(title)}</h2></div>
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
      await load();
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

const field = (label, control, full = false) =>
  `<div class="field ${full ? "full" : ""}"><label>${esc(label)}</label>${control}</div>`;

function formHTML(rec = {}, editing = false) {
  const v = key => esc(rec[key] || "");
  return (
    field("Nama *", `<input name="name" maxlength="100" required value="${v("name")}">`, true) +
    field("No ID Card *", `<input name="idCardNo" maxlength="30" required ${editing ? "readonly" : ""} value="${v("idCardNo")}">`) +
    field("Status Karyawan", `<select name="employmentStatus"><option value="">-</option>${STATUSES.map(s => `<option ${rec.employmentStatus === s ? "selected" : ""}>${s}</option>`).join("")}</select>`) +
    field("Jabatan", `<input name="position" maxlength="100" value="${v("position")}">`) +
    field("Departemen", `<input name="department" maxlength="100" value="${v("department")}">`) +
    field("Lokasi Kerja", `<input name="workLocation" maxlength="80" value="${v("workLocation")}">`) +
    field("No Blok", `<input name="blockNo" maxlength="20" value="${v("blockNo")}">`) +
    field("Tim", `<input name="team" maxlength="80" value="${v("team")}">`) +
    field("Atasan", `<input name="supervisor" maxlength="100" value="${v("supervisor")}">`) +
    field("Detail Pekerjaan", `<textarea name="jobDetail" maxlength="300">${v("jobDetail")}</textarea>`, true)
  );
}

/* ---------- Data ---------- */

function toDoc(rec) {
  return {
    ...rec,
    updatedBy: user.uid,
    updatedByName: profile.name,
    updatedAt: serverTimestamp()
  };
}

async function saveRecord(data, editing) {
  const rec = cleanRecord(data);
  const problem = validate(rec);
  if (problem) throw new Error(problem);

  if (!editing) {
    const existing = await getDoc(doc(db, COLLECTION, rec.idCardNo));
    if (existing.exists()) throw new Error(`No ID Card ${rec.idCardNo} sudah terdaftar.`);
  }

  await setDoc(doc(db, COLLECTION, rec.idCardNo), toDoc(rec));
  return editing ? "Data karyawan diperbarui." : "Karyawan ditambahkan.";
}

async function load() {
  if (!user || !profile || !canManage()) return;
  const current = generation;
  try {
    const snap = await getDocs(collection(db, COLLECTION));
    if (current !== generation) return;
    rows = snap.docs.map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "id"));
    loaded = true;
  } catch (error) {
    if (current !== generation) return;
    console.error(error);
    message("Gagal memuat Master Karyawan. Periksa izin akses dan firestore.rules.");
  }
  render();
}

/* ---------- Tampilan ---------- */

function filtered() {
  const term = ($("employeeSearch")?.value || "").trim().toLocaleLowerCase("id-ID");
  const status = $("employeeStatusFilter")?.value || "";
  const location = $("employeeLocationFilter")?.value || "";

  return rows.filter(r => {
    if (status && r.employmentStatus !== status) return false;
    if (location && r.workLocation !== location) return false;
    if (!term) return true;
    return FIELDS.map(([key]) => r[key]).join(" ").toLocaleLowerCase("id-ID").includes(term);
  });
}

function renderLocationFilter() {
  const select = $("employeeLocationFilter");
  if (!select) return;
  const current = select.value;
  const locations = [...new Set(rows.map(r => r.workLocation).filter(Boolean))].sort((a, b) => a.localeCompare(b, "id"));
  select.innerHTML = `<option value="">Semua lokasi</option>${locations.map(l => `<option ${l === current ? "selected" : ""}>${esc(l)}</option>`).join("")}`;
}

function render() {
  const body = $("employeeTable");
  if (!body) return;

  renderLocationFilter();

  const list = filtered();
  const visible = list.slice(0, shown);

  if ($("employeeSummary")) {
    const tetap = rows.filter(r => r.employmentStatus === "Tetap").length;
    const kontrak = rows.filter(r => r.employmentStatus === "Kontrak").length;
    $("employeeSummary").textContent =
      `${rows.length} karyawan · ${tetap} tetap · ${kontrak} kontrak · menampilkan ${visible.length} dari ${list.length} hasil`;
  }

  body.innerHTML = visible.length
    ? visible.map(r => `
      <tr>
        <td data-label="Nama"><strong>${esc(r.name)}</strong></td>
        <td data-label="No ID Card">${esc(r.idCardNo || r.id)}</td>
        <td data-label="Jabatan">${esc(r.position || "-")}</td>
        <td data-label="Departemen">${esc(r.department || "-")}</td>
        <td data-label="Lokasi Kerja">${esc(r.workLocation || "-")}${r.blockNo ? ` <small>(Blok ${esc(r.blockNo)})</small>` : ""}</td>
        <td data-label="Detail Pekerjaan">${esc(r.jobDetail || "-")}</td>
        <td data-label="Tim">${esc(r.team || "-")}</td>
        <td data-label="Atasan">${esc(r.supervisor || "-")}</td>
        <td data-label="Status"><span class="status-badge ${r.employmentStatus === "Kontrak" ? "warning" : r.employmentStatus ? "" : "neutral"}">${esc(r.employmentStatus || "-")}</span></td>
        <td data-label="Aksi"><div class="row-actions">
          <button type="button" class="small-action" data-emp-edit="${esc(r.id)}">Edit</button>
          ${isMain() ? `<button type="button" class="small-action delete" data-emp-del="${esc(r.id)}">Hapus</button>` : ""}
        </div></td>
      </tr>`).join("")
    : `<tr><td colspan="10" class="empty-cell">${loaded ? "Belum ada data karyawan. Tambah manual atau Import Excel." : "Memuat data karyawan..."}</td></tr>`;

  const more = $("employeeMore");
  if (more) more.hidden = list.length <= shown;
}

/* ---------- Tindakan ---------- */

function openAdd() {
  openModal("Tambah Karyawan", formHTML({}, false), "Simpan", data => saveRecord(data, false));
}

function openEdit(id) {
  const rec = rows.find(r => r.id === id);
  if (!rec) return message("Data tidak ditemukan.");
  openModal("Edit Karyawan", formHTML(rec, true), "Simpan Perubahan", data => saveRecord({ ...data, idCardNo: rec.id }, true));
}

function askDelete(id) {
  const rec = rows.find(r => r.id === id);
  if (!rec) return;
  openModal(
    "Hapus Karyawan",
    field("", `<div>Hapus <strong>${esc(rec.name)}</strong> (${esc(rec.id)}) dari Master Karyawan? Tindakan ini tidak dapat dibatalkan.</div>`, true),
    "Hapus",
    async () => {
      await deleteDoc(doc(db, COLLECTION, id));
      return "Data karyawan dihapus.";
    }
  );
}

$("employeeTable")?.addEventListener("click", event => {
  const edit = event.target.closest("[data-emp-edit]");
  const del = event.target.closest("[data-emp-del]");
  if (edit) openEdit(edit.dataset.empEdit);
  else if (del) askDelete(del.dataset.empDel);
});

$("addEmployeeButton")?.addEventListener("click", openAdd);
$("employeeMore")?.addEventListener("click", () => { shown += PAGE_SIZE; render(); });

for (const id of ["employeeSearch", "employeeStatusFilter", "employeeLocationFilter"]) {
  $(id)?.addEventListener(id === "employeeSearch" ? "input" : "change", () => { shown = PAGE_SIZE; render(); });
}

/* ---------- Export & Import Excel ---------- */

function headerRow() {
  return FIELDS.map(f => f[1]);
}

$("exportEmployeesButton")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await downloadXlsx(`Master-Karyawan-${stamp()}.xlsx`, [{
      name: "Master Karyawan",
      widths: FIELDS.map(f => f[2]),
      rows: [headerRow()].concat(rows.map(r => FIELDS.map(([key]) => r[key] || "")))
    }]);
    message("File Excel diunduh.");
  } catch (error) {
    console.error(error);
    message(error.message || "Export gagal.");
  } finally {
    button.disabled = false;
  }
});

$("templateEmployeesButton")?.addEventListener("click", async () => {
  try {
    await downloadXlsx("Template-Master-Karyawan.xlsx", [{
      name: "Master Karyawan",
      widths: FIELDS.map(f => f[2]),
      rows: [headerRow(), ["Budi Santoso", "EIEB-0001", "Operator", "Produksi", "Pabrik 1", "B-12", "Mengoperasikan mesin line 2", "Tim A", "Pak Hendra", "Tetap"]]
    }]);
  } catch (error) {
    message(error.message || "Gagal membuat template.");
  }
});

$("importEmployeesButton")?.addEventListener("click", () => $("importEmployeesFile")?.click());

const norm = v => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function mapRows(sheetRows) {
  if (!sheetRows.length) return { records: [], skipped: 0, problems: [] };

  const header = sheetRows[0].map(norm);
  const columns = new Map();
  for (const [key, , , aliases] of FIELDS) {
    const index = header.findIndex(h => aliases.includes(h));
    if (index >= 0) columns.set(key, index);
  }
  if (!columns.has("name") || !columns.has("idCardNo")) {
    throw new Error("Kolom 'Nama' dan 'No ID Card' tidak ditemukan di baris pertama.");
  }

  const records = [];
  const problems = [];
  const seen = new Set();
  let skipped = 0;

  sheetRows.slice(1).forEach((cells, i) => {
    if (!cells || cells.every(c => String(c ?? "").trim() === "")) return;
    const raw = {};
    for (const [key, index] of columns) raw[key] = cells[index];
    const rec = cleanRecord(raw);
    const problem = validate(rec);
    if (problem) { skipped++; if (problems.length < 5) problems.push(`Baris ${i + 2}: ${problem}`); return; }
    if (seen.has(rec.idCardNo)) { skipped++; if (problems.length < 5) problems.push(`Baris ${i + 2}: ID Card ganda di file.`); return; }
    seen.add(rec.idCardNo);
    records.push(rec);
  });

  return { records, skipped, problems };
}

$("importEmployeesFile")?.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || busy) return;

  try {
    const XLSX = await loadXLSX();
    const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = book.Sheets[book.SheetNames[0]];
    const sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    const { records, skipped, problems } = mapRows(sheetRows);

    if (!records.length) throw new Error(problems[0] || "Tidak ada data yang bisa diimpor.");

    const existing = new Set(rows.map(r => r.id));
    const updates = records.filter(r => existing.has(r.idCardNo)).length;

    openModal(
      "Import Master Karyawan",
      field("", `<div>
        <p><strong>${records.length}</strong> karyawan siap diimpor (${records.length - updates} baru, ${updates} memperbarui data yang sudah ada).</p>
        ${skipped ? `<p>${skipped} baris dilewati.</p><small>${problems.map(esc).join("<br>")}</small>` : ""}
      </div>`, true),
      "Import Sekarang",
      async () => {
        for (let i = 0; i < records.length; i += 400) {
          const batch = writeBatch(db);
          records.slice(i, i + 400).forEach(r => batch.set(doc(db, COLLECTION, r.idCardNo), toDoc(r)));
          await batch.commit();
        }
        return `${records.length} karyawan diimpor.`;
      }
    );
  } catch (error) {
    console.error(error);
    message(error.message || "Import gagal.");
  }
});

/* ---------- Siklus halaman ---------- */

document.addEventListener("ga:page", event => {
  if (event.detail === "employees") load();
});

await authPersistenceReady;

onAuthStateChanged(auth, async current => {
  const thisGeneration = ++generation;

  user = null;
  profile = null;
  rows = [];
  loaded = false;
  closeModal();
  render();

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

    if (document.querySelector(".page.active")?.id === "page-employees") load();
  } catch (error) {
    if (thisGeneration !== generation) return;
    console.error("Gagal memuat Master Karyawan:", error);
  }
});
