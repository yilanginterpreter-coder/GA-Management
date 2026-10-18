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

let user = null;
let profile = null;
let prList = [];
let poList = [];
let vendorsList = [];
let archiveDocsList = [];

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

function field(label, control, full = true) {
  return `<div class="field ${full ? "full" : ""}"><label>${esc(label)}</label>${control}</div>`;
}

function closeModal() {
  $("procurementModal")?.remove();
}

function openModal(title, bodyHTML, submitLabel, onSubmit) {
  closeModal();

  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "procurementModal";
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-heading">
        <div>
          <span class="eyebrow">GA PROCUREMENT</span>
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
    if (!onSubmit) return;

    const submitBtn = event.currentTarget.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const formData = Object.fromEntries(new FormData(event.currentTarget));
      const res = await onSubmit(formData);
      closeModal();
      toast(res || "Berhasil disimpan.");
      await loadData();
    } catch (err) {
      console.error("Procurement action error:", err);
      toast(err.message || "Terjadi kesalahan.");
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  document.body.appendChild(modal);
}

async function loadVendorPortalData() {
  if (!user || profile?.role !== "vendor") return;

  const vendorId = profile.vendorId;
  const table = $("vendorPoTable");
  if (!table) return;

  try {
    if (!vendorId) {
      table.innerHTML = `<tr><td colspan="6" class="empty-cell">Akun vendor Anda belum dihubungkan ke Master Vendor. Hubungi Main Admin.</td></tr>`;
      return;
    }

    const q = query(collection(db, "purchaseOrders"), where("vendorId", "==", vendorId));
    const snap = await getDocs(q);
    const pos = snap.docs.map(d => ({ ...d.data(), id: d.id }));

    table.innerHTML = pos.length ? pos.map(po => `
      <tr>
        <td><strong>${esc(po.poNo)}</strong></td>
        <td>${esc(po.poDate || "-")}</td>
        <td>${esc(po.items?.[0]?.itemName)} × ${esc(po.items?.[0]?.quantity)} ${esc(po.items?.[0]?.unit)}</td>
        <td>${esc(po.expectedDeliveryDate || "-")}</td>
        <td><span class="status-badge ${po.status === 'Closed' || po.status === 'Delivered' ? '' : 'warning'}">${esc(po.status || 'PO Issued')}</span></td>
        <td>
          <button type="button" class="small-action" data-vpo-update="${esc(po.id)}">Update Status & Surat Jalan</button>
        </td>
      </tr>
    `).join("") : `<tr><td colspan="6" class="empty-cell">Belum ada PO yang ditugaskan ke vendor Anda.</td></tr>`;
  } catch (err) {
    console.error("Gagal load vendor portal PO:", err);
    table.innerHTML = `<tr><td colspan="6" class="empty-cell">Gagal memuat PO vendor.</td></tr>`;
  }
}

$("vendorPoTable")?.addEventListener("click", async event => {
  const btn = event.target.closest("[data-vpo-update]");
  if (!btn) return;
  const poId = btn.dataset.vpoUpdate;

  const poDoc = await getDoc(doc(db, "purchaseOrders", poId));
  if (!poDoc.exists()) return toast("PO tidak ditemukan.");

  const po = poDoc.data();

  openModal(
    `Konfirmasi PO & Status Pengiriman - ${po.poNo}`,
    field("Status Pengiriman Vendor *", `
      <select name="status">
        <option value="Vendor Confirmed" ${po.status === 'Vendor Confirmed' ? 'selected' : ''}>Vendor Confirmed (Diterima & Diproses)</option>
        <option value="Shipped / In Progress" ${po.status === 'Shipped / In Progress' ? 'selected' : ''}>Shipped / Dalam Pengiriman</option>
        <option value="Delivered" ${po.status === 'Delivered' ? 'selected' : ''}>Delivered / Sudah Sampai</option>
      </select>
    `) +
    field("Nomor Surat Jalan Vendor", `<input name="vendorDeliveryNote" value="${esc(po.vendorDeliveryNote || "")}" placeholder="SJ-VND-2026/001">`) +
    field("Catatan Pengiriman / Estimasi Tiba", `<textarea name="shipmentNotes" placeholder="Catatan ekspedisi, kurir, plat nomor armada...">${esc(po.shipmentNotes || "")}</textarea>`),
    "Simpan Status",
    async data => {
      await updateDoc(doc(db, "purchaseOrders", poId), {
        status: data.status,
        vendorDeliveryNote: data.vendorDeliveryNote || "",
        shipmentNotes: data.shipmentNotes || "",
        updatedAt: serverTimestamp()
      });

      return "Status PO berhasil diperbarui oleh Vendor.";
    }
  );
});

