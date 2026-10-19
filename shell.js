import { auth, db, authPersistenceReady } from "./firebase-init.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  writeBatch,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

import {
  MENUS,
  MENU_KEYS,
  ADMIN_ROLES,
  hasPerm,
  permissionMap
} from "./perms.js";

const $ = id => document.getElementById(id);

const ROLE_LABELS = {
  main_admin: "Main Admin",
  ga_admin: "GA Admin",
  admin_operational: "Admin Operational",
  employee: "Karyawan"
};

const STAFF_ROLES = ["main_admin", "ga_admin", "admin_operational"];
const BELL_REFRESH_MS = 60000;

// Kotak menu di beranda (admin). "page" = halaman tujuan.
const STAFF_TILES = [
  { id: "inventory", perm: ["inventory", "requests"], gate: "inventory", page: "inventory-hub", label: "Inventory & Stok", zh: "出入库", icon: "fa-box" },
  { id: "procurement", perm: ["procurement"], gate: "procurement", page: "procurement", label: "Pengadaan & Arsip PO", zh: "采购与归档", icon: "fa-file-contract" },
  { id: "assets", perm: ["assets"], gate: "assets", page: "assets", label: "Aset Perusahaan", zh: "公司资产", icon: "fa-laptop" },
  { id: "vehicles", perm: ["vehicles"], gate: "vehicles", page: "vehicles", label: "Kendaraan", zh: "车辆", icon: "fa-car" },
  { id: "repairs", perm: ["repairs"], gate: "repairs", page: "repairs", label: "Fasilitas & Perbaikan", zh: "维修设施", icon: "fa-screwdriver-wrench" },
  { id: "meals", perm: ["meals"], gate: "meals", page: "canteen", label: "Pesan Makan Siang & Malam", zh: "预订餐", icon: "fa-utensils" },
  { id: "vendors", perm: ["vendors"], gate: "vendors", page: "vendors", label: "Vendor", zh: "供应商", icon: "fa-truck-field" }
];

const EMPLOYEE_TILES = [
  { id: "requests", page: "requests", label: "Permintaan Barang", zh: "物品申请", icon: "fa-clipboard-list" },
  { id: "repairs", page: "repairs", label: "Fasilitas & Perbaikan", zh: "维修设施", icon: "fa-screwdriver-wrench" }
];

const HUB_TILES = [
  { gate: "inventory", page: "inventory", label: "Stok In & Stok Out", sub: "Panel pengelolaan stok", icon: "fa-cubes" },
  { gate: "requests", page: "requests", label: "Permintaan Karyawan", sub: "Pengajuan dan persetujuan", icon: "fa-clipboard-list" }
];

let user = null;
let profile = null;
let generation = 0;
let currentPage = "home";
let bellTimer = null;
let data = { service: [], repairs: [], access: [] };
let notifFilter = "all"; // "all" | "unread"

const isStaff = () => !!profile && STAFF_ROLES.includes(profile.role);
const isMain = () => profile?.role === "main_admin";
const can = key => hasPerm(profile, key);

const esc = value =>
  String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

function toast(text) {
  if (typeof window.notify === "function") window.notify(text);
  else alert(text);
}

function errorText(error) {
  if (error?.code === "permission-denied") {
    return "Rules menolak tindakan ini. Pastikan firestore.rules terbaru sudah dipublikasikan.";
  }
  return error?.message || "Terjadi kesalahan.";
}

/* ---------- Modal ringkas ---------- */

function closeShellModal() {
  $("shellModal")?.remove();
}

function showModal({ title, icon, body, actions, wide = false }) {
  closeShellModal();

  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "shellModal";
  modal.innerHTML = `
    <div class="modal-card ${wide ? "" : "dialog-card"}">
      ${icon ? `<div class="dialog-icon"><i class="fa-solid ${esc(icon)}"></i></div>` : ""}
      ${title ? `<h2>${esc(title)}</h2>` : ""}
      <div class="shell-modal-body">${body}</div>
      <div class="modal-actions">
        ${actions.map((a, i) =>
          `<button type="button" class="${esc(a.cls || "secondary-button")}" data-act="${i}">${esc(a.label)}</button>`
        ).join("")}
      </div>
    </div>`;

  modal.addEventListener("click", async event => {
    if (event.target === modal) return closeShellModal();

    const button = event.target.closest("[data-act]");
    if (!button || button.disabled) return;

    const action = actions[Number(button.dataset.act)];
    if (!action) return;

    if (!action.onClick) return closeShellModal();

    button.disabled = true;
    try {
      const result = await action.onClick(modal);
      if (result !== false) closeShellModal();
    } catch (error) {
      console.error(error);
      toast(errorText(error));
      button.disabled = false;
    }
  });

  document.body.appendChild(modal);
  return modal;
}

/* ---------- Navigasi ---------- */

function backTarget(page) {
  if (page === "home") return null;
  if (["inventory", "requests"].includes(page) && isStaff()) {
    return { page: "inventory-hub", label: "Inventory & Stok" };
  }
  return { page: "home", label: "Beranda" };
}

function goto(page) {
  const section = $("page-" + page);
  if (!section) return;

  document.querySelectorAll(".page").forEach(el => el.classList.remove("active"));
  section.classList.add("active");
  currentPage = page;

  const back = backTarget(page);
  const bar = $("pageBack");
  if (bar) {
    bar.hidden = !back;
    bar.dataset.target = back?.page || "";
  }
  if ($("backLabel")) $("backLabel").textContent = back?.label || "Beranda";

  closeMenus();
  window.scrollTo(0, 0);

  if (page === "users") renderUsersPage();
  if (page === "settings") renderSettingsPage();
  if (page === "notifications") renderNotificationsPage();
  if (page === "history") renderEmployeeHistory();
  if (page === "employee-vehicles") renderEmployeeVehiclePage();
  if (page === "vehicles") renderAdminVehiclePage();

  if (typeof window.renderAll === "function") {
    try { window.renderAll(); } catch (error) { console.error(error); }
  }
}

// Halaman lama memanggil showPage(...) lewat onclick; arahkan ke sini.
window.showPage = name => goto(name);

/* ---------- Dialog hak akses ---------- */

function accessStatus(key) {
  return data.access.find(a => a.uid === user?.uid && a.menu === key)?.status || "";
}

function askAccess(key) {
  const label = MENUS[key] || key;

  if (isMain()) return;

  if (accessStatus(key) === "Menunggu") {
    showModal({
      icon: "fa-hourglass-half",
      body: `<p>Permintaan akses untuk <strong>${esc(label)}</strong> sudah dikirim dan menunggu persetujuan Main Admin.</p>`,
      actions: [{ label: "Tutup", cls: "primary-button" }]
    });
    return;
  }

  showModal({
    icon: "fa-lock",
    body: `<p>Akun anda tidak ada hak akses, mohon meminta persetujuan main admin.</p><p><small>Menu: ${esc(label)}</small></p>`,
    actions: [
      { label: "Batal" },
      {
        label: "Minta Akses",
        cls: "primary-button",
        onClick: async () => {
          await sendAccessRequest(key);
          toast("Permintaan akses dikirim ke Main Admin.");
        }
      }
    ]
  });
}

