// Perbarui data Inventory dari Excel (khusus Main Admin).
// Kolom yang ADA di Excel menggantikan data lama; kolom yang tidak ada tidak disentuh.
import { auth, db, authPersistenceReady } from "./firebase-init.js";
import {
  collection, doc, getDoc, getDocs, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

(window.__gaModules ||= {}).inventoryUpdate = true;

const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = v => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const text = v => String(v ?? "").replace(/\s+/g, " ").trim();

let profile = null;
let busy = false;

const FIELDS = [
  { key: "code", label: "Kode", aliases: ["kode", "kode barang", "code", "sku", "编码", "编号"] },
  { key: "newCode", label: "Kode Baru", aliases: ["kode baru", "new code", "新编码"] },
  { key: "name", label: "Nama Barang", aliases: ["nama barang", "nama", "name", "品名", "名称"], max: 150 },
  { key: "specification", label: "Spesifikasi", aliases: ["spesifikasi", "specification", "spec", "规格"], max: 200, allowEmpty: false },
  { key: "category", label: "Kategori", aliases: ["kategori", "category", "类别", "分类"], max: 100 },
  { key: "unit", label: "Satuan", aliases: ["satuan", "unit", "单位"], max: 40 },
  { key: "location", label: "Lokasi", aliases: ["lokasi", "location", "仓库", "位置"], max: 150 },
  { key: "minimum", label: "Minimum", aliases: ["minimum", "min", "stok minimum", "最低库存", "安全库存"], number: true },
  { key: "stock", label: "Stok", aliases: ["stok", "stock", "stok aktual", "stok awal", "库存", "数量"], number: true }
];

const message = t => (typeof window.notify === "function" ? window.notify(t) : alert(t));

function parseCount(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : NaN;
  const t = text(value).replace(/[,\s]/g, "");
  return /^\d+(\.0+)?$/.test(t) ? Number(t) : NaN;
}

const cleanCode = raw => text(raw).toUpperCase().replace(/[\s/.\\]+/g, "-").replace(/[^A-Z0-9_-]/g, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");

async function xl() {
  try { return await import("./xlsx-util.js"); }
  catch { throw new Error("File xlsx-util.js belum diunggah ke GitHub."); }
}

function closeModal() { if (!busy) $("invUpdateModal")?.remove(); }

function showModal(html) {
  let modal = $("invUpdateModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "invUpdateModal";
    modal.className = "modal open";
    modal.addEventListener("click", e => { if (e.target === modal || e.target.closest("[data-close]")) closeModal(); });
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="modal-card"><div class="modal-heading"><div><span class="eyebrow">INVENTORY</span><h2>Perbarui dari Excel</h2></div><button type="button" class="icon-button" data-close aria-label="Tutup"><i class="fa-solid fa-xmark"></i></button></div>${html}</div>`;
  return modal;
}

/* ---------- Susun rencana perubahan ---------- */

function plan(sheetRows, items) {
  if (!sheetRows.length) throw new Error("File kosong.");
  const head = sheetRows[0].map(norm);
  const col = {};
  for (const f of FIELDS) {
    const i = head.findIndex(h => f.aliases.includes(h));
    if (i >= 0) col[f.key] = i;
  }
  if (col.code === undefined) throw new Error("Kolom \"Kode\" tidak ditemukan di baris pertama. Kode dipakai untuk mencocokkan barang. Tip: klik Export Excel, edit, lalu import kembali.");
  const editable = FIELDS.filter(f => f.key !== "code" && col[f.key] !== undefined);
  if (!editable.length) throw new Error("Tidak ada kolom yang bisa diperbarui selain Kode.");

  const byCode = new Map(items.map(i => [i.code, i]));
  const changes = [];
  const missing = [];
  const problems = [];
  const seen = new Set();
  let same = 0;

  sheetRows.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    if (!cells || cells.every(c => text(c) === "")) return;
    const code = cleanCode(cells[col.code]);
    if (!code) { problems.push(`Baris ${line}: kode kosong.`); return; }
    if (seen.has(code)) { problems.push(`Baris ${line}: kode ${code} ganda di file.`); return; }
    seen.add(code);
    const item = byCode.get(code);
    if (!item) { missing.push(code); return; }

    const diff = {};
    let bad = "";
    for (const f of editable) {
      const raw = cells[col[f.key]];
      if (text(raw) === "") continue; // sel kosong = jangan diubah
      let v;
      if (f.key === "newCode") {
        v = cleanCode(raw);
        if (!/^[A-Z0-9_-]{2,60}$/.test(v)) { bad = `kode baru "${text(raw)}" tidak valid`; break; }
        if (v === item.code) continue;
        if (byCode.has(v)) { bad = `kode baru ${v} sudah dipakai barang lain`; break; }
        diff.code = v;
        continue;
      }
      if (f.number) {
        v = parseCount(raw);
        if (Number.isNaN(v)) { bad = `${f.label} harus angka bulat ≥ 0`; break; }
      } else {
        v = text(raw);
        if (f.max && v.length > f.max) { bad = `${f.label} melebihi ${f.max} karakter`; break; }
      }
      if (v !== (item[f.key] ?? (f.number ? 0 : ""))) diff[f.key] = v;
    }
    if (bad) { problems.push(`Baris ${line} (${code}): ${bad}.`); return; }
    if (!Object.keys(diff).length) { same++; return; }
    changes.push({ item, diff });
  });

  const newCodes = changes.map(c => c.diff.code).filter(Boolean);
  if (new Set(newCodes).size !== newCodes.length) throw new Error("Ada Kode Baru yang sama dipakai lebih dari satu barang.");

  return { changes, missing, problems, same, columns: editable.map(f => f.label) };
}

/* ---------- Terapkan ---------- */

async function applyAll(changes, progress) {
  const simple = changes.filter(c => !("stock" in c.diff) && !("code" in c.diff));
  const complex = changes.filter(c => ("stock" in c.diff) || ("code" in c.diff));
  const failures = [];
  let done = 0;
  const total = changes.length;

  for (let i = 0; i < simple.length; i += 300) {
    const slice = simple.slice(i, i + 300);
    try {
      const batch = writeBatch(db);
      slice.forEach(c => batch.update(doc(db, "inventory", c.item.id), c.diff));
      await batch.commit();
    } catch (e) {
      console.warn("Batch gagal, ulangi satu per satu", e);
      for (const c of slice) {
        try {
          const b = writeBatch(db);
          b.update(doc(db, "inventory", c.item.id), c.diff);
          await b.commit();
        } catch (err) { failures.push(`${c.item.code}: ${err.message}`); }
      }
    }
    done += slice.length;
    progress(done, total);
  }

  for (const c of complex) {
    try {
      if (typeof window.applyInventoryEdit !== "function") throw new Error("stock-firebase.js belum dimuat.");
      await window.applyInventoryEdit(c.item.id, c.diff, { reason: "Perbarui dari Excel" });
    } catch (err) { failures.push(`${c.item.code}: ${err.message}`); }
    done++;
    progress(done, total);
  }

  try {
    const b = writeBatch(db);
    b.set(doc(collection(db, "inventoryAudit")), {
      itemId: "-", itemCode: "(massal)", itemName: "Perbarui dari Excel",
      action: "import-excel",
      changes: { jumlahBarang: { from: "", to: String(changes.length - failures.length) } },
      reason: "Perbarui dari Excel", requestId: "", requestedBy: "",
      byUid: auth.currentUser.uid, byName: profile.name, createdAt: serverTimestamp()
    });
    await b.commit();
  } catch (e) { console.warn("Audit massal gagal", e); }

  return failures;
}

/* ---------- Alur UI ---------- */

async function onFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || busy) return;
  try {
    const { loadXLSX } = await xl();
    const XLSX = await loadXLSX();
    const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: "", raw: true });
    const snap = await getDocs(collection(db, "inventory"));
    const items = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    const result = plan(rows, items);
    const sample = result.changes.slice(0, 8);

    const modal = showModal(`
      <div class="import-body">
        <p>Kolom yang akan <strong>diganti</strong>: <strong>${result.columns.map(esc).join(", ")}</strong>.<br>Kolom lain tidak disentuh. Sel kosong di Excel tidak mengubah data.</p>
        <p><strong>${result.changes.length}</strong> barang akan diperbarui · ${result.same} tidak berubah · ${result.missing.length} kode tidak ditemukan${result.problems.length ? ` · ${result.problems.length} baris bermasalah` : ""}.</p>
        ${sample.length ? `<div class="table-wrap"><table><thead><tr><th>Kode</th><th>Perubahan</th></tr></thead><tbody>${sample.map(c => `<tr><td>${esc(c.item.code)}</td><td>${Object.entries(c.diff).map(([k, v]) => `${esc(k)}: ${esc(c.item[k] ?? "")} → <strong>${esc(v)}</strong>`).join("<br>")}</td></tr>`).join("")}</tbody></table></div>` : ""}
        ${result.missing.length ? `<small>Kode tidak ditemukan (dilewati): ${result.missing.slice(0, 10).map(esc).join(", ")}${result.missing.length > 10 ? "…" : ""}. Barang baru: pakai Import Excel biasa.</small><br>` : ""}
        ${result.problems.length ? `<small>${result.problems.slice(0, 6).map(esc).join("<br>")}</small>` : ""}
        <div id="invUpdateProgress"></div>
      </div>
      <div class="modal-actions"><button type="button" class="secondary-button" data-close>Batal</button>
      ${result.changes.length ? `<button type="button" class="primary-button" id="invUpdateGo">Terapkan ${result.changes.length} Perubahan</button>` : ""}</div>`);

    $("invUpdateGo")?.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      $("invUpdateGo").disabled = true;
      const prog = (d, t) => { $("invUpdateProgress").innerHTML = `<p>Memproses ${d} / ${t}...</p>`; };
      try {
        const failures = await applyAll(result.changes, prog);
        busy = false;
        showModal(`<div class="import-body"><p><strong>${result.changes.length - failures.length}</strong> barang berhasil diperbarui.${failures.length ? ` ${failures.length} gagal:` : ""}</p>${failures.length ? `<small>${failures.slice(0, 8).map(esc).join("<br>")}</small>` : ""}</div><div class="modal-actions"><button type="button" class="primary-button" data-close>Selesai</button></div>`);
        if (typeof window.refreshFirestoreInventory === "function") window.refreshFirestoreInventory();
        document.dispatchEvent(new Event("ga:data-changed"));
      } catch (err) {
        busy = false;
        console.error(err);
        message(err.message || "Gagal menerapkan perubahan.");
        $("invUpdateGo") && ($("invUpdateGo").disabled = false);
      }
    });
  } catch (error) {
    console.error(error);
    message(error.message || "File tidak bisa dibaca.");
  }
}

function ensureButton() {
  const page = $("page-inventory");
  const heading = page?.querySelector(".page-heading");
  if (!heading) return;
  let button = $("updateInventoryBtn");
  if (!button) {
    const file = document.createElement("input");
    file.type = "file"; file.accept = ".xlsx,.xls,.csv"; file.hidden = true; file.id = "updateInventoryFile";
    file.addEventListener("change", onFile);
    button = document.createElement("button");
    button.id = "updateInventoryBtn";
    button.type = "button";
    button.className = "secondary-button";
    button.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Perbarui dari Excel';
    button.addEventListener("click", () => file.click());
    heading.append(button, file);
  }
  button.hidden = !(profile && profile.role === "main_admin");
}

ensureButton();
await authPersistenceReady;
onAuthStateChanged(auth, async current => {
  profile = null;
  ensureButton();
  if (!current) return;
  try {
    const snap = await getDoc(doc(db, "users", current.uid));
    if (snap.exists() && snap.data().active === true) { profile = snap.data(); ensureButton(); }
  } catch (e) { console.error(e); }
});
