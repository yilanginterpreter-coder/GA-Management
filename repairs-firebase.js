
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

import {
  doc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
  setDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

import {
  auth,
  db,
  authPersistenceReady
} from "./firebase-init.js";

const el = (id) => document.getElementById(id);

const adminRoles = ["main_admin", "ga_admin"];
const allRoles = [...adminRoles, "admin_operational"];

const statuses = [
  "Baru",
  "Disetujui",
  "Ditolak",
  "Dikerjakan",
  "Menunggu Part",
  "Selesai",
  "Dibatalkan"
];

let profile = null;
let uid = null;
let unsubscribe = null;
let records = [];
let photo = "";
let busy = false;

const escapeHTML = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);

const isAdmin = () => adminRoles.includes(profile?.role);

const date = () => {
  const d = new Date();

  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
};

function ticket() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));

  return (
    "RPR-" +
    date().slice(2).replaceAll("-", "") +
    "-" +
    Array.from(bytes, (b) =>
      (b % 36).toString(36).toUpperCase()
    ).join("")
  );
}

function notice(message) {
  alert(message);
}

function modal(title, html) {
  let box = el("repairDialog");

  if (!box) {
    const style = document.createElement("style");

    style.textContent = `
      #repairDialog {
        position: fixed;
        inset: 0;
        z-index: 99999;
        background: #0008;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 15px;
      }

      #repairDialog.open {
        display: flex;
      }

      #repairDialog .rf-card {
        background: white;
        border-radius: 16px;
        padding: 24px;
        width: min(610px, 100%);
        max-height: 90vh;
        overflow: auto;
        color: #243330;
      }

      #repairDialog label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        margin: 12px 0;
      }

      #repairDialog input,
      #repairDialog select,
      #repairDialog textarea {
        box-sizing: border-box;
        width: 100%;
        padding: 11px;
        margin-top: 5px;
        border: 1px solid #ccd7d4;
        border-radius: 8px;
        font: inherit;
      }

      #repairDialog textarea {
        min-height: 95px;
      }

      #repairDialog .rf-buttons {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 18px;
      }

      #repairDialog button {
        padding: 10px 15px;
        border-radius: 8px;
        cursor: pointer;
      }

      #repairDialog .rf-primary {
        background: #437e7b;
        color: white;
        border: 0;
      }

      #repairDialog .rf-preview {
        max-width: 200px;
        max-height: 150px;
        display: none;
      }

      #repairDialog .rf-error {
        color: #b42318;
      }
    `;

    document.head.appendChild(style);

    box = document.createElement("div");
    box.id = "repairDialog";

    box.innerHTML = `
      <div class="rf-card" role="dialog" aria-modal="true">
        <h2 id="rfTitle"></h2>
        <div id="rfBody"></div>
      </div>
    `;

    document.body.appendChild(box);

    box.addEventListener("click", (event) => {
      if (event.target === box) {
        closeModal();
      }
    });
  }

  el("rfTitle").textContent = title;
  el("rfBody").innerHTML = html;

  box.classList.add("open");

  el("rfCancel")?.addEventListener("click", closeModal);
}

function closeModal() {
  el("repairDialog")?.classList.remove("open");
  photo = "";
}

async function compress(file) {
  if (!file) return "";

  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  ) {
    throw Error("Foto harus JPG/PNG/WebP maksimal 10 MB.");
  }

  const bitmap = await createImageBitmap(file);

  try {
    let width = 900;
    let quality = 0.75;

    for (let i = 0; i < 10; i++) {
      const scale = Math.min(
        1,
        width / Math.max(bitmap.width, bitmap.height)
      );

      const canvas = document.createElement("canvas");

      canvas.width = Math.max(
        1,
        Math.round(bitmap.width * scale)
      );

      canvas.height = Math.max(
        1,
        Math.round(bitmap.height * scale)
      );

      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        bitmap,
        0,
        0,
        canvas.width,
        canvas.height
      );

      const data = canvas.toDataURL("image/jpeg", quality);

      if (data.length <= 120000) {
        return data;
      }

      width = Math.round(width * 0.78);
      quality = Math.max(0.35, quality - 0.06);
    }

    throw Error("Foto terlalu besar setelah kompresi.");
  } finally {
    bitmap.close();
  }
}

