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

(window.__gaModules ||= {}).vehicles = true;

const $ = id => document.getElementById(id);

const MANAGER_ROLES = ["main_admin", "ga_admin"];
const STAFF_ROLES = ["main_admin", "ga_admin", "admin_operational"];
const VALID_ROLES = [...STAFF_ROLES, "employee"];
const DRIVER_OPTIONS = ["Sopir GA", "Bawa sendiri"];
const STATUSES = ["Menunggu", "Disetujui", "Selesai", "Ditolak", "Dibatalkan"];

let user = null;
let profile = null;
let requests = [];
let statusFilter = "";
let searchTerm = "";
let busy = false;
let generation = 0;

const isStaff = () => !!profile && STAFF_ROLES.includes(profile.role);
const canManage = () =>
  !!profile && MANAGER_ROLES.includes(profile.role) && hasPerm(profile, "vehicles");

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
    return "Rules menolak tindakan ini. Pastikan firestore.rules terbaru sudah dipublikasikan dan status permintaan masih sesuai.";
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
  return `VEH-${ymd}-${random}`;
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

function scheduleText(r) {
  return `${formatDay(r.departDate)} ${r.departTime || ""} → ${formatDay(r.returnDate)} ${r.returnTime || ""}`;
}

function statusBadge(status) {
  const cls = {
    Menunggu: "warning",
    Disetujui: "",
    Selesai: "",
    Ditolak: "danger",
    Dibatalkan: "neutral"
  }[status] ?? "neutral";
  return `<span class="status-badge ${cls}">${esc(status || "-")}</span>`;
}

/* ---------- Modal ---------- */

function closeModal() {
  $("vehicleModal")?.remove();
}

function field(label, control, full = true) {
  return `<div class="field ${full ? "full" : ""}"><label>${esc(label)}</label>${control}</div>`;
}

function openModal(title, bodyHTML, submitLabel, onSubmit, setup) {
  closeModal();

  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "vehicleModal";
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

  if (setup) setup(modal);

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
      await load();
    } catch (error) {
      console.error("Permintaan kendaraan gagal:", error);
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

function rowHTML(r) {
  const actions = [
    `<button type="button" class="small-action" data-action="detail" data-id="${esc(r.id)}">Detail</button>`
  ];

  if (canManage()) {
    if (r.status === "Menunggu") {
      actions.push(
        `<button type="button" class="small-action" data-action="approve" data-id="${esc(r.id)}">Setujui</button>`,
        `<button type="button" class="small-action delete" data-action="reject" data-id="${esc(r.id)}">Tolak</button>`
      );
    }
    if (r.status === "Disetujui") {
      actions.push(
        `<button type="button" class="small-action" data-action="finish" data-id="${esc(r.id)}">Selesaikan</button>`
      );
    }
  }

  if (r.requesterUid === user?.uid && r.status === "Menunggu") {
    actions.push(
      `<button type="button" class="small-action delete" data-action="cancel" data-id="${esc(r.id)}">Batalkan</button>`
    );
  }

  const assigned = r.vehicleInfo
    ? `${r.vehicleInfo}${r.driverName ? ` (${r.driverName})` : ""}`
    : "-";

  return `
    <tr>
      <td data-label="Tiket">${esc(r.ticketNo || r.id)}</td>
      <td data-label="Pemohon">${esc(r.requesterName)}${r.department ? ` <small>(${esc(r.department)})</small>` : ""}</td>
      <td data-label="Tujuan">${esc(r.destination)}</td>
      <td data-label="Jadwal">${esc(scheduleText(r))}</td>
      <td data-label="Penumpang">${esc(r.passengers)} org · ${esc(r.driverNeeded)}</td>
      <td data-label="Kendaraan">${esc(assigned)}</td>
      <td data-label="Status">${statusBadge(r.status)}</td>
      <td data-label="Aksi"><div class="row-actions">${actions.join("")}</div></td>
    </tr>`;
}

function render() {
  const subtitle = $("vehicleSubtitle");
  if (subtitle) {
    subtitle.textContent = isStaff()
      ? "Setujui permintaan kendaraan dan tentukan kendaraan serta sopirnya."
      : "Ajukan kendaraan untuk keperluan operasional dan pantau statusnya.";
  }

  const body = $("vehicleRequestTable");
  if (!body) return;

  const term = searchTerm.trim().toLocaleLowerCase("id-ID");

  const rows = requests.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (!term) return true;
    return [r.ticketNo, r.requesterName, r.destination, r.purpose, r.vehicleInfo]
      .join(" ").toLocaleLowerCase("id-ID").includes(term);
  });

  body.innerHTML = rows.length
    ? rows.map(rowHTML).join("")
    : `<tr><td colspan="8" class="empty-cell">${
        profile ? "Belum ada permintaan kendaraan." : "Silakan login."
      }</td></tr>`;
}

