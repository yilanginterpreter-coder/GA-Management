// Hak akses per menu. Dipakai bersama oleh semua modul.
// Aturan ini harus sama dengan fungsi hasPerm() di firestore.rules.

export const MENUS = {
  inventory: "Stok In & Stok Out",
  requests: "Permintaan Karyawan",
  assets: "Aset Perusahaan",
  vehicles: "Kendaraan",
  repairs: "Fasilitas & Perbaikan",
  meals: "Pesan Makan Siang & Malam",
  vendors: "Vendor",
  reports: "Laporan"
};

export const MENU_KEYS = Object.keys(MENUS);

// Bawaan GA Admin sebelum Main Admin mengatur hak akses sendiri.
const DEFAULT_GA_ADMIN = ["inventory", "requests", "repairs"];

export const ADMIN_ROLES = ["ga_admin", "admin_operational"];

export function hasPerm(profile, key) {
  if (!profile) return false;
  if (profile.role === "main_admin") return true;
  if (!ADMIN_ROLES.includes(profile.role)) return false;

  const map = profile.permissions;
  if (map && typeof map === "object") return map[key] === true;

  return profile.role === "ga_admin" && DEFAULT_GA_ADMIN.includes(key);
}

// Peta izin lengkap (semua kunci) untuk satu pengguna.
export function permissionMap(profile) {
  return Object.fromEntries(MENU_KEYS.map(k => [k, hasPerm(profile, k)]));
}