function photoInput() {
  const input = el("rfPhoto");

  if (!input) return;

  input.onchange = async (event) => {
    photo = "";

    const img = el("rfPreview");

    img.style.display = "none";
    el("rfError").textContent = "";

    try {
      if (event.target.files[0]) {
        photo = await compress(event.target.files[0]);

        img.src = photo;
        img.style.display = "block";
      }
    } catch (error) {
      el("rfError").textContent = error.message;
      input.value = "";
    }
  };
}

function reportForm() {
  if (!uid || !profile) {
    return notice("Silakan login terlebih dahulu.");
  }

  photo = "";

  modal("Lapor Kerusakan", `
    <form id="rfForm">
      <label>
        Kategori *
        <select name="category" required>
          <option value="">Pilih kategori</option>
          <option>AC</option>
          <option>Listrik</option>
          <option>Air / Plumbing</option>
          <option>Bangunan</option>
          <option>Furniture</option>
          <option>Peralatan</option>
          <option>Lainnya</option>
        </select>
      </label>

      <label>
        Lokasi *
        <input name="location" maxlength="150" required>
      </label>

      <label>
        Deskripsi masalah *
        <textarea
          name="description"
          maxlength="1000"
          required
        ></textarea>
      </label>

      <label>
        Urgensi *
        <select name="urgency">
          <option>Rendah</option>
          <option selected>Sedang</option>
          <option>Mendesak</option>
        </select>
      </label>

      <label>
        Foto kerusakan (opsional)
        <input
          id="rfPhoto"
          type="file"
          accept="image/jpeg,image/png,image/webp"
        >
      </label>

      <img
        id="rfPreview"
        class="rf-preview"
        alt="Preview foto"
      >

      <p class="rf-error" id="rfError"></p>

      <div class="rf-buttons">
        <button type="button" id="rfCancel">
          Batal
        </button>

        <button
          type="submit"
          class="rf-primary"
          id="rfSave"
        >
          Kirim Laporan
        </button>
      </div>
    </form>
  `);

  photoInput();

  el("rfForm").onsubmit = async (event) => {
    event.preventDefault();

    if (busy) return;

    const form = new FormData(event.currentTarget);

    const category = String(form.get("category") || "");
    const location = String(form.get("location") || "").trim();
    const description = String(form.get("description") || "").trim();
    const urgency = String(form.get("urgency") || "");

    if (!category || !location || !description) {
      return;
    }

    busy = true;
    el("rfSave").disabled = true;

    try {
      const id = ticket();

      await setDoc(doc(db, "repairRequests", id), {
        ticketNo: id,
        type: "perbaikan",
        requesterUid: uid,
        requesterName: profile.name,
        department: profile.department || "",
        category,
        location,
        description,
        urgency,
        photoData: photo,
        status: "Baru",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      closeModal();
      notice("Laporan berhasil dikirim: " + id);
    } catch (error) {
      console.error(error);

      el("rfError").textContent =
        "Gagal menyimpan: " + error.message;
    } finally {
      busy = false;
      el("rfSave").disabled = false;
    }
  };
}

function actions(record) {
  let result = `
    <button
      data-action="detail"
      data-id="${escapeHTML(record.id)}"
    >
      Detail
    </button>
  `;

  if (isAdmin()) {
    if (record.status === "Baru") {
      result += `
        <button
          data-action="approve"
          data-id="${escapeHTML(record.id)}"
        >
          Setujui
        </button>

        <button
          data-action="reject"
          data-id="${escapeHTML(record.id)}"
        >
          Tolak
        </button>
      `;
    }

    if (
      ["Disetujui", "Menunggu Part"].includes(record.status)
    ) {
      result += `
        <button
          data-action="start"
          data-id="${escapeHTML(record.id)}"
        >
          Kerjakan
        </button>
      `;
    }

    if (record.status === "Dikerjakan") {
      result += `
        <button
          data-action="hold"
          data-id="${escapeHTML(record.id)}"
        >
          Tunggu Part
        </button>
      `;
    }

    if (
      ["Dikerjakan", "Menunggu Part"].includes(record.status)
    ) {
      result += `
        <button
          data-action="finish"
          data-id="${escapeHTML(record.id)}"
        >
          Selesai
        </button>
      `;
    }
  }

  if (
    record.requesterUid === uid &&
    record.status === "Baru"
  ) {
    result += `
      <button
        data-action="cancel"
        data-id="${escapeHTML(record.id)}"
      >
        Batalkan
      </button>
    `;
  }

  return result;
}

function render() {
  const tbody = el("repairTable");

  if (!tbody) return;

  const search = (
    el("repairSearch")?.value || ""
  ).toLowerCase();

  const status = el("repairFilter")?.value || "";

  const list = records.filter((record) => {
    const matchesStatus =
      !status || record.status === status;

    const matchesSearch = [
      record.ticketNo,
      record.requesterName,
      record.location,
      record.category,
      record.description
    ].some((value) =>
      String(value || "")
        .toLowerCase()
        .includes(search)
    );

    return matchesStatus && matchesSearch;
  });

  tbody.innerHTML = list.length
    ? list.map((record) => `
        <tr>
          <td>${escapeHTML(record.ticketNo)}</td>
          <td>${escapeHTML(
            record.createdAt?.toDate?.()
              .toLocaleDateString("id-ID") || "-"
          )}</td>
          <td>${escapeHTML(record.requesterName)}</td>
          <td>
            ${escapeHTML(record.category)} /
            ${escapeHTML(record.location)}
          </td>
          <td>${escapeHTML(record.description)}</td>
          <td>${escapeHTML(record.urgency)}</td>
          <td>${escapeHTML(record.executor || "-")}</td>
          <td>${escapeHTML(record.status)}</td>
          <td>${actions(record)}</td>
        </tr>
      `).join("")
    : `
      <tr>
        <td colspan="9" class="empty-cell">
          Belum ada laporan.
        </td>
      </tr>
    `;
}

function details(record) {
  const image = (value) =>
    typeof value === "string" &&
    value.startsWith("data:image/jpeg;base64,")
      ? `
        <img
          style="max-width:100%;max-height:250px"
          src="${value}"
          alt="Foto laporan"
        >
      `
      : "";

  modal("Detail " + record.ticketNo, `
    <p>
      <b>Pelapor:</b>
      ${escapeHTML(record.requesterName)}
    </p>

    <p>
      <b>Lokasi:</b>
      ${escapeHTML(record.location)}
    </p>

    <p>
      <b>Masalah:</b>
      ${escapeHTML(record.description)}
    </p>

    <p>
      <b>Status:</b>
      ${escapeHTML(record.status)}
    </p>

    <p>
      <b>Catatan:</b>
      ${escapeHTML(record.statusNote || "-")}
    </p>

    ${image(record.photoData)}
    ${image(record.afterPhotoData)}

    <div class="rf-buttons">
      <button id="rfCancel">Tutup</button>
    </div>
  `);
}

function updateForm(record, action) {
  const mapping = {
    approve: ["Setujui", "Disetujui"],
    reject: ["Tolak", "Ditolak"],
    start: ["Mulai Pekerjaan", "Dikerjakan"],
    hold: ["Tunggu Part", "Menunggu Part"],
    finish: ["Selesaikan", "Selesai"],
    cancel: ["Batalkan", "Dibatalkan"]
  };

  const config = mapping[action];

  if (!config) return;

  if (action !== "cancel" && !isAdmin()) {
    return notice("Tidak memiliki izin.");
  }

  if (
    action === "cancel" &&
    (
      record.requesterUid !== uid ||
      record.status !== "Baru"
    )
  ) {
    return;
  }

  const extra =
    action === "start"
      ? `
        <label>
          Pelaksana
          <select name="executor">
            <option>Internal</option>
            <option>Vendor</option>
          </select>
        </label>

        <label>
          Nama Vendor (jika vendor)
          <input
            name="vendorName"
            maxlength="100"
          >
        </label>
      `
      : action === "finish"
      ? `
        <label>
          Tindakan *
          <textarea
            name="actionNote"
            required
            maxlength="1000"
          ></textarea>
        </label>

        <label>
          Tanggal selesai *
          <input
            type="date"
            name="completedDate"
            value="${date()}"
            required
          >
        </label>

        <label>
          Biaya (Rp) *
          <input
            type="number"
            name="cost"
            min="0"
            max="100000000000"
            value="0"
            required
          >
        </label>

        <label>
          Foto hasil (opsional)
          <input
            type="file"
            id="rfPhoto"
            accept="image/jpeg,image/png,image/webp"
          >
        </label>

        <img
          id="rfPreview"
          class="rf-preview"
          alt="Foto hasil"
        >
      `
      : "";

  const required = [
    "reject",
    "hold",
    "cancel"
  ].includes(action);

  photo = "";

  modal(config[0] + " — " + record.ticketNo, `
    <form id="rfActionForm">
      <label>
        Catatan ${required ? "*" : "(opsional)"}
        <textarea
          name="statusNote"
          maxlength="500"
          ${required ? "required" : ""}
        ></textarea>
      </label>

      ${extra}

      <p class="rf-error" id="rfError"></p>

      <div class="rf-buttons">
        <button type="button" id="rfCancel">
          Batal
        </button>

        <button
          type="submit"
          id="rfSave"
          class="rf-primary"
        >
          Simpan
        </button>
      </div>
    </form>
  `);

  photoInput();

  el("rfActionForm").onsubmit = async (event) => {
    event.preventDefault();

    if (busy) return;

    const form = new FormData(event.currentTarget);

    const note = String(
      form.get("statusNote") || ""
    ).trim();

    const update = {
      status: config[1],
      statusNote: note,
      updatedAt: serverTimestamp()
    };

    if (action !== "cancel") {
      update.updatedBy = uid;
      update.updatedByName = profile.name;
    }

    if (action === "start") {
      update.executor = String(
        form.get("executor") || "Internal"
      );

      update.vendorName = String(
        form.get("vendorName") || ""
      ).trim();

      if (
        update.executor === "Vendor" &&
        !update.vendorName
      ) {
        el("rfError").textContent =
          "Nama vendor wajib.";
        return;
      }
    }

    if (action === "finish") {
      update.actionNote = String(
        form.get("actionNote") || ""
      ).trim();

      update.completedDate = String(
        form.get("completedDate") || ""
      );

      update.cost = Number(form.get("cost"));
      update.afterPhotoData = photo;

      if (
        !Number.isSafeInteger(update.cost) ||
        update.cost < 0 ||
        update.cost > 100000000000
      ) {
        el("rfError").textContent =
          "Biaya tidak valid.";
        return;
      }
    }

    busy = true;
    el("rfSave").disabled = true;

    try {
      await updateDoc(
        doc(db, "repairRequests", record.id),
        update
      );

      closeModal();
      notice("Status berhasil diperbarui.");
    } catch (error) {
      console.error(error);

      el("rfError").textContent =
        "Gagal memperbarui: " + error.message;
    } finally {
      busy = false;
      el("rfSave").disabled = false;
    }
  };
}

function setup() {
  el("newRepairButton")?.addEventListener(
    "click",
    reportForm
  );

  el("repairSearch")?.addEventListener(
    "input",
    render
  );

  const filter = el("repairFilter");

  if (filter) {
    filter.innerHTML =
      '<option value="">Semua status</option>' +
      statuses.map((status) =>
        `<option>${status}</option>`
      ).join("");

    filter.addEventListener("change", render);
  }

  el("repairTable")?.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest(
        "button[data-action]"
      );

      if (!button) return;

      const record = records.find(
        (item) => item.id === button.dataset.id
      );

      if (!record) return;

      if (button.dataset.action === "detail") {
        details(record);
      } else {
        updateForm(record, button.dataset.action);
      }
    }
  );
}

