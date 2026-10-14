import { auth, db, authPersistenceReady } from "./firebase-init.js";

import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";

const assetCollection = collection(db, "assets");

let currentUser = null;
let currentProfile = null;
let assets = [];
let editingCode = null;
let saving = false;

const assetFields = [
  ["code", "Kode Aset", "text", "Contoh: AST-001", true],
  ["name", "Nama Aset", "text", "Nama aset", true],
  ["category", "Kategori", "select",
    ["Laptop", "Komputer", "AC", "Meja & Kursi",
     "Printer", "Kendaraan", "Peralatan", "Lainnya"], true],
  ["location", "Lokasi", "text", "Lokasi aset", true],
  ["owner", "Penanggung Jawab", "text", "Nama karyawan", false],
  ["condition", "Kondisi", "select",
    ["Baik", "Perlu Perbaikan", "Rusak"], true],
  ["status", "Status", "select",
    ["Aktif", "Dipinjam", "Dalam Perbaikan", "Tidak Aktif"], true],
  ["date", "Tanggal Perolehan", "date", "", false],
  ["value", "Nilai Perolehan (Rp)", "number", "0", false]
];

function canWrite() {
  return currentProfile?.active === true &&
    ["main_admin", "ga_admin"].includes(currentProfile.role);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function message(text) {
  if (typeof window.notify === "function") {
    window.notify(text);
  } else {
    alert(text);
  }
}

function getAsset(code) {
  return assets.find(item => item.code === code);
}

function fieldHTML(field, record = {}) {
  const [key, label, type, options, required] = field;
  const value = record[key] ?? "";
  const requiredHTML = required ? "required" : "";
  const disabledHTML =
    key === "code" && editingCode ? "readonly" : "";

  let control;

  if (type === "select") {
    control = `
      <select name="${key}" ${requiredHTML}>
        <option value="">Pilih ${escapeHTML(label)}</option>
        ${options.map(option => `
          <option value="${escapeHTML(option)}"
            ${value === option ? "selected" : ""}>
            ${escapeHTML(option)}
          </option>
        `).join("")}
      </select>
    `;
  } else {
    control = `
      <input
        type="${type}"
        name="${key}"
        value="${escapeHTML(value)}"
        placeholder="${escapeHTML(options)}"
        ${type === "number" ? 'min="0" step="any"' : ""}
        ${requiredHTML}
        ${disabledHTML}
      >
    `;
  }

  return `
    <div class="field">
      <label>
        ${escapeHTML(label)}
        ${required ? '<span style="color:#C45E55">*</span>' : ""}
      </label>
      ${control}
    </div>
  `;
}

function openAssetForm(code = null) {
  if (!canWrite()) {
    message("Anda tidak memiliki izin mengubah aset.");
    return;
  }

  const record = code ? getAsset(code) : null;

  if (code && !record) {
    message("Aset tidak ditemukan.");
    return;
  }

  editingCode = code;

  const form = document.getElementById("dataForm");
  const modal = document.getElementById("dataModal");
  const title = document.getElementById("modalTitle");
  const fields = document.getElementById("formFields");

  if (!form || !modal || !title || !fields) {
    message("Form aset tidak ditemukan.");
    return;
  }

  form.reset();
  title.textContent = code ? "Edit Aset" : "Tambah Aset";

  fields.innerHTML = assetFields
    .map(field => fieldHTML(field, record || {}))
    .join("");

  modal.classList.add("open");
}


function closeAssetForm() {
  const modal = document.getElementById("dataModal");

  if (modal) {
    modal.classList.remove("open");
    delete modal.dataset.mode;
  }

  editingCode = null;
}
async function saveAsset(event) {
  if (document.getElementById("dataModal")?.dataset.mode !== "assets_firebase") return;

  event.preventDefault();
  event.stopImmediatePropagation();

  if (saving) return;

  if (!canWrite() || !currentUser) {
    message("Akses ditolak.");
    return;
  }

  const data = Object.fromEntries(
    new FormData(event.currentTarget).entries()
  );

  const code = String(data.code || "").trim().toUpperCase();

  if (!/^[A-Z0-9_-]{2,60}$/.test(code)) {
    message("Kode aset hanya boleh huruf kapital, angka, _ dan -.");
    return;
  }

  if (editingCode && editingCode !== code) {
    message("Kode aset tidak dapat diubah.");
    return;
  }

  const value = Number(data.value || 0);

  if (!Number.isFinite(value) || value < 0) {
    message("Nilai perolehan tidak valid.");
    return;
  }

  const payload = {
    code,
    name: String(data.name || "").trim(),
    category: data.category,
    location: String(data.location || "").trim(),
    owner: String(data.owner || "").trim(),
    condition: data.condition,
    status: data.status,
    date: data.date || "",
    value
  };

  if (!payload.name || !payload.location) {
    message("Nama dan lokasi aset wajib diisi.");
    return;
  }

  saving = true;

  try {
    const reference = doc(db, "assets", code);

    if (editingCode) {
      await updateDoc(reference, {
        name: payload.name,
        category: payload.category,
        location: payload.location,
        owner: payload.owner,
        condition: payload.condition,
        status: payload.status,
        date: payload.date,
        value: payload.value
      });
    } else {
      const existing = await getDoc(reference);

      if (existing.exists()) {
        message("Kode aset sudah digunakan.");
        return;
      }

      await setDoc(reference, {
        ...payload,
        createdBy: currentUser.uid,
        createdByName: currentProfile.name,
        createdByRole: currentProfile.role,
        createdAt: serverTimestamp()
      });
    }

    closeAssetForm();
    await loadAssets();
    message("Data aset berhasil disimpan.");

  } catch (error) {
    console.error("Gagal menyimpan aset:", error);
    message("Gagal menyimpan aset: " + error.message);
  } finally {
    saving = false;
  }
}

function renderAssets() {
  const table = document.getElementById("assetTable");
  if (!table) return;

  const keyword = (
    document.getElementById("assetSearch")?.value || ""
  ).toLowerCase();

  const filtered = assets.filter(item =>
    [
      item.code,
      item.name,
      item.category,
      item.location,
      item.owner
    ].join(" ").toLowerCase().includes(keyword)
  );

  table.innerHTML = "";

  if (!filtered.length) {
    table.innerHTML = `
      <tr>
        <td colspan="7" class="empty-cell">
          Belum ada data aset.
        </td>
      </tr>
    `;
  }

  filtered.forEach(item => {
    const row = document.createElement("tr");

    [
      item.code,
      item.name,
      item.category,
      item.location,
      item.owner,
      item.condition
    ].forEach(value => {
      const cell = document.createElement("td");
      cell.textContent = value || "-";
      row.appendChild(cell);
    });

    const actionCell = document.createElement("td");

    if (canWrite()) {
      const editButton = document.createElement("button");
      editButton.className = "small-action";
      editButton.innerHTML = '<i class="fa-solid fa-pen"></i>';
      editButton.title = "Edit Aset";
      editButton.addEventListener("click", () => {
        openFirebaseAssetForm(item.code);
      });
      actionCell.appendChild(editButton);
    } else {
      actionCell.textContent = "-";
    }

    row.appendChild(actionCell);
    table.appendChild(row);
  });

  const total = document.getElementById("totalAssets");
  if (total) total.textContent = assets.length;

  const report = document.getElementById("reportAssets");
  if (report) report.textContent = assets.length;
}

async function loadAssets() {
  if (!currentUser || !currentProfile?.active) return;

  try {
    const snapshot = await getDocs(assetCollection);

    assets = snapshot.docs.map(item => ({
      ...item.data(),
      code: item.id
    }));

    assets.sort((a, b) =>
      String(a.code).localeCompare(String(b.code))
    );

    renderAssets();

  } catch (error) {
    console.error("Gagal membaca aset:", error);
    message("Gagal memuat data aset.");
  }
}


function setupAssets() {
  const page = document.getElementById("page-assets");
  if (!page) return;

  const addButton = page.querySelector(".page-heading button");

  if (addButton) {
    addButton.removeAttribute("onclick");

    if (!addButton.dataset.firebaseBound) {
      addButton.addEventListener("click", () => {
        openFirebaseAssetForm();
      });

      addButton.dataset.firebaseBound = "true";
    }

    addButton.style.display = canWrite() ? "" : "none";
  }

  const search = document.getElementById("assetSearch");

  if (search) {
    search.removeAttribute("oninput");

    if (!search.dataset.firebaseBound) {
      search.addEventListener("input", renderAssets);
      search.dataset.firebaseBound = "true";
    }
  }

  const form = document.getElementById("dataForm");

  if (form && !form.dataset.assetFirebaseBound) {
    form.addEventListener("submit", saveAsset, true);
    form.dataset.assetFirebaseBound = "true";
  }
}

// Agar modal lama tetap bisa digunakan,
// kita tandai form yang dibuka oleh modul aset.
const originalOpenAssetForm = openAssetForm;

function openFirebaseAssetForm(code = null) {
 originalOpenAssetForm(code);
document.getElementById("dataModal").dataset.mode = "assets_firebase";
}

// Dipakai oleh tombol tambah/edit aset.
window.openFirebaseAssetForm = openFirebaseAssetForm;

await authPersistenceReady;

onAuthStateChanged(auth, async user => {
  currentUser = user;
  currentProfile = null;
  assets = [];

  if (!user) {
    renderAssets();
    return;
  }

  try {
    const profile = await getDoc(doc(db, "users", user.uid));

    if (!profile.exists()) return;

    currentProfile = profile.data();

    setupAssets();
    await loadAssets();

  } catch (error) {
    console.error("Gagal memuat profil aset:", error);
  }
});