async function sendAccessRequest(key) {
  const id = `${user.uid}_${key}`;
  const existing = data.access.find(a => a.id === id);

  if (existing) {
    await updateDoc(doc(db, "accessRequests", id), {
      status: "Menunggu",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } else {
    await setDoc(doc(db, "accessRequests", id), {
      uid: user.uid,
      userName: profile.name,
      role: profile.role,
      menu: key,
      menuLabel: MENUS[key],
      status: "Menunggu",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  await loadBell();
}

// Buka halaman bila punya hak akses, bila tidak tampilkan dialog.
function openGuarded(gate, page) {
  if (!isStaff() || can(gate)) return goto(page);
  askAccess(gate);
}

/* ---------- Kotak menu ---------- */

function tileHTML(tile, locked, index, group) {
  return `
    <button type="button" class="tile${locked ? " locked" : ""}" data-group="${group}" data-index="${index}">
      ${locked ? `<i class="fa-solid fa-lock lock" aria-hidden="true"></i>` : ""}
      <i class="fa-solid ${esc(tile.icon)} tile-icon" aria-hidden="true"></i>
      <strong>${esc(tile.label)}</strong>
      <small>${esc(tile.zh || tile.sub || "")}</small>
    </button>`;
}

async function renderEmployeeHistory(filter = "all") {
  const tbody = $("employeeHistoryTable");
  if (!tbody || !user) return;

  const uid = user.uid;
  const results = await Promise.allSettled([
    (filter === "all" || filter === "service") ? getDocs(query(collection(db, "serviceRequests"), where("requesterUid", "==", uid))) : Promise.resolve(null),
    (filter === "all" || filter === "procurement") ? getDocs(query(collection(db, "procurementRequisitions"), where("requesterUid", "==", uid))) : Promise.resolve(null),
    (filter === "all" || filter === "repair") ? getDocs(query(collection(db, "repairRequests"), where("requesterUid", "==", uid))) : Promise.resolve(null),
    (filter === "all" || filter === "vehicle") ? getDocs(query(collection(db, "vehicleRequests"), where("requesterUid", "==", uid))) : Promise.resolve(null)
  ]);

  let list = [];
  let hasError = false;

  const [serviceRes, prRes, repairRes, vehicleRes] = results;

  if (serviceRes.status === "fulfilled" && serviceRes.value) {
    serviceRes.value.docs.forEach(d => {
      const item = d.data();
      list.push({
        id: d.id,
        raw: item,
        kind: "service",
        type: "Permintaan Barang",
        date: item.createdAt?.toDate ? item.createdAt.toDate().toLocaleDateString("id-ID") : "-",
        rawDate: seconds(item.createdAt),
        desc: `${item.ticketNo || d.id} — ${item.itemName || "-"} (${item.quantity || 1} ${item.unit || "unit"})`,
        status: item.status || "Menunggu"
      });
    });
  } else if (serviceRes.status === "rejected") {
    console.warn("Gagal memuat serviceRequests:", serviceRes.reason);
    hasError = true;
  }

  if (prRes.status === "fulfilled" && prRes.value) {
    prRes.value.docs.forEach(d => {
      const item = d.data();
      list.push({
        id: d.id,
        raw: item,
        kind: "procurement",
        type: "Pembelian (PR)",
        date: item.createdAt?.toDate ? item.createdAt.toDate().toLocaleDateString("id-ID") : "-",
        rawDate: seconds(item.createdAt),
        desc: `${item.prNo || "PR"} — ${item.itemName || item.title || (item.items?.[0]?.itemName) || "Pengadaan Barang"}`,
        status: item.status || "Diajukan"
      });
    });
  } else if (prRes.status === "rejected") {
    console.warn("Gagal memuat procurementRequisitions:", prRes.reason);
    hasError = true;
  }

  if (repairRes.status === "fulfilled" && repairRes.value) {
    repairRes.value.docs.forEach(d => {
      const item = d.data();
      list.push({
        id: d.id,
        raw: item,
        kind: "repair",
        type: "Lapor Perbaikan",
        date: item.createdAt?.toDate ? item.createdAt.toDate().toLocaleDateString("id-ID") : "-",
        rawDate: seconds(item.createdAt),
        desc: `${item.ticketNo || d.id} — ${item.category || "-"} (${item.location || "-"})`,
        status: item.status || "Baru"
      });
    });
  } else if (repairRes.status === "rejected") {
    console.warn("Gagal memuat repairRequests:", repairRes.reason);
    hasError = true;
  }

  if (vehicleRes.status === "fulfilled" && vehicleRes.value) {
    vehicleRes.value.docs.forEach(d => {
      const item = d.data();
      list.push({
        id: d.id,
        raw: item,
        kind: "vehicle",
        type: "Permintaan Kendaraan",
        date: item.createdAt?.toDate ? item.createdAt.toDate().toLocaleDateString("id-ID") : "-",
        rawDate: seconds(item.createdAt),
        desc: `${item.ticketNo || d.id} — ${item.destination || "Tujuan"} (${item.travelDate || "-"})`,
        status: item.status || "Pending"
      });
    });
  } else if (vehicleRes.status === "rejected") {
    console.warn("Gagal memuat vehicleRequests:", vehicleRes.reason);
    hasError = true;
  }

  list.sort((a, b) => b.rawDate - a.rawDate);
  window.__historyList = list;

  if (list.length > 0) {
    tbody.innerHTML = list.map((item, idx) => `
      <tr>
        <td>${esc(item.date)}</td>
        <td><strong>${esc(item.type)}</strong></td>
        <td>${esc(item.desc)}</td>
        <td>${badge(item.status)}</td>
        <td><button type="button" class="small-action" data-hist-idx="${idx}">Detail</button></td>
      </tr>
    `).join("") + (hasError ? `<tr><td colspan="5" class="notice" style="text-align:center"><small><i class="fa-solid fa-triangle-exclamation"></i> Sebagian riwayat tidak dapat dimuat karena kendala izin atau koneksi.</small></td></tr>` : "");
  } else if (hasError) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">Gagal memuat sebagian riwayat. Pastikan firestore.rules mengizinkan akses.</td></tr>`;
  } else {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">Belum ada riwayat pengajuan.</td></tr>`;
  }
}

async function renderEmployeeHomeWidget() {
  const widget = $("employeeWelcomeWidget");
  if (!widget) return;

  const now = new Date();
  const dateStr = now.toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  let quoteText = "Tetap semangat dan berikan yang terbaik untuk setiap pekerjaan hari ini.";
  let quoteAuthor = "GA Management";

  try {
    const qSnap = await getDocs(query(collection(db, "motivationalQuotes"), where("active", "==", true)));
    if (!qSnap.empty) {
      const quotes = qSnap.docs.map(d => d.data());
      const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 1000 / 60 / 60 / 24);
      const selected = quotes[dayOfYear % quotes.length];
      if (selected?.quote) {
        quoteText = selected.quote;
        quoteAuthor = selected.author || "Anonim";
      }
    }
  } catch (err) {
    console.warn("Could not load quotes:", err);
  }

  let announcementsHTML = "";
  try {
    const aSnap = await getDocs(query(collection(db, "announcements"), where("active", "==", true)));
    if (!aSnap.empty) {
      const anns = aSnap.docs.map(d => d.data());
      announcementsHTML = anns.slice(0, 3).map(a => `
        <div class="announcement-card-item">
          <div class="announcement-head">
            <strong class="announcement-title"><i class="fa-solid fa-bullhorn"></i> ${esc(a.title)}</strong>
            <span class="status-badge">${esc(a.category || "Umum")}</span>
          </div>
          <p class="announcement-content">${esc(a.content)}</p>
          <small class="announcement-date"><i class="fa-regular fa-clock"></i> ${esc(a.date || "")}</small>
        </div>
      `).join("");
    }
  } catch (err) {
    console.warn("Could not load announcements:", err);
  }

  if (!announcementsHTML) {
    announcementsHTML = `
      <div class="announcement-card-item">
        <div class="announcement-head">
          <strong class="announcement-title"><i class="fa-solid fa-bullhorn"></i> Informasi Operasional GA</strong>
          <span class="status-badge">Operasional</span>
        </div>
        <p class="announcement-content">Pengajuan barang, laporan perbaikan fasilitas, dan booking kendaraan operasional dapat dilakukan langsung melalui navigasi bawah. Tim GA siap membantu kebutuhan operasional Anda.</p>
      </div>
    `;
  }

  widget.innerHTML = `
    <div class="employee-welcome-card">
      <div class="greeting-header" style="margin-bottom: 12px;">
        <h2 class="greeting-title" style="font-size: 1.35rem; font-weight: 700; margin: 0 0 4px 0;">Selamat Datang, ${esc(profile?.name || "Karyawan")}!</h2>
        <div class="greeting-date" style="font-size: 0.88rem; color: #D1E7DD;"><i class="fa-regular fa-calendar-days"></i> ${esc(dateStr)} ${profile?.department ? `· ${esc(profile.department)}` : ""}</div>
      </div>

      <div class="employee-quote-box" style="margin-bottom: 16px;">
        <div style="font-size: 0.95rem; font-weight: 500;">"${esc(quoteText)}"</div>
        <small style="display: block; text-align: right; margin-top: 4px; color: #A3E635;">— ${esc(quoteAuthor)}</small>
      </div>

      <div class="employee-news-box">
        <h3 style="font-size: 1rem; font-weight: 600; color: #A3E635; margin-bottom: 10px; display: flex; align-items: center; gap: 8px;">
          <i class="fa-solid fa-newspaper"></i> Pengumuman & Informasi GA
        </h3>
        <div class="announcement-container" style="display: flex; flex-direction: column; gap: 10px;">
          ${announcementsHTML}
        </div>
      </div>
    </div>
  `;
}

function renderHome() {
  const grid = $("tileGrid");
  const title = $("homeTitle");
  const homeNote = document.querySelector(".home-note");
  if (!grid) return;

  if (!profile) {
    grid.innerHTML = "";
    return;
  }

  const welcomeWidget = $("employeeWelcomeWidget");
  const bottomNav = $("mobileBottomNav");

  if (profile.role === "employee") {
    if (bottomNav) bottomNav.hidden = false;
    if (welcomeWidget) {
      welcomeWidget.hidden = false;
      renderEmployeeHomeWidget();
    }
    if (title) title.hidden = true;
    grid.hidden = true;
    grid.innerHTML = "";
    if (homeNote) homeNote.hidden = true;
  } else if (profile.role === "vendor") {
    if (bottomNav) bottomNav.hidden = true;
    if (welcomeWidget) welcomeWidget.hidden = true;
    if (title) {
      title.textContent = "MENU VENDOR PORTAL";
      title.hidden = false;
    }
    grid.hidden = false;
    grid.innerHTML = `
      <button type="button" class="tile" data-group="vendor" data-index="0">
        <i class="fa-solid fa-store tile-icon" aria-hidden="true"></i>
        <strong>Vendor Portal</strong>
        <small>Daftar PO & Katalog Vendor</small>
      </button>
    `;
    if (homeNote) homeNote.hidden = false;
  } else {
    // Admin / Staff roles
    if (bottomNav) bottomNav.hidden = true;
    if (welcomeWidget) welcomeWidget.hidden = true;
    if (title) {
      title.textContent = isMain() ? "MENU MAIN ADMIN" : "MENU ADMIN GA";
      title.hidden = false;
    }
    grid.hidden = false;
    grid.innerHTML = STAFF_TILES.map((tile, i) => {
      const allowed = tile.perm.some(can);
      return tileHTML(tile, !allowed, i, "staff");
    }).join("");
    if (homeNote) homeNote.hidden = false;
  }

  const hub = $("hubGrid");
  if (hub) {
    hub.innerHTML = HUB_TILES.map((tile, i) =>
      tileHTML(tile, isStaff() && !can(tile.gate), i, "hub")
    ).join("");
  }
}

function onTileClick(event) {
  const button = event.target.closest(".tile");
  if (!button) return;

  const index = Number(button.dataset.index);
  const group = button.dataset.group;

  if (group === "employee") {
    return goto(EMPLOYEE_TILES[index].page);
  }

  if (group === "hub") {
    const tile = HUB_TILES[index];
    return openGuarded(tile.gate, tile.page);
  }

  if (group === "vendor") {
    return goto("vendor-portal");
  }

  const tile = STAFF_TILES[index];
  if (tile.perm.some(can)) return goto(tile.page);
  askAccess(tile.gate);
}

/* ---------- Header: avatar & menu profil ---------- */

function initials(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0].toUpperCase())
    .join("") || "GA";
}

const safePhoto = value =>
  typeof value === "string" && value.startsWith("data:image/jpeg;base64,");

function renderAvatar() {
  const button = $("avatarButton");
  const anchor = $("avatarMenuAnchor") || button?.closest(".menu-anchor");
  if (!button || !profile) return;

  if (profile.role === "employee") {
    if (anchor) anchor.hidden = true;
  } else {
    if (anchor) anchor.hidden = false;
  }

  if (safePhoto(profile.photoData)) {
    button.innerHTML = `<img src="${esc(profile.photoData)}" alt="Foto profil">`;
  } else {
    button.textContent = initials(profile.name);
  }

  if ($("menuName")) $("menuName").textContent = profile.name || "Pengguna";
  if ($("menuRole")) $("menuRole").textContent = ROLE_LABELS[profile.role] || "";

  const staff = isStaff();
  document.querySelectorAll("[data-profile-action]").forEach(item => {
    const action = item.dataset.profileAction;
    item.hidden =
      (action === "settings" && !staff) ||
      (action === "users" && !staff) ||
      (action === "reports" && !staff);
  });
}

function closeMenus() {
  for (const id of ["bellPanel", "profileMenu"]) {
    const panel = $(id);
    if (panel) panel.hidden = true;
  }
  $("bellButton")?.setAttribute("aria-expanded", "false");
  $("avatarButton")?.setAttribute("aria-expanded", "false");
}

function toggleMenu(panelId, buttonId) {
  const panel = $(panelId);
  if (!panel) return;
  const open = panel.hidden;
  closeMenus();
  panel.hidden = !open;
  $(buttonId)?.setAttribute("aria-expanded", String(open));
  return open;
}

/* ---------- Foto profil ---------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("File bukan gambar yang valid.")); };
    img.src = url;
  });
}

async function compressAvatar(file) {
  if (!file || !String(file.type).startsWith("image/")) {
    throw new Error("Pilih file gambar (JPG atau PNG).");
  }

  const img = await loadImage(file);
  let side = 256;
  let quality = 0.85;

  for (let i = 0; i < 10; i++) {
    const size = Math.min(img.width, img.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, side, side);
    ctx.drawImage(
      img,
      (img.width - size) / 2, (img.height - size) / 2, size, size,
      0, 0, side, side
    );

    const out = canvas.toDataURL("image/jpeg", quality);
    if (out.length <= 60000) return out;

    quality -= 0.1;
    if (quality < 0.4) { quality = 0.8; side = Math.round(side * 0.8); }
  }

  throw new Error("Foto terlalu besar. Pilih foto lain.");
}

/* ---------- Profil ---------- */

function openProfile() {
  closeMenus();

  let newPhoto = "";
  let pending = null;

  const modal = showModal({
    wide: true,
    title: "Profil",
    body: `
      <div class="form-fields">
        <div class="field full"><div class="avatar-edit">
          <span class="session-avatar" id="profilePreview">${
            safePhoto(profile.photoData)
              ? `<img src="${esc(profile.photoData)}" alt="Foto profil">`
              : esc(initials(profile.name))
          }</span>
          <div><label>Foto Profil</label><input type="file" id="profilePhoto" accept="image/*"></div>
        </div></div>
        <div class="field full"><label>Nama</label><input id="profileName" maxlength="60" value="${esc(profile.name || "")}"></div>
        <div class="field full"><label>Nama Pengguna</label><input id="profileUsername" maxlength="30" value="${esc(profile.username || "")}" placeholder="huruf, angka, titik, strip"></div>
        <div class="field full"><label>Email</label><div>${esc(user.email || "-")}</div></div>
        <div class="field full"><label>Role</label><div>${esc(ROLE_LABELS[profile.role] || "-")}</div></div>
      </div>`,
    actions: [
      { label: "Batal" },
      {
        label: "Simpan",
        cls: "primary-button",
        onClick: async root => {
          if (pending) await pending;

          const name = root.querySelector("#profileName").value.trim();
          const username = root.querySelector("#profileUsername").value.trim();

          if (!name || name.length > 60) throw new Error("Nama wajib diisi, maksimal 60 karakter.");
          if (!/^[A-Za-z0-9._-]{0,30}$/.test(username)) {
            throw new Error("Nama pengguna hanya boleh huruf, angka, titik, garis bawah, dan strip (maks 30).");
          }

          const update = { name, username };
          if (newPhoto) update.photoData = newPhoto;

          await updateDoc(doc(db, "users", user.uid), update);

          const nameChanged = name !== profile.name;
          profile = { ...profile, ...update };
          renderAvatar();

          toast("Profil disimpan.");
          if (nameChanged) setTimeout(() => location.reload(), 900);
        }
      }
    ]
  });

  const input = modal.querySelector("#profilePhoto");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    newPhoto = "";
    if (!file) return;

    pending = compressAvatar(file)
      .then(out => {
        newPhoto = out;
        modal.querySelector("#profilePreview").innerHTML =
          `<img src="${esc(out)}" alt="Pratinjau foto">`;
      })
      .catch(error => {
        input.value = "";
        toast(error.message);
      });
  });
}