async function loadData() {
  if (!user || !profile) return;

  try {
    const [prSnap, poSnap, vendorSnap] = await Promise.all([
      getDocs(collection(db, "procurementRequisitions")),
      getDocs(collection(db, "purchaseOrders")),
      getDocs(collection(db, "vendors"))
    ]);

    prList = prSnap.docs.map(d => ({ ...d.data(), id: d.id }));
    poList = poSnap.docs.map(d => ({ ...d.data(), id: d.id }));
    vendorsList = vendorSnap.docs.map(d => ({ ...d.data(), id: d.id }));

    const archiveSnap = await getDocs(collection(db, "documentArchive"));
    archiveDocsList = archiveSnap.docs.map(d => ({ ...d.data(), id: d.id }));

    renderPrTable();
    renderPoTable();
    renderArchiveDocsTable();
  } catch (err) {
    console.error("Gagal memuat data pengadaan:", err);
  }
}

function renderPrTable() {
  const body = $("prTable");
  if (!body) return;

  body.innerHTML = prList.length ? prList.map(pr => `
    <tr>
      <td><strong>${esc(pr.prNo || pr.id)}</strong></td>
      <td>${esc(pr.createdAt?.toDate ? pr.createdAt.toDate().toLocaleDateString("id-ID") : "-")}</td>
      <td>${esc(pr.requesterName || "-")} <small>(${esc(pr.department || "-")})</small></td>
      <td>${esc(pr.items?.[0]?.itemName || "-")} × ${esc(pr.items?.[0]?.quantity || 1)} ${esc(pr.items?.[0]?.unit || "")}</td>
      <td>${esc(pr.neededDate || "-")}</td>
      <td><span class="status-badge ${pr.status === 'Approved' ? '' : 'warning'}">${esc(pr.status || 'Draft')}</span></td>
      <td>
        <button type="button" class="small-action" data-pr-action="review" data-id="${esc(pr.id)}">Review GA</button>
        ${pr.status === 'Approved' ? `<button type="button" class="small-action" data-pr-action="create-po" data-id="${esc(pr.id)}">Terbitkan PO</button>` : ''}
      </td>
    </tr>
  `).join("") : `<tr><td colspan="7" class="empty-cell">Belum ada Requisisi Pembelian (PR).</td></tr>`;
}

