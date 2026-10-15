import { auth, db, authPersistenceReady } from "./firebase-init.js";

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

let user = null;
let profile = null;
let requests = [];
let items = [];
let statusFilter = "";
let busy = false;
let generation = 0;

const isStaff = () => !!profile && STAFF_ROLES.includes(profile.role);
const canManage = () => !!profile && MANAGER_ROLES.includes(profile.role);

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
    return "Rules menolak tindakan ini. Periksa role akun atau status permintaan.";
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
      await load();
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

/* ---------- Tampilan tabel ---------- */

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

  if (canManage() && r.status === "Disetujui") {
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
      <td>${esc(r.deliveryLocation)}</td>
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
  const body = $("firebaseRequestTable");
  if (!body) return;

  const newButton = $("newRequestButton");
  if (newButton) newButton.hidden = !profile;

  const subtitle = $("requestSubtitle");
  if (subtitle) {
    subtitle.textContent = isStaff()
      ? "Verifikasi, setujui, dan serahkan permintaan barang dari karyawan."
      : "Ajukan kebutuhan barang dan pantau statusnya.";
  }

  const rows = requests.filter(
    r => !statusFilter || r.status === statusFilter
  );

  body.innerHTML = rows.length
    ? rows.map(rowHTML).join("")
    : `<tr><td colspan="8" class="empty-cell">${
        profile ? "Belum ada permintaan." : "Silakan login."
      }</td></tr>`;

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

async function createRequest(data) {
  const item = items.find(i => i.id === data.itemId);
  if (!item) throw new Error("Pilih barang yang valid.");

  const quantity = Number(data.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1000000) {
    throw new Error("Jumlah harus bilangan bulat lebih dari nol.");
  }

  const reason = String(data.reason || "").trim();
  const location = String(data.deliveryLocation || "").trim();

  if (!reason || reason.length > 500) {
    throw new Error("Alasan wajib diisi, maksimal 500 karakter.");
  }
  if (!location || location.length > 150) {
    throw new Error("Lokasi penyerahan wajib diisi, maksimal 150 karakter.");
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
    deliveryLocation: location,
    status: "Menunggu",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

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

async function openNewRequest() {
  if (!user || !profile) return message("Silakan login kembali.");

  try {
    const snapshot = await getDocs(collection(db, "inventory"));
    items = snapshot.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  } catch (error) {
    console.error("Gagal memuat barang:", error);
    return message("Daftar barang tidak dapat dimuat.");
  }

  if (!items.length) return message("Belum ada barang yang dapat diminta.");

  const options = items.map(i => `
    <option value="${esc(i.id)}" ${Number(i.stock) > 0 ? "" : "disabled"}>
      ${esc(i.code)} — ${esc(i.name)}
      (${Number(i.stock) > 0 ? `stok: ${esc(i.stock)} ${esc(i.unit)}` : "stok habis"})
    </option>`).join("");

  openModal(
    "Buat Permintaan Barang",
    field("Barang *", `<select name="itemId" required><option value="">Pilih barang</option>${options}</select>`) +
    field("Jumlah *", `<input name="quantity" type="number" min="1" step="1" required>`, false) +
    field("Lokasi Penyerahan *", `<input name="deliveryLocation" maxlength="150" required placeholder="Contoh: Kantor Lt. 2">`, false) +
    field("Alasan Kebutuhan *", `<textarea name="reason" maxlength="500" required placeholder="Jelaskan untuk apa barang dibutuhkan"></textarea>`),
    "Ajukan",
    createRequest
  );
}

function openAction(action, id) {
  const r = requests.find(x => x.id === id);
  if (!r) return message("Permintaan tidak ditemukan.");

  const summary = `${esc(r.ticketNo)} — ${esc(r.itemName)} (${esc(r.quantity)} ${esc(r.unit)})`;

  if (action === "detail") {
    const lines = [
      ["Tiket", r.ticketNo],
      ["Pemohon", `${r.requesterName || "-"}${r.department ? ` (${r.department})` : ""}`],
      ["Barang", `${r.itemCode} — ${r.itemName}`],
      ["Jumlah", `${r.quantity} ${r.unit}`],
      ["Lokasi penyerahan", r.deliveryLocation],
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

$("newRequestButton")?.addEventListener("click", openNewRequest);

$("requestFilter")?.addEventListener("change", event => {
  statusFilter = event.target.value;
  render();
});

$("firebaseRequestTable")?.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (button) openAction(button.dataset.action, button.dataset.id);
});

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
  closeModal();
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
    await load();
  } catch (error) {
    if (thisGeneration !== generation) return;
    console.error("Gagal memuat modul permintaan:", error);
  }
});