/* ---------- Halaman Pengaturan & Pengguna Akses ---------- */

async function renderSettingsPage() {
  const manage = ["main_admin", "ga_admin"].includes(profile?.role) && can("requests");
  const isMainAdmin = profile?.role === "main_admin";

  const handoverPanel = $("handoverSettingsPanel");
  if (handoverPanel) handoverPanel.hidden = !manage;

  const quotesPanel = $("quotesSettingsPanel");
  if (quotesPanel) quotesPanel.hidden = !isMainAdmin;

  const announcementsPanel = $("announcementsSettingsPanel");
  if (announcementsPanel) announcementsPanel.hidden = !manage;

  const poConfigPanel = $("poConfigSettingsPanel");
  if (poConfigPanel) poConfigPanel.hidden = !isMainAdmin;

  const vendorMappingPanel = $("vendorMappingPanel");
  if (vendorMappingPanel) vendorMappingPanel.hidden = !isMainAdmin;

  const hasAnySettings = manage || isMainAdmin;
  if ($("settingsEmpty")) $("settingsEmpty").hidden = hasAnySettings;

  if (isMainAdmin) {
    loadQuotesSettings();
    loadPoConfigSettings();
    loadVendorMappingSettings();
  }
  if (manage) {
    loadAnnouncementsSettings();
  }
}

