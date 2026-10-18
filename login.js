
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
const togglePasswordBtn = document.getElementById("togglePassword");
const togglePasswordIcon = document.getElementById("togglePasswordIcon");
const submitBtn = document.getElementById("login-submit-btn");

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
function showMessage(message, type = "") {
  if (loginMessage) {
    loginMessage.textContent = message;
    loginMessage.className = "login-message " + (type ? `type-${type}` : "");
  }
}

function showLogin(message = "") {
  if (loginScreen) loginScreen.hidden = false;
  if (appContent) appContent.hidden = true;
  showMessage(message);
}

const ROLE_LABELS = {
  main_admin: "Main Admin",
  ga_admin: "GA Admin",
  admin_operational: "Admin Operational",
  employee: "Karyawan"
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

function showApp(role, name) {
  if (loginScreen) loginScreen.hidden = true;
  if (appContent) appContent.hidden = false;

  document.body.dataset.userRole = role;
  showProfile(name, role);

  // Tampilan menu diatur oleh shell.js (kotak menu + hak akses).
  showMessage("");
}
function validRole(role) {
  return [
    "main_admin",
    "ga_admin",
    "admin_operational",
    "employee"
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

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add("loading");
    }
    showMessage("Sedang masuk, mohon tunggu...", "info");

    try {
      await authPersistenceReady;

      const credential = await signInWithEmailAndPassword(
        auth,
        emailInput.value.trim(),
        passwordInput.value
      );

      await credential.user.reload();

      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user);
        await signOut(auth);
        showLogin("Email verifikasi sudah dikirim. Periksa kotak masuk atau folder Spam.", "warning");
        return;
      }

      await checkUserRole(credential.user);
      showMessage("Login berhasil, mengalihkan...", "success");
    } catch (error) {
      console.error("Login gagal:", error.code || error.message);

      await signOut(auth).catch(() => {});

      if (error.message === "ROLE_NOT_FOUND") {
        showLogin("Akun belum diberi akses oleh Main Admin.", "error");
      } else if (error.message === "ROLE_INVALID") {
        showLogin("Akun tidak aktif atau role tidak valid.", "error");
      } else if (error.code === "auth/invalid-credential" || error.code === "auth/user-not-found" || error.code === "auth/wrong-password") {
        showLogin("Email atau password tidak sesuai. Periksa kembali data Anda.", "error");
      } else {
        showLogin("Login gagal. Periksa email, password, dan koneksi internet Anda.", "error");
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove("loading");
      }
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    try {
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
  if (!user) {
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
    showApp(userData.role, userData.name);
// Data Inventory & Transaksi dimuat oleh stock-firebase.js.

  } catch (error) {
    console.error("Pemeriksaan akses gagal:", error.code || error.message);
    await signOut(auth);
    showLogin("Akun belum memiliki akses yang valid.");
  }
});
