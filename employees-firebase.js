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
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

const $ = id => document.getElementById(id);

let user = null;
let profile = null;
let employees = [];
let userAccounts = [];
let generation = 0;

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

const isStaff = () => !!profile && profile.role === "main_admin";

async function loadData() {
  if (!user || !isStaff()) return;
  const current = ++generation;

  try {
    const [empSnap, userSnap] = await Promise.all([
      getDocs(collection(db, "employeeMaster")),
      getDocs(collection(db, "users"))
    ]);

    if (current !== generation) return;

    employees = empSnap.docs.map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "id"));

    userAccounts = userSnap.docs.map(d => ({ ...d.data(), id: d.id }));

    populateDeptFilter();
    renderTable();
  } catch (err) {
    console.error("Gagal memuat Master Karyawan:", err);
  }
}

function populateDeptFilter() {
  const select = $("employeeDeptFilter");
  if (!select) return;
  const depts = Array.from(new Set(employees.map(e => e.department).filter(Boolean))).sort();
  const currentVal = select.value;
  select.innerHTML = '<option value="">Semua Departemen</option>' +
    depts.map(d => `<option value="${esc(d)}"${d === currentVal ? " selected" : ""}>${esc(d)}</option>`).join("");
}

function renderTable() {
  const table = $("employeeMasterTable");
  if (!table) return;

  const term = ($("employeeMasterSearch")?.value || "").trim().toLocaleLowerCase("id-ID");
  const deptFilter = $("employeeDeptFilter")?.value || "";
  const statusFilter = $("employeeStatusFilter")?.value || "";

  const filtered = employees.filter(e => {
    if (deptFilter && e.department !== deptFilter) return false;
    if (statusFilter && (e.activeStatus || "Aktif") !== statusFilter) return false;
    if (!term) return true;
    return [
      e.name, e.nik, e.idCardNo, e.position, e.department,
      e.workLocation, e.blockNo, e.team, e.supervisor
    ].join(" ").toLocaleLowerCase("id-ID").includes(term);
  });

  table.innerHTML = filtered.length ? filtered.map(e => {
    const linkedUser = userAccounts.find(u => u.id === e.linkedUid || u.email === e.email);
    const linkBadge = linkedUser
      ? `<span class="status-badge" style="background:#e0f2fe;color:#0369a1;"><i class="fa-solid fa-link"></i> ${esc(linkedUser.email || linkedUser.name)}</span>`
      : `<span class="status-badge neutral">Belum Taut</span>`;

    return `
      <tr>
        <td data-label="Nama"><strong>${esc(e.name || "-")}</strong><br><small>${esc(e.email || "-")}</small></td>
        <td data-label="NIK">${esc(e.nik || "-")}</td>
        <td data-label="No ID Card">${esc(e.idCardNo || "-")}</td>
        <td data-label="Jabatan & Dept">${esc(e.position || "-")}<br><small>${esc(e.department || "-")}</small></td>
        <td data-label="Lokasi / Blok">${esc(e.workLocation || "-")} / ${esc(e.blockNo || "-")}</td>
        <td data-label="Status Kerja"><span class="status-badge ${(e.activeStatus || "Aktif") === "Aktif" ? "" : "neutral"}">${esc(e.activeStatus || "Aktif")}</span></td>
        <td data-label="Akun Linked">${linkBadge}</td>
        <td data-label="Aksi">
          <div class="row-actions">
            <button type="button" class="small-action" data-emp-act="edit" data-id="${esc(e.id)}">Edit</button>
            <button type="button" class="small-action delete" data-emp-act="delete" data-id="${esc(e.id)}">Hapus</button>
          </div>
        </td>
      </tr>`;
  }).join("") : `<tr><td colspan="8" class="empty-cell">Tidak ada data karyawan.</td></tr>`;
}

function openModal(title, bodyHTML, actions) {
  $("empModal")?.remove();
  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "empModal";
  modal.innerHTML = `
    <div class="modal-card" style="max-width:650px;">
      <div class="modal-heading">
        <div>
          <span class="eyebrow">EMPLOYEE MASTER DATA</span>
          <h2>${esc(title)}</h2>
        </div>
        <button type="button" class="icon-button" data-close aria-label="Tutup"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="shell-modal-body">${bodyHTML}</div>
      <div class="modal-actions">
        ${actions.map((a, i) => `<button type="button" class="${esc(a.cls || "secondary-button")}" data-act="${i}">${esc(a.label)}</button>`).join("")}
      </div>
    </div>`;

  modal.addEventListener("click", async event => {
    if (event.target === modal || event.target.closest("[data-close]")) return modal.remove();
    const btn = event.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = actions[Number(btn.dataset.act)];
    if (!act.onClick) return modal.remove();
    btn.disabled = true;
    try {
      await act.onClick();
      modal.remove();
    } catch (err) {
      console.error(err);
      toast(err.message || "Terjadi kesalahan.");
      btn.disabled = false;
    }
  });

  document.body.appendChild(modal);
}