async function loadQuotesSettings() {
  const table = $("quotesTable");
  if (!table) return;
  try {
    const snap = await getDocs(collection(db, "motivationalQuotes"));
    const quotes = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    table.innerHTML = quotes.length ? quotes.map(q => `
      <tr>
        <td>${esc(q.quote || "-")}</td>
        <td>${esc(q.author || "Anonim")}</td>
        <td><span class="status-badge ${q.active !== false ? "" : "neutral"}">${q.active !== false ? "Aktif" : "Nonaktif"}</span></td>
        <td>
          <button type="button" class="small-action" data-quote-toggle="${esc(q.id)}" data-active="${q.active !== false}">
            ${q.active !== false ? "Nonaktifkan" : "Aktifkan"}
          </button>
        </td>
      </tr>
    `).join("") : `<tr><td colspan="4" class="empty-cell">Belum ada kata motivasi. Silakan tambah baru.</td></tr>`;
  } catch (err) {
    console.error("Gagal load quote settings:", err);
    table.innerHTML = `<tr><td colspan="4" class="empty-cell">Gagal memuat quote.</td></tr>`;
  }
}

async function loadAnnouncementsSettings() {
  const table = $("announcementsTable");
  if (!table) return;
  try {
    const snap = await getDocs(collection(db, "announcements"));
    const list = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    table.innerHTML = list.length ? list.map(a => `
      <tr>
        <td><strong>${esc(a.title || "-")}</strong><br><small>${esc(a.content || "")}</small></td>
        <td>${esc(a.category || "Umum")}</td>
        <td>${esc(a.date || "-")}</td>
        <td><span class="status-badge ${a.active !== false ? "" : "neutral"}">${a.active !== false ? "Aktif" : "Arsip"}</span></td>
        <td>
          <button type="button" class="small-action" data-ann-toggle="${esc(a.id)}" data-active="${a.active !== false}">
            ${a.active !== false ? "Arsipkan" : "Aktifkan"}
          </button>
        </td>
      </tr>
    `).join("") : `<tr><td colspan="5" class="empty-cell">Belum ada pengumuman GA.</td></tr>`;
  } catch (err) {
    console.error("Gagal load announcements:", err);
    table.innerHTML = `<tr><td colspan="5" class="empty-cell">Gagal memuat pengumuman.</td></tr>`;
  }
}

async function loadPoConfigSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "poConfig"));
    if (snap.exists()) {
      const data = snap.data();
      if ($("prPrefixInput")) $("prPrefixInput").value = data.prPrefix || "PR-GA-{YYYY}{MM}-";
      if ($("poPrefixInput")) $("poPrefixInput").value = data.poPrefix || "PO-GA-{YYYY}{MM}-";
    }
  } catch (err) {
    console.error("Gagal load PO config:", err);
  }
}

async function loadVendorMappingSettings() {
  const table = $("vendorMappingTable");
  if (!table) return;
  try {
    const [usersSnap, vendorsSnap] = await Promise.all([
      getDocs(query(collection(db, "users"), where("role", "==", "vendor"))),
      getDocs(collection(db, "vendors"))
    ]);

    const vendorUsers = usersSnap.docs.map(d => ({ ...d.data(), id: d.id }));
    const vendorsList = vendorsSnap.docs.map(d => ({ ...d.data(), id: d.id }));

    table.innerHTML = vendorUsers.length ? vendorUsers.map(u => {
      const linked = vendorsList.find(v => v.id === u.vendorId || v.uid === u.id);
      return `
        <tr>
          <td><strong>${esc(u.name || "-")}</strong><br><small>${esc(u.email || "-")}</small></td>
          <td>${linked ? esc(linked.name || linked.companyName || "-") : "<em>Belum terhubung</em>"}</td>
          <td><span class="status-badge ${linked ? "" : "warning"}">${linked ? "Terhubung" : "Perlu Link"}</span></td>
          <td>
            <button type="button" class="small-action" data-map-vendor="${esc(u.id)}">
              ${linked ? "Ubah Link Vendor" : "Hubungkan Vendor"}
            </button>
          </td>
        </tr>
      `;
    }).join("") : `<tr><td colspan="4" class="empty-cell">Belum ada akun pengguna dengan role Vendor.</td></tr>`;
  } catch (err) {
    console.error("Gagal load vendor mapping:", err);
    table.innerHTML = `<tr><td colspan="4" class="empty-cell">Gagal memuat pemetaan vendor.</td></tr>`;
  }
}

function permBadges(target) {
  if (target.role === "main_admin") return `<span class="status-badge">Akses penuh</span>`;
  if (!ADMIN_ROLES.includes(target.role)) return `<span class="status-badge neutral">Portal karyawan</span>`;

  const map = permissionMap(target);
  const granted = MENU_KEYS.filter(k => map[k]);
  return granted.length
    ? `<div class="perm-badges">${granted.map(k => `<span class="status-badge">${esc(MENUS[k])}</span>`).join("")}</div>`
    : `<span class="status-badge danger">Tidak ada akses</span>`;
}

async function renderUsersPage() {
  const session = $("currentSession");
  if (session && profile) {
    session.innerHTML = `
      <span class="session-avatar">${
        safePhoto(profile.photoData)
          ? `<img src="${esc(profile.photoData)}" alt="Foto profil">`
          : esc(initials(profile.name))
      }</span>
      <div>
        <strong>${esc(profile.name || "Pengguna")}</strong>${profile.username ? ` <small>@${esc(profile.username)}</small>` : ""}<br>
        <small>${esc(user.email || "-")} · ${esc(ROLE_LABELS[profile.role] || "")}</small>
      </div>`;
  }

  const manager = $("accessManager");
  if (manager) manager.hidden = !isMain();
  if (!isMain()) return;

  const body = $("accessTable");
  const current = generation;

  try {
    const snapshot = await getDocs(collection(db, "users"));
    if (current !== generation) return;

    const users = snapshot.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "id"));

    window.__accessUsers = users;

    body.innerHTML = users.length
      ? users.map(u => `
        <tr>
          <td>${esc(u.name || "-")}${u.id === user.uid ? " <small>(Anda)</small>" : ""}${u.active === false ? ` <span class="status-badge neutral">Nonaktif</span>` : ""}</td>
          <td>${esc(ROLE_LABELS[u.role] || u.role || "-")}</td>
          <td>${permBadges(u)}</td>
          <td>${ADMIN_ROLES.includes(u.role)
            ? `<button type="button" class="small-action" data-edit-access="${esc(u.id)}">Atur Akses</button>`
            : "-"}</td>
        </tr>`).join("")
      : `<tr><td colspan="4" class="empty-cell">Belum ada pengguna.</td></tr>`;
  } catch (error) {
    console.error("Gagal memuat pengguna:", error);
    body.innerHTML = `<tr><td colspan="4" class="empty-cell">Gagal memuat pengguna. Pastikan firestore.rules terbaru sudah dipublikasikan.</td></tr>`;
  }
}

function openAccessEditor(userId) {
  const target = (window.__accessUsers || []).find(u => u.id === userId);
  if (!target) return;

  const map = permissionMap(target);

  showModal({
    wide: true,
    title: `Hak Akses: ${target.name || "-"}`,
    body: `
      <p style="text-align:left;margin-bottom:12px"><small>${esc(ROLE_LABELS[target.role] || "")}. Centang menu yang boleh dikelola. Menu yang tidak dicentang akan menampilkan permintaan akses.</small></p>
      <div class="perm-list">${MENU_KEYS.map(k => `
        <label><input type="checkbox" data-perm="${k}" ${map[k] ? "checked" : ""}> ${esc(MENUS[k])}</label>`).join("")}
      </div>`,
    actions: [
      { label: "Batal" },
      {
        label: "Cabut Semua",
        cls: "secondary-button",
        onClick: async () => {
          await savePermissions(userId, Object.fromEntries(MENU_KEYS.map(k => [k, false])));
        }
      },
      {
        label: "Simpan",
        cls: "primary-button",
        onClick: async root => {
          const next = Object.fromEntries(
            MENU_KEYS.map(k => [k, !!root.querySelector(`[data-perm="${k}"]`)?.checked])
          );
          await savePermissions(userId, next);
        }
      }
    ]
  });
}

async function savePermissions(userId, permissions) {
  await updateDoc(doc(db, "users", userId), { permissions });
  toast("Hak akses disimpan.");
  await renderUsersPage();
}

/* ---------- Lonceng & Halaman Notifikasi ---------- */

const readNotifsKey = () => `ga_read_notifs_${user?.uid}`;

