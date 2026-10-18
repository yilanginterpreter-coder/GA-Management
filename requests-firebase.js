import { auth, db, authPersistenceReady } from "./firebase-init.js";
import { hasPerm } from "./perms.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  runTransaction,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

const $ = id => document.getElementById(id);

const MANAGER_ROLES = ["main_admin", "ga_admin"];
const STAFF_ROLES = ["main_admin", "ga_admin", "admin_operational"];
const VALID_ROLES = [...STAFF_ROLES, "employee"];
const SLOT_PATTERN = /^\d{2}:\d{2} - \d{2}:\d{2}$/;
const MAX_SLOTS = 3;

let user = null;
let profile = null;
let requests = [];
let items = [];
let itemsLoadedAt = 0;
let slots = [];
let statusFilter = "";
let catalogTerm = "";
let busy = false;
let generation = 0;

const isStaff = () => !!profile && STAFF_ROLES.includes(profile.role);
const canManage = () =>
  !!profile && MANAGER_ROLES.includes(profile.role) && hasPerm(profile, "requests");
// Serah-terima mengurangi stok, jadi butuh hak Stok juga.
const canHandover = () => canManage() && hasPerm(profile, "inventory");

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

function errorText(error) {
  if (error?.code === "permission-denied") {
    return "Rules menolak tindakan ini. Periksa role akun, jadwal penyerahan, atau status permintaan.";
  }
  return error?.message || "Terjadi kesalahan.";
}

function localDate() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
}

function newTicket() {
  const d = new Date();
  const ymd =
    String(d.getFullYear()).slice(2) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = Array.from(
    crypto.getRandomValues(new Uint8Array(6)),
    b => chars[b % chars.length]
  ).join("");
  return `REQ-${ymd}-${random}`;
}

function formatDate(timestamp) {
  const date = timestamp?.toDate?.();
  return date
    ? date.toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      })
    : "-";
}

function formatDay(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      });
}

function scheduleText(r) {
  if (r.handoverDate && r.handoverSlot) {
    return `${formatDay(r.handoverDate)} · ${r.handoverSlot}`;
  }
  return r.deliveryLocation || "-";
}

function badge(status) {
  const cls = {
    Menunggu: "warning",
    Disetujui: "",
    Diserahkan: "",
    Ditolak: "danger",
    Dibatalkan: "neutral"
  }[status] ?? "neutral";
  return `<span class="status-badge ${cls}">${esc(status || "-")}</span>`;
}

const safePhoto = item =>
  typeof item?.photoData === "string" &&
  item.photoData.startsWith("data:image/jpeg;base64,");

/* ---------- Modal ---------- */

function closeModal() {
  $("requestModal")?.remove();
}

function field(label, control, full = true) {
  return `<div class="field ${full ? "full" : ""}"><label>${esc(label)}</label>${control}</div>`;
}