function openForm(employee = null) {
  const e = employee || {};
  const isEdit = !!e.id;

  const userOpts = ['<option value="">-- Pilih Akun User (Opsional) --</option>'].concat(
    userAccounts.map(u => `<option value="${esc(u.id)}"${u.id === e.linkedUid ? " selected" : ""}>${esc(u.name)} (${esc(u.email)})</option>`)
  ).join("");

  const bodyHTML = `
    <div class="form-fields">
      <div class="field"><label>Nama Lengkap *</label><input id="emName" maxlength="100" value="${esc(e.name || "")}" required></div>
      <div class="field"><label>NIK / Employee ID *</label><input id="emNik" maxlength="50" value="${esc(e.nik || "")}" required></div>
      <div class="field"><label>No ID Card</label><input id="emIdCardNo" maxlength="50" value="${esc(e.idCardNo || "")}"></div>
      <div class="field"><label>No Blok</label><input id="emBlockNo" maxlength="50" value="${esc(e.blockNo || "")}"></div>
      <div class="field"><label>Nama Lokasi Kerja</label><input id="emWorkLocation" maxlength="150" value="${esc(e.workLocation || "")}"></div>
      <div class="field"><label>Departemen</label><input id="emDepartment" maxlength="100" value="${esc(e.department || "")}"></div>
      <div class="field"><label>Jabatan / Position</label><input id="emPosition" maxlength="100" value="${esc(e.position || "")}"></div>
      <div class="field"><label>Tim / Team</label><input id="emTeam" maxlength="100" value="${esc(e.team || "")}"></div>
      <div class="field"><label>Atasan / Supervisor</label><input id="emSupervisor" maxlength="100" value="${esc(e.supervisor || "")}"></div>
      <div class="field"><label>Email</label><input id="emEmail" type="email" maxlength="100" value="${esc(e.email || "")}"></div>
      <div class="field"><label>Status Kepegawaian</label><select id="emEmpStatus"><option ${e.employmentStatus === "Tetap" ? "selected" : ""}>Tetap</option><option ${e.employmentStatus === "Kontrak" ? "selected" : ""}>Kontrak</option><option ${e.employmentStatus === "Outsourcing" ? "selected" : ""}>Outsourcing</option><option ${e.employmentStatus === "Magang" ? "selected" : ""}>Magang</option></select></div>
      <div class="field"><label>Status Aktif</label><select id="emActiveStatus"><option ${e.activeStatus === "Aktif" ? "selected" : ""}>Aktif</option><option ${e.activeStatus === "Nonaktif" ? "selected" : ""}>Nonaktif</option></select></div>
      <div class="field full"><label>Tautkan dengan Akun Auth User</label><select id="emLinkedUid">${userOpts}</select></div>
      <div class="field full"><label>Uraian Tugas / Job Description</label><textarea id="emJobDesc" maxlength="500">${esc(e.jobDescription || "")}</textarea></div>
    </div>`;

  openModal(
    isEdit ? "Edit Master Karyawan" : "Tambah Master Karyawan",
    bodyHTML,
    [
      { label: "Batal" },
      {
        label: isEdit ? "Simpan Perubahan" : "Tambah Karyawan",
        cls: "primary-button",
        onClick: async () => {
          const name = ($("emName").value || "").trim();
          const nik = ($("emNik").value || "").trim();
          if (!name || !nik) throw new Error("Nama dan NIK wajib diisi.");

          const payload = {
            name,
            nik,
            idCardNo: ($("emIdCardNo").value || "").trim(),
            blockNo: ($("emBlockNo").value || "").trim(),
            workLocation: ($("emWorkLocation").value || "").trim(),
            department: ($("emDepartment").value || "").trim(),
            position: ($("emPosition").value || "").trim(),
            team: ($("emTeam").value || "").trim(),
            supervisor: ($("emSupervisor").value || "").trim(),
            email: ($("emEmail").value || "").trim(),
            employmentStatus: $("emEmpStatus").value,
            activeStatus: $("emActiveStatus").value,
            linkedUid: $("emLinkedUid").value || "",
            jobDescription: ($("emJobDesc").value || "").trim(),
            updatedAt: serverTimestamp()
          };

          const docId = isEdit ? e.id : nik.replace(/[^A-Za-z0-9_-]/g, "");
          const docRef = doc(db, "employeeMaster", docId);

          if (!isEdit) {
            const existingSnap = await getDoc(docRef);
            if (existingSnap.exists()) {
              throw new Error(`Karyawan dengan NIK/Employee ID "${nik}" sudah ada di database.`);
            }
            payload.createdAt = serverTimestamp();
            await setDoc(docRef, payload);
          } else {
            await updateDoc(docRef, payload);
          }

          if (payload.linkedUid) {
            try {
              await updateDoc(doc(db, "users", payload.linkedUid), {
                idCardNo: payload.idCardNo,
                blockNo: payload.blockNo,
                workLocation: payload.workLocation,
                department: payload.department,
                nik: payload.nik
              });
            } catch (err) {
              console.warn("Gagal update user document:", err);
            }
          }

          toast(isEdit ? "Data karyawan diperbarui." : "Karyawan ditambahkan.");
          await loadData();
        }
      }
    ]
  );
}