function getReadNotifs() {
  if (!user) return new Set();
  try {
    const raw = localStorage.getItem(readNotifsKey());
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveReadNotifs(set) {
  if (!user) return;
  try {
    localStorage.setItem(readNotifsKey(), JSON.stringify(Array.from(set)));
  } catch {}
}

function markNotifAsRead(id) {
  const read = getReadNotifs();
  if (!read.has(id)) {
    read.add(id);
    saveReadNotifs(read);
    updateBadge();
    if (currentPage === "notifications") renderNotificationsPage();
  }
  if (id && db) {
    try {
      updateDoc(doc(db, "notifications", id), { read: true, updatedAt: serverTimestamp() }).catch(() => {});
    } catch {}
  }
}

function markAllNotifsAsRead() {
  const list = bellList();
  const read = getReadNotifs();
  list.forEach(item => read.add(item.id));
  saveReadNotifs(read);
  updateBadge();
  if (currentPage === "notifications") renderNotificationsPage();
  toast("Semua notifikasi ditandai sudah dibaca.");
}

function seconds(ts) {
  return ts?.seconds || (ts?.toDate ? ts.toDate().getTime() / 1000 : 0);
}

function timeAgo(ts) {
  const diff = Math.max(0, Date.now() / 1000 - seconds(ts));
  if (!seconds(ts)) return "";
  if (diff < 60) return "baru saja";
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  return `${Math.floor(diff / 86400)} hari lalu`;
}

function bellList() {
  if (isStaff()) {
    const list = [];

    for (const a of data.access.filter(x => x.status === "Menunggu")) {
      list.push({
        kind: "access", id: a.id, ts: a.createdAt, raw: a,
        icon: "fa-key",
        title: `Permintaan akses · ${a.userName || "-"}`,
        sub: `Meminta akses menu ${a.menuLabel || a.menu}`
      });
    }
    for (const r of data.service.filter(x => x.status === "Menunggu")) {
      list.push({
        kind: "requests", id: r.id, ts: r.createdAt,
        icon: "fa-clipboard-list",
        title: `Permintaan barang · ${r.requesterName || "-"}`,
        sub: `${r.itemName || "-"} × ${r.quantity ?? "-"} ${r.unit || ""}`
      });
    }
    for (const r of data.repairs.filter(x => x.status === "Baru")) {
      list.push({
        kind: "repairs", id: r.id, ts: r.createdAt,
        icon: "fa-screwdriver-wrench",
        title: `Laporan kerusakan · ${r.requesterName || "-"}${r.urgency === "Mendesak" ? " (Mendesak)" : ""}`,
        sub: `${r.category || "-"} — ${r.location || "-"}`
      });
    }

    return list.sort((a, b) => seconds(b.ts) - seconds(a.ts));
  }

  const list = [];

  if (data.notifications && data.notifications.length > 0) {
    for (const n of data.notifications) {
      let icon = "fa-bell";
      if (n.type === "service" || n.type === "requests") icon = "fa-clipboard-list";
      else if (n.type === "repair" || n.type === "repairs") icon = "fa-screwdriver-wrench";
      else if (n.type === "vehicle" || n.type === "vehicles") icon = "fa-car";
      else if (n.type === "procurement") icon = "fa-file-invoice";

      list.push({
        kind: n.type || "requests",
        id: n.id,
        ts: n.createdAt || n.updatedAt,
        icon,
        title: n.title || "Notifikasi GA",
        sub: n.body || "",
        read: n.read || false,
        requestId: n.requestId || ""
      });
    }
    return list.sort((a, b) => seconds(b.ts) - seconds(a.ts));
  }

  for (const r of data.service.filter(x => x.status !== "Menunggu")) {
    list.push({
      kind: "requests", id: r.id, ts: r.updatedAt || r.createdAt,
      icon: "fa-clipboard-list",
      title: `Permintaan barang: ${r.itemName || "-"}`,
      sub: `Status: ${r.status}`
    });
  }
  for (const r of data.repairs.filter(x => x.status !== "Baru")) {
    list.push({
      kind: "repairs", id: r.id, ts: r.updatedAt || r.createdAt,
      icon: "fa-screwdriver-wrench",
      title: `Laporan perbaikan: ${r.category || "-"}`,
      sub: `Status: ${r.status}`
    });
  }

  return list.sort((a, b) => seconds(b.ts) - seconds(a.ts)).slice(0, 15);
}

function updateBadge() {
  const badge = $("bellBadge");
  const unreadBadge = $("notifUnreadCount");

  const list = bellList();
  const read = getReadNotifs();
  const unreadCount = list.filter(item => !read.has(item.id)).length;

  if (badge) {
    badge.hidden = unreadCount === 0;
    badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
  }

  if (unreadBadge) {
    unreadBadge.hidden = unreadCount === 0;
    unreadBadge.textContent = String(unreadCount);
  }
}

function renderNotificationsPage() {
  const container = $("notificationsList");
  if (!container) return;

  const list = bellList();
  const readSet = getReadNotifs();

  const filtered = list.filter(item => {
    if (notifFilter === "unread") return !readSet.has(item.id);
    return true;
  });

  if (!filtered.length) {
    container.innerHTML = `<div class="notif-empty">${
      notifFilter === "unread" ? "Tidak ada notifikasi belum dibaca." : "Belum ada notifikasi."
    }</div>`;
    updateBadge();
    return;
  }

  container.innerHTML = filtered.map(item => {
    const isRead = readSet.has(item.id);
    return `
      <div class="notif-page-item${isRead ? " read" : " unread"}" data-kind="${esc(item.kind)}" data-id="${esc(item.id)}">
        <span class="notif-icon"><i class="fa-solid ${esc(item.icon)}"></i></span>
        <div class="notif-content">
          <div class="notif-title-row">
            <strong>${esc(item.title)}</strong>
            <span class="notif-time">${esc(timeAgo(item.ts))}</span>
          </div>
          <p class="notif-sub">${esc(item.sub)}</p>
          ${item.kind === "access" && isMain()
            ? `<div class="notif-actions">
                 <button type="button" class="small-action" data-access-act="Disetujui" data-id="${esc(item.id)}">Setujui</button>
                 <button type="button" class="small-action delete" data-access-act="Ditolak" data-id="${esc(item.id)}">Tolak</button>
               </div>`
            : ""}
        </div>
        ${!isRead ? `<span class="notif-unread-dot" title="Belum dibaca"></span>` : ""}
      </div>`;
  }).join("");

  updateBadge();
}

function renderBell() {
  const panel = $("bellPanel");
  if (!panel) return;

  const list = bellList();

  const itemHTML = item => `
    <div class="bell-item" data-kind="${esc(item.kind)}" data-id="${esc(item.id)}" role="button" tabindex="0">
      <span class="bell-icon"><i class="fa-solid ${esc(item.icon)}"></i></span>
      <span class="bell-text">
        <strong>${esc(item.title)}</strong>
        <small>${esc(item.sub)}</small>
        <small>${esc(timeAgo(item.ts))}</small>
        ${item.kind === "access"
          ? (isMain()
              ? `<span class="bell-actions">
                   <button type="button" class="small-action" data-access-act="Disetujui" data-id="${esc(item.id)}">Setujui</button>
                   <button type="button" class="small-action delete" data-access-act="Ditolak" data-id="${esc(item.id)}">Tolak</button>
                 </span>`
              : `<small>Menunggu persetujuan Main Admin</small>`)
          : ""}
      </span>
    </div>`;

  panel.innerHTML = `
    <div class="bell-head">Notifikasi</div>
    ${list.length
      ? list.map(itemHTML).join("")
      : `<div class="bell-empty">Belum ada notifikasi.</div>`}`;

  updateBadge();
}

async function loadBell() {
  if (!user || !profile) return;
  const current = generation;

  try {
    if (isStaff()) {
      const [service, repairs, access] = await Promise.all([
        getDocs(collection(db, "serviceRequests")),
        getDocs(collection(db, "repairRequests")),
        getDocs(collection(db, "accessRequests"))
      ]);
      if (current !== generation) return;

      data = {
        service: service.docs.map(d => ({ ...d.data(), id: d.id })),
        repairs: repairs.docs.map(d => ({ ...d.data(), id: d.id })),
        access: access.docs.map(d => ({ ...d.data(), id: d.id }))
      };
    } else {
      const uid = user.uid;
      const [serviceRes, repairRes, notifsRes] = await Promise.allSettled([
        getDocs(query(collection(db, "serviceRequests"), where("requesterUid", "==", uid))),
        getDocs(query(collection(db, "repairRequests"), where("requesterUid", "==", uid))),
        getDocs(query(collection(db, "notifications"), where("recipientUid", "==", uid)))
      ]);
      if (current !== generation) return;

      const serviceDocs = serviceRes.status === "fulfilled" ? serviceRes.value.docs.map(d => ({ ...d.data(), id: d.id })) : [];
      const repairDocs = repairRes.status === "fulfilled" ? repairRes.value.docs.map(d => ({ ...d.data(), id: d.id })) : [];
      const notifDocs = notifsRes.status === "fulfilled" ? notifsRes.value.docs.map(d => ({ ...d.data(), id: d.id })) : [];

      data = {
        service: serviceDocs,
        repairs: repairDocs,
        access: [],
        notifications: notifDocs
      };
    }

    renderBell();
    if (currentPage === "notifications") renderNotificationsPage();
  } catch (error) {
    if (current !== generation) return;
    console.warn("Notifikasi tidak dapat dimuat:", error?.code || error?.message);
  }
}

async function decideAccess(id, decision) {
  const request = data.access.find(a => a.id === id);
  if (!request) throw new Error("Permintaan tidak ditemukan.");

  const batch = writeBatch(db);

  if (decision === "Disetujui") {
    const snapshot = await getDoc(doc(db, "users", request.uid));
    if (!snapshot.exists()) throw new Error("Pengguna tidak ditemukan.");

    const target = snapshot.data();
    if (!ADMIN_ROLES.includes(target.role)) {
      throw new Error("Hanya GA Admin atau Admin Operational yang bisa diberi akses menu.");
    }

    const permissions = permissionMap(target);
    permissions[request.menu] = true;
    batch.update(doc(db, "users", request.uid), { permissions });
  }

  batch.update(doc(db, "accessRequests", id), {
    status: decision,
    decidedBy: user.uid,
    decidedByName: profile.name,
    updatedAt: serverTimestamp()
  });

  await batch.commit();
  toast(decision === "Disetujui" ? "Akses disetujui." : "Permintaan akses ditolak.");
  await loadBell();
  if (currentPage === "users") renderUsersPage();
}

function handleNotifItemClick(kind, id) {
  markNotifAsRead(id);

  if (kind === "access") {
    if (isMain()) goto("users");
    return;
  }

  if (kind === "requests") {
    if (isStaff() && !can("requests")) {
      return askAccess("requests");
    }
    const item = data.service.find(x => x.id === id);
    if (typeof window.openRequestDetail === "function" && item) {
      window.openRequestDetail(item);
    } else {
      goto("requests");
    }
    return;
  }

  if (kind === "repairs") {
    if (isStaff() && !can("repairs")) {
      return askAccess("repairs");
    }
    const item = data.repairs.find(x => x.id === id);
    if (typeof window.openRepairDetail === "function" && item) {
      window.openRepairDetail(item);
    } else {
      goto("repairs");
    }
    return;
  }
}

function startBellTimer() {
  clearInterval(bellTimer);
  bellTimer = setInterval(loadBell, BELL_REFRESH_MS);
}

/* ---------- Helper Profile Requester untuk Admin ---------- */

const profileCache = new Map();

async function getRequesterProfile(uid) {
  if (!uid) return null;
  if (profileCache.has(uid)) return profileCache.get(uid);

  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
      const data = snap.data();
      profileCache.set(uid, data);
      return data;
    }
  } catch (err) {
    console.warn("Could not load user profile for", uid, err);
  }
  return null;
}

