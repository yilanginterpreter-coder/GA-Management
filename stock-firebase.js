import { auth, db, authPersistenceReady } from "./firebase-init.js";

import {
  doc,
  getDoc,
  collection,
  getDocs,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

const $ = id => document.getElementById(id);

let inventory = [];
let transactions = [];
let busy = false;
let ready = false;
let activeRole = null;
let inventorySearchTerm = "";
let authGeneration = 0;

const canWrite = () =>
  ["main_admin", "ga_admin"].includes(activeRole);

const html = value =>
  String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

const localDate = () => {
  const d = new Date();

  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
};

function message(text) {
  if (typeof window.notify === "function") {
    window.notify(text);
  } else {
    alert(text);
  }
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function hideOldInventoryUI() {
  // Sembunyikan tombol Tambah Barang sistem lama
  document
    .querySelectorAll("#page-inventory button")
    .forEach(button => {
      const action = button.getAttribute("onclick") || "";

      if (/^\s*openForm\(['"]inventory['"]/.test(action)) {
        button.hidden = true;
        button.style.display = "none";
      }
    });

  const localTable = $("inventoryTable")?.closest("article");

  if (localTable) {
    localTable.querySelector("table")?.setAttribute("hidden", "");

    const toolbar = localTable.querySelector(".toolbar");

    if (toolbar) {
      toolbar.querySelector("#inventorySearch")
        ?.setAttribute("hidden", "");

      const transactionButton = [
        ...toolbar.querySelectorAll("button")
      ].find(b =>
        b.getAttribute("onclick")?.includes("'transaction'")
      );

      if (transactionButton) {
        transactionButton.hidden = !canWrite();
      }
    }
  }

  const localHistory = $("transactionTable")?.closest("article");
  if (localHistory) localHistory.hidden = true;

  const oldAddButton = [
    ...document.querySelectorAll(
      "#page-inventory .page-heading button"
    )
  ].find(b =>
    b.getAttribute("onclick")?.includes("'inventory'")
  );

  if (oldAddButton) oldAddButton.hidden = true;

  const firebaseTitle = $("firestoreInventoryTable")
    ?.closest("article")
    ?.querySelector("h3");

  if (firebaseTitle) {
    firebaseTitle.textContent = "Daftar Barang";
  }

  const firebaseDescription = $("firestoreInventoryTable")
    ?.closest("article")
    ?.querySelector(".panel-heading p");

  if (firebaseDescription) {
    firebaseDescription.textContent =
      "Pantau ketersediaan barang dan kelola stok secara terpusat.";
  }
}

function ensureAddButton() {
  const page = $("page-inventory");
  if (!page) return;

  let button = $("addFirebaseInventoryBtn");

  if (!button) {
button = document.createElement("button");
button.id = "addFirebaseInventoryBtn";
button.type = "button";
button.className = "primary-button";
button.innerHTML = '<i class="fa-solid fa-plus"></i> Tambah Barang';
button.addEventListener("click", openInventoryForm);

    const heading = page.querySelector(".page-heading");

    
if (heading) {
  heading.appendChild(button);
} else {
  page.prepend(button);
}
  }

  button.hidden = !ready || !canWrite();

  let trxButton = $("firebaseStockTransactionBtn");
  if (!trxButton) {
    trxButton = document.createElement("button");
    trxButton.id = "firebaseStockTransactionBtn";
    trxButton.type = "button";
    trxButton.className = "secondary-button";
    trxButton.innerHTML = '<i class="fa-solid fa-arrow-right-arrow-left"></i> Transaksi Stok';
    trxButton.addEventListener("click", openTransactionForm);
    const heading = page.querySelector(".page-heading");
    if (heading) heading.appendChild(trxButton);
  }
  if (trxButton) trxButton.hidden = !ready || !canWrite();
}
function ensureInventorySearch() {
  const table = $("firestoreInventoryTable");
  const article = table?.closest("article");

  if (!article) return;

  let search = $("firebaseInventorySearch");

  if (!search) {
    search = document.createElement("input");
    search.id = "firebaseInventorySearch";
    search.type = "search";
    search.placeholder = "Cari kode, nama, kategori, lokasi...";
    search.setAttribute("aria-label", "Cari barang");
    search.style.cssText =
      "width:100%;max-width:380px;padding:11px 14px;" +
      "margin:14px 0;border:1px solid #d9e2df;" +
      "border-radius:10px;font:inherit;";

    const tableWrap = table.closest(".table-wrap");

    if (tableWrap) {
      tableWrap.before(search);
    } else {
      table.before(search);
    }

    search.addEventListener("input", event => {
      inventorySearchTerm = event.target.value
        .trim()
        .toLocaleLowerCase("id-ID");

      draw();
    });
  }
}
function draw() {
  hideOldInventoryUI();
ensureAddButton();
ensureInventorySearch();

  if (!ready) return;

  const low = inventory.filter(
    i => Number(i.stock) <= Number(i.minimum)
  );

  const totalStock = inventory.reduce(
    (n, i) => n + (Number(i.stock) || 0), 0
  );

  for (const id of [
    "totalItems", "inventoryCount", "reportItems"
  ]) {
    setText(id, inventory.length);
  }

  for (const id of ["stockUnits", "reportStock"]) {
    setText(id, totalStock);
  }

  for (const id of ["lowStock", "inventoryLow"]) {
    setText(id, low.length);
  }

  setText("reportTransactions", transactions.length);
const filteredInventory = inventory.filter(item => {
  const searchable = [
    item.code,
    item.name,
    item.category,
    item.location,
    item.unit
  ].join(" ").toLocaleLowerCase("id-ID");

  return searchable.includes(inventorySearchTerm);
});
  const inventoryTable = $("firestoreInventoryTable");

  if (inventoryTable) {
   inventoryTable.innerHTML = filteredInventory.length
  ? filteredInventory.map(i => `
          <tr>
            <td>${i.photoData ? `<button type="button" class="inventory-photo-open" data-item-id="${html(i.id)}" aria-label="Lihat foto ${html(i.name)}"><img class="inventory-photo-thumb" src="${html(i.photoData)}" alt="Foto ${html(i.name)}"></button>` : "—"}</td>
            ${[
              "code", "name", "specification", "category", "stock",
              "minimum", "unit", "location"
            ].map(k =>
              `<td>${html(k === "specification" ? (i[k] || "-") : (i[k] ?? "-"))}</td>`
            ).join("")}
            <td>
              ${canWrite()
                ? `<button type="button"
                    class="btn btn-sm edit-firebase-item"
                    data-item-id="${html(i.id)}">
                    Edit
                   </button>`
                : "-"}
            </td>
          </tr>
        `).join("")
      : `<tr>
          <td colspan="10" class="empty-cell">
           Tidak ada barang yang cocok dengan pencarian.
          </td>
        </tr>`;
  }

  const historyTable = $("firestoreTransactionTable");
  if (historyTable) {
    historyTable.innerHTML = transactions.length
      ? transactions.map(t => `
          <tr>
            <td>${html(t.date || "-")}</td>
            <td>${html(t.code || t.itemId || "-")}</td>
            <td>${html(t.name || "-")}</td>
            <td>${html(t.type || "-")}</td>
            <td>${html(t.quantity ?? "-")}</td>
            <td>${html(t.stockBefore ?? "-")}</td>
            <td>${html(t.stockAfter ?? "-")}</td>
            <td>${html(t.note || "-")}</td>
            <td>${html(t.createdByName || "-")}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="9" class="empty-cell">Belum ada transaksi operasional.</td></tr>`;
  }

  const dashboard = $("dashboardStock");

  if (dashboard) {
    dashboard.innerHTML = low.length
      ? low.slice(0, 8).map(i => `
          <tr>
            <td>${html(i.name)}</td>
            <td>${html(i.category)}</td>
            <td>${html(i.stock)} ${html(i.unit)}</td>
            <td>${html(i.minimum)}</td>
            <td>
              ${Number(i.stock) === 0
                ? "Habis"
                : "Stok Menipis"}
            </td>
          </tr>
        `).join("")
      : `<tr>
          <td colspan="5" class="empty-cell">
            Tidak ada stok menipis.
          </td>
        </tr>`;
  }

  const activity = $("recentActivity");

  if (activity) {
    activity.innerHTML = transactions.length
      ? transactions.slice(0, 8).map(t => `
          <div class="activity-row">
            <span class="activity-dot"></span>
            <div>
              <p>
                ${html(t.type)}:
                ${html(t.name || t.code || t.itemId)}
                (${html(t.quantity)})
              </p>
              <small>${html(t.date)}</small>
            </div>
          </div>
        `).join("")
      : `<div class="empty-state">
          <p>Belum ada transaksi.</p>
        </div>`;
  }
}

async function refresh() {
  const generation = authGeneration;
  const uid = auth.currentUser?.uid;

  const [items, records] = await Promise.all([
    getDocs(collection(db, "inventory")),
    getDocs(collection(db, "transactions"))
  ]);

  if (
    generation !== authGeneration ||
    auth.currentUser?.uid !== uid
  ) {
    return;
  }

  inventory = items.docs.map(d => ({
    ...d.data(),
    id: d.id
  }));

  transactions = records.docs
    .map(d => ({ ...d.data(), id: d.id }))
    .filter(t => t.testOnly !== true);

  transactions.sort(
    (a, b) =>
      (b.createdAt?.seconds || 0) -
      (a.createdAt?.seconds || 0)
  );

  ready = true;
  draw();
}

// Foto disimpan sebagai JPEG kecil dalam dokumen Firestore (tanpa Storage).
// Batas sengaja ketat agar tetap jauh di bawah batas dokumen Firestore 1 MiB.
const MAX_PHOTO_BYTES = 90 * 1024;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const PHOTO_DIMENSION = 640;

function photoField(current = "") {
  return `
    <div class="field full inventory-photo-field">
      <label for="inventoryPhotoInput">Foto Barang (opsional)</label>
      <input id="inventoryPhotoInput" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="inventoryPhotoHelp">
      <small id="inventoryPhotoHelp">JPG, PNG, atau WebP maksimal 10 MB; otomatis dikompresi menjadi JPEG kecil (maks. 90 KB).</small>
      <img id="inventoryPhotoPreview" class="inventory-photo-preview" alt="Pratinjau foto barang" ${current ? `src="${html(current)}"` : 'hidden'}>
      <label class="inventory-photo-remove" ${current ? '' : 'hidden'}><input id="inventoryPhotoRemove" type="checkbox"> Hapus foto yang tersimpan</label>
    </div>`;
}

function preparePhotoInput() {
  const input = $("inventoryPhotoInput");
  const preview = $("inventoryPhotoPreview");
  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressPhoto(file);
      input.dataset.compressedPhoto = dataUrl;
      preview.src = dataUrl;
      preview.hidden = false;
      const remove = $("inventoryPhotoRemove");
      if (remove) remove.checked = false;
    } catch (error) {
      input.value = "";
      delete input.dataset.compressedPhoto;
      message(error.message || "Foto tidak dapat diproses.");
    }
  });
}

async function compressPhoto(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Pilih gambar JPG, PNG, atau WebP.");
  }
  if (file.size > MAX_SOURCE_BYTES) throw new Error("Foto awal maksimal 10 MB.");
  const objectUrl = URL.createObjectURL(file);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    let dimension = PHOTO_DIMENSION;
    for (let attempt = 0; attempt < 7; attempt++) {
      const scale = Math.min(1, dimension / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Browser tidak dapat memproses gambar.");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.76, 0.60, 0.44, 0.30]) {
        const encoded = canvas.toDataURL("image/jpeg", quality);
        if (Math.ceil(encoded.length * 0.75) <= MAX_PHOTO_BYTES) return encoded;
      }
      dimension = Math.floor(dimension * 0.75);
    }
    throw new Error("Foto terlalu kompleks untuk batas ukuran; coba gambar lain.");
  } finally {
    bitmap?.close?.();
    URL.revokeObjectURL(objectUrl);
  }
}