$("addEmployeeBtn")?.addEventListener("click", () => openForm());
$("employeeMasterSearch")?.addEventListener("input", renderTable);
$("employeeDeptFilter")?.addEventListener("change", renderTable);
$("employeeStatusFilter")?.addEventListener("change", renderTable);

$("employeeMasterTable")?.addEventListener("click", async event => {
  const btn = event.target.closest("[data-emp-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const emp = employees.find(x => x.id === id);
  if (!emp) return;

  if (btn.dataset.empAct === "edit") {
    openForm(emp);
  } else if (btn.dataset.empAct === "delete") {
    openModal(
      "Hapus Master Karyawan?",
      `<p>Apakah Anda yakin ingin menghapus data <strong>${esc(emp.name)}</strong> (${esc(emp.nik)})?</p>`,
      [
        { label: "Batal" },
        {
          label: "Hapus",
          cls: "secondary-button danger-outline",
          onClick: async () => {
            await deleteDoc(doc(db, "employeeMaster", id));
            toast("Data karyawan dihapus.");
            await loadData();
          }
        }
      ]
    );
  }
});

$("empImportExcelBtn")?.addEventListener("click", () => {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".xlsx, .xls";
  fileInput.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const XLSX = window.XLSX || await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mjs");
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet);

      if (!rows.length) return toast("File Excel kosong atau format tidak sesuai.");

      let successCount = 0;
      let skipCount = 0;

      for (const row of rows) {
        const nik = String(row["NIK"] || row["Nik"] || row["NIK/Employee ID"] || "").trim();
        const name = String(row["Nama"] || row["Nama Lengkap"] || row["Name"] || "").trim();

        if (!nik || !name) {
          skipCount++;
          continue;
        }

        const docId = nik.replace(/[^A-Za-z0-9_-]/g, "");
        const docRef = doc(db, "employeeMaster", docId);

        const payload = {
          nik,
          name,
          idCardNo: String(row["No ID Card"] || row["ID Card"] || "").trim(),
          blockNo: String(row["No Blok"] || row["Blok"] || "").trim(),
          workLocation: String(row["Lokasi Kerja"] || row["Nama Lokasi Kerja"] || "").trim(),
          department: String(row["Departemen"] || row["Department"] || "").trim(),
          position: String(row["Jabatan"] || row["Position"] || "").trim(),
          team: String(row["Tim"] || row["Team"] || "").trim(),
          supervisor: String(row["Supervisor"] || row["Atasan"] || "").trim(),
          email: String(row["Email"] || "").trim(),
          employmentStatus: String(row["Status Kepegawaian"] || "Tetap").trim(),
          activeStatus: String(row["Status Aktif"] || "Aktif").trim(),
          jobDescription: String(row["Uraian Tugas"] || row["Job Description"] || "").trim(),
          updatedAt: serverTimestamp()
        };

        const existingSnap = await getDoc(docRef);
        if (!existingSnap.exists()) {
          payload.createdAt = serverTimestamp();
          await setDoc(docRef, payload);
          successCount++;
        } else {
          await updateDoc(docRef, payload);
          successCount++;
        }
      }

      toast(`Import selesai: ${successCount} data berhasil diproses, ${skipCount} dilewati.`);
      await loadData();
    } catch (err) {
      console.error(err);
      toast("Gagal mengimpor file Excel: " + (err.message || "format salah"));
    }
  };
  fileInput.click();
});

$("empExportExcelBtn")?.addEventListener("click", async () => {
  if (!employees.length) return toast("Tidak ada data karyawan untuk diexport.");
  try {
    const XLSX = window.XLSX || await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mjs");
    const data = employees.map(e => ({
      "NIK": e.nik || "",
      "Nama": e.name || "",
      "No ID Card": e.idCardNo || "",
      "No Blok": e.blockNo || "",
      "Lokasi Kerja": e.workLocation || "",
      "Departemen": e.department || "",
      "Jabatan": e.position || "",
      "Tim": e.team || "",
      "Supervisor": e.supervisor || "",
      "Email": e.email || "",
      "Status Kepegawaian": e.employmentStatus || "",
      "Status Aktif": e.activeStatus || "Aktif",
      "Uraian Tugas": e.jobDescription || ""
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Master Karyawan");
    XLSX.writeFile(wb, `master-karyawan-${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast("Master Karyawan berhasil diexport.");
  } catch (err) {
    console.error(err);
    toast("Gagal export Excel.");
  }
});

document.addEventListener("ga:page", event => {
  if (event.detail === "employees-master") loadData();
});

await authPersistenceReady;

onAuthStateChanged(auth, async current => {
  user = null;
  profile = null;
  if (!current) return;

  try {
    await current.reload();
    if (!current.emailVerified) return;

    const snap = await getDoc(doc(db, "users", current.uid));
    if (!snap.exists() || snap.data().active !== true) return;

    user = current;
    profile = snap.data();

    if (document.querySelector(".page.active")?.id === "page-employees-master") {
      loadData();
    }
  } catch (err) {
    console.error("Master Karyawan auth listener error:", err);
  }
});
