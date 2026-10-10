import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

import {
  auth,
  authPersistenceReady
} from "./firebase-init.js";

const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("login-email");
const passwordInput = document.getElementById("login-password");
const loginMessage = document.getElementById("login-message");
const appContent = document.getElementById("app-content");
const logoutButton = document.getElementById("logout-button");

function showMessage(message) {
  if (loginMessage) loginMessage.textContent = message;
}

function showLogin() {
  if (loginForm) loginForm.hidden = false;
  if (appContent) appContent.hidden = true;
}

function showApp() {
  if (loginForm) loginForm.hidden = true;
  if (appContent) appContent.hidden = false;
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("Sedang masuk...");

    try {
      await authPersistenceReady;

      await signInWithEmailAndPassword(
        auth,
        emailInput.value.trim(),
        passwordInput.value
      );

      showMessage("");
    } catch (error) {
      console.error("Login gagal:", error.code);
      showMessage("Login gagal. Periksa email dan password.");
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

onAuthStateChanged(auth, (user) => {
  if (user) {
    showApp();
  } else {
    showLogin();
  }
});