async function buildRequesterHeaderHTML(requesterUid, fallbackName, fallbackDept) {
  const p = await getRequesterProfile(requesterUid);
  const name = p?.name || fallbackName || "Karyawan";
  const dept = p?.department || fallbackDept || "-";
  const username = p?.username ? `@${p.username}` : "-";
  const photo = safePhoto(p?.photoData)
    ? `<img src="${esc(p.photoData)}" alt="Foto profil" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">`
    : `<span style="width:48px;height:48px;border-radius:50%;background:#0D9488;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:1.1rem;">${esc(initials(name))}</span>`;

  return `
    <div style="display:flex;align-items:center;gap:12px;padding:12px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;margin-bottom:16px;">
      ${photo}
      <div>
        <strong style="font-size:0.98rem;display:block;">${esc(name)}</strong>
        <small style="color:#64748B;">Departemen: ${esc(dept)} · ID: ${esc(username)}</small>
      </div>
    </div>
  `;
}

/* ---------- Notifikasi Helper ---------- */

async function sendNotification({ recipientUid, title, body, type, requestId }) {
  if (!recipientUid) return;
  try {
    const notifRef = doc(collection(db, "notifications"));
    await setDoc(notifRef, {
      id: notifRef.id,
      recipientUid,
      title,
      body,
      type: type || "general",
      requestId: requestId || "",
      read: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    console.warn("Gagal mengirim notifikasi:", err);
  }
}

/* ---------- Permintaan Kendaraan Karyawan & Admin ---------- */

function newVehicleTicket() {
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
  return `VR-${ymd}-${random}`;
}

async function renderEmployeeVehiclePage() {
  const tbody = $("employeeVehicleRequestsTable");
  if (!tbody || !user) return;

  try {
    const snap = await getDocs(
      query(collection(db, "vehicleRequests"), where("requesterUid", "==", user.uid))
    );
    const list = snap.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => seconds(b.createdAt) - seconds(a.createdAt));

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">Belum ada pengajuan kendaraan. Silakan klik "Ajukan Permintaan Kendaraan".</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(item => `
      <tr>
        <td><strong>${esc(item.ticketNo || item.id)}</strong><br><small>${formatDate(item.createdAt)}</small></td>
        <td><strong>Tujuan:</strong> ${esc(item.destination || "-")}<br><small><strong>Jemput:</strong> ${esc(item.pickupLocation || "-")}</small></td>
        <td>${esc(item.travelDate || "-")} ${esc(item.departureTime || "")}</td>
        <td>${esc(item.estimatedDuration || "-")} (${esc(item.passengerCount || 1)} orang)</td>
        <td>${esc(item.purpose || "-")}</td>
        <td>${esc(item.assignedVehicle || "Belum ditugaskan")}${item.driverName ? `<br><small>Driver: ${esc(item.driverName)}</small>` : ""}</td>
        <td>${badge(item.status || "Pending")}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="small-action" data-veh-action="detail" data-id="${esc(item.id)}">Detail</button>
            ${item.status === "Pending" ? `<button type="button" class="small-action delete" data-veh-action="cancel" data-id="${esc(item.id)}">Batal</button>` : ""}
          </div>
        </td>
      </tr>
    `).join("");

    window.__employeeVehicles = list;
  } catch (err) {
    console.error("Gagal memuat vehicleRequests karyawan:", err);
    tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">Gagal memuat data pengajuan kendaraan.</td></tr>`;
  }
}

function openCreateVehicleRequestModal() {
  if (!user || !profile) return toast("Silakan login terlebih dahulu.");

  const todayStr = localDate();

  showModal({
    wide: true,
    title: "Ajukan Permintaan Kendaraan Operasional",
    body: `
      <div class="form-fields">
        <div class="field full"><label>Lokasi Penjemputan *</label><input id="vPickup" placeholder="Contoh: Kantor Utama / Lobby A" required></div>
        <div class="field full"><label>Lokasi Tujuan *</label><input id="vDest" placeholder="Contoh: Bandara Soekarno-Hatta / Pabrik B" required></div>
        <div class="field"><label>Tanggal Keberangkatan *</label><input id="vDate" type="date" min="${todayStr}" value="${todayStr}" required></div>
        <div class="field"><label>Jam Keberangkatan *</label><input id="vTime" type="time" value="08:00" required></div>
        <div class="field"><label>Perkiraan Durasi *</label><input id="vDuration" placeholder="Contoh: 3 Jam / 1 Hari" required></div>
        <div class="field"><label>Jumlah Penumpang *</label><input id="vPassengers" type="number" min="1" value="1" required></div>
        <div class="field full"><label>Keperluan / Tujuan Perjalanan *</label><textarea id="vPurpose" rows="3" placeholder="Jelaskan alasan dan agenda perjalanan dinas ini..." required></textarea></div>
        <div class="field full"><label>Catatan Tambahan (Opsional)</label><textarea id="vNotes" rows="2" placeholder="Catatan khusus, barang bawaan, dll..."></textarea></div>
      </div>
    `,
    actions: [
      { label: "Batal" },
      {
        label: "Kirim Pengajuan",
        cls: "primary-button",
        onClick: async root => {
          const pickupLocation = root.querySelector("#vPickup").value.trim();
          const destination = root.querySelector("#vDest").value.trim();
          const travelDate = root.querySelector("#vDate").value;
          const departureTime = root.querySelector("#vTime").value;
          const estimatedDuration = root.querySelector("#vDuration").value.trim();
          const passengerCount = Number(root.querySelector("#vPassengers").value);
          const purpose = root.querySelector("#vPurpose").value.trim();
          const notes = root.querySelector("#vNotes").value.trim();

          if (!pickupLocation || !destination || !travelDate || !departureTime || !estimatedDuration || !purpose) {
            throw new Error("Mohon lengkapi seluruh kolom yang wajib diisi.");
          }
          if (!passengerCount || passengerCount < 1) {
            throw new Error("Jumlah penumpang minimal 1 orang.");
          }

          const ticketNo = newVehicleTicket();
          const docRef = doc(db, "vehicleRequests", ticketNo);

          await setDoc(docRef, {
            ticketNo,
            type: "kendaraan",
            requesterUid: user.uid,
            requesterName: profile.name,
            department: profile.department || "",
            pickupLocation,
            destination,
            travelDate,
            departureTime,
            estimatedDuration,
            passengerCount,
            purpose,
            notes,
            status: "Pending",
            assignedVehicle: "",
            driverName: "",
            statusNote: "",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });

          await sendNotification({
            recipientUid: user.uid,
            title: `Permintaan Kendaraan Terkirim`,
            body: `Pengajuan kendaraan #${ticketNo} ke ${destination} berhasil dikirim dan menunggu persetujuan Admin GA.`,
            type: "vehicle",
            requestId: ticketNo
          });

          toast("Permintaan kendaraan berhasil diajukan.");
          renderEmployeeVehiclePage();
        }
      }
    ]
  });
}

async function renderAdminVehiclePage() {
  const tbody = $("adminVehicleRequestsTable");
  if (!tbody || !user || !isStaff()) return;

  try {
    const snap = await getDocs(collection(db, "vehicleRequests"));
    const list = snap.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => seconds(b.createdAt) - seconds(a.createdAt));

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">Belum ada pengajuan kendaraan dari karyawan.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(item => `
      <tr>
        <td><strong>${esc(item.ticketNo || item.id)}</strong></td>
        <td>${formatDate(item.createdAt)}</td>
        <td><strong>${esc(item.requesterName)}</strong><br><small>${esc(item.department || "-")}</small></td>
        <td><strong>Tujuan:</strong> ${esc(item.destination || "-")}<br><small><strong>Jemput:</strong> ${esc(item.pickupLocation || "-")}</small></td>
        <td>${esc(item.travelDate || "-")} ${esc(item.departureTime || "")}<br><small>Durasi: ${esc(item.estimatedDuration || "-")}</small></td>
        <td>${esc(item.passengerCount || 1)} Orang</td>
        <td>${esc(item.assignedVehicle || "Belum ada")}${item.driverName ? `<br><small>Driver: ${esc(item.driverName)}</small>` : ""}</td>
        <td>${badge(item.status || "Pending")}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="small-action" data-admin-veh="detail" data-id="${esc(item.id)}">Detail</button>
            ${item.status === "Pending" ? `
              <button type="button" class="small-action" data-admin-veh="approve" data-id="${esc(item.id)}">Setujui</button>
              <button type="button" class="small-action delete" data-admin-veh="reject" data-id="${esc(item.id)}">Tolak</button>
            ` : ""}
            ${item.status === "Disetujui" ? `
              <button type="button" class="small-action" data-admin-veh="finish" data-id="${esc(item.id)}">Selesai</button>
            ` : ""}
          </div>
        </td>
      </tr>
    `).join("");

    window.__adminVehicles = list;
  } catch (err) {
    console.error("Gagal memuat vehicleRequests admin:", err);
    tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">Gagal memuat pengajuan kendaraan. Pastikan hak akses kendaraan sesuai.</td></tr>`;
  }
}

