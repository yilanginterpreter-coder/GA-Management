
import {
  signInWithEmailAndPassword,
  sendEmailVerification,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

import {
  doc,
  getDoc,
  collection,
  getDocs,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

import {
  auth,
  db,
  authPersistenceReady
} from "./firebase-init.js";

const loginScreen = document.getElementById("login-screen");
const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("login-email");
const passwordInput = document.getElementById("login-password");
const loginMessage = document.getElementById("login-message");
const appContent = document.getElementById("app-content");
const logoutButton = document.getElementById("logout-button");
const togglePasswordBtn = document.getElementById("toggle-password");
const togglePasswordIcon = document.getElementById("toggle-password-icon");
const loginSubmitBtn = document.getElementById("login-submit-btn");
const loginFields = document.getElementById("login-fields");
const loginResume = document.getElementById("login-resume");
const loginSwitch = document.getElementById("login-switch");

// Akun terakhir diingat di perangkat ini; sesi tetap tersimpan sampai logout.
const LAST_KEY = "ga_last_login";
const ENTERED_KEY = "ga_entered";
let resumeMode = false;
let pendingResume = null;

function store(kind) {
  try { return kind === "session" ? sessionStorage : localStorage; } catch { return null; }
}

function readLast() {
  try { return JSON.parse(store("local")?.getItem(LAST_KEY) || "null") || {}; } catch { return {}; }
}

function writeLast(info) {
  try { store("local")?.setItem(LAST_KEY, JSON.stringify(info)); } catch {}
}

function setEntered(flag) {
  try {
    if (flag) store("session")?.setItem(ENTERED_KEY, "1");
    else store("session")?.removeItem(ENTERED_KEY);
  } catch {}
}

const hasEntered = () => {
  try { return store("session")?.getItem(ENTERED_KEY) === "1"; } catch { return false; }
};

if (emailInput && readLast().email) emailInput.value = readLast().email;

function setResume(on, info = {}) {
  resumeMode = on;
  if (loginFields) loginFields.hidden = on;
  if (loginResume) loginResume.hidden = !on;
  if (loginSwitch) loginSwitch.hidden = !on;

  const title = document.querySelector(".login-header h2");
  const sub = document.querySelector(".login-header p");
  if (title) title.textContent = on ? "Selamat Datang Kembali" : "Selamat Datang";
  if (sub) sub.textContent = on
    ? "Tekan Masuk untuk melanjutkan dengan akun ini."
    : "Silakan masuk dengan akun Anda untuk melanjutkan.";

  if (on) {
    const name = info.name || info.email || "Pengguna";
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join("") || "GA";
    document.getElementById("login-resume-avatar").textContent = initials;
    document.getElementById("login-resume-name").textContent = name;
    document.getElementById("login-resume-email").textContent = info.email || "";
  }
}

if (togglePasswordBtn && passwordInput && togglePasswordIcon) {
  togglePasswordBtn.addEventListener("click", () => {
    const isPassword = passwordInput.type === "password";
    passwordInput.type = isPassword ? "text" : "password";
    togglePasswordIcon.className = isPassword ? "fa-regular fa-eye-slash" : "fa-regular fa-eye";
    togglePasswordBtn.setAttribute("aria-label", isPassword ? "Sembunyikan password" : "Tampilkan password");
  });
}


async function readInventoryFromFirestore() {
  const snapshot = await getDocs(collection(db, "inventory"));

  const items = snapshot.docs.map((item) => ({
    ...item.data(),
    id: item.id
  }));

  console.log(
    "Inventory Firebase berhasil dibaca. Jumlah barang:",
    items.length
  );

  window.receiveFirestoreInventory(items);

  return items;
}

async function readTransactionsFromFirestore() {
  const snapshot = await getDocs(collection(db, "transactions"));

  const transactions = snapshot.docs.map((item) => ({
    ...item.data(),
    id: item.id
  }));

  console.log(
    "Transaksi Firebase berhasil dibaca. Jumlah transaksi:",
    transactions.length
  );
window.receiveFirestoreTransactions(transactions);
  
  return transactions;
}
async function saveStockTransactionToFirestore(data) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Silakan login terlebih dahulu.");
  }

  const userSnapshot = await getDoc(doc(db, "users", user.uid));

  if (!userSnapshot.exists()) {
    throw new Error("Data pengguna tidak ditemukan.");
  }

  const profile = userSnapshot.data();

  if (
    profile.active !== true ||
    !["main_admin", "ga_admin"].includes(profile.role)
  ) {
    throw new Error("Akun tidak memiliki izin transaksi stok.");
  }

  const quantity = Number(data.quantity);

  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("Jumlah harus bilangan bulat lebih dari nol.");
  }

  if (!["Masuk", "Keluar"].includes(data.type)) {
    throw new Error("Jenis transaksi tidak valid.");
  }

  if (!data.itemId) {
    throw new Error("Pilih barang terlebih dahulu.");
  }

  const inventoryRef = doc(db, "inventory", data.itemId);
  const transactionRef = doc(collection(db, "transactions"));

  await runTransaction(db, async (transaction) => {
    const inventorySnapshot = await transaction.get(inventoryRef);

    if (!inventorySnapshot.exists()) {
      throw new Error("Barang tidak ditemukan di Firebase.");
    }

    const item = inventorySnapshot.data();
    const currentStock = item.stock;

    if (!Number.isSafeInteger(currentStock) || currentStock < 0) {
      throw new Error("Data stok Firebase tidak valid.");
    }

    const newStock =
      currentStock + (data.type === "Masuk" ? quantity : -quantity);

    if (!Number.isSafeInteger(newStock) || newStock < 0) {
      throw new Error("Stok tidak mencukupi atau hasil stok tidak valid.");
    }

    transaction.update(inventoryRef, {
  stock: newStock,
  lastTransactionId: transactionRef.id,
  lastStockBefore: currentStock
});

    transaction.set(transactionRef, {
      itemId: data.itemId,
      code: item.code || data.itemId,
      name: item.name || "",
      type: data.type,
      quantity: quantity,
      stockBefore: currentStock,
      stockAfter: newStock,
      date: data.date || new Date().toISOString().slice(0, 10),
      note: data.note || "",
      createdBy: user.uid,
      createdByName: profile.name || "Pengguna",
      createdByRole: profile.role,
      createdAt: serverTimestamp(),
      testOnly: false
    });
  });
}
function showMessage(message, type = "error") {
  if (loginMessage) {
    loginMessage.textContent = message;
    loginMessage.className = "login-message";
    if (message) {
      loginMessage.classList.add(type);
    }
  }
}

