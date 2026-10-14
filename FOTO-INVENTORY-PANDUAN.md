# Inventory dengan foto di Firestore (tanpa Firebase Storage)

## Yang berubah
- Tambah Barang: pilih foto JPG/PNG/WebP (opsional), preview, kompres otomatis menjadi JPEG maks. 90 KB.
- Edit Barang: lihat foto lama, ganti foto, atau centang Hapus foto.
- Tabel Inventory: thumbnail foto; klik untuk melihat lebih besar.
- Foto disimpan di field `photoData` pada dokumen `inventory/{kodeBarang}` dalam Firestore. Foto lama tetap ada saat mengedit kolom lain.
- Stok, transaksi, login, dan menu lain tetap memakai file yang sama dari paket Inventory sebelumnya.

## Cara pasang
1. Cadangkan repository GitHub terlebih dahulu.
2. Ekstrak ZIP dan upload **isi ZIP** ke root repo GitHub, menggantikan file bernama sama; jangan upload ZIP sebagai file website.
3. Commit; tunggu GitHub Pages selesai deploy; refresh Ctrl+Shift+R.
4. Login main_admin/ga_admin, tambah barang dengan foto kecil, simpan, refresh dan cek fotonya; edit lalu ganti/hapus foto; login admin_operational untuk memeriksa hak baca.

## PENTING: Firestore Security Rules
Aturan `inventory` di Firebase harus mengizinkan field opsional `photoData` (string JPEG data URL) pada CREATE dan UPDATE. Bila rules memakai `keys().hasOnly([...])`, tambahkan `photoData` pada daftar field yang diizinkan. Bila rules memakai `keys().hasAll([...])`, **jangan** jadikan `photoData` wajib untuk dokumen lama.

Validasi yang disarankan di bagian fungsi validasi inventory rules (gabungkan ke rules yang ada; JANGAN mengganti seluruh rules):

```
(!('photoData' in request.resource.data) ||
  (request.resource.data.photoData is string &&
   request.resource.data.photoData.size() <= 125000 &&
   (request.resource.data.photoData == '' ||
    request.resource.data.photoData.matches('^data:image/jpeg;base64,[A-Za-z0-9+/=]+$'))))
```

Jangan menghapus aturan role dan aturan transaksi yang sudah ada. Firestore Rules harus membatasi CREATE/UPDATE foto hanya untuk main_admin/ga_admin yang aktif, sedangkan pembacaan untuk role yang diperbolehkan. Pengamanan sisi browser saja tidak cukup.

## Batasan
- Setiap foto akan ikut dibaca saat dokumen Inventory dimuat, sehingga tidak cocok untuk ribuan foto atau foto resolusi tinggi.
- Firestore punya batas dokumen 1 MiB; foto dibatasi sekitar 90 KB dan dikecilkan ke dimensi maksimum 640 piksel.
- Foto baru dan perubahan stok perlu dites dengan aturan Firestore project sebenarnya; tes runtime Firebase belum dilakukan dalam paket ini.
- Jangan gunakan untuk dokumen sensitif atau foto pribadi.
