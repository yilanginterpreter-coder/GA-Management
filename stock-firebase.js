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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  const localTable = $("inventoryTable")?.closest("article");

  if (localTable) {
    localTable.querySelector("table")?.setAttribute("hidden", "");

    const toolbar = localTable.querySelector(".toolbar");

    if (toolbar) {
      toolbar.querySelector("#inventorySearch")?.setAttribute("hidden", "");

      const transactionButton = [...toolbar.querySelectorAll("button")]
        .find(b => b.getAttribute("onclick")?.includes("'transaction'"));

      if (transactionButton) {
        transactionButton.hidden = !canWrite();
      }
    }
  }

  const localHistory = $("transactionTable")?.closest("article");
  if (localHistory) localHistory.hidden = true;

  const addButton = [
    ...document.querySelectorAll("#page-inventory .page-heading button")
  ].find(b => b.getAttribute("onclick")?.includes("'inventory'"));

  if (addButton) addButton.hidden = true;

  const firebaseTitle = $("firestoreInventoryTable")
    ?.closest("article")
    ?.querySelector("h3");

  if (firebaseTitle) {
    firebaseTitle.textContent = "Inventory Firebase (Data Utama)";
  }

  const firebaseDescription = $("firestoreInventoryTable")
    ?.closest("article")
    ?.querySelector(".panel-heading p");

  if (firebaseDescription) {
    firebaseDescription.textContent =
      "Stok tersimpan di Firestore. Perubahan stok hanya melalui transaksi yang sah.";
  }

  const trxTitle = $("firestoreTransactionTable")
    ?.closest(".table-wrap")
    ?.previousElementSibling;

  if (trxTitle?.tagName === "H3") {
    trxTitle.textContent = "Riwayat Transaksi Firebase";
  }
}

function draw() {
  if (!ready) return;

  hideOldInventoryUI();

  const low = inventory.filter(
    i => Number(i.stock) <= Number(i.minimum)
  );

  const totalStock = inventory.reduce(
    (n, i) => n + (Number(i.stock) || 0), 0
  );

  for (const id of ["totalItems", "inventoryCount", "reportItems"]) {
    setText(id, inventory.length);
  }

  for (const id of ["stockUnits", "reportStock"]) {
    setText(id, totalStock);
  }

  for (const id of ["lowStock", "inventoryLow"]) {
    setText(id, low.length);
  }

  setText("reportTransactions", transactions.length);

  const inventoryTable = $("firestoreInventoryTable");

  if (inventoryTable) {
    inventoryTable.innerHTML = inventory.length
      ? inventory.map(i =>
          `<tr>${[
            "code", "name", "category", "stock",
            "minimum", "unit", "location"
          ].map(k => `<td>${html(i[k] ?? "-")}</td>`).join("")}</tr>`
        ).join("")
      : '<tr><td colspan="7" class="empty-cell">Belum ada barang Firebase.</td></tr>';
  }

  const historyTable = $("firestoreTransactionTable");

  if (historyTable) {
    historyTable.innerHTML = transactions.length
      ? transactions.map(t =>
          `<tr>${[
            t.date,
            t.code || t.itemId,
            t.type,
            t.quantity,
            t.note
          ].map(v => `<td>${html(v ?? "-")}</td>`).join("")}</tr>`
        ).join("")
      : '<tr><td colspan="5" class="empty-cell">Belum ada transaksi operasional.</td></tr>';
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
            <td>${Number(i.stock) === 0 ? "Habis" : "Stok Menipis"}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="5" class="empty-cell">Tidak ada stok menipis.</td></tr>';
  }

  const activity = $("recentActivity");

  if (activity) {
    activity.innerHTML = transactions.length
      ? transactions.slice(0, 8).map(t => `
          <div class="activity-row">
            <span class="activity-dot"></span>
            <div>
              <p>${html(t.type)}: ${html(t.name || t.code || t.itemId)} (${html(t.quantity)})</p>
              <small>${html(t.date)}</small>
            </div>
          </div>
        `).join("")
      : '<div class="empty-state"><p>Belum ada transaksi operasional Firebase.</p></div>';
  }
}

async function refresh() {
  const [items, records] = await Promise.all([
    getDocs(collection(db, "inventory")),
    getDocs(collection(db, "transactions"))
  ]);

  inventory = items.docs.map(d => ({
    ...d.data(),
    id: d.id
  }));

  transactions = records.docs
    .map(d => ({ ...d.data(), id: d.id }))
    .filter(t => t.testOnly === false);

  transactions.sort(
    (a, b) =>
      (b.createdAt?.seconds || 0) -
      (a.createdAt?.seconds || 0)
  );

  ready = true;
  draw();
}