let authCbStarted = false;
function markReady() {
  if (!authCbStarted || window.__gaAuthReady) return;
  window.__gaAuthReady = true;
  document.dispatchEvent(new Event("ga:auth-ready"));
}

function showLogin(message = "", type = "error") {
  setTimeout(markReady, 0);
  if (loginScreen) loginScreen.hidden = false;
  if (appContent) appContent.hidden = true;
  showMessage(message, type);
  window.scrollTo(0, 0);
}

function setSubmittingState(isSubmitting) {
  if (!loginSubmitBtn) return;
  loginSubmitBtn.disabled = isSubmitting;
  if (isSubmitting) {
    loginSubmitBtn.innerHTML = `
      <i class="fa-solid fa-circle-notch btn-spinner"></i>
      <span class="btn-text">Memproses...</span>
    `;
  } else {
    loginSubmitBtn.innerHTML = `
      <span class="btn-text">Masuk</span>
      <i class="fa-solid fa-arrow-right btn-icon"></i>
    `;
  }
}

const ROLE_LABELS = {
  main_admin: "Main Admin",
  ga_admin: "GA Admin",
  admin_operational: "Admin Operational",
  employee: "Karyawan",
  vendor: "Vendor Portal"
};

function showProfile(name, role) {
  const displayName = name || ROLE_LABELS[role] || "Pengguna";
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

  const nameEl = document.querySelector(".profile strong");
  const roleEl = document.querySelector(".profile small");
  if (nameEl) nameEl.textContent = displayName;
  if (roleEl) roleEl.textContent = ROLE_LABELS[role] || "";

  document.querySelectorAll(".avatar").forEach((el) => {
    el.textContent = initials || "GA";
  });
}