async function load() {
  if (!user || !profile) return;
  const current = generation;
  const uid = user.uid;

  try {
    const source = isStaff()
      ? collection(db, "vehicleRequests")
      : query(collection(db, "vehicleRequests"), where("requesterUid", "==", uid));

    const snapshot = await getDocs(source);
    if (current !== generation) return;

    requests = snapshot.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    render();
  } catch (error) {
    if (current !== generation) return;
    console.error("Gagal memuat permintaan kendaraan:", error);
    message("Gagal memuat permintaan kendaraan. Periksa koneksi dan izin akses.");
  }
}

/* ---------- Tindakan ---------- */

async function createRequest(data) {
  const destination = String(data.destination || "").trim();
  const purpose = String(data.purpose || "").trim();
  const departDate = String(data.departDate || "");
  const departTime = String(data.departTime || "");
  const returnDate = String(data.returnDate || "");
  const returnTime = String(data.returnTime || "");
  const passengers = Number(data.passengers);
  const driverNeeded = String(data.driverNeeded || "");

  if (!destination || destination.length > 150) {
    throw new Error("Tujuan wajib diisi, maksimal 150 karakter.");
  }
  if (!purpose || purpose.length > 500) {
    throw new Error("Keperluan wajib diisi, maksimal 500 karakter.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departDate) || departDate < localDate()) {
    throw new Error("Tanggal berangkat tidak boleh sebelum hari ini.");
  }
  if (!/^\d{2}:\d{2}$/.test(departTime) || !/^\d{2}:\d{2}$/.test(returnTime)) {
    throw new Error("Isi jam berangkat dan jam kembali.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) {
    throw new Error("Isi tanggal kembali.");
  }
  if (
    returnDate < departDate ||
    (returnDate === departDate && returnTime <= departTime)
  ) {
    throw new Error("Waktu kembali harus setelah waktu berangkat.");
  }
  if (!Number.isSafeInteger(passengers) || passengers < 1 || passengers > 100) {
    throw new Error("Jumlah penumpang 1 sampai 100.");
  }
  if (!DRIVER_OPTIONS.includes(driverNeeded)) {
    throw new Error("Pilih sopir GA atau bawa sendiri.");
  }

  const ticket = newTicket();

  await setDoc(doc(db, "vehicleRequests", ticket), {
    ticketNo: ticket,
    type: "kendaraan",
    requesterUid: user.uid,
    requesterName: profile.name,
    department: profile.department || "",
    destination,
    purpose,
    departDate,
    departTime,
    returnDate,
    returnTime,
    passengers,
    driverNeeded,
    status: "Menunggu",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return `Permintaan ${ticket} berhasil diajukan.`;
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

async function approveRequest(id, data) {
  const vehicleInfo = String(data.vehicleInfo || "").trim();
  const driverName = String(data.driverName || "").trim();

  if (!vehicleInfo || vehicleInfo.length > 100) {
    throw new Error("Isi kendaraan yang ditugaskan, maksimal 100 karakter.");
  }
  if (driverName.length > 100) throw new Error("Nama sopir maksimal 100 karakter.");

  await updateDoc(doc(db, "vehicleRequests", id), {
    status: "Disetujui",
    vehicleInfo,
    driverName,
    ...stamp(checkNote(data.note, false))
  });

  return "Permintaan disetujui.";
}

async function rejectRequest(id, note) {
  const text = checkNote(note, true, "Alasan penolakan wajib diisi.");

  await updateDoc(doc(db, "vehicleRequests", id), {
    status: "Ditolak",
    ...stamp(text)
  });

  return "Permintaan ditolak.";
}

async function finishRequest(id, note) {
  await updateDoc(doc(db, "vehicleRequests", id), {
    status: "Selesai",
    ...stamp(checkNote(note, false))
  });

  return "Permintaan ditandai selesai.";
}

async function cancelRequest(id, note) {
  const text = checkNote(note, true, "Alasan pembatalan wajib diisi.");

  await updateDoc(doc(db, "vehicleRequests", id), {
    status: "Dibatalkan",
    statusNote: text,
    updatedAt: serverTimestamp()
  });

  return "Permintaan dibatalkan.";
}

/* ---------- Form ---------- */

function openCreate() {
  if (!user || !profile) return message("Silakan login kembali.");

  const today = localDate();

  openModal(
    "Ajukan Kendaraan",
    field("Tujuan *", `<input name="destination" maxlength="150" required placeholder="Contoh: Pelabuhan / Kantor Pusat / Bandara">`) +
    field("Keperluan *", `<textarea name="purpose" maxlength="500" required placeholder="Jelaskan keperluan perjalanan"></textarea>`) +
    field("Tanggal Berangkat *", `<input name="departDate" type="date" min="${today}" value="${today}" required>`, false) +
    field("Jam Berangkat *", `<input name="departTime" type="time" required>`, false) +
    field("Tanggal Kembali *", `<input name="returnDate" type="date" min="${today}" value="${today}" required>`, false) +
    field("Jam Kembali *", `<input name="returnTime" type="time" required>`, false) +
    field("Jumlah Penumpang *", `<input name="passengers" type="number" min="1" max="100" step="1" value="1" required>`, false) +
    field("Pengemudi *", `<select name="driverNeeded" required>${DRIVER_OPTIONS.map(o => `<option>${esc(o)}</option>`).join("")}</select>`, false),
    "Ajukan",
    createRequest
  );
}

function openAction(action, id) {
  const r = requests.find(x => x.id === id);
  if (!r) return message("Permintaan tidak ditemukan.");

  const summary =
    `${esc(r.ticketNo)} — ${esc(r.destination)}` +
    `<br><small>${esc(scheduleText(r))} · ${esc(r.passengers)} orang · ${esc(r.driverNeeded)}</small>`;

  if (action === "detail") {
    const lines = [
      ["Tiket", r.ticketNo],
      ["Pemohon", `${r.requesterName || "-"}${r.department ? ` (${r.department})` : ""}`],
      ["Tujuan", r.destination],
      ["Keperluan", r.purpose],
      ["Berangkat", `${formatDay(r.departDate)} ${r.departTime}`],
      ["Kembali", `${formatDay(r.returnDate)} ${r.returnTime}`],
      ["Penumpang", `${r.passengers} orang`],
      ["Pengemudi", r.driverNeeded],
      ["Status", r.status],
      ["Kendaraan", r.vehicleInfo || "-"],
      ["Sopir ditugaskan", r.driverName || "-"],
      ["Catatan", r.statusNote || "-"],
      ["Diproses oleh", r.updatedByName || "-"]
    ];
    openModal(
      "Detail Permintaan Kendaraan",
      lines.map(([label, value]) => field(label, `<div>${esc(value ?? "-")}</div>`)).join(""),
      "",
      null
    );
  } else if (action === "approve") {
    const needsDriver = r.driverNeeded === "Sopir GA";
    openModal(
      "Setujui Permintaan Kendaraan",
      field("Permintaan", `<div>${summary}</div>`) +
      field("Kendaraan yang ditugaskan *", `<input name="vehicleInfo" maxlength="100" required placeholder="Contoh: Toyota Avanza B 1234 XYZ">`) +
      (needsDriver
        ? field("Nama Sopir", `<input name="driverName" maxlength="100" placeholder="Nama sopir yang bertugas">`)
        : field("Pengemudi", `<div>Karyawan membawa sendiri.</div>`)) +
      field("Catatan (opsional)", `<textarea name="note" maxlength="500"></textarea>`),
      "Setujui",
      data => approveRequest(id, data)
    );
  } else if (action === "reject") {
    openModal(
      "Tolak Permintaan Kendaraan",
      field("Permintaan", `<div>${summary}</div>`) +
      field("Alasan penolakan *", `<textarea name="note" maxlength="500" required></textarea>`),
      "Tolak",
      data => rejectRequest(id, data.note)
    );
  } else if (action === "finish") {
    openModal(
      "Selesaikan Permintaan",
      field("Permintaan", `<div>${summary}</div>`) +
      field("Catatan (opsional)", `<textarea name="note" maxlength="500" placeholder="Contoh: kendaraan sudah kembali"></textarea>`),
      "Tandai Selesai",
      data => finishRequest(id, data.note)
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

$("newVehicleRequestButton")?.addEventListener("click", openCreate);

$("vehicleFilter")?.addEventListener("change", event => {
  statusFilter = event.target.value;
  render();
});

$("vehicleSearch")?.addEventListener("input", event => {
  searchTerm = event.target.value;
  render();
});

$("vehicleRequestTable")?.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (button) openAction(button.dataset.action, button.dataset.id);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
});

const filter = $("vehicleFilter");
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
  requests = [];
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
    console.error("Gagal memuat modul kendaraan:", error);
  }
});
