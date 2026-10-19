import { auth, db, authPersistenceReady } from "./firebase-init.js";
import { hasPerm } from "./perms.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
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

const CATEGORIES = [
  "Listrik",
  "Air / Plumbing",
  "AC / Pendingin",
  "Furnitur",
  "Bangunan",
  "Kebersihan",
  "Lainnya"
];
const URGENCIES = ["Rendah", "Sedang", "Mendesak"];
const STATUSES = [
  "Baru", "Disetujui", "Dikerjakan", "Menunggu Part",
  "Selesai", "Ditolak", "Dibatalkan"
];

const MAX_PHOTO_CHARS = 110000;

let user = null;
let profile = null;
let repairs = [];
let statusFilter = "";
let searchTerm = "";
let busy = false;
let generation = 0;

const isStaff = () => !!profile && STAFF_ROLES.includes(profile.role);
const canManage = () =>
  !!profile && MANAGER_ROLES.includes(profile.role) && hasPerm(profile, "repairs");

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
    return "Rules menolak tindakan ini. Pastikan firestore.rules terbaru sudah dipublikasikan dan status laporan masih sesuai.";
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
  return `RPR-${ymd}-${random}`;
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
    ? String(value || "-")
    : date.toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      });
}

function rupiah(value) {
  return "Rp " + Number(value || 0).toLocaleString("id-ID");
}

function statusBadge(status) {
  const cls = {
    Baru: "warning",
    Disetujui: "",
    Dikerjakan: "",
    "Menunggu Part": "warning",
    Selesai: "",
    Ditolak: "danger",
    Dibatalkan: "neutral"
  }[status] ?? "neutral";
  return `<span class="status-badge ${cls}">${esc(status || "-")}</span>`;
}

function urgencyBadge(level) {
  const cls = { Mendesak: "danger", Sedang: "warning", Rendah: "neutral" }[level] ?? "neutral";
  return `<span class="status-badge ${cls}">${esc(level || "-")}</span>`;
}

const safePhoto = value =>
  typeof value === "string" && value.startsWith("data:image/jpeg;base64,");

/* ---------- Foto: kompres jadi JPEG kecil ---------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("File bukan gambar yang valid."));
    };
    img.src = url;
  });
}

async function compressPhoto(file) {
  if (!file || !String(file.type).startsWith("image/")) {
    throw new Error("Pilih file gambar (JPG atau PNG).");
  }

  const img = await loadImage(file);
  let maxSide = 1024;
  let quality = 0.8;

  for (let attempt = 0; attempt < 12; attempt++) {
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const data = canvas.toDataURL("image/jpeg", quality);
    if (data.length <= MAX_PHOTO_CHARS) return data;

    quality -= 0.1;
    if (quality < 0.4) {
      quality = 0.75;
      maxSide = Math.round(maxSide * 0.75);
    }
  }

  throw new Error("Foto terlalu besar. Pilih foto lain.");
}

// Pasang pemilih foto: hasilnya disimpan di objek yang dikembalikan.
function bindPhotoInput(modal, inputName) {
  const holder = { data: "", pending: null };
  const input = modal.querySelector(`input[name="${inputName}"]`);
  const preview = modal.querySelector(`[data-preview="${inputName}"]`);
  if (!input) return holder;

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    holder.data = "";
    if (preview) preview.innerHTML = "";
    if (!file) return;

    holder.pending = compressPhoto(file)
      .then(data => {
        holder.data = data;
        if (preview) {
          preview.innerHTML = `<img src="${esc(data)}" alt="Pratinjau foto">`;
        }
      })
      .catch(error => {
        input.value = "";
        message(error.message);
      });
  });

  return holder;
}

/* ---------- Modal ---------- */

function closeModal() {
  $("repairModal")?.remove();
}

function field(label, control, full = true) {
  return `<div class="field ${full ? "full" : ""}"><label>${esc(label)}</label>${control}</div>`;
}