async function selectedPhotoData(form) {
  const input = form.querySelector("#inventoryPhotoInput");
  const remove = form.querySelector("#inventoryPhotoRemove");
  if (input?.files?.length) {
    // Tunggu pemrosesan bila pengguna menekan Simpan terlalu cepat.
    return { photoData: await compressPhoto(input.files[0]) };
  }
  if (remove?.checked) return { photoData: "" };
  return {};
}

function openModal(title, fieldsHTML, mode) {
  const fields = $("formFields");
  const form = $("dataForm");
  const modal = $("dataModal");

  if (!fields || !form || !modal) {
    message("Form tidak ditemukan.");
    return;
  }

  form.reset();
  form.dataset.firebaseMode = mode;

  // Hapus penanda lama agar tidak bentrok.
  form.dataset.firebaseTransaction = "";

  const modalTitle = $("modalTitle");
  if (modalTitle) modalTitle.textContent = title;

  fields.innerHTML = fieldsHTML;
  modal.classList.add("open");
}
function openEditInventoryForm(itemId) {
  if (!auth.currentUser || !canWrite()) {
    return message("Akun ini tidak memiliki izin edit barang.");
  }

  const item = inventory.find(i => i.id === itemId);

  if (!item) {
    return message("Barang tidak ditemukan.");
  }

  openModal(
    "Edit Barang",
    `
      <div class="field">
        <label>Kode Barang</label>
        <input value="${html(item.code)}" disabled>
      </div>

      <div class="field">
        <label>Nama Barang *</label>
        <input name="name" required maxlength="150"
          value="${html(item.name)}">
      </div>

      <div class="field">
        <label>Kategori *</label>
        <input name="category" required maxlength="100"
          value="${html(item.category)}">
      </div>

      <div class="field">
        <label>Satuan *</label>
        <input name="unit" required maxlength="40"
          value="${html(item.unit)}">
      </div>

      <div class="field">
        <label>Minimum Stok *</label>
        <input name="minimum" type="number"
          min="0" step="1" required
          value="${html(item.minimum)}">
      </div>

      <div class="field">
        <label>Lokasi *</label>
        <input name="location" required maxlength="150"
          value="${html(item.location)}">
      </div>

      <div class="field full">
        <label>Spesifikasi</label>
        <input name="specification" maxlength="200"
          placeholder="Contoh: Putih, 5 liter  /  Ukuran L, lengan panjang"
          value="${html(item.specification || "")}">
      </div>

      ${photoField(item.photoData || "")}
      <div class="field full">
        <p>Kode barang dan stok tidak dapat diedit langsung.</p>
      </div>
    `,
    "editInventory"
  );

  $("dataForm").dataset.editItemId = itemId;
  preparePhotoInput();
}

