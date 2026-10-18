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

function renderHome() {
  const grid = $("tileGrid");
  const title = $("homeTitle");
  if (!grid) return;

  if (!profile) {
    grid.innerHTML = "";
    return;
  }

  if (isStaff()) {
    if (title) {
      title.textContent = isMain() ? "MENU MAIN ADMIN" : "MENU ADMIN GA";
    }
    grid.innerHTML = STAFF_TILES.map((tile, i) => {
      const allowed = tile.perm.some(can);
      return tileHTML(tile, !allowed, i, "staff");
    }).join("");
  } else {
    if (title) title.textContent = "MENU KARYAWAN";
    grid.innerHTML = EMPLOYEE_TILES.map((tile, i) =>
      tileHTML(tile, false, i, "employee")
    ).join("");
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
  if (!button || !profile) return;

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

function renderSettingsPage() {
  const manage =
    ["main_admin", "ga_admin"].includes(profile?.role) && can("requests");
  const panel = $("handoverSettingsPanel");
  if (panel) panel.hidden = !manage;
  if ($("settingsEmpty")) $("settingsEmpty").hidden = manage;
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
      const [service, repairs] = await Promise.all([
        getDocs(query(collection(db, "serviceRequests"), where("requesterUid", "==", uid))),
        getDocs(query(collection(db, "repairRequests"), where("requesterUid", "==", uid)))
      ]);
      if (current !== generation) return;

      data = {
        service: service.docs.map(d => ({ ...d.data(), id: d.id })),
        repairs: repairs.docs.map(d => ({ ...d.data(), id: d.id })),
        access: []
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

/* ---------- Pasang ke halaman ---------- */

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