function optionList(list, selected = "") {
  return list
    .map(v => `<option${v === selected ? " selected" : ""}>${esc(v)}</option>`)
    .join("");
}

function openModal(title, bodyHTML, submitLabel, onSubmit, setup) {
  closeModal();

  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "repairModal";
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

  const helpers = setup ? setup(modal) : null;

  modal.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!onSubmit || busy) return;

    busy = true;
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;

    try {
      // Tunggu kompresi foto yang masih berjalan.
      if (helpers) {
        for (const holder of Object.values(helpers)) {
          if (holder?.pending) await holder.pending;
        }
      }

      const data = Object.fromEntries(
        [...new FormData(event.currentTarget)].filter(
          ([, value]) => typeof value === "string"
        )
      );
      const result = await onSubmit(data, helpers);
      closeModal();
      message(result || "Berhasil disimpan.");
      document.dispatchEvent(new Event("ga:data-changed"));
      await load();
    } catch (error) {
      console.error("Laporan perbaikan gagal:", error);
      message(errorText(error));
      if (submit) submit.disabled = false;
    } finally {
      busy = false;
    }
  });

  document.body.appendChild(modal);
  modal.querySelector("input, select, textarea, .primary-button")?.focus();
}

/* ---------- Tabel ---------- */

function executorText(r) {
  if (!r.executor) return "-";
  return r.executor === "Vendor" ? `Vendor: ${r.vendorName || "-"}` : "Internal GA";
}

function rowHTML(r) {
  const actions = [
    `<button type="button" class="small-action" data-action="detail" data-id="${esc(r.id)}">Detail</button>`
  ];

  if (canManage()) {
    if (r.status === "Baru") {
      actions.push(
        `<button type="button" class="small-action" data-action="approve" data-id="${esc(r.id)}">Setujui</button>`,
        `<button type="button" class="small-action delete" data-action="reject" data-id="${esc(r.id)}">Tolak</button>`
      );
    }
    if (r.status === "Disetujui") {
      actions.push(
        `<button type="button" class="small-action" data-action="start" data-id="${esc(r.id)}">Kerjakan</button>`
      );
    }
    if (r.status === "Dikerjakan") {
      actions.push(
        `<button type="button" class="small-action" data-action="hold" data-id="${esc(r.id)}">Tunggu Part</button>`,
        `<button type="button" class="small-action" data-action="finish" data-id="${esc(r.id)}">Selesaikan</button>`
      );
    }
    if (r.status === "Menunggu Part") {
      actions.push(
        `<button type="button" class="small-action" data-action="resume" data-id="${esc(r.id)}">Lanjutkan</button>`,
        `<button type="button" class="small-action" data-action="finish" data-id="${esc(r.id)}">Selesaikan</button>`
      );
    }
  }

  if (r.requesterUid === user?.uid && r.status === "Baru") {
    actions.push(
      `<button type="button" class="small-action delete" data-action="cancel" data-id="${esc(r.id)}">Batalkan</button>`
    );
  }

  return `
    <tr>
      <td>${esc(r.ticketNo || r.id)}</td>
      <td>${formatDate(r.createdAt)}</td>
      <td>${esc(r.requesterName)}${r.department ? ` <small>(${esc(r.department)})</small>` : ""}</td>
      <td>${esc(r.category)}<br><small>${esc(r.location)}</small></td>
      <td class="repair-desc">${esc(r.description)}</td>
      <td>${urgencyBadge(r.urgency)}</td>
      <td>${esc(executorText(r))}</td>
      <td>${statusBadge(r.status)}</td>
      <td><div class="row-actions">${actions.join("")}</div></td>
    </tr>`;
}