function openTransactionForm() {
  if (!auth.currentUser || !canWrite()) {
    return message("Akun ini tidak memiliki izin transaksi stok.");
  }

  if (!ready) {
    return message("Data Firebase belum selesai dimuat.");
  }

  if (!inventory.length) {
    return message("Belum ada barang di Inventory Firebase.");
  }

  const fields = $("formFields");
  const form = $("dataForm");

  if (!fields || !form) {
    return message("Form transaksi tidak ditemukan.");
  }

  form.reset();

  $("modalTitle").textContent = "Transaksi Stok Firebase";

  fields.innerHTML = `
    <div class="field">
      <label>Pilih Barang *</label>
      <select name="itemId" required>
        <option value="">Pilih barang</option>
        ${inventory.map(i => `
          <option value="${html(i.id)}">
            ${html(i.code)} — ${html(i.name)}
            (stok: ${html(i.stock)} ${html(i.unit)})
          </option>
        `).join("")}
      </select>
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
      <input name="quantity" type="number" min="1" step="1" required>
    </div>

    <div class="field">
      <label>Tanggal *</label>
      <input name="date" type="date" value="${localDate()}" required>
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
  `;

  $("dataModal").classList.add("open");
  form.dataset.firebaseTransaction = "true";
}

async function saveTransaction(data) {
  const user = auth.currentUser;

  if (!user || !canWrite()) {
    throw new Error("Tidak memiliki izin transaksi stok.");
  }

  const profileSnapshot = await getDoc(
    doc(db, "users", user.uid)
  );

  if (!profileSnapshot.exists()) {
    throw new Error("Profil pengguna tidak ditemukan.");
  }

  const profile = profileSnapshot.data();

  if (
    profile.active !== true ||
    !["main_admin", "ga_admin"].includes(profile.role)
  ) {
    throw new Error("Akun tidak diizinkan melakukan transaksi.");
  }

  const quantity = Number(data.quantity);

  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("Jumlah harus bilangan bulat positif.");
  }

  if (!["Masuk", "Keluar"].includes(data.type)) {
    throw new Error("Jenis transaksi tidak valid.");
  }

  if (typeof data.itemId !== "string" || !data.itemId) {
    throw new Error("Pilih barang yang valid.");
  }

  if (
    typeof data.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
    Number.isNaN(new Date(`${data.date}T00:00:00`).getTime())
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
      throw new Error("Barang tidak ditemukan di Firebase.");
    }

    const item = snap.data();

    if (!Number.isSafeInteger(item.stock) || item.stock < 0) {
      throw new Error("Stok Firebase tidak valid.");
    }

    if (
      typeof item.code !== "string" ||
      typeof item.name !== "string"
    ) {
      throw new Error("Identitas barang Firebase tidak lengkap.");
    }

    const newStock =
      item.stock + (data.type === "Masuk" ? quantity : -quantity);

    if (!Number.isSafeInteger(newStock) || newStock < 0) {
      throw new Error("Stok tidak mencukupi atau hasil stok tidak valid.");
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

// Menangkap klik sebelum fungsi lama dijalankan.
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
    message("Penambahan/edit barang Firebase belum diaktifkan.");
  } else if (/^\s*deleteRecord\(['"]inventory['"]/.test(action)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    message("Penghapusan barang Firebase tidak diizinkan.");
  }
}, true);

// Mencegah fungsi lama menyimpan transaksi ke localStorage.
$("dataForm")?.addEventListener("submit", async event => {
  if (event.currentTarget.dataset.firebaseTransaction !== "true") {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  if (busy) return;

  busy = true;

  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');

  if (submit) submit.disabled = true;

  try {
    await saveTransaction(
      Object.fromEntries(new FormData(form))
    );

    form.dataset.firebaseTransaction = "";

    if (typeof window.closeForm === "function") {
      window.closeForm();
    }

    message("Transaksi Firebase berhasil disimpan.");
    await refresh();

  } catch (error) {
    console.error("Gagal menyimpan transaksi Firebase:", error);

    message(
      error.code === "permission-denied"
        ? "Firebase Rules produksi masih menolak transaksi. Jangan ubah Rules sebelum pengujian."
        : (error.message || "Transaksi gagal disimpan.")
    );

  } finally {
    busy = false;
    if (submit) submit.disabled = false;
  }
}, true);

// Menjaga dashboard tetap sinkron saat tampilan lama dirender.
const legacyRender = window.renderAll;

if (typeof legacyRender === "function") {
  window.renderAll = function (...args) {
    const result = legacyRender.apply(this, args);
    draw();
    return result;
  };
}

// Menghapus penanda transaksi ketika modal ditutup.
const oldClose = window.closeForm;

if (typeof oldClose === "function") {
  window.closeForm = function (...args) {
    if ($("dataForm")) {
      $("dataForm").dataset.firebaseTransaction = "";
    }

    return oldClose.apply(this, args);
  };
}

await authPersistenceReady;

onAuthStateChanged(auth, async user => {
  ready = false;
  inventory = [];
  transactions = [];
  activeRole = null;

  if (!user) return;

  try {
    await user.reload();

    if (!user.emailVerified) return;

    const profile = await getDoc(
      doc(db, "users", user.uid)
    );

    if (
      !profile.exists() ||
      profile.data().active !== true
    ) {
      return;
    }

    activeRole = profile.data().role;

    await refresh();

  } catch (error) {
    console.error("Gagal memuat data stok Firebase:", error);

    message(
      "Gagal memuat stok Firebase. Periksa koneksi dan izin akses."
    );
  }
});