function renderArchiveDocsTable() {
  const body = $("archiveDocsTable");
  if (!body) return;

  body.innerHTML = archiveDocsList.length ? archiveDocsList.map(doc => `
    <tr>
      <td><span class="status-badge ${doc.type === 'Invoice' ? 'warning' : ''}">${esc(doc.type)}</span></td>
      <td><strong>${esc(doc.docNo)}</strong></td>
      <td>${esc(doc.poNo || "-")}</td>
      <td>${esc(doc.vendorName || "-")}</td>
      <td>${esc(doc.docDate || "-")}</td>
      <td>${doc.amount ? 'Rp ' + Number(doc.amount).toLocaleString('id-ID') : '-'}</td>
      <td><span class="status-badge">${esc(doc.status || "Archived")}</span></td>
      <td>
        <button type="button" class="small-action" data-archive-detail="${esc(doc.id)}">Detail Dokumentasi</button>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="8" class="empty-cell">Belum ada dokumen yang diarsip.</td></tr>`;
}

$("uploadArchiveDocBtn")?.addEventListener("click", () => {
  const poOptions = poList.map(p => `<option value="${esc(p.poNo)}">${esc(p.poNo)} - ${esc(p.vendorName)}</option>`).join("");

  openModal(
    "Arsipkan Dokumen Baru (Delivery Note / Invoice Archive)",
    field("Jenis Dokumen *", `<select name="type"><option value="Surat Jalan">Surat Jalan (Delivery Note)</option><option value="Invoice">Invoice (Tagihan Non-Payment)</option><option value="PR/PO Signed">PR/PO Signed Approval</option></select>`, false) +
    field("Nomor Dokumen *", `<input name="docNo" required placeholder="Contoh: INV/2026/089 atau SJ-99281">`, false) +
    field("Ref Official PO *", `<select name="poNo" required>${poOptions}</select>`, false) +
    field("Tanggal Dokumen *", `<input name="docDate" type="date" value="${new Date().toISOString().slice(0,10)}" required>`, false) +
    field("Nominal Tagihan (Pencatatan Dokumentasi) *", `<input name="amount" type="number" placeholder="Contoh: 1500000 (Opsional / Non-Payment)" value="0">`, false) +
    field("Catatan Arsip", `<textarea name="notes" placeholder="Catatan kelengkapan dokumen..."></textarea>`),
    "Simpan ke Arsip Dokumen",
    async data => {
      const selectedPo = poList.find(p => p.poNo === data.poNo);

      const archRef = doc(collection(db, "documentArchive"));
      await setDoc(archRef, {
        type: data.type,
        docNo: data.docNo,
        poNo: data.poNo,
        vendorName: selectedPo ? selectedPo.vendorName : "-",
        docDate: data.docDate,
        amount: Number(data.amount) || 0,
        notes: data.notes || "",
        status: "Documents Complete",
        archivedBy: user.uid,
        archivedByName: profile.name,
        createdAt: serverTimestamp()
      });

      if (selectedPo?.id) {
        await updateDoc(doc(db, "purchaseOrders", selectedPo.id), {
          status: "Closed",
          updatedAt: serverTimestamp()
        }).catch(() => {});
      }

      return "Dokumen berhasil diarsipkan dan status PO diperbarui menjadi Closed (Documents Complete).";
    }
  );
});

$("archiveDocsTable")?.addEventListener("click", event => {
  const btn = event.target.closest("[data-archive-detail]");
  if (!btn) return;
  const docId = btn.dataset.archiveDetail;
  const item = archiveDocsList.find(x => x.id === docId);
  if (!item) return;

  openModal(
    `Detail Arsip Dokumen: ${item.docNo}`,
    field("Jenis Dokumen", `<div>${esc(item.type)}</div>`) +
    field("Ref Official PO", `<div>${esc(item.poNo)}</div>`) +
    field("Vendor", `<div>${esc(item.vendorName)}</div>`) +
    field("Tanggal", `<div>${esc(item.docDate)}</div>`) +
    field("Nominal (Pencatatan)", `<div>${item.amount ? 'Rp ' + Number(item.amount).toLocaleString('id-ID') : '-'}</div>`) +
    field("Catatan", `<div>${esc(item.notes || "-")}</div>`) +
    field("Diarsipkan Oleh", `<div>${esc(item.archivedByName)}</div>`),
    "",
    null
  );
});

function renderPoTable() {
  const body = $("poTable");
  if (!body) return;

  body.innerHTML = poList.length ? poList.map(po => `
    <tr>
      <td><strong>${esc(po.poNo || po.id)}</strong></td>
      <td>${esc(po.poDate || "-")}</td>
      <td>${esc(po.vendorName || "-")}</td>
      <td>${esc(po.prNo || "-")}</td>
      <td>${esc(po.expectedDeliveryDate || "-")}</td>
      <td><span class="status-badge ${po.status === 'Delivered' || po.status === 'Closed' ? '' : 'warning'}">${esc(po.status || 'PO Issued')}</span></td>
      <td>
        <button type="button" class="small-action" data-po-action="detail" data-id="${esc(po.id)}">Detail / Cetak</button>
        ${po.status !== 'Closed' ? `<button type="button" class="small-action" data-po-action="receive" data-id="${esc(po.id)}">Terima Barang</button>` : ''}
      </td>
    </tr>
  `).join("") : `<tr><td colspan="7" class="empty-cell">Belum ada Purchase Order (PO).</td></tr>`;
}

function openCreatePoModal(preselectedPr = null) {
  if (!vendorsList.length) {
    return toast("Belum ada vendor terdaftar. Tambahkan vendor di menu Vendor terlebih dahulu.");
  }

  const vendorOptions = vendorsList.map(v => `<option value="${esc(v.id)}">${esc(v.name || v.companyName || v.id)} (${esc(v.category || "General")})</option>`).join("");
  const today = new Date().toISOString().slice(0, 10);
  const autoPoNo = `PO-GA-${new Date().getFullYear()}${String(new Date().getMonth()+1).padStart(2,'0')}-${Math.floor(1000 + Math.random() * 9000)}`;

  openModal(
    "Terbitkan Official Purchase Order (PO)",
    field("Nomor Official PO", `<input name="poNo" value="${esc(autoPoNo)}" readonly style="background:#F1F5F9;">`) +
    field("Ref Requisisi (PR)", `<input name="prNo" value="${esc(preselectedPr ? preselectedPr.prNo : "")}" placeholder="PR-GA-..." ${preselectedPr ? 'readonly' : ''}>`, false) +
    field("Pilih Vendor *", `<select name="vendorId" required>${vendorOptions}</select>`, false) +
    field("Tanggal PO *", `<input name="poDate" type="date" value="${today}" required>`, false) +
    field("Perkiraan Tanggal Tiba *", `<input name="expectedDeliveryDate" type="date" value="${today}" required>`, false) +
    field("Deskripsi Barang / Layanan *", `<input name="itemName" value="${esc(preselectedPr?.items?.[0]?.itemName || "")}" required>`, false) +
    field("Jumlah *", `<input name="quantity" type="number" min="1" value="${esc(preselectedPr?.items?.[0]?.quantity || 1)}" required>`, false) +
    field("Satuan *", `<input name="unit" value="${esc(preselectedPr?.items?.[0]?.unit || "Unit")}" required>`, false) +
    field("Catatan Tambahan & Ketentuan", `<textarea name="notes" placeholder="Catatan pengiriman, alamat gudang, dll..."></textarea>`),
    "Terbitkan PO Official",
    async data => {
      const selectedVendor = vendorsList.find(v => v.id === data.vendorId);

      const poRef = doc(db, "purchaseOrders", autoPoNo);
      await setDoc(poRef, {
        poNo: autoPoNo,
        prNo: data.prNo || null,
        vendorId: data.vendorId,
        vendorName: selectedVendor ? (selectedVendor.name || selectedVendor.companyName) : "Vendor",
        poDate: data.poDate,
        expectedDeliveryDate: data.expectedDeliveryDate,
        items: [{
          itemName: data.itemName,
          quantity: Number(data.quantity),
          unit: data.unit
        }],
        notes: data.notes || "",
        status: "PO Issued",
        issuedBy: user.uid,
        issuedByName: profile.name,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      if (data.prNo) {
        await updateDoc(doc(db, "procurementRequisitions", data.prNo), {
          status: "PO Issued",
          poNo: autoPoNo,
          updatedAt: serverTimestamp()
        }).catch(() => {});
      }

      return `Purchase Order ${autoPoNo} berhasil diterbitkan!`;
    }
  );
}

$("createPoButton")?.addEventListener("click", () => openCreatePoModal());

$("prTable")?.addEventListener("click", event => {
  const btn = event.target.closest("[data-pr-action]");
  if (!btn) return;

  const action = btn.dataset.prAction;
  const id = btn.dataset.id;
  const pr = prList.find(x => x.id === id);
  if (!pr) return;

  if (action === "review") {
    openModal(
      `Review Requisisi ${pr.prNo}`,
      field("Pemohon / Dept", `<div>${esc(pr.requesterName)} (${esc(pr.department)})</div>`) +
      field("Supervisor", `<div>${esc(pr.supervisorInfo || "-")}</div>`) +
      field("Barang / Kebutuhan", `<div>${esc(pr.items?.[0]?.itemName)} × ${esc(pr.items?.[0]?.quantity)} ${esc(pr.items?.[0]?.unit)}</div>`) +
      field("Justifikasi Bisnis", `<div>${esc(pr.justification || "-")}</div>`) +
      field("Status Saat Ini", `<div><strong style="color:#2563EB;">${esc(pr.status)}</strong></div>`),
      "Setujui (Approve) Requisisi",
      async () => {
        await updateDoc(doc(db, "procurementRequisitions", id), {
          status: "Approved",
          reviewedBy: user.uid,
          reviewedByName: profile.name,
          updatedAt: serverTimestamp()
        });
        return "Requisisi berhasil disetujui untuk diterbitkan PO!";
      }
    );
  } else if (action === "create-po") {
    openCreatePoModal(pr);
  }
});

$("poTable")?.addEventListener("click", async event => {
  const btn = event.target.closest("[data-po-action]");
  if (!btn) return;

  const action = btn.dataset.poAction;
  const id = btn.dataset.id;
  const po = poList.find(x => x.id === id);
  if (!po) return;

  if (action === "detail") {
    openModal(
      `Official Purchase Order: ${po.poNo}`,
      field("Vendor", `<div><strong>${esc(po.vendorName)}</strong></div>`) +
      field("Tanggal PO", `<div>${esc(po.poDate)}</div>`) +
      field("Perkiraan Tgl Tiba", `<div>${esc(po.expectedDeliveryDate)}</div>`) +
      field("Ref PR", `<div>${esc(po.prNo || "-")}</div>`) +
      field("Barang / Spesifikasi", `<div>${esc(po.items?.[0]?.itemName)} × ${esc(po.items?.[0]?.quantity)} ${esc(po.items?.[0]?.unit)}</div>`) +
      field("Status", `<div><strong>${esc(po.status)}</strong></div>`) +
      field("Cetak Form PO", `<button type="button" class="secondary-button" onclick="window.print()"><i class="fa-solid fa-print"></i> Cetak / Download PDF</button>`),
      "",
      null
    );
  } else if (action === "receive") {
    const invSnap = await getDocs(collection(db, "inventory"));
    const invItems = invSnap.docs.map(d => ({ ...d.data(), id: d.id }));
    const options = invItems.map(i => `<option value="${esc(i.id)}">${esc(i.code)} — ${esc(i.name)} (Stok: ${i.stock})</option>`).join("");

    openModal(
      `Penerimaan Barang (Goods Receipt) - ${po.poNo}`,
      field("Nomor Surat Jalan (Delivery Note) *", `<input name="deliveryNoteNo" required placeholder="SJ/2026/001">`, false) +
      field("Tanggal Terima *", `<input name="receiveDate" type="date" value="${new Date().toISOString().slice(0,10)}" required>`, false) +
      field("Jumlah Diterima *", `<input name="receivedQuantity" type="number" min="1" value="${esc(po.items?.[0]?.quantity || 1)}" required>`, false) +
      field("Update Stok Warehouse?", `<select name="updateStock"><option value="yes">Ya, Tambah Stok Gudang</option><option value="no">Tidak (Layanan/Perbaikan)</option></select>`, false) +
      field("Pilih Barang Warehouse", `<select name="itemId"><option value="">-- Pilih Barang di Inventory --</option>${options}</select>`) +
      field("Kondisi Barang *", `<select name="condition"><option value="Baik / Lengkap">Baik & Lengkap</option><option value="Ada Kerusakan">Ada Kerusakan / Cacat</option></select>`, false) +
      field("Catatan Penerimaan", `<textarea name="notes" placeholder="Catatan penerimaan fisik barang..."></textarea>`),
      "Konfirmasi Penerimaan & Atomic Stock Update",
      async data => {
        const qty = Number(data.receivedQuantity);
        if (!Number.isSafeInteger(qty) || qty <= 0) {
          throw new Error("Jumlah diterima harus lebih besar dari 0.");
        }

        const poRef = doc(db, "purchaseOrders", id);
        const grRef = doc(collection(db, "goodsReceipts"));

        if (data.updateStock === "yes" && data.itemId) {
          const itemRef = doc(db, "inventory", data.itemId);
          const trxRef = doc(collection(db, "transactions"));

          await runTransaction(db, async transaction => {
            const itemDoc = await transaction.get(itemRef);
            if (!itemDoc.exists()) throw new Error("Barang inventory tidak ditemukan.");

            const itemData = itemDoc.data();
            const currentStock = Number(itemData.stock) || 0;
            const newStock = currentStock + qty;

            transaction.update(itemRef, {
              stock: newStock,
              lastTransactionId: trxRef.id,
              lastStockBefore: currentStock
            });

            transaction.set(trxRef, {
              itemId: data.itemId,
              code: itemData.code || "",
              name: itemData.name || "",
              type: "Masuk",
              quantity: qty,
              stockBefore: currentStock,
              stockAfter: newStock,
              date: data.receiveDate,
              note: `Penerimaan PO ${po.poNo} - Surat Jalan: ${data.deliveryNoteNo}`,
              createdBy: user.uid,
              createdByName: profile.name,
              createdByRole: profile.role,
              createdAt: serverTimestamp(),
              testOnly: false
            });

            transaction.set(grRef, {
              poNo: po.poNo,
              deliveryNoteNo: data.deliveryNoteNo,
              receiveDate: data.receiveDate,
              receivedQuantity: qty,
              condition: data.condition,
              itemId: data.itemId,
              stockUpdated: true,
              notes: data.notes || "",
              receivedBy: user.uid,
              receivedByName: profile.name,
              createdAt: serverTimestamp()
            });

            transaction.update(poRef, {
              status: "Delivered",
              updatedAt: serverTimestamp()
            });
          });

          return `Penerimaan barang dicatat. Stok ${data.itemId} berhasil ditambah ${qty} unit.`;
        } else {
          await setDoc(grRef, {
            poNo: po.poNo,
            deliveryNoteNo: data.deliveryNoteNo,
            receiveDate: data.receiveDate,
            receivedQuantity: qty,
            condition: data.condition,
            stockUpdated: false,
            notes: data.notes || "",
            receivedBy: user.uid,
            receivedByName: profile.name,
            createdAt: serverTimestamp()
          });

          await updateDoc(poRef, {
            status: "Delivered",
            updatedAt: serverTimestamp()
          });

          return "Penerimaan dicatat dan status PO diperbarui menjadi Delivered.";
        }
      }
    );
  }
});

await authPersistenceReady;

onAuthStateChanged(auth, async current => {
  user = null;
  profile = null;

  if (!current) return;

  try {
    const snapshot = await getDoc(doc(db, "users", current.uid));
    if (snapshot.exists()) {
      user = current;
      profile = snapshot.data();
      if (profile.role === "vendor") {
        loadVendorPortalData();
      } else if (hasPerm(profile, "procurement")) {
        loadData();
      }
    }
  } catch (err) {
    console.error("Procurement auth init error:", err);
  }
});