function render() {
  const subtitle = $("repairSubtitle");
  if (subtitle) {
    subtitle.textContent = isStaff()
      ? "Setujui laporan kerusakan, tentukan pelaksana, dan pantau sampai selesai."
      : "Laporkan kerusakan fasilitas dan pantau prosesnya sampai selesai.";
  }

  const body = $("repairTable");
  if (!body) return;

  const term = searchTerm.trim().toLocaleLowerCase("id-ID");

  const rows = repairs.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (!term) return true;
    return [
      r.ticketNo, r.requesterName, r.category, r.location,
      r.description, r.vendorName
    ].join(" ").toLocaleLowerCase("id-ID").includes(term);
  });

  body.innerHTML = rows.length
    ? rows.map(rowHTML).join("")
    : `<tr><td colspan="9" class="empty-cell">${
        profile ? "Belum ada laporan perbaikan." : "Silakan login."
      }</td></tr>`;
}

async function load() {
  if (!user || !profile) return;
  const current = generation;
  const uid = user.uid;

  try {
    const source = isStaff()
      ? collection(db, "repairRequests")
      : query(collection(db, "repairRequests"), where("requesterUid", "==", uid));

    const snapshot = await getDocs(source);
    if (current !== generation) return;

    repairs = snapshot.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    render();
  } catch (error) {
    if (current !== generation) return;
    console.error("Gagal memuat laporan perbaikan:", error);
    message("Gagal memuat laporan perbaikan. Periksa koneksi dan izin akses.");
  }
}

/* ---------- Tindakan ---------- */

