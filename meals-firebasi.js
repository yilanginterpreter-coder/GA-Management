import { auth, db, authPersistenceReady } from "./firebase-init.js";
import { hasPerm } from "./perms.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

const $ = id => document.getElementById(id);

const STAFF_ROLES = ["main_admin", "ga_admin", "admin_operational"];
const DEFAULT_CFG = { lunchOpen: 480, lunchClose: 1020, dinnerOpen: 1200, dinnerClose: 300 };
const MEAL_LABEL = { siang: "Makan Siang", malam: "Makan Malam" };
const SHIFT_MEAL = { pagi: "siang", malam: "malam" };
const WIB_MS = 7 * 3600 * 1000;

let user = null;
let profile = null;
let cfg = null;
let generation = 0;
let adminTab = "orders";
let adminOrders = [];
let shiftUsers = [];
let menuPhoto = null; // null = tidak diubah, "" = tanpa foto
let busy = false;

const isMain = () => profile?.role === "main_admin";
const isStaff = () => !!profile && STAFF_ROLES.includes(profile.role);
const canMeals = () => hasPerm(profile, "meals");

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
    return "Ditolak oleh sistem. Kemungkinan jam pemesanan sudah berubah, pesanan sudah diproses, atau firestore.rules terbaru belum dipublikasikan.";
  }
  return error?.message || "Terjadi kesalahan.";
}

/* ---------- Waktu (selalu WIB, sama dengan rules) ---------- */