async function openVehicleRequestDetail(req) {
  if (!req) return;
  const headerHTML = await buildRequesterHeaderHTML(req.requesterUid, req.requesterName, req.department);

  showModal({
    wide: true,
    title: `Detail Permintaan Kendaraan: ${req.ticketNo || req.id}`,
    body: `
      ${headerHTML}
      <div class="form-fields">
        <div class="field"><label>Tanggal Keberangkatan</label><div>${esc(req.travelDate || "-")} ${esc(req.departureTime || "")}</div></div>
        <div class="field"><label>Perkiraan Durasi & Penumpang</label><div>${esc(req.estimatedDuration || "-")} (${esc(req.passengerCount || 1)} orang)</div></div>
        <div class="field full"><label>Lokasi Penjemputan</label><div>${esc(req.pickupLocation || "-")}</div></div>
        <div class="field full"><label>Lokasi Tujuan</label><div>${esc(req.destination || "-")}</div></div>
        <div class="field full"><label>Keperluan</label><div>${esc(req.purpose || "-")}</div></div>
        ${req.notes ? `<div class="field full"><label>Catatan</label><div>${esc(req.notes)}</div></div>` : ""}
        <div class="field"><label>Status</label><div>${badge(req.status || "Pending")}</div></div>
        <div class="field"><label>Kendaraan & Driver</label><div>${esc(req.assignedVehicle || "Belum ditugaskan")}${req.driverName ? ` (Driver: ${esc(req.driverName)})` : ""}</div></div>
        ${req.statusNote ? `<div class="field full"><label>Catatan Admin</label><div>${esc(req.statusNote)}</div></div>` : ""}
      </div>
    `,
    actions: [{ label: "Tutup", cls: "primary-button" }]
  });
}

function openAdminVehicleAction(action, id) {
  const req = (window.__adminVehicles || []).find(x => x.id === id);
  if (!req) return toast("Data permintaan tidak ditemukan.");

  if (action === "detail") {
    openVehicleRequestDetail(req);
    return;
  }

  if (action === "approve") {
    showModal({
      title: `Setujui Permintaan Kendaraan: ${req.ticketNo}`,
      body: `
        <p><small>Pemohon: ${esc(req.requesterName)} · Tujuan: ${esc(req.destination)} (${esc(req.travelDate)} ${esc(req.departureTime)})</small></p>
        <div class="form-fields">
          <div class="field full"><label>Tugaskan Kendaraan *</label><input id="vAssignCar" placeholder="Contoh: B 1234 ABC (Toyota Avanza)" required></div>
          <div class="field full"><label>Nama Driver *</label><input id="vAssignDriver" placeholder="Contoh: Pak Budi (Driver GA)" required></div>
          <div class="field full"><label>Catatan Tambahan (Opsional)</label><textarea id="vAssignNote" placeholder="Informasi lokasi penjemputan driver, dll..."></textarea></div>
        </div>
      `,
      actions: [
        { label: "Batal" },
        {
          label: "Setujui & Penugasan",
          cls: "primary-button",
          onClick: async root => {
            const assignedVehicle = root.querySelector("#vAssignCar").value.trim();
            const driverName = root.querySelector("#vAssignDriver").value.trim();
            const statusNote = root.querySelector("#vAssignNote").value.trim();

            if (!assignedVehicle || !driverName) {
              throw new Error("Mohon lengkapi kendaraan dan nama driver.");
            }

            await updateDoc(doc(db, "vehicleRequests", id), {
              status: "Disetujui",
              assignedVehicle,
              driverName,
              statusNote,
              updatedAt: serverTimestamp()
            });

            await sendNotification({
              recipientUid: req.requesterUid,
              title: "Permintaan Kendaraan Disetujui",
              body: `Pengajuan kendaraan #${req.ticketNo} telah disetujui. Kendaraan: ${assignedVehicle}, Driver: ${driverName}.`,
              type: "vehicle",
              requestId: req.ticketNo
            });

            toast("Permintaan disetujui dan kendaraan ditugaskan.");
            renderAdminVehiclePage();
          }
        }
      ]
    });
  } else if (action === "reject") {
    showModal({
      title: `Tolak Permintaan Kendaraan: ${req.ticketNo}`,
      body: `
        <div class="form-fields">
          <div class="field full"><label>Alasan Penolakan *</label><textarea id="vRejectNote" placeholder="Tuliskan alasan penolakan..." required></textarea></div>
        </div>
      `,
      actions: [
        { label: "Batal" },
        {
          label: "Tolak Pengajuan",
          cls: "secondary-button",
          onClick: async root => {
            const statusNote = root.querySelector("#vRejectNote").value.trim();
            if (!statusNote) throw new Error("Alasan penolakan wajib diisi.");

            await updateDoc(doc(db, "vehicleRequests", id), {
              status: "Ditolak",
              statusNote,
              updatedAt: serverTimestamp()
            });

            await sendNotification({
              recipientUid: req.requesterUid,
              title: "Permintaan Kendaraan Ditolak",
              body: `Pengajuan kendaraan #${req.ticketNo} ditolak. Alasan: ${statusNote}`,
              type: "vehicle",
              requestId: req.ticketNo
            });

            toast("Permintaan kendaraan ditolak.");
            renderAdminVehiclePage();
          }
        }
      ]
    });
  } else if (action === "finish") {
    showModal({
      title: `Selesaikan Perjalanan Kendaraan: ${req.ticketNo}`,
      body: `<p>Tandai perjalanan dinas ini telah selesai?</p>`,
      actions: [
        { label: "Batal" },
        {
          label: "Tandai Selesai",
          cls: "primary-button",
          onClick: async () => {
            await updateDoc(doc(db, "vehicleRequests", id), {
              status: "Selesai",
              updatedAt: serverTimestamp()
            });

            await sendNotification({
              recipientUid: req.requesterUid,
              title: "Perjalanan Kendaraan Selesai",
              body: `Pengajuan kendaraan #${req.ticketNo} telah selesai. Terima kasih.`,
              type: "vehicle",
              requestId: req.ticketNo
            });

            toast("Perjalanan kendaraan ditandai selesai.");
            renderAdminVehiclePage();
          }
        }
      ]
    });
  }
}