async function createRepair(data, photo) {
  const category = String(data.category || "");
  const location = String(data.location || "").trim();
  const description = String(data.description || "").trim();
  const urgency = String(data.urgency || "");

  if (!CATEGORIES.includes(category)) throw new Error("Pilih kategori kerusakan.");
  if (!location || location.length > 150) {
    throw new Error("Lokasi wajib diisi, maksimal 150 karakter.");
  }
  if (!description || description.length > 1000) {
    throw new Error("Deskripsi wajib diisi, maksimal 1000 karakter.");
  }
  if (!URGENCIES.includes(urgency)) throw new Error("Pilih tingkat urgensi.");

  const ticket = newTicket();

  await setDoc(doc(db, "repairRequests", ticket), {
    ticketNo: ticket,
    type: "perbaikan",
    requesterUid: user.uid,
    requesterName: profile.name,
    department: profile.department || "",
    category,
    location,
    description,
    urgency,
    photoData: photo?.data || "",
    status: "Baru",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  if (typeof window.sendNotification === "function") {
    await window.sendNotification({
      recipientUid: user.uid,
      title: "Laporan Kerusakan Terkirim",
      body: `Laporan #${ticket} (${category} - ${location}) berhasil dikirim.`,
      type: "repair",
      requestId: ticket
    });
  }

  return `Laporan ${ticket} berhasil dikirim.`;
}

function stamp(note) {
  return {
    statusNote: String(note || "").trim(),
    updatedBy: user.uid,
    updatedByName: profile.name,
    updatedAt: serverTimestamp()
  };
}

function checkNote(note, required, label) {
  const text = String(note || "").trim();
  if (text.length > 500) throw new Error("Catatan maksimal 500 karakter.");
  if (required && !text) throw new Error(label);
  return text;
}

async function reviewRepair(id, decision, note) {
  const text = checkNote(note, decision === "Ditolak", "Alasan penolakan wajib diisi.");
  const req = repairs.find(x => x.id === id);

  await updateDoc(doc(db, "repairRequests", id), {
    status: decision,
    ...stamp(text)
  });

  if (req && typeof window.sendNotification === "function") {
    await window.sendNotification({
      recipientUid: req.requesterUid,
      title: `Laporan Perbaikan ${decision}`,
      body: `Laporan #${req.ticketNo || id} (${req.category}) telah ${decision.toLowerCase()}.${text ? ` Catatan: ${text}` : ""}`,
      type: "repair",
      requestId: req.ticketNo || id
    });
  }

  return decision === "Disetujui" ? "Laporan disetujui." : "Laporan ditolak.";
}

async function startRepair(id, data) {
  const executor = String(data.executor || "");
  const vendorName = executor === "Vendor" ? String(data.vendorName || "").trim() : "";

  if (!["Internal", "Vendor"].includes(executor)) {
    throw new Error("Pilih pelaksana: Internal atau Vendor.");
  }
  if (executor === "Vendor" && (!vendorName || vendorName.length > 100)) {
    throw new Error("Nama vendor wajib diisi, maksimal 100 karakter.");
  }

  const text = checkNote(data.note, false);
  const req = repairs.find(x => x.id === id);

  await updateDoc(doc(db, "repairRequests", id), {
    status: "Dikerjakan",
    executor,
    vendorName,
    ...stamp(text)
  });

  if (req && typeof window.sendNotification === "function") {
    await window.sendNotification({
      recipientUid: req.requesterUid,
      title: "Laporan Perbaikan Dikerjakan",
      body: `Laporan #${req.ticketNo || id} sedang dikerjakan oleh ${executor === "Vendor" ? `Vendor ${vendorName}` : "Tim Internal GA"}.`,
      type: "repair",
      requestId: req.ticketNo || id
    });
  }

  return "Perbaikan mulai dikerjakan.";
}

async function resumeRepair(id, note) {
  const r = repairs.find(x => x.id === id);
  if (!r?.executor) throw new Error("Pelaksana belum tercatat.");

  await updateDoc(doc(db, "repairRequests", id), {
    status: "Dikerjakan",
    executor: r.executor,
    vendorName: r.vendorName || "",
    ...stamp(checkNote(note, false))
  });

  return "Perbaikan dilanjutkan.";
}

async function holdRepair(id, note) {
  const text = checkNote(note, true, "Tuliskan part yang ditunggu.");

  await updateDoc(doc(db, "repairRequests", id), {
    status: "Menunggu Part",
    ...stamp(text)
  });

  return "Status diubah menjadi Menunggu Part.";
}

async function finishRepair(id, data, photo) {
  const actionNote = String(data.actionNote || "").trim();
  const completedDate = String(data.completedDate || "");
  const costText = String(data.cost ?? "").trim();
  const cost = costText === "" ? 0 : Number(costText);

  if (!actionNote || actionNote.length > 1000) {
    throw new Error("Catatan tindakan wajib diisi, maksimal 1000 karakter.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(completedDate)) {
    throw new Error("Tanggal selesai tidak valid.");
  }
  if (!Number.isSafeInteger(cost) || cost < 0) {
    throw new Error("Biaya harus bilangan bulat, 0 atau lebih.");
  }

  const prev = repairs.find(x => x.id === id);

  await updateDoc(doc(db, "repairRequests", id), {
    status: "Selesai",
    actionNote,
    completedDate,
    cost,
    afterPhotoData: photo?.data || "",
    ...stamp(prev?.statusNote || "")
  });

  if (prev && typeof window.sendNotification === "function") {
    await window.sendNotification({
      recipientUid: prev.requesterUid,
      title: "Laporan Perbaikan Selesai",
      body: `Laporan #${prev.ticketNo || id} telah selesai dikerjakan.`,
      type: "repair",
      requestId: prev.ticketNo || id
    });
  }

  return "Laporan ditandai selesai.";
}

async function cancelRepair(id, note) {
  const text = checkNote(note, true, "Alasan pembatalan wajib diisi.");

  await updateDoc(doc(db, "repairRequests", id), {
    status: "Dibatalkan",
    statusNote: text,
    updatedAt: serverTimestamp()
  });

  return "Laporan dibatalkan.";
}

/* ---------- Form ---------- */

function openCreate() {
  if (!user || !profile) return message("Silakan login kembali.");

  openModal(
    "Lapor Kerusakan",
    field("Kategori *", `<select name="category" required><option value="">Pilih kategori</option>${optionList(CATEGORIES)}</select>`, false) +
    field("Tingkat Urgensi *", `<select name="urgency" required>${optionList(URGENCIES, "Sedang")}</select>`, false) +
    field("Lokasi *", `<input name="location" maxlength="150" required placeholder="Contoh: Mess B, kamar 12 / Gedung Produksi lantai 2">`) +
    field("Deskripsi Masalah *", `<textarea name="description" maxlength="1000" required placeholder="Jelaskan apa yang rusak dan bagaimana kondisinya"></textarea>`) +
    field("Foto Kerusakan (opsional)", `<input name="photo" type="file" accept="image/*"><div class="repair-preview" data-preview="photo"></div>`),
    "Kirim Laporan",
    (data, helpers) => createRepair(data, helpers.photo),
    modal => ({ photo: bindPhotoInput(modal, "photo") })
  );
}

function photoBlock(src, label) {
  return safePhoto(src)
    ? field(label, `<div class="repair-preview"><img src="${esc(src)}" alt="${esc(label)}"></div>`)
    : "";
}

export async function openRepairDetail(r) {
  if (!r) return message("Laporan tidak ditemukan.");

  let headerHTML = "";
  if (r.requesterUid && typeof window.buildRequesterHeaderHTML === "function") {
    headerHTML = await window.buildRequesterHeaderHTML(r.requesterUid, r.requesterName, r.department);
  }

  const lines = [
    ["Tiket", r.ticketNo],
    ["Pelapor", `${r.requesterName || "-"}${r.department ? ` (${r.department})` : ""}`],
    ["Tanggal lapor", formatDate(r.createdAt)],
    ["Kategori", r.category],
    ["Lokasi", r.location],
    ["Urgensi", r.urgency],
    ["Deskripsi", r.description],
    ["Status", r.status],
    ["Pelaksana", executorText(r)],
    ["Catatan status", r.statusNote || "-"],
    ["Diproses oleh", r.updatedByName || "-"]
  ];

  if (r.status === "Selesai") {
    lines.push(
      ["Tanggal selesai", formatDay(r.completedDate)],
      ["Tindakan", r.actionNote || "-"],
      ["Biaya", rupiah(r.cost)]
    );
  }

  openModal(
    "Detail Laporan",
    headerHTML +
    lines.map(([label, value]) =>
      field(label, `<div>${esc(value ?? "-")}</div>`)
    ).join("") +
    photoBlock(r.photoData, "Foto kerusakan") +
    photoBlock(r.afterPhotoData, "Foto setelah perbaikan"),
    "",
    null
  );
}

window.openRepairDetail = openRepairDetail;

function openAction(action, id) {
  const r = repairs.find(x => x.id === id);
  if (!r) return message("Laporan tidak ditemukan.");

  const summary =
    `${esc(r.ticketNo)} — ${esc(r.category)}, ${esc(r.location)}` +
    `<br><small>${esc(r.description)}</small>`;

  if (action === "detail") {
    openRepairDetail(r);
  } else if (action === "approve") {
    openModal(
      "Setujui Laporan",
      field("Laporan", `<div>${summary}</div>`) +
      field("Catatan (opsional)", `<textarea name="note" maxlength="500"></textarea>`),
      "Setujui",
      data => reviewRepair(id, "Disetujui", data.note)
    );
  } else if (action === "reject") {
    openModal(
      "Tolak Laporan",
      field("Laporan", `<div>${summary}</div>`) +
      field("Alasan penolakan *", `<textarea name="note" maxlength="500" required></textarea>`),
      "Tolak",
      data => reviewRepair(id, "Ditolak", data.note)
    );
  } else if (action === "start") {
    openModal(
      "Mulai Perbaikan",
      field("Laporan", `<div>${summary}</div>`) +
      field("Pelaksana *", `<select name="executor" required><option value="">Pilih pelaksana</option><option value="Internal">Tim internal GA</option><option value="Vendor">Vendor</option></select>`, false) +
      field("Nama Vendor", `<input name="vendorName" maxlength="100" placeholder="Wajib bila pelaksana Vendor" disabled>`, false) +
      field("Catatan (opsional)", `<textarea name="note" maxlength="500"></textarea>`),
      "Mulai Kerjakan",
      data => startRepair(id, data),
      modal => {
        const select = modal.querySelector('[name="executor"]');
        const vendor = modal.querySelector('[name="vendorName"]');
        select.addEventListener("change", () => {
          const isVendor = select.value === "Vendor";
          vendor.disabled = !isVendor;
          vendor.required = isVendor;
          if (!isVendor) vendor.value = "";
        });
        return null;
      }
    );
  } else if (action === "resume") {
    openModal(
      "Lanjutkan Perbaikan",
      field("Laporan", `<div>${summary}</div>`) +
      field("Pelaksana", `<div>${esc(executorText(r))}</div>`) +
      field("Catatan (opsional)", `<textarea name="note" maxlength="500" placeholder="Contoh: part sudah datang"></textarea>`),
      "Lanjutkan",
      data => resumeRepair(id, data.note)
    );
  } else if (action === "hold") {
    openModal(
      "Menunggu Part",
      field("Laporan", `<div>${summary}</div>`) +
      field("Part yang ditunggu *", `<textarea name="note" maxlength="500" required placeholder="Contoh: kompresor AC, perkiraan tiba 3 hari"></textarea>`),
      "Simpan",
      data => holdRepair(id, data.note)
    );
  } else if (action === "finish") {
    openModal(
      "Selesaikan Perbaikan",
      field("Laporan", `<div>${summary}</div>`) +
      field("Tanggal Selesai *", `<input name="completedDate" type="date" value="${localDate()}" required>`, false) +
      field("Biaya (Rp)", `<input name="cost" type="number" min="0" step="1" value="0">`, false) +
      field("Catatan Tindakan *", `<textarea name="actionNote" maxlength="1000" required placeholder="Apa yang sudah dikerjakan"></textarea>`) +
      field("Foto Setelah Perbaikan (opsional)", `<input name="afterPhoto" type="file" accept="image/*"><div class="repair-preview" data-preview="afterPhoto"></div>`),
      "Tandai Selesai",
      (data, helpers) => finishRepair(id, data, helpers.afterPhoto),
      modal => ({ afterPhoto: bindPhotoInput(modal, "afterPhoto") })
    );
  } else if (action === "cancel") {
    openModal(
      "Batalkan Laporan",
      field("Laporan", `<div>${summary}</div>`) +
      field("Alasan pembatalan *", `<textarea name="note" maxlength="500" required></textarea>`),
      "Batalkan Laporan",
      data => cancelRepair(id, data.note)
    );
  }
}

/* ---------- Pasang ke halaman ---------- */

$("newRepairButton")?.addEventListener("click", openCreate);

$("repairFilter")?.addEventListener("change", event => {
  statusFilter = event.target.value;
  render();
});

$("repairSearch")?.addEventListener("input", event => {
  searchTerm = event.target.value;
  render();
});

$("repairTable")?.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (button) openAction(button.dataset.action, button.dataset.id);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
});

// Isi opsi filter status dari daftar status.
const filter = $("repairFilter");
if (filter && filter.options.length <= 1) {
  filter.insertAdjacentHTML(
    "beforeend",
    STATUSES.map(s => `<option>${esc(s)}</option>`).join("")
  );
}

await authPersistenceReady;

onAuthStateChanged(auth, async current => {
  const thisGeneration = ++generation;

  user = null;
  profile = null;
  repairs = [];
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
    if (thisGeneration === generation) render();
  } catch (error) {
    if (thisGeneration !== generation) return;
    console.error("Gagal memuat modul perbaikan:", error);
  }
});