const minToText = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const textToMin = t => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(t || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

function wibDate(nowMs = Date.now()) {
  return new Date(nowMs + WIB_MS);
}

function dayText(offset = 0, nowMs = Date.now()) {
  return new Date(nowMs + WIB_MS + offset * 86400000).toISOString().slice(0, 10);
}

function niceDate(text) {
  const d = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? String(text || "-")
    : d.toLocaleDateString("id-ID", {
        weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
      });
}

function windowOf(meal, c) {
  return meal === "siang"
    ? { open: c.lunchOpen, close: c.lunchClose }
    : { open: c.dinnerOpen, close: c.dinnerClose };
}

// Jendela pesan untuk satu jenis makan. Tanggal makan = hari setelah jendela dibuka.
function cycle(meal, c, nowMs = Date.now()) {
  const { open, close } = windowOf(meal, c);
  const L = wibDate(nowMs);
  const n = L.getUTCHours() * 60 + L.getUTCMinutes();
  const normal = open < close;
  const isOpen = normal ? (n >= open && n < close) : (n >= open || n < close);

  if (isOpen) {
    return {
      isOpen: true,
      target: dayText(normal || n >= open ? 1 : 0, nowMs),
      info: `Pemesanan ditutup pukul ${minToText(close)} WIB`
    };
  }

  const tomorrow = normal && n >= close;
  return {
    isOpen: false,
    target: dayText(tomorrow ? 2 : 1, nowMs),
    info: `Pemesanan dibuka ${tomorrow ? "besok" : "hari ini"} pukul ${minToText(open)} WIB`
  };
}

/* ---------- Modal ---------- */

function closeModal() {
  $("mealModal")?.remove();
}

function showDialog({ title, body, actions, top = false }) {
  closeModal();
  const modal = document.createElement("div");
  modal.className = `modal open${top ? " top-dialog" : ""}`;
  modal.id = "mealModal";
  modal.innerHTML = `
    <div class="modal-card dialog-card">
      <h2>${esc(title)}</h2>
      <div class="shell-modal-body">${body}</div>
      <div class="modal-actions">
        ${actions.map((a, i) =>
          `<button type="button" class="${esc(a.cls || "secondary-button")}" data-act="${i}">${esc(a.label)}</button>`
        ).join("")}
      </div>
    </div>`;

  modal.addEventListener("click", async event => {
    if (event.target === modal) return closeModal();
    const button = event.target.closest("[data-act]");
    if (!button || button.disabled) return;
    const action = actions[Number(button.dataset.act)];
    if (!action?.onClick) return closeModal();

    button.disabled = true;
    try {
      await action.onClick();
      closeModal();
    } catch (error) {
      console.error(error);
      message(errorText(error));
      button.disabled = false;
    }
  });

  document.body.appendChild(modal);
}

/* ---------- Konfigurasi ---------- */

async function loadConfig() {
  try {
    const snap = await getDoc(doc(db, "settings", "mealConfig"));
    if (snap.exists()) {
      const d = snap.data();
      cfg = {
        lunchOpen: Number(d.lunchOpen), lunchClose: Number(d.lunchClose),
        dinnerOpen: Number(d.dinnerOpen), dinnerClose: Number(d.dinnerClose)
      };
      return;
    }
    cfg = null;
    if (isMain()) {
      await setDoc(doc(db, "settings", "mealConfig"), DEFAULT_CFG);
      cfg = { ...DEFAULT_CFG };
    }
  } catch (error) {
    console.warn("Jadwal pesan makan tidak dapat dimuat:", error?.code || error?.message);
  }
}

/* ======================================================================
   TAMPILAN KARYAWAN
   ====================================================================== */

let myOrders = [];
let myMenu = null;
let myOrder = null;

function mealOf(p) {
  return SHIFT_MEAL[p?.mealShift] || "";
}

async function loadEmployee() {
  const view = $("mealEmployeeView");
  if (!view || !user || !profile) return;
  const current = generation;

  await loadConfig();
  if (current !== generation) return;

  const meal = mealOf(profile);
  if (cfg && meal) {
    const c = cycle(meal, cfg);
    try {
      const [menuSnap, orderSnap] = await Promise.all([
        getDoc(doc(db, "mealMenus", `${c.target}_${meal}`)),
        getDoc(doc(db, "mealOrders", `${user.uid}_${c.target}_${meal}`))
      ]);
      myMenu = menuSnap.exists() ? menuSnap.data() : null;
      myOrder = orderSnap.exists() ? orderSnap.data() : null;
    } catch (error) {
      console.warn("Data makan tidak dapat dimuat:", error?.code);
      myMenu = null;
      myOrder = null;
    }
  }

  try {
    const snap = await getDocs(query(collection(db, "mealOrders"), where("uid", "==", user.uid)));
    myOrders = snap.docs.map(d => d.data())
      .sort((a, b) => String(b.mealDate).localeCompare(String(a.mealDate)))
      .slice(0, 6);
  } catch (error) {
    myOrders = [];
  }

  if (current === generation) renderEmployee();
}

function badgeClass(status) {
  if (["Ditolak", "Dibatalkan"].includes(status)) return "danger";
  if (status === "Menunggu") return "warning";
  return "";
}

function renderEmployee() {
  const view = $("mealEmployeeView");
  if (!view) return;

  if (!profile) { view.innerHTML = ""; return; }

  const meal = mealOf(profile);

  if (!meal) {
    view.innerHTML = `<article class="panel meal-card"><i class="fa-solid fa-user-clock meal-icon"></i><h3>Shift belum diatur</h3><p>Shift kerja Anda (pagi atau malam) belum ditentukan. Hubungi GA agar bisa memesan makan.</p></article>`;
    return;
  }

  if (!cfg) {
    view.innerHTML = `<article class="panel meal-card"><i class="fa-solid fa-clock meal-icon"></i><h3>Jadwal belum diatur</h3><p>Jam pemesanan makan belum diatur oleh admin. Coba lagi nanti.</p></article>`;
    return;
  }

  const c = cycle(meal, cfg);
  const w = windowOf(meal, cfg);
  const order = myOrder && myOrder.mealDate === c.target ? myOrder : null;

  let action = "";
  if (order) {
    const text = {
      Menunggu: "Pesanan Anda terkirim dan menunggu persetujuan.",
      Disetujui: "Pesanan Anda sudah disetujui.",
      Ditolak: "Pesanan Anda ditolak oleh admin.",
      Dibatalkan: "Pesanan dibatalkan. Untuk hari ini Anda tidak bisa memesan lagi."
    }[order.status] || "";
    action = `
      <div class="meal-state"><span class="status-badge ${badgeClass(order.status)}">${esc(order.status)}</span><p>${esc(text)}</p></div>
      ${["Menunggu", "Disetujui"].includes(order.status) && c.isOpen
        ? `<button type="button" class="secondary-button danger-outline" id="mealCancelButton"><i class="fa-solid fa-xmark"></i> Cancel Pesanan</button>`
        : ""}`;
  } else if (c.isOpen) {
    action = `<button type="button" class="primary-button" id="mealOrderButton"><i class="fa-solid fa-bowl-food"></i> Pesan</button>`;
  } else {
    action = `<div class="meal-state"><span class="status-badge neutral">Belum dibuka</span><p>${esc(c.info)}.</p></div>`;
  }

  const menuHTML = myMenu
    ? `${myMenu.photoData ? `<img class="meal-photo" src="${esc(myMenu.photoData)}" alt="Menu">` : ""}
       ${myMenu.title ? `<p class="meal-menu-text">${esc(myMenu.title)}</p>` : ""}`
    : `<p class="catalog-empty">Menu belum diumumkan oleh GA.</p>`;

  view.innerHTML = `
    <article class="panel meal-order-card">
      <div class="meal-head">
        <div>
          <span class="eyebrow">${esc(MEAL_LABEL[meal].toUpperCase())}</span>
          <h3>${esc(niceDate(c.target))}</h3>
          <small>Jam pesan: ${esc(minToText(w.open))} – ${esc(minToText(w.close))} WIB · ${esc(c.isOpen ? c.info : "Sedang tutup")}</small>
        </div>
        <span class="status-badge ${c.isOpen ? "" : "neutral"}">${c.isOpen ? "Dibuka" : "Ditutup"}</span>
      </div>
      <div class="meal-menu">
        <p class="meal-menu-label"><i class="fa-regular fa-image"></i> Menu (hanya informasi)</p>
        ${menuHTML}
      </div>
      <div class="meal-actions">${action}</div>
    </article>
    <article class="panel">
      <div class="panel-heading"><div><h3>Pesanan Saya</h3></div></div>
      ${myOrders.length ? myOrders.map(o => `
        <div class="profile-row"><span>${esc(niceDate(o.mealDate))} · ${esc(MEAL_LABEL[o.meal] || o.meal)}</span><strong><span class="status-badge ${badgeClass(o.status)}">${esc(o.status)}</span></strong></div>`).join("")
        : `<p class="catalog-empty">Belum ada pesanan.</p>`}
    </article>`;
}

async function placeOrder() {
  if (busy) return;
  const meal = mealOf(profile);
  const c = cycle(meal, cfg);
  if (!c.isOpen) return message("Pemesanan sedang ditutup.");

  showDialog({
    title: `Pesan ${MEAL_LABEL[meal].toLowerCase()}?`,
    body: `<p>${esc(niceDate(c.target))}</p><p><small>Pesanan hanya bisa satu kali per hari. Setelah dibatalkan, Anda tidak bisa memesan lagi.</small></p>`,
    actions: [
      { label: "Kembali" },
      {
        label: "Ya, Pesan",
        cls: "primary-button",
        onClick: async () => {
          busy = true;
          try {
            const id = `${user.uid}_${c.target}_${meal}`;
            await setDoc(doc(db, "mealOrders", id), {
              orderId: id,
              uid: user.uid,
              name: profile.name,
              department: profile.department || "",
              idCardNo: profile.idCardNo || "",
              blockNo: profile.blockNo || "",
              workLocation: profile.workLocation || "",
              shift: profile.mealShift,
              meal,
              mealDate: c.target,
              status: "Menunggu",
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
            message("Pesanan terkirim. Menunggu persetujuan.");
            document.dispatchEvent(new Event("ga:data-changed"));
          } finally {
            busy = false;
          }
          await loadEmployee();
        }
      }
    ]
  });
}

function askCancel() {
  const meal = mealOf(profile);
  const label = MEAL_LABEL[meal].toLowerCase();
  const c = cycle(meal, cfg);

  showDialog({
    top: true,
    title: `Serius nih, besok nggak ${label}? 🍱`,
    body: `<p>Perut kosong nggak bisa kerja maksimal, lho.</p><p><small>Kalau dibatalkan, Anda tidak bisa memesan lagi untuk ${esc(niceDate(c.target))}.</small></p>`,
    actions: [
      { label: "Eh, jadi makan!", cls: "primary-button" },
      {
        label: "Ya, cancel",
        cls: "secondary-button",
        onClick: async () => {
          await updateDoc(doc(db, "mealOrders", `${user.uid}_${c.target}_${meal}`), {
            status: "Dibatalkan",
            updatedAt: serverTimestamp()
          });
          message("Pesanan dibatalkan.");
          document.dispatchEvent(new Event("ga:data-changed"));
          await loadEmployee();
        }
      }
    ]
  });
}

$("mealEmployeeView")?.addEventListener("click", event => {
  if (event.target.closest("#mealOrderButton")) placeOrder();
  else if (event.target.closest("#mealCancelButton")) askCancel();
});

/* ======================================================================
   TAMPILAN ADMIN
   ====================================================================== */

const adminValue = id => $(id)?.value || "";

function setTab(tab) {
  adminTab = tab;
  document.querySelectorAll("[data-meal-tab]").forEach(b =>
    b.classList.toggle("active", b.dataset.mealTab === tab));
  for (const name of ["orders", "recap", "menu", "settings"]) {
    const pane = $("mealTab-" + name);
    if (pane) pane.hidden = name !== tab;
  }
  loadAdminTab();
}

async function loadAdmin() {
  if (!user || !profile || !canMeals()) return;
  await loadConfig();

  const tomorrow = dayText(1);
  for (const id of ["moDate", "mrDate", "mmDate"]) {
    if ($(id) && !$(id).value) $(id).value = tomorrow;
  }

  const settingsTab = document.querySelector('[data-meal-tab="settings"]');
  if (settingsTab) settingsTab.hidden = !isMain();
  if (!isMain() && adminTab === "settings") adminTab = "orders";

  setTab(adminTab);
}

function loadAdminTab() {
  if (adminTab === "orders" || adminTab === "recap") return loadOrders();
  if (adminTab === "menu") return loadMenuEditor();
  if (adminTab === "settings") return loadSettings();
}

async function loadOrders() {
  const date = adminTab === "recap" ? adminValue("mrDate") : adminValue("moDate");
  if (!date) return;
  const current = generation;

  try {
    const snap = await getDocs(query(collection(db, "mealOrders"), where("mealDate", "==", date)));
    if (current !== generation) return;
    adminOrders = snap.docs.map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "id"));
  } catch (error) {
    console.error(error);
    adminOrders = [];
    message("Gagal memuat pesanan. Periksa izin akses dan firestore.rules.");
  }

  if (adminTab === "orders") renderOrders();
  else renderRecap();
}

function renderOrders() {
  const meal = adminValue("moMeal");
  const status = adminValue("moStatus");
  const rows = adminOrders.filter(o =>
    (!meal || o.meal === meal) && (!status || o.status === status));

  const count = s => adminOrders.filter(o => (!meal || o.meal === meal) && o.status === s).length;
  if ($("moSummary")) {
    $("moSummary").innerHTML = ["Menunggu", "Disetujui", "Ditolak", "Dibatalkan"]
      .map(s => `<span class="status-badge ${badgeClass(s)}">${s}: ${count(s)}</span>`).join(" ");
  }
  if ($("moApproveAll")) {
    $("moApproveAll").hidden = !isMain();
    $("moApproveAll").disabled = count("Menunggu") === 0;
  }

  const body = $("moTable");
  if (!body) return;
  body.innerHTML = rows.length ? rows.map(o => `
    <tr>
      <td data-label="Nama">${esc(o.name)}${o.department ? ` <small>(${esc(o.department)})</small>` : ""}</td>
      <td data-label="No ID Card">${esc(o.idCardNo || "-")}</td>
      <td data-label="No Blok">${esc(o.blockNo || "-")}</td>
      <td data-label="Lokasi Kerja">${esc(o.workLocation || "-")}</td>
      <td data-label="Makan">${esc(MEAL_LABEL[o.meal] || o.meal)}</td>
      <td data-label="Status"><span class="status-badge ${badgeClass(o.status)}">${esc(o.status)}</span></td>
      <td data-label="Aksi">${isMain() && o.status !== "Dibatalkan"
        ? `<div class="row-actions">
            ${o.status !== "Disetujui" ? `<button type="button" class="small-action" data-meal-act="Disetujui" data-id="${esc(o.id)}">Setujui</button>` : ""}
            ${o.status !== "Ditolak" ? `<button type="button" class="small-action delete" data-meal-act="Ditolak" data-id="${esc(o.id)}">Tolak</button>` : ""}
          </div>` : "-"}</td>
    </tr>`).join("")
    : `<tr><td colspan="7" class="empty-cell">Belum ada pesanan untuk tanggal ini.</td></tr>`;
}

function reviewFields(status) {
  return {
    status,
    reviewedBy: user.uid,
    reviewedByName: profile.name,
    updatedAt: serverTimestamp()
  };
}

$("moTable")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-meal-act]");
  if (!button || busy) return;
  button.disabled = true;
  try {
    await updateDoc(doc(db, "mealOrders", button.dataset.id), reviewFields(button.dataset.mealAct));
    document.dispatchEvent(new Event("ga:data-changed"));
    await loadOrders();
  } catch (error) {
    console.error(error);
    message(errorText(error));
    button.disabled = false;
  }
});