function openModal(title, bodyHTML, submitLabel, onSubmit) {
  closeModal();

  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "requestModal";
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-heading">
        <div>
          <span class="eyebrow">GA MANAGEMENT</span>
          <h2>${esc(title)}</h2>
        </div>
        <button type="button" class="icon-button" data-close aria-label="Tutup">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <form>
        <div class="form-fields">${bodyHTML}</div>
        <div class="modal-actions">
          <button type="button" class="secondary-button" data-close>
            ${onSubmit ? "Batal" : "Tutup"}
          </button>
          ${onSubmit
            ? `<button type="submit" class="primary-button">${esc(submitLabel)}</button>`
            : ""}
        </div>
      </form>
    </div>`;

  modal.addEventListener("click", event => {
    if (event.target === modal || event.target.closest("[data-close]")) {
      closeModal();
    }
  });

  modal.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!onSubmit || busy) return;

    busy = true;
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;

    try {
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const result = await onSubmit(data);
      closeModal();
      message(result || "Berhasil disimpan.");
      document.dispatchEvent(new Event("ga:data-changed"));
      await Promise.all([load(), loadItems(true)]);
    } catch (error) {
      console.error("Permintaan gagal:", error);
      message(errorText(error));
      if (submit) submit.disabled = false;
    } finally {
      busy = false;
    }
  });

  document.body.appendChild(modal);
  modal.querySelector("input, select, textarea, .primary-button")?.focus();
}

/* ---------- Tab ---------- */

function setTab(name) {
  const catalog = name === "catalog";

  const catalogView = $("catalogView");
  const requestsView = $("requestsView");
  if (catalogView) catalogView.hidden = !catalog;
  if (requestsView) requestsView.hidden = catalog;

  const tabCatalog = $("tabCatalog");
  const tabRequests = $("tabRequests");
  if (tabCatalog) {
    tabCatalog.className = catalog ? "primary-button" : "secondary-button";
  }
  if (tabRequests) {
    tabRequests.className = catalog ? "secondary-button" : "primary-button";
  }

  // Muat ulang stok bila katalog dibuka lagi setelah beberapa saat.
  if (catalog && user && Date.now() - itemsLoadedAt > 30000) {
    loadItems(true);
  }
}

/* ---------- Katalog ---------- */

function cardHTML(item) {
  const stock = Number(item.stock) || 0;
  const minimum = Number(item.minimum) || 0;
  const out = stock <= 0;
  const stockClass = out ? "out" : stock <= minimum ? "low" : "";
  const stockText = out
    ? "Stok habis"
    : `Stok: ${stock} ${item.unit || ""}${stock <= minimum ? " (menipis)" : ""}`;

  const photo = safePhoto(item)
    ? `<img src="${esc(item.photoData)}" alt="Foto ${esc(item.name)}" loading="lazy">`
    : `<i class="fa-solid fa-box"></i>`;

  return `
    <button type="button" class="catalog-card" data-item-id="${esc(item.id)}" ${out ? "disabled" : ""}>
      <span class="catalog-photo">${photo}</span>
      <span class="catalog-name">${esc(item.name)}</span>
      ${item.specification ? `<span class="catalog-spec">${esc(item.specification)}</span>` : ""}
      <span class="catalog-meta">${esc(item.code)} · ${esc(item.category)}</span>
      <span class="catalog-stock ${stockClass}">${esc(stockText)}</span>
    </button>`;
}

function renderCatalog() {
  const grid = $("catalogGrid");
  if (!grid) return;

  const term = catalogTerm.trim().toLocaleLowerCase("id-ID");

  const list = items.filter(item =>
    [item.code, item.name, item.specification, item.category]
      .join(" ")
      .toLocaleLowerCase("id-ID")
      .includes(term)
  );

  grid.innerHTML = list.length
    ? list.map(cardHTML).join("")
    : `<p class="catalog-empty">${
        profile
          ? (items.length ? "Barang tidak ditemukan." : "Belum ada barang.")
          : "Silakan login."
      }</p>`;

  const count = $("catalogCount");
  if (count) {
    count.textContent = profile ? `${list.length} barang` : "";
  }
}

async function loadItems(force = false) {
  if (!user || !profile) return;
  if (!force && items.length) return;

  const current = generation;

  try {
    const snapshot = await getDocs(collection(db, "inventory"));
    if (current !== generation) return;

    items = snapshot.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "id"));

    itemsLoadedAt = Date.now();
    renderCatalog();
  } catch (error) {
    if (current !== generation) return;
    console.error("Gagal memuat katalog:", error);
    message("Katalog barang tidak dapat dimuat.");
  }
}

/* ---------- Jadwal penyerahan ---------- */

async function loadSlots() {
  try {
    const snapshot = await getDoc(doc(db, "settings", "handoverSlots"));

    slots = snapshot.exists() && Array.isArray(snapshot.data().slots)
      ? snapshot.data().slots.filter(
          s => typeof s === "string" && SLOT_PATTERN.test(s)
        )
      : [];
  } catch (error) {
    console.error("Gagal memuat jadwal penyerahan:", error);
    slots = [];
  }

  fillSlotInputs();
}

function slotInput(kind, index) {
  return document.querySelector(`[data-slot-${kind}="${index}"]`);
}

function fillSlotInputs() {
  const panel = $("handoverSettingsPanel");
  if (panel) panel.hidden = !canManage();

  for (let i = 0; i < MAX_SLOTS; i++) {
    const [start = "", end = ""] = (slots[i] || "").split(" - ");
    const startInput = slotInput("start", i);
    const endInput = slotInput("end", i);
    if (startInput) startInput.value = start;
    if (endInput) endInput.value = end;
  }
}

async function saveSlots() {
  if (!canManage() || busy) return;

  const result = [];

  for (let i = 0; i < MAX_SLOTS; i++) {
    const start = slotInput("start", i)?.value || "";
    const end = slotInput("end", i)?.value || "";

    if (!start && !end) continue;

    if (!start || !end) {
      return message(`Pilihan ${i + 1}: isi jam mulai dan jam selesai.`);
    }
    if (end <= start) {
      return message(`Pilihan ${i + 1}: jam selesai harus setelah jam mulai.`);
    }

    const label = `${start} - ${end}`;
    if (result.includes(label)) {
      return message(`Pilihan ${i + 1} sama dengan pilihan lain.`);
    }
    result.push(label);
  }

  if (!result.length) {
    return message("Isi minimal satu pilihan jam penyerahan.");
  }

  busy = true;
  const button = $("saveSlotsButton");
  if (button) button.disabled = true;

  try {
    await setDoc(doc(db, "settings", "handoverSlots"), {
      slots: result,
      updatedBy: user.uid,
      updatedByName: profile.name,
      updatedAt: serverTimestamp()
    });

    slots = result;
    message("Jadwal penyerahan barang disimpan.");
  } catch (error) {
    console.error("Gagal menyimpan jadwal:", error);
    message(errorText(error));
  } finally {
    busy = false;
    if (button) button.disabled = false;
  }
}

/* ---------- Tabel permintaan ---------- */

function rowHTML(r) {
  const actions = [
    `<button type="button" class="small-action" data-action="detail" data-id="${esc(r.id)}">Detail</button>`
  ];

  if (canManage() && r.status === "Menunggu") {
    actions.push(
      `<button type="button" class="small-action" data-action="approve" data-id="${esc(r.id)}">Setujui</button>`,
      `<button type="button" class="small-action delete" data-action="reject" data-id="${esc(r.id)}">Tolak</button>`
    );
  }

  if (canHandover() && r.status === "Disetujui") {
    actions.push(
      `<button type="button" class="small-action" data-action="handover" data-id="${esc(r.id)}">Serahkan</button>`
    );
  }

  if (r.requesterUid === user?.uid && r.status === "Menunggu") {
    actions.push(
      `<button type="button" class="small-action delete" data-action="cancel" data-id="${esc(r.id)}">Batalkan</button>`
    );
  }

  return `
    <tr>
      <td>${esc(r.ticketNo || r.id)}</td>
      <td>${formatDate(r.createdAt)}</td>
      <td>${esc(r.requesterName)}${r.department ? ` <small>(${esc(r.department)})</small>` : ""}</td>
      <td>${esc(r.itemCode)} — ${esc(r.itemName)}</td>
      <td>${esc(r.quantity)} ${esc(r.unit)}</td>
      <td>${esc(scheduleText(r))}</td>
      <td>${badge(r.status)}</td>
      <td><div class="row-actions">${actions.join("")}</div></td>
    </tr>`;
}

function updatePending() {
  if (!isStaff()) return;
  const el = $("pendingRequests");
  if (el) {
    el.textContent = String(
      requests.filter(r => r.status === "Menunggu").length
    );
  }
}

function render() {
  const subtitle = $("requestSubtitle");
  if (subtitle) {
    subtitle.textContent = isStaff()
      ? "Cari barang di katalog, lalu verifikasi, setujui, dan serahkan permintaan karyawan."
      : "Cari barang di katalog, pilih jam penyerahan, dan pantau statusnya.";
  }

  const body = $("firebaseRequestTable");
  if (body) {
    const rows = requests.filter(
      r => !statusFilter || r.status === statusFilter
    );

    body.innerHTML = rows.length
      ? rows.map(rowHTML).join("")
      : `<tr><td colspan="8" class="empty-cell">${
          profile ? "Belum ada permintaan." : "Silakan login."
        }</td></tr>`;
  }

  renderCatalog();
  updatePending();
}

async function load() {
  if (!user || !profile) return;
  const current = generation;
  const uid = user.uid;

  try {
    const source = isStaff()
      ? collection(db, "serviceRequests")
      : query(
          collection(db, "serviceRequests"),
          where("requesterUid", "==", uid)
        );

    const snapshot = await getDocs(source);
    if (current !== generation) return;

    requests = snapshot.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort(
        (a, b) =>
          (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)
      );

    render();
  } catch (error) {
    if (current !== generation) return;
    console.error("Gagal memuat permintaan:", error);
    message("Gagal memuat permintaan. Periksa koneksi dan izin akses.");
  }
}

/* ---------- Tindakan ---------- */

async function createRequest(item, data) {
  const stock = Number(item.stock) || 0;
  const quantity = Number(data.quantity);

  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("Jumlah harus bilangan bulat lebih dari nol.");
  }
  if (quantity > stock) {
    throw new Error(`Jumlah melebihi stok tersedia (${stock} ${item.unit}).`);
  }

  const reason = String(data.reason || "").trim();
  if (!reason || reason.length > 500) {
    throw new Error("Alasan wajib diisi, maksimal 500 karakter.");
  }

  const handoverDate = String(data.handoverDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(handoverDate) || handoverDate < localDate()) {
    throw new Error("Tanggal penyerahan tidak boleh sebelum hari ini.");
  }

  const handoverSlot = String(data.handoverSlot || "");
  if (!slots.includes(handoverSlot)) {
    throw new Error("Pilih salah satu jam penyerahan yang tersedia.");
  }

  const ticket = newTicket();

  await setDoc(doc(db, "serviceRequests", ticket), {
    ticketNo: ticket,
    type: "barang",
    requesterUid: user.uid,
    requesterName: profile.name,
    department: profile.department || "",
    itemId: item.id,
    itemCode: item.code,
    itemName: item.name,
    unit: item.unit,
    quantity,
    reason,
    handoverDate,
    handoverSlot,
    status: "Menunggu",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  setTab("requests");
  return `Permintaan ${ticket} berhasil diajukan.`;
}

async function reviewRequest(id, decision, note) {
  const text = String(note || "").trim();

  if (text.length > 500) throw new Error("Catatan maksimal 500 karakter.");
  if (decision === "Ditolak" && !text) {
    throw new Error("Alasan penolakan wajib diisi.");
  }

  await updateDoc(doc(db, "serviceRequests", id), {
    status: decision,
    statusNote: text,
    reviewedBy: user.uid,
    reviewedByName: profile.name,
    reviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return decision === "Disetujui"
    ? "Permintaan disetujui."
    : "Permintaan ditolak.";
}

async function cancelRequest(id, note) {
  const text = String(note || "").trim();

  if (!text || text.length > 500) {
    throw new Error("Alasan pembatalan wajib diisi, maksimal 500 karakter.");
  }

  await updateDoc(doc(db, "serviceRequests", id), {
    status: "Dibatalkan",
    statusNote: text,
    updatedAt: serverTimestamp()
  });

  return "Permintaan dibatalkan.";
}

// Stok baru berkurang di sini, dalam satu transaksi atomik:
// stok barang, riwayat transaksi, dan status permintaan berubah bersama.
async function handoverRequest(id) {
  const requestRef = doc(db, "serviceRequests", id);
  const trxRef = doc(collection(db, "transactions"));

  await runTransaction(db, async tx => {
    const requestSnap = await tx.get(requestRef);
    if (!requestSnap.exists()) throw new Error("Permintaan tidak ditemukan.");

    const req = requestSnap.data();
    if (req.status !== "Disetujui") {
      throw new Error("Hanya permintaan yang sudah disetujui yang dapat diserahkan.");
    }

    const itemRef = doc(db, "inventory", req.itemId);
    const itemSnap = await tx.get(itemRef);
    if (!itemSnap.exists()) throw new Error("Barang tidak ditemukan.");

    const item = itemSnap.data();

    if (!Number.isSafeInteger(item.stock) || item.stock < 0) {
      throw new Error("Data stok tidak valid.");
    }

    const newStock = item.stock - req.quantity;
    if (newStock < 0) {
      throw new Error(
        `Stok tidak mencukupi. Tersedia ${item.stock} ${item.unit}, diminta ${req.quantity}.`
      );
    }

    tx.update(itemRef, {
      stock: newStock,
      lastTransactionId: trxRef.id,
      lastStockBefore: item.stock
    });

    tx.set(trxRef, {
      itemId: req.itemId,
      code: item.code,
      name: item.name,
      type: "Keluar",
      quantity: req.quantity,
      stockBefore: item.stock,
      stockAfter: newStock,
      date: localDate(),
      note: `Permintaan ${req.ticketNo} - ${req.requesterName}`,
      createdBy: user.uid,
      createdByName: profile.name,
      createdByRole: profile.role,
      createdAt: serverTimestamp(),
      testOnly: false
    });

    tx.update(requestRef, {
      status: "Diserahkan",
      transactionId: trxRef.id,
      handedOverBy: user.uid,
      handedOverByName: profile.name,
      handedOverAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  });

  return "Barang diserahkan dan stok sudah dikurangi.";
}

/* ---------- Form ---------- */

async function openOrder(itemId) {
  if (!user || !profile) return message("Silakan login kembali.");

  const item = items.find(i => i.id === itemId);
  if (!item) return message("Barang tidak ditemukan.");

  const stock = Number(item.stock) || 0;
  if (stock <= 0) return message("Stok barang ini habis.");

  // Ambil jadwal terbaru yang diatur admin GA.
  await loadSlots();

  if (!slots.length) {
    return message(
      "Admin GA belum mengatur jam penyerahan barang. Silakan hubungi admin GA."
    );
  }

  const today = localDate();

  const photo = safePhoto(item)
    ? `<span class="catalog-photo"><img src="${esc(item.photoData)}" alt="Foto ${esc(item.name)}"></span>`
    : `<span class="catalog-photo"><i class="fa-solid fa-box"></i></span>`;

  const slotOptions = slots.map(slot => `
    <label class="slot-option">
      <input type="radio" name="handoverSlot" value="${esc(slot)}" required>
      ${esc(slot)}
    </label>`).join("");

  openModal(
    "Ajukan Permintaan",
    field("Barang", `
      <div class="order-summary">
        ${photo}
        <div>
          <strong>${esc(item.name)}</strong><br>
          <small>${esc(item.code)} · ${esc(item.category)}</small><br>
          ${item.specification ? `<small>Spesifikasi: ${esc(item.specification)}</small><br>` : ""}
          <small>Stok tersedia: ${stock} ${esc(item.unit)}</small>
        </div>
      </div>`) +
    field("Jumlah *", `<input name="quantity" type="number" min="1" max="${stock}" step="1" required>`, false) +
    field("Tanggal Penyerahan *", `<input name="handoverDate" type="date" min="${today}" value="${today}" required>`, false) +
    field("Jam Penyerahan *", `<div class="slot-options">${slotOptions}</div>`) +
    field("Alasan Kebutuhan *", `<textarea name="reason" maxlength="500" required placeholder="Jelaskan untuk apa barang dibutuhkan"></textarea>`),
    "Ajukan",
    data => createRequest(item, data)
  );
}

function openAction(action, id) {
  const r = requests.find(x => x.id === id);
  if (!r) return message("Permintaan tidak ditemukan.");

  const summary =
    `${esc(r.ticketNo)} — ${esc(r.itemName)} (${esc(r.quantity)} ${esc(r.unit)})` +
    `<br><small>Penyerahan: ${esc(scheduleText(r))}</small>`;

  if (action === "detail") {
    const lines = [
      ["Tiket", r.ticketNo],
      ["Pemohon", `${r.requesterName || "-"}${r.department ? ` (${r.department})` : ""}`],
      ["Barang", `${r.itemCode} — ${r.itemName}`],
      ["Spesifikasi", items.find(i => i.id === r.itemId)?.specification || "-"],
      ["Jumlah", `${r.quantity} ${r.unit}`],
      ["Jadwal penyerahan", scheduleText(r)],
      ["Alasan kebutuhan", r.reason],
      ["Status", r.status],
      ["Catatan / alasan", r.statusNote || "-"],
      ["Diproses oleh", r.reviewedByName || "-"],
      ["Diserahkan oleh", r.handedOverByName || "-"]
    ];
    openModal(
      "Detail Permintaan",
      lines.map(([label, value]) =>
        field(label, `<div>${esc(value ?? "-")}</div>`)
      ).join(""),
      "",
      null
    );
  } else if (action === "approve") {
    openModal(
      "Setujui Permintaan",
      field("Permintaan", `<div>${summary}</div>`) +
      field("Catatan (opsional)", `<textarea name="note" maxlength="500"></textarea>`),
      "Setujui",
      data => reviewRequest(id, "Disetujui", data.note)
    );
  } else if (action === "reject") {
    openModal(
      "Tolak Permintaan",
      field("Permintaan", `<div>${summary}</div>`) +
      field("Alasan penolakan *", `<textarea name="note" maxlength="500" required></textarea>`),
      "Tolak",
      data => reviewRequest(id, "Ditolak", data.note)
    );
  } else if (action === "handover") {
    openModal(
      "Serahkan Barang",
      field("Permintaan", `<div>${summary}</div>`) +
      field("Perhatian", `<div>Stok barang akan langsung berkurang ${esc(r.quantity)} ${esc(r.unit)} dan tercatat di riwayat transaksi.</div>`),
      "Serahkan Barang",
      () => handoverRequest(id)
    );
  } else if (action === "cancel") {
    openModal(
      "Batalkan Permintaan",
      field("Permintaan", `<div>${summary}</div>`) +
      field("Alasan pembatalan *", `<textarea name="note" maxlength="500" required></textarea>`),
      "Batalkan Permintaan",
      data => cancelRequest(id, data.note)
    );
  }
}

/* ---------- Pasang ke halaman ---------- */

$("tabCatalog")?.addEventListener("click", () => setTab("catalog"));
$("tabRequests")?.addEventListener("click", () => setTab("requests"));

$("catalogSearch")?.addEventListener("input", event => {
  catalogTerm = event.target.value;
  renderCatalog();
});

$("catalogGrid")?.addEventListener("click", event => {
  const card = event.target.closest(".catalog-card");
  if (card && !card.disabled) openOrder(card.dataset.itemId);
});

$("requestFilter")?.addEventListener("change", event => {
  statusFilter = event.target.value;
  render();
});

$("firebaseRequestTable")?.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (button) openAction(button.dataset.action, button.dataset.id);
});

$("saveSlotsButton")?.addEventListener("click", saveSlots);

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
});

// Dashboard lama menghitung "Permintaan Pending" dari localStorage;
// timpa dengan angka dari Firestore setiap kali tampilan dirender ulang.
const legacyRender = window.renderAll;

if (typeof legacyRender === "function") {
  window.renderAll = function (...args) {
    const result = legacyRender.apply(this, args);
    updatePending();
    return result;
  };
}

await authPersistenceReady;

onAuthStateChanged(auth, async current => {
  const thisGeneration = ++generation;

  user = null;
  profile = null;
  requests = [];
  items = [];
  itemsLoadedAt = 0;
  slots = [];
  catalogTerm = "";
  closeModal();
  fillSlotInputs();
  render();

  if (!current) return;

  try {
    await current.reload();
    if (thisGeneration !== generation || !current.emailVerified) return;

    const snapshot = await getDoc(doc(db, "users", current.uid));
    if (thisGeneration !== generation || !snapshot.exists()) return;

    const data = snapshot.data();
    if (data.active !== true || !VALID_ROLES.includes(data.role)) return;

    user = current;
    profile = data;

    setTab(isStaff() ? "requests" : "catalog");

    await Promise.all([
      load(),
      loadItems(true),
      canManage() ? loadSlots() : Promise.resolve()
    ]);

    if (thisGeneration === generation) {
      fillSlotInputs();
      render();
    }
  } catch (error) {
    if (thisGeneration !== generation) return;
    console.error("Gagal memuat modul permintaan:", error);
  }
});
