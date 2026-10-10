import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD16acFoDX-NTCNqT10_-AlUxjiIp2l4g0",
  authDomain: "ga-management-57775.firebaseapp.com",
  projectId: "ga-management-57775",
  storageBucket: "ga-management-57775.firebasestorage.app",
  messagingSenderId: "679298566079",
  appId: "1:679298566079:web:60dda2a6d464b72b46430a",
  measurementId: "G-JP4HJ5Q20"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

export const authPersistenceReady = setPersistence(
  auth,
  browserLocalPersistence
);