setup();

await authPersistenceReady;

onAuthStateChanged(auth, async (user) => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  uid = null;
  profile = null;
  records = [];

  render();

  if (!user) return;

  try {
    const snapshot = await getDoc(
      doc(db, "users", user.uid)
    );

    if (
      !snapshot.exists() ||
      snapshot.data().active !== true ||
      auth.currentUser?.uid !== user.uid
    ) {
      return;
    }

    uid = user.uid;
    profile = snapshot.data();

    const collectionRef = collection(
      db,
      "repairRequests"
    );

    const reportsQuery = allRoles.includes(
      profile.role
    )
      ? collectionRef
      : query(
          collectionRef,
          where("requesterUid", "==", uid)
        );

    unsubscribe = onSnapshot(
      reportsQuery,
      (snapshot) => {
        records = snapshot.docs
          .map((document) => ({
            ...document.data(),
            id: document.id
          }))
          .sort(
            (a, b) =>
              (b.createdAt?.seconds || 0) -
              (a.createdAt?.seconds || 0)
          );

        render();
      },
      (error) => {
        console.error(
          "Repair Firestore:",
          error
        );

        if (el("repairTable")) {
          el("repairTable").innerHTML = `
            <tr>
              <td colspan="9">
                Gagal memuat:
                ${escapeHTML(error.message)}
              </td>
            </tr>
          `;
        }
      }
    );
  } catch (error) {
    console.error(
      "Repair initialization:",
      error
    );
  }
});