$("moApproveAll")?.addEventListener("click", async () => {
  const meal = adminValue("moMeal");
  const pending = adminOrders.filter(o => o.status === "Menunggu" && (!meal || o.meal === meal));
  if (!pending.length) return;
  busy = true;
  try {
    for (let i = 0; i < pending.length; i += 400) {
      const batch = writeBatch(db);
      pending.slice(i, i + 400).forEach(o =>
        batch.update(doc(db, "mealOrders", o.id), reviewFields("Disetujui")));
      await batch.commit();
    }
    message(`${pending.length} pesanan disetujui.`);
    document.dispatchEvent(new Event("ga:data-changed"));
    await loadOrders();
  } catch (error) {
    console.error(error);
    message(errorText(error));
  } finally {
    busy = false;
  }
});

["moDate", "moMeal", "moStatus"].forEach(id =>
  $(id)?.addEventListener("change", () => { id === "moDate" ? loadOrders() : renderOrders(); }));

/* ---------- Rekap vendor ---------- */

function recapData() {
  const meal = adminValue("mrMeal") || "siang";
  const approved = adminOrders.filter(o => o.status === "Disetujui" && o.meal === meal);
  const pending = adminOrders.filter(o => o.status === "Menunggu" && o.meal === meal).length;
  const groups = new Map();
  for (const o of approved) {
    const key = o.workLocation || "Tanpa lokasi";
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return { meal, approved, pending, groups: [...groups.entries()].sort((a, b) => b[1] - a[1]) };
}

function renderRecap() {
  const { meal, approved, pending, groups } = recapData();
  if ($("mrSummary")) {
    $("mrSummary").innerHTML = `
      <div class="recap-total"><strong>${approved.length}</strong><span>porsi ${esc(MEAL_LABEL[meal].toLowerCase())} disetujui</span></div>
      ${pending ? `<small><i class="fa-solid fa-circle-info"></i> ${pending} pesanan masih menunggu persetujuan dan belum dihitung.</small>` : ""}`;
  }
  const body = $("mrTable");
  if (body) {
    body.innerHTML = groups.length
      ? groups.map(([name, n]) => `<tr><td data-label="Lokasi Kerja">${esc(name)}</td><td data-label="Jumlah">${n}</td></tr>`).join("")
      : `<tr><td colspan="2" class="empty-cell">Belum ada pesanan yang disetujui.</td></tr>`;
  }
}

["mrDate"].forEach(id => $(id)?.addEventListener("change", loadOrders));
$("mrMeal")?.addEventListener("change", renderRecap);

$("mrCopy")?.addEventListener("click", async () => {
  const { meal, approved, groups } = recapData();
  const text =
    `Pesanan ${MEAL_LABEL[meal]} - ${niceDate(adminValue("mrDate"))}\n` +
    `Total: ${approved.length} porsi\n` +
    groups.map(([n, c]) => `- ${n}: ${c}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    message("Ringkasan disalin.");
  } catch {
    showDialog({ title: "Ringkasan", body: `<pre style="text-align:left;white-space:pre-wrap">${esc(text)}</pre>`, actions: [{ label: "Tutup", cls: "primary-button" }] });
  }
});

$("mrCsv")?.addEventListener("click", () => {
  const { meal, approved } = recapData();
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [["Nama", "No ID Card", "No Blok", "Lokasi Kerja", "Departemen", "Makan", "Tanggal"]]
    .concat(approved.map(o => [o.name, o.idCardNo, o.blockNo, o.workLocation, o.department, MEAL_LABEL[o.meal], o.mealDate]))
    .map(r => r.map(cell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `pesan-makan-${meal}-${adminValue("mrDate")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* ---------- Menu ---------- */

async function loadMenuEditor() {
  const date = adminValue("mmDate");
  const meal = adminValue("mmMeal") || "siang";
  menuPhoto = null;
  if ($("mmPhoto")) $("mmPhoto").value = "";
  if (!date) return;

  let data = null;
  try {
    const snap = await getDoc(doc(db, "mealMenus", `${date}_${meal}`));
    data = snap.exists() ? snap.data() : null;
  } catch (error) {
    console.warn(error?.code);
  }
  if ($("mmTitle")) $("mmTitle").value = data?.title || "";
  renderMenuPreview(data?.photoData || "");
  if ($("mmDelete")) $("mmDelete").hidden = !data;
  $("mmEditor").dataset.existingPhoto = data?.photoData || "";
}

function renderMenuPreview(src) {
  const box = $("mmPreview");
  if (box) box.innerHTML = src ? `<img class="meal-photo" src="${esc(src)}" alt="Foto menu">` : `<p class="catalog-empty">Belum ada foto menu.</p>`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("File bukan gambar yang valid.")); };
    img.src = url;
  });
}

async function compressPhoto(file) {
  if (!file || !String(file.type).startsWith("image/")) throw new Error("Pilih file gambar (JPG atau PNG).");
  const img = await loadImage(file);
  let max = 1000;
  let quality = 0.82;

  for (let i = 0; i < 12; i++) {
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL("image/jpeg", quality);
    if (out.length <= 120000) return out;
    quality -= 0.1;
    if (quality < 0.4) { quality = 0.75; max = Math.round(max * 0.8); }
  }
  throw new Error("Foto terlalu besar. Pilih foto lain.");
}

$("mmPhoto")?.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    menuPhoto = await compressPhoto(file);
    renderMenuPreview(menuPhoto);
  } catch (error) {
    event.target.value = "";
    menuPhoto = null;
    message(error.message);
  }
});