async function saveEditInventory(itemId, data) {
  await getAuthorizedProfile();

  const name = String(data.name || "").trim();
  const category = String(data.category || "").trim();
  const unit = String(data.unit || "").trim();
  const specification = String(data.specification || "").trim();

  if (specification.length > 200) {
    throw new Error("Spesifikasi maksimal 200 karakter.");
  }
  const storageLocation = String(data.location || "").trim();
  const rawMinimum = String(data.minimum ?? "").trim();
  const minimum = Number(rawMinimum);

  for (const [label, value, max] of [
    ["Nama barang", name, 150],
    ["Kategori", category, 100],
    ["Satuan", unit, 40],
    ["Lokasi", storageLocation, 150]
  ]) {
    if (!value || value.length > max) {
      throw new Error(`${label} wajib diisi, maksimal ${max} karakter.`);
    }
  }

  if (
    !/^\d+$/.test(rawMinimum) ||
    !Number.isSafeInteger(minimum)
  ) {
    throw new Error("Minimum stok harus bilangan bulat 0 atau lebih.");
  }

  const itemRef = doc(db, "inventory", itemId);

  await runTransaction(db, async tx => {
    const snapshot = await tx.get(itemRef);

    if (!snapshot.exists()) {
      throw new Error("Barang tidak ditemukan.");
    }

    tx.update(itemRef, {
      name,
      category,
      unit,
      location: storageLocation,
      minimum,
      specification,
      ...(data.photoData !== undefined ? { photoData: data.photoData } : {})
    });
  });
}
function openInventoryForm() {
  if (!auth.currentUser || !canWrite()) {
    message("Akun ini tidak memiliki izin tambah barang.");
    return;
  }

  if (!ready) {
    message("Data belum selesai dimuat.");
    return;
  }

  openModal(
    "Tambah Barang",
    `
      <div class="field">
        <label>Kode Barang *</label>
        <input
          name="code"
          required
          maxlength="60"
          placeholder="ATK-001"
          pattern="[A-Za-z0-9_-]{2,60}"
        >
      </div>

      <div class="field">
        <label>Nama Barang *</label>
        <input
          name="name"
          required
          maxlength="150"
          placeholder="Pulpen Hitam"
        >
      </div>

      <div class="field">
        <label>Kategori *</label>
        <input
          name="category"
          required
          maxlength="100"
          placeholder="ATK"
        >
      </div>

      <div class="field">
        <label>Satuan *</label>
        <input
          name="unit"
          required
          maxlength="40"
          placeholder="pcs"
        >
      </div>

      <div class="field">
        <label>Minimum Stok *</label>
        <input
          name="minimum"
          type="number"
          min="0"
          step="1"
          value="10"
          required
        >
      </div>

      <div class="field">
        <label>Lokasi *</label>
        <input
          name="location"
          required
          maxlength="150"
          placeholder="Gudang GA"
        >
      </div>

      <div class="field full">
        <label>Spesifikasi</label>
        <input name="specification" maxlength="200"
          placeholder="Contoh: Putih, 5 liter  /  Ukuran L, lengan panjang"
          value="">
      </div>

      ${photoField()}
      <div class="field full">
        <p>
          Stok awal otomatis 0.
          Isi stok menggunakan Transaksi Masuk.
        </p>
      </div>
    `,
    "inventory"
  );
  preparePhotoInput();
}