function showApp(role, name, email) {
  setTimeout(markReady, 0);
  if (email) writeLast({ email, name: name || "" });
  setResume(false);
  if (loginScreen) loginScreen.hidden = true;
  if (appContent) appContent.hidden = false;

  document.body.dataset.userRole = role;
  showProfile(name, role);

  // Tampilan menu diatur oleh shell.js (kotak menu + hak akses).
  showMessage("");
  window.scrollTo(0, 0);
}
function validRole(role) {
  return [
    "main_admin",
    "ga_admin",
    "admin_operational",
    "employee",
    "vendor"
  ].includes(role);
}

async function checkUserRole(user) {
  const userRef = doc(db, "users", user.uid);
  const userSnapshot = await getDoc(userRef);

  if (!userSnapshot.exists()) {
    throw new Error("ROLE_NOT_FOUND");
  }

  const userData = userSnapshot.data();

  if (userData.active !== true || !validRole(userData.role)) {
    throw new Error("ROLE_INVALID");
  }

  return userData;
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("");

    if (resumeMode && pendingResume) {
      setEntered(true);
      showApp(pendingResume.role, pendingResume.name, pendingResume.email);
      return;
    }

    setSubmittingState(true);

    try {
      await authPersistenceReady;
      setEntered(true);

      const credential = await signInWithEmailAndPassword(
        auth,
        emailInput.value.trim(),
        passwordInput.value
      );

      await credential.user.reload();

      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user);
        await signOut(auth);
        showLogin("Email verifikasi sudah dikirim. Periksa kotak masuk atau folder Spam.", "info");
        return;
      }

      await checkUserRole(credential.user);
      showMessage("Login berhasil.", "success");
    } catch (error) {
      console.error("Login gagal:", error.code || error.message);
      setEntered(false);

      await signOut(auth).catch(() => {});

      if (error.message === "ROLE_NOT_FOUND") {
        showLogin("Akun belum diberi akses oleh Main Admin.", "error");
      } else if (error.message === "ROLE_INVALID") {
        showLogin("Akun tidak aktif atau role tidak valid.", "error");
      } else {
        showLogin("Login gagal. Periksa email, password, dan akses akun.", "error");
      }
    } finally {
      setSubmittingState(false);
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    try {
      setEntered(false);
      await signOut(auth);
    } catch (error) {
      console.error("Logout gagal:", error.code);
      showMessage("Logout gagal. Silakan coba lagi.");
    }
  });
}

await authPersistenceReady;

showLogin();

onAuthStateChanged(auth, async (user) => {
  authCbStarted = true;
  if (!user) {
    pendingResume = null;
    setResume(false);
    if (emailInput && readLast().email) emailInput.value = readLast().email;
    if (passwordInput) passwordInput.value = "";
    showLogin();
    return;
  }

   try {
    await user.reload();

    if (!user.emailVerified) {
      await signOut(auth);
      showLogin("Silakan verifikasi email sebelum masuk.");
      return;
    }

    const userData = await checkUserRole(user);

    // Sudah pernah login: langsung buka panel tanpa mengisi email/password lagi.
    showApp(userData.role, userData.name, user.email);
    setEntered(true);
// Data Inventory & Transaksi dimuat oleh stock-firebase.js.

  } catch (error) {
    console.error("Pemeriksaan akses gagal:", error.code || error.message);
    if (["auth/network-request-failed", "unavailable", "failed-precondition"].includes(error.code)) {
      showLogin("Tidak ada koneksi internet. Sambungkan lalu muat ulang aplikasi.");
      return;
    }
    await signOut(auth);
    showLogin("Akun belum memiliki akses yang valid.");
  }
});

loginSwitch?.addEventListener("click", async () => {
  setEntered(false);
  pendingResume = null;
  await signOut(auth).catch(() => {});
});