["mmDate", "mmMeal"].forEach(id => $(id)?.addEventListener("change", loadMenuEditor));

$("mmSave")?.addEventListener("click", async () => {
  if (busy) return;
  const date = adminValue("mmDate");
  const meal = adminValue("mmMeal") || "siang";
  const title = adminValue("mmTitle").trim();
  if (!date) return message("Pilih tanggal.");
  if (title.length > 500) return message("Keterangan menu maksimal 500 karakter.");

  const photoData = menuPhoto !== null ? menuPhoto : ($("mmEditor").dataset.existingPhoto || "");
  if (!title && !photoData) return message("Isi keterangan atau unggah foto menu.");

  busy = true;
  try {
    await setDoc(doc(db, "mealMenus", `${date}_${meal}`), {
      date, meal, title, photoData,
      updatedBy: user.uid,
      updatedByName: profile.name,
      updatedAt: serverTimestamp()
    });
    message("Menu disimpan.");
    await loadMenuEditor();
  } catch (error) {
    console.error(error);
    message(errorText(error));
  } finally {
    busy = false;
  }
});

$("mmDelete")?.addEventListener("click", async () => {
  try {
    await deleteDoc(doc(db, "mealMenus", `${adminValue("mmDate")}_${adminValue("mmMeal") || "siang"}`));
    message("Menu dihapus.");
    await loadMenuEditor();
  } catch (error) {
    console.error(error);
    message(errorText(error));
  }
});