// Pencarian barang dengan mengetik (menggantikan daftar pilihan panjang).
function setupItemPicker() {
  const search = $("trxItemSearch");
  const hidden = $("trxItemId");
  const results = $("trxItemResults");
  const selected = $("trxItemSelected");

  if (!search || !hidden || !results || !selected) return;

  const MAX_RESULTS = 8;
  let matches = [];
  let active = 0;

  const label = item => `${item.code} — ${item.name}`;

  function findMatches(term) {
    const words = term
      .toLocaleLowerCase("id-ID")
      .split(/\s+/)
      .filter(Boolean);

    if (!words.length) return [];

    return inventory.filter(item => {
      const haystack = [
        item.code, item.name, item.specification, item.category, item.location
      ].join(" ").toLocaleLowerCase("id-ID");

      return words.every(word => haystack.includes(word));
    });
  }

  function render() {
    const term = search.value.trim();

    if (!term) {
      matches = [];
      results.innerHTML =
        `<p class="item-hint">Ketik untuk mencari di ${html(inventory.length)} barang.</p>`;
      return;
    }

    const all = findMatches(term);
    matches = all.slice(0, MAX_RESULTS);
    active = Math.min(active, Math.max(matches.length - 1, 0));

    if (!matches.length) {
      results.innerHTML = `<p class="item-hint">Tidak ada barang yang cocok.</p>`;
      return;
    }

    results.innerHTML =
      matches.map((item, index) => `
        <button type="button" role="option"
          class="item-result ${index === active ? "active" : ""}"
          data-index="${index}">
          <strong>${html(item.code)}</strong> ${html(item.name)}
          <small>${item.specification ? html(item.specification) + " · " : ""}stok: ${html(item.stock)} ${html(item.unit)}</small>
        </button>`).join("") +
      (all.length > matches.length
        ? `<p class="item-hint">dan ${all.length - matches.length} barang lain — ketik lebih spesifik.</p>`
        : "");
  }

  function choose(item) {
    hidden.value = item.id;
    search.value = label(item);
    search.setCustomValidity("");
    results.innerHTML = "";
    selected.hidden = false;
    selected.textContent =
      `Dipilih: ${label(item)} (stok: ${item.stock} ${item.unit})`;
  }

  function clearChoice() {
    hidden.value = "";
    selected.hidden = true;
    selected.textContent = "";
    search.setCustomValidity("Pilih salah satu barang dari daftar.");
  }

  clearChoice();
  render();

  search.addEventListener("input", () => {
    clearChoice();
    active = 0;
    render();
  });

  search.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!matches.length) return;
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      render();
      results.querySelector(".item-result.active")?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && !hidden.value) {
      // Enter memilih hasil teratas, bukan mengirim formulir.
      event.preventDefault();
      if (matches.length) choose(matches[active] || matches[0]);
    }
  });

  results.addEventListener("click", event => {
    const button = event.target.closest(".item-result");
    if (!button) return;
    const item = matches[Number(button.dataset.index)];
    if (item) {
      choose(item);
      $("dataForm")?.querySelector('[name="type"]')?.focus();
    }
  });

  search.focus();
}

