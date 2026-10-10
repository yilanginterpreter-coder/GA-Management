import { auth, db, authPersistenceReady } from "./firebase-init.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

async function testFirebase() {
  try {
    await authPersistenceReady;

    console.log("Firebase Auth berhasil diinisialisasi:", !!auth);
    console.log("Firestore berhasil diinisialisasi:", !!db);

    // Membaca koleksi kosong/yang belum ada tidak mengubah data.
    // Dengan Rules saat ini, permintaan ini seharusnya ditolak.
    await getDocs(collection(db, "connection_test"));

    console.log("Firestore berhasil membaca data.");
  } catch (error) {
    console.error("Hasil tes Firebase:", error.code, error.message);
  }
}

testFirebase();