/* ---------- Pengaturan: jam & shift ---------- */

async function loadSettings() {
  if (!isMain()) return;
  const c = cfg || DEFAULT_CFG;
  if ($("cfgLunchOpen")) {
    $("cfgLunchOpen").value = minToText(c.lunchOpen);
    $("cfgLunchClose").value = minToText(c.lunchClose);
    $("cfgDinnerOpen").value = minToText(c.dinnerOpen);
    $("cfgDinnerClose").value = minToText(c.dinnerClose);
  }

  const current = generation;
  try {
    const snap = await getDocs(collection(db, "users"));
    if (current !== generation) return;
    shiftUsers = snap.docs.map(d => ({ ...d.data(), id: d.id }))
      .filter(u => u.role === "employee")
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "id"));
  } catch (error) {
    console.error(error);
    shiftUsers = [];
  }
  renderShifts();
}

$("cfgSave")?.addEventListener("click", async () => {
  const next = {
    lunchOpen: textToMin(adminValue("cfgLunchOpen")),
    lunchClose: textToMin(adminValue("cfgLunchClose")),
    dinnerOpen: textToMin(adminValue("cfgDinnerOpen")),
    dinnerClose: textToMin(adminValue("cfgDinnerClose"))
  };
  if (Object.values(next).some(Number.isNaN)) return message("Isi semua jam.");
  if (next.lunchOpen === next.lunchClose || next.dinnerOpen === next.dinnerClose) {
    return message("Jam buka dan tutup tidak boleh sama.");
  }
  try {
    await setDoc(doc(db, "settings", "mealConfig"), next);
    cfg = next;
    message("Jam pemesanan disimpan.");
  } catch (error) {
    console.error(error);
    message(errorText(error));
  }
});