function openTransactionForm() {
  if (!auth.currentUser || !canWrite()) {
    message("Akun ini tidak memiliki izin transaksi stok.");
    return;
  }

  if (!ready) {
    message("Data belum selesai dimuat.");
    return;
  }

  if (!inventory.length) {
    message("Belum ada barang di Inventory.");
    return;
  }

  openModal(
    "Transaksi Stok",
    `
      <div class="field full item-picker">
        <label for="trxItemSearch">Cari Barang *</label>
        <input id="trxItemSearch" type="search" autocomplete="off"
          placeholder="Ketik kode, nama, atau spesifikasi barang...">
        <input type="hidden" name="itemId" id="trxItemId">
        <div id="trxItemSelected" class="item-selected" hidden></div>
        <div id="trxItemResults" class="item-results" role="listbox"></div>
      </div>

      <div class="field">
        <label>Jenis Transaksi *</label>
        <select name="type" required>
          <option value="">Pilih jenis</option>
          <option value="Masuk">Masuk</option>
          <option value="Keluar">Keluar</option>
        </select>
      </div>

      <div class="field">
        <label>Jumlah *</label>
        <input
          name="quantity"
          type="number"
          min="1"
          step="1"
          required
        >
      </div>

      <div class="field">
        <label>Tanggal *</label>
        <input
          name="date"
          type="date"
          value="${localDate()}"
          required
        >
      </div>

      <div class="field full">
        <label>Catatan</label>
        <input
          name="note"
          type="text"
          maxlength="500"
          placeholder="Nomor dokumen / tujuan"
        >
      </div>
    `,
    "transaction"
  );

  setupItemPicker();
}