async function openEmployeeVehicleCancel(id) {
  const req = (window.__employeeVehicles || []).find(x => x.id === id);
  if (!req) return;

  showModal({
    title: `Batalkan Permintaan Kendaraan: ${req.ticketNo}`,
    body: `<p>Apakah Anda yakin ingin membatalkan pengajuan kendaraan ini?</p>`,
    actions: [
      { label: "Batal" },
      {
        label: "Ya, Batalkan",
        cls: "secondary-button",
        onClick: async () => {
          await updateDoc(doc(db, "vehicleRequests", id), {
            status: "Canceled",
            updatedAt: serverTimestamp()
          });

          await sendNotification({
            recipientUid: user.uid,
            title: "Permintaan Kendaraan Dibatalkan",
            body: `Pengajuan kendaraan #${req.ticketNo} telah dibatalkan.`,
            type: "vehicle",
            requestId: req.ticketNo
          });

          toast("Pengajuan kendaraan dibatalkan.");
          renderEmployeeVehiclePage();
        }
      }
    ]
  });
}

window.buildRequesterHeaderHTML = buildRequesterHeaderHTML;
window.sendNotification = sendNotification;

/* ---------- Pasang ke halaman ---------- */

$("newEmployeeVehicleBtn")?.addEventListener("click", openCreateVehicleRequestModal);

$("employeeVehicleRequestsTable")?.addEventListener("click", event => {
  const btn = event.target.closest("[data-veh-action]");
  if (!btn) return;
  const act = btn.dataset.vehAction;
  const id = btn.dataset.id;
  const list = window.__employeeVehicles || [];
  const item = list.find(x => x.id === id);
  if (act === "detail") openVehicleRequestDetail(item);
  else if (act === "cancel") openEmployeeVehicleCancel(id);
});

$("adminVehicleRequestsTable")?.addEventListener("click", event => {
  const btn = event.target.closest("[data-admin-veh]");
  if (!btn) return;
  const act = btn.dataset.adminVeh;
  const id = btn.dataset.id;
  openAdminVehicleAction(act, id);
});

document.querySelectorAll("[data-history-filter]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-history-filter]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const filter = btn.dataset.historyFilter;
    renderEmployeeHistory(filter);
  });
});

$("employeeHistoryTable")?.addEventListener("click", event => {
  const btn = event.target.closest("[data-hist-idx]");
  if (!btn) return;
  const idx = Number(btn.dataset.histIdx);
  const item = (window.__historyList || [])[idx];
  if (!item) return;

  if (item.kind === "service") {
    if (typeof window.openRequestDetail === "function") window.openRequestDetail(item.raw);
  } else if (item.kind === "repair") {
    if (typeof window.openRepairDetail === "function") window.openRepairDetail(item.raw);
  } else if (item.kind === "vehicle") {
    openVehicleRequestDetail(item.raw);
  } else if (item.kind === "procurement") {
    showModal({
      title: `Detail Requisisi Pembelian: ${item.raw.prNo || item.id}`,
      body: `
        <div class="form-fields">
          <div class="field"><label>Tanggal</label><div>${esc(item.date)}</div></div>
          <div class="field"><label>Departemen</label><div>${esc(item.raw.department || "-")}</div></div>
          <div class="field full"><label>Barang / Items</label><div>${esc(item.desc)}</div></div>
          <div class="field full"><label>Alasan / Justifikasi</label><div>${esc(item.raw.justification || "-")}</div></div>
          <div class="field"><label>Status</label><div>${badge(item.status)}</div></div>
        </div>
      `,
      actions: [{ label: "Tutup", cls: "primary-button" }]
    });
  }
});

$("tileGrid")?.addEventListener("click", onTileClick);
$("hubGrid")?.addEventListener("click", onTileClick);

$("homeButton")?.addEventListener("click", () => goto("home"));

$("backButton")?.addEventListener("click", () => {
  goto($("pageBack")?.dataset.target || "home");
});

$("bellButton")?.addEventListener("click", event => {
  event.stopPropagation();
  goto("notifications");
});

document.querySelectorAll("#mobileBottomNav .nav-item").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#mobileBottomNav .nav-item").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const nav = btn.dataset.nav;
    if (nav === "home") goto("home");
    else if (nav === "requests") goto("requests");
    else if (nav === "repairs") goto("repairs");
    else if (nav === "vehicles") goto("employee-vehicles");
    else if (nav === "history") goto("history");
    else if (nav === "profile") openProfile();
  });
});

document.querySelectorAll("[data-notif-filter]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-notif-filter]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    notifFilter = btn.dataset.notifFilter;
    renderNotificationsPage();
  });
});

$("markAllReadButton")?.addEventListener("click", () => {
  markAllNotifsAsRead();
});

$("notificationsList")?.addEventListener("click", event => {
  const act = event.target.closest("[data-access-act]");
  if (act) {
    event.stopPropagation();
    act.disabled = true;
    decideAccess(act.dataset.id, act.dataset.accessAct).catch(error => {
      console.error(error);
      toast(errorText(error));
      act.disabled = false;
    });
    return;
  }

  const item = event.target.closest(".notif-page-item");
  if (!item) return;

  const kind = item.dataset.kind;
  const id = item.dataset.id;
  handleNotifItemClick(kind, id);
});

$("avatarButton")?.addEventListener("click", event => {
  event.stopPropagation();
  toggleMenu("profileMenu", "avatarButton");
});

$("bellPanel")?.addEventListener("click", event => {
  event.stopPropagation();
  const act = event.target.closest("[data-access-act]");
  if (act) {
    act.disabled = true;
    decideAccess(act.dataset.id, act.dataset.accessAct).catch(error => {
      console.error(error);
      toast(errorText(error));
      act.disabled = false;
    });
    return;
  }

  const item = event.target.closest(".bell-item");
  if (!item) return;

  const kind = item.dataset.kind;
  const id = item.dataset.id;
  closeMenus();
  handleNotifItemClick(kind, id);
});

$("profileMenu")?.addEventListener("click", event => {
  event.stopPropagation();
  const item = event.target.closest("[data-profile-action]");
  if (!item) return;

  const action = item.dataset.profileAction;
  closeMenus();

  if (action === "profile") openProfile();
  else if (action === "settings") goto("settings");
  else if (action === "users") goto("users");
  else if (action === "reports") openGuarded("reports", "reports");
});

$("accessTable")?.addEventListener("click", event => {
  const button = event.target.closest("[data-edit-access]");
  if (button) openAccessEditor(button.dataset.editAccess);
});

document.addEventListener("click", closeMenus);
document.addEventListener("ga:data-changed", () => { loadBell(); });

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeMenus();
    closeShellModal();
  }
});

await authPersistenceReady;

onAuthStateChanged(auth, async current => {
  const thisGeneration = ++generation;

  user = null;
  profile = null;
  data = { service: [], repairs: [], access: [] };
  clearInterval(bellTimer);
  closeMenus();
  closeShellModal();
  renderHome();
  goto("home");

  if (!current) return;

  try {
    await current.reload();
    if (thisGeneration !== generation || !current.emailVerified) return;

    const snapshot = await getDoc(doc(db, "users", current.uid));
    if (thisGeneration !== generation || !snapshot.exists()) return;

    const loaded = snapshot.data();
    if (loaded.active !== true || !(loaded.role in ROLE_LABELS)) return;

    user = current;
    profile = loaded;

    renderAvatar();
    renderHome();

    // Karyawan: tidak memakai halaman Inventory/Stok.
    await loadBell();
    if (thisGeneration === generation) startBellTimer();
  } catch (error) {
    if (thisGeneration !== generation) return;
    console.error("Gagal menyiapkan tampilan:", error);
  }
});