function filteredShiftUsers() {
  const term = adminValue("shiftSearch").trim().toLocaleLowerCase("id-ID");
  const filter = adminValue("shiftFilter");
  return shiftUsers.filter(u => {
    if (filter === "none" && u.mealShift) return false;
    if (filter === "pagi" && u.mealShift !== "pagi") return false;
    if (filter === "malam" && u.mealShift !== "malam") return false;
    if (!term) return true;
    return [u.name, u.username, u.department, u.idCardNo, u.email].join(" ")
      .toLocaleLowerCase("id-ID").includes(term);
  });
}

function renderShifts() {
  const body = $("shiftTable");
  if (!body) return;
  const rows = filteredShiftUsers();
  const unset = shiftUsers.filter(u => !u.mealShift).length;
  if ($("shiftSummary")) {
    $("shiftSummary").textContent = `${shiftUsers.length} karyawan · ${unset} belum diatur shift · menampilkan ${Math.min(rows.length, 100)} dari ${rows.length}`;
  }
  body.innerHTML = rows.length
    ? rows.slice(0, 100).map(u => `
      <tr>
        <td data-label="Nama">${esc(u.name || "-")}</td>
        <td data-label="Departemen">${esc(u.department || "-")}</td>
        <td data-label="No ID Card">${esc(u.idCardNo || "-")}</td>
        <td data-label="Shift"><select data-shift-user="${esc(u.id)}">
          <option value="" ${!u.mealShift ? "selected" : ""}>Belum diatur</option>
          <option value="pagi" ${u.mealShift === "pagi" ? "selected" : ""}>Shift Pagi (makan siang)</option>
          <option value="malam" ${u.mealShift === "malam" ? "selected" : ""}>Shift Malam (makan malam)</option>
        </select></td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="empty-cell">Tidak ada karyawan.</td></tr>`;
}

$("shiftSearch")?.addEventListener("input", renderShifts);
$("shiftFilter")?.addEventListener("change", renderShifts);

$("shiftTable")?.addEventListener("change", async event => {
  const select = event.target.closest("[data-shift-user]");
  if (!select) return;
  try {
    await updateDoc(doc(db, "users", select.dataset.shiftUser), { mealShift: select.value });
    const u = shiftUsers.find(x => x.id === select.dataset.shiftUser);
    if (u) u.mealShift = select.value;
    renderShifts();
  } catch (error) {
    console.error(error);
    message(errorText(error));
    loadSettings();
  }
});

$("shiftBulkButton")?.addEventListener("click", () => {
  const value = adminValue("shiftBulk");
  const rows = filteredShiftUsers();
  if (!rows.length) return message("Tidak ada karyawan pada daftar ini.");

  const label = { pagi: "Shift Pagi", malam: "Shift Malam", "": "Belum diatur" }[value];
  showDialog({
    title: "Terapkan shift?",
    body: `<p>${rows.length} karyawan pada daftar saat ini akan diubah menjadi <strong>${esc(label)}</strong>.</p>`,
    actions: [
      { label: "Batal" },
      {
        label: "Terapkan",
        cls: "primary-button",
        onClick: async () => {
          for (let i = 0; i < rows.length; i += 400) {
            const batch = writeBatch(db);
            rows.slice(i, i + 400).forEach(u =>
              batch.update(doc(db, "users", u.id), { mealShift: value }));
            await batch.commit();
          }
          message("Shift diperbarui.");
          await loadSettings();
        }
      }
    ]
  });
});

document.querySelectorAll("[data-meal-tab]").forEach(b =>
  b.addEventListener("click", () => setTab(b.dataset.mealTab)));

/* ---------- Siklus halaman ---------- */

function activePage() {
  return document.querySelector(".page.active")?.id || "";
}

function refresh() {
  const page = activePage();
  if (page === "page-meals" && profile?.role === "employee") loadEmployee();
  else if (page === "page-canteen" && isStaff()) loadAdmin();
}

document.addEventListener("ga:page", event => {
  if (["meals", "canteen"].includes(event.detail)) refresh();
});

// Status jam buka/tutup diperbarui tanpa memuat ulang data.
setInterval(() => {
  if (activePage() === "page-meals" && profile?.role === "employee" && !$("mealModal")) renderEmployee();
}, 30000);

await authPersistenceReady;

onAuthStateChanged(auth, async current => {
  const thisGeneration = ++generation;

  user = null;
  profile = null;
  cfg = null;
  myOrder = null;
  myMenu = null;
  myOrders = [];
  closeModal();
  renderEmployee();

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
    refresh();
  } catch (error) {
    if (thisGeneration !== generation) return;
    console.error("Gagal memuat modul pesan makan:", error);
  }
});