async function getAuthorizedProfile() {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Silakan login kembali.");
  }

  const snapshot = await getDoc(
    doc(db, "users", user.uid)
  );

  if (!snapshot.exists()) {
    throw new Error("Profil pengguna tidak ditemukan.");
  }

  const profile = snapshot.data();

  if (
    profile.active !== true ||
    !["main_admin", "ga_admin"].includes(profile.role)
  ) {
    throw new Error("Akun tidak memiliki izin.");
  }

  return { user, profile };
}

async function saveInventory(data) {
  const { user, profile } = await getAuthorizedProfile();

  const code = String(data.code || "").trim().toUpperCase();
  const name = String(data.name || "").trim();
  const category = String(data.category || "").trim();
  const unit = String(data.unit || "").trim();
  const specification = String(data.specification || "").trim();

  if (specification.length > 200) {
    throw new Error("Spesifikasi maksimal 200 karakter.");
  }
  const storageLocation = String(data.location || "").trim();

  const rawMinimum = String(data.minimum ?? "").trim();
  const minimum = Number(rawMinimum);

  if (!/^[A-Z0-9_-]{2,60}$/.test(code)) {
    throw new Error(
      "Kode harus 2–60 karakter: huruf, angka, _ atau -."
    );
  }

  for (const [label, value, max] of [
    ["Nama barang", name, 150],
    ["Kategori", category, 100],
    ["Satuan", unit, 40],
    ["Lokasi", storageLocation, 150]
  ]) {
    if (!value || value.length > max) {
      throw new Error(`${label} wajib diisi, maksimal ${max} karakter.`);
    }
  }

  if (
    !/^\d+$/.test(rawMinimum) ||
    !Number.isSafeInteger(minimum)
  ) {
    throw new Error(
      "Minimum stok harus bilangan bulat 0 atau lebih."
    );
  }

  const itemRef = doc(db, "inventory", code);

  await runTransaction(db, async tx => {
    const existing = await tx.get(itemRef);

    if (existing.exists()) {
      throw new Error(
        `Kode ${code} sudah digunakan. Gunakan kode lain.`
      );
    }

    tx.set(itemRef, {
      code,
      name,
      category,
      unit,
      location: storageLocation,
      minimum,
      specification,
      stock: 0,
      photoData: data.photoData || "",
      createdBy: user.uid,
      createdByName: profile.name,
      createdByRole: profile.role,
      createdAt: serverTimestamp()
    });
  });
}

