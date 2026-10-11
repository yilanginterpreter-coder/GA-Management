
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
  getDocs
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

  return transactions;
}

function showMessage(message) {
  if (loginMessage) {
    loginMessage.textContent = message;
  }
}

function showLogin(message = "") {
  if (loginScreen) loginScreen.hidden = false;
  if (appContent) appContent.hidden = true;
  showMessage(message);
}

function showApp(role) {
  if (loginScreen) loginScreen.hidden = true;
  if (appContent) appContent.hidden = false;

  document.body.dataset.userRole = role;
document.querySelectorAll(".nav-link").forEach((menu) => {
  if (role === "main_admin") {
    menu.hidden = false;
  } else {
    menu.hidden = !menu.hasAttribute("data-ga-admin-allowed");
  }
});
  document.querySelectorAll("[data-main-admin-only]").forEach((menu) => {
    menu.hidden = role !== "main_admin";
  });

  showMessage("");
}
function validRole(role) {
  return [
    "main_admin",
    "ga_admin",
    "admin_operational"
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

  return userData.role;
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("Sedang masuk...");

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
  showLogin("Email verifikasi sudah dikirim. Periksa kotak masuk atau folder Spam.");
  return;
}

      await checkUserRole(credential.user);
      showMessage("Login berhasil.");
    } catch (error) {
      console.error("Login gagal:", error.code || error.message);

      await signOut(auth).catch(() => {});

      if (error.message === "ROLE_NOT_FOUND") {
        showLogin("Akun belum diberi akses oleh Main Admin.");
      } else if (error.message === "ROLE_INVALID") {
        showLogin("Akun tidak aktif atau role tidak valid.");
      } else {
        showLogin("Login gagal. Periksa email, password, dan akses akun.");
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

    const role = await checkUserRole(user);
    showApp(role);
readInventoryFromFirestore().catch((error) => {
  console.error("Gagal membaca Inventory Firebase:", error.code || error.message);
});

readTransactionsFromFirestore().catch((error) => {
  console.error("Gagal membaca Transactions Firebase:", error.code || error.message);
});

  } catch (error) {
    console.error("Pemeriksaan akses gagal:", error.code || error.message);
    await signOut(auth);
    showLogin("Akun belum memiliki akses yang valid.");
  }
});