async function saveStockTransaction(data) {
  const { user, profile } = await getAuthorizedProfile();

  const quantity = Number(data.quantity);

  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0
  ) {
    throw new Error("Jumlah harus bilangan bulat positif.");
  }

  if (!["Masuk", "Keluar"].includes(data.type)) {
    throw new Error("Jenis transaksi tidak valid.");
  }

  if (
    typeof data.itemId !== "string" ||
    !data.itemId
  ) {
    throw new Error("Pilih barang yang valid.");
  }

  if (
    typeof data.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
    Number.isNaN(
      new Date(`${data.date}T00:00:00`).getTime()
    )
  ) {
    throw new Error("Tanggal tidak valid.");
  }

  const note = String(data.note || "").trim();

  if (note.length > 500) {
    throw new Error("Catatan terlalu panjang.");
  }

  const itemRef = doc(db, "inventory", data.itemId);
  const trxRef = doc(collection(db, "transactions"));

  await runTransaction(db, async tx => {
    const snap = await tx.get(itemRef);

    if (!snap.exists()) {
      throw new Error("Barang tidak ditemukan.");
    }

    const item = snap.data();

    if (
      !Number.isSafeInteger(item.stock) ||
      item.stock < 0
    ) {
      throw new Error("Stok tidak valid.");
    }

    if (
      typeof item.code !== "string" ||
      typeof item.name !== "string"
    ) {
      throw new Error(
        "Identitas barang tidak lengkap."
      );
    }

    const newStock =
      item.stock +
      (data.type === "Masuk" ? quantity : -quantity);

    if (
      !Number.isSafeInteger(newStock) ||
      newStock < 0
    ) {
      throw new Error(
        "Stok tidak mencukupi atau hasil stok tidak valid."
      );
    }

    tx.update(itemRef, {
      stock: newStock,
      lastTransactionId: trxRef.id,
      lastStockBefore: item.stock
    });

    tx.set(trxRef, {
      itemId: data.itemId,
      code: item.code,
      name: item.name,
      type: data.type,
      quantity,
      stockBefore: item.stock,
      stockAfter: newStock,
      date: data.date,
      note,
      createdBy: user.uid,
      createdByName: profile.name,
      createdByRole: profile.role,
      createdAt: serverTimestamp(),
      testOnly: false
    });
  });
}
document.addEventListener("click", event => {
  const photoButton = event.target.closest(".inventory-photo-open");
  if (photoButton) {
    const item = inventory.find(i => i.id === photoButton.dataset.itemId);
    if (!item?.photoData) return;
    const overlay = document.createElement("div");
    overlay.className = "inventory-photo-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", `Foto ${item.name}`);
    overlay.innerHTML = `<button type="button" class="inventory-photo-close" aria-label="Tutup foto">×</button><img src="${html(item.photoData)}" alt="Foto ${html(item.name)}">`;
    overlay.addEventListener("click", e => { if (e.target === overlay || e.target.closest(".inventory-photo-close")) overlay.remove(); });
    document.body.appendChild(overlay);
    overlay.querySelector("button")?.focus();
    return;
  }
  const button = event.target.closest(".edit-firebase-item");
  if (!button) return;

  openEditInventoryForm(button.dataset.itemId);
});
// Tangkap tombol lama sebelum fungsi localStorage berjalan.
document.addEventListener("click", event => {
  const trigger = event.target.closest("[onclick]");
  if (!trigger) return;

  const action = trigger.getAttribute("onclick") || "";

  if (/^\s*openForm\(['"]transaction['"]\)/.test(action)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    openTransactionForm();

  } else if (/^\s*openForm\(['"]inventory['"]/.test(action)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    openInventoryForm();

  } else if (/^\s*deleteRecord\(['"]inventory['"]/.test(action)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    message("Penghapusan barang tidak diizinkan.");
  }
}, true);

// Satu handler untuk kedua formulir Firebase.
$("dataForm")?.addEventListener("submit", async event => {
  const form = event.currentTarget;
  const mode = form.dataset.firebaseMode;

 if (!["inventory", "transaction", "editInventory"].includes(mode)) {
  return;
}

  event.preventDefault();
  event.stopImmediatePropagation();

  if (busy) return;

  busy = true;

  const submit = form.querySelector(
    'button[type="submit"]'
  );

  if (submit) submit.disabled = true;

  try {
    const data = Object.fromEntries(new FormData(form));

    if (mode === "inventory") {
  Object.assign(data, await selectedPhotoData(form));
  await saveInventory(data);
} else if (mode === "editInventory") {
  Object.assign(data, await selectedPhotoData(form));
  await saveEditInventory(form.dataset.editItemId, data);
} else {
  await saveStockTransaction(data);
}

    form.dataset.firebaseMode = "";
    form.dataset.firebaseTransaction = "";

    if (typeof window.closeForm === "function") {
      window.closeForm();
    } else {
      $("dataModal")?.classList.remove("open");
    }

    message(
     mode === "inventory"
  ? "Barang berhasil ditambahkan."
  : mode === "editInventory"
    ? "Data barang berhasil diperbarui."
    : "Transaksi berhasil disimpan."
    );

    await refresh();

  } catch (error) {
    console.error("Gagal menyimpan data:", error);

    message(
      error.code === "permission-denied"
        ? "Rules menolak penyimpanan. Periksa izin create inventory atau role akun."
        : (error.message || "Penyimpanan gagal.")
    );

  } finally {
    busy = false;
    if (submit) submit.disabled = false;
  }
}, true);

// Dipakai modul import Excel untuk memuat ulang daftar barang.
window.refreshFirestoreInventory = () =>
  refresh().catch(error => console.error("Gagal memuat ulang stok:", error));

// Pertahankan sinkronisasi dengan dashboard lama.
const legacyRender = window.renderAll;

if (typeof legacyRender === "function") {
  window.renderAll = function (...args) {
    const result = legacyRender.apply(this, args);
    draw();
    return result;
  };
}

// Bersihkan mode ketika modal ditutup.
const oldClose = window.closeForm;

if (typeof oldClose === "function") {
  window.closeForm = function (...args) {
    const form = $("dataForm");

    if (form) {
      form.dataset.firebaseMode = "";
      form.dataset.firebaseTransaction = "";
    }

    return oldClose.apply(this, args);
  };
}

await authPersistenceReady;

onAuthStateChanged(auth, async user => {
  const generation = ++authGeneration;

  ready = false;
  inventory = [];
  transactions = [];
  activeRole = null;

  draw();

  if (!user) return;

  try {
    await user.reload();

    if (generation !== authGeneration) return;
    if (!user.emailVerified) return;

    const profile = await getDoc(
      doc(db, "users", user.uid)
    );

    if (generation !== authGeneration) return;

    if (
      !profile.exists() ||
      profile.data().active !== true
    ) {
      return;
    }

    activeRole = profile.data().role;

    // Karyawan tidak membaca transaksi stok; modul ini hanya untuk staf GA.
    if (!["main_admin", "ga_admin", "admin_operational"].includes(activeRole)) {
      return;
    }

    await refresh();

  } catch (error) {
    if (generation !== authGeneration) return;

    console.error(
      "Gagal memuat data stok:",
      error
    );

    message(
      "Gagal memuat stok . Periksa koneksi dan izin akses."
    );
  }
});
