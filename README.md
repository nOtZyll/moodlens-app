MoodLens adalah aplikasi web berbasis Artificial Intelligence (AI) yang dirancang untuk mendeteksi dan mengenali ekspresi wajah serta emosi manusia secara otomatis. Aplikasi ini menggabungkan kekuatan Computer Vision dan Web Development untuk memberikan pengalaman interaktif kepada pengguna.

Teknologi yang Digunakan
1. Backend: Python, Flask
2. Machine Learning: Keras / TensorFlow (Deep Learning Model)
3. Frontend: HTML, CSS
4. Lainnya: NumPy, Pickle (Label Encoder)

Struktur Proyek
1. app.py: File utama untuk menjalankan server aplikasi web (Flask).
2. FacialExpressionModel.h5: Model Machine Learning (pre-trained) yang bertugas memprediksi emosi dari gambar wajah.
3. LabelEncoder.pck: File untuk menerjemahkan angka hasil prediksi model AI menjadi label teks yang bisa dibaca (misal: Senang, Sedih, Terkejut).
4. cek_label.py: Skrip utilitas untuk memeriksa dan memverifikasi label emosi yang ada di dalam LabelEncoder.
5. requirements.txt: Daftar pustaka (library) Python yang dibutuhkan untuk menjalankan aplikasi.
6. templates/: Folder yang berisi file antarmuka web (HTML).
7. static/: Folder yang berisi file desain antarmuka (CSS).

Cara Menjalankan Aplikasi di Komputer Lokal
1. Clone repositori ini ke komputermu:
git clone https://github.com/motmots/moodlens-app.git
cd moodlens-app

2. Install semua library yang dibutuhkan:
pip install -r requirements.txt

3. Jalankan aplikasi:
python app.py

4. Buka aplikasi di browser:
Buka browser dan akses alamat http://localhost:5000 (atau sesuai dengan port yang muncul di terminalmu).

Mode Pameran (Kiosk)
1. Buat virtual environment dan install library (cukup sekali):
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt

2. Klik dua kali start-exhibition.bat. Script ini menyalakan server, menunggu model selesai dimuat, lalu membuka halaman Detect layar penuh di Microsoft Edge.

3. Klik "Allow" saat browser meminta izin kamera.

4. Untuk keluar dari layar penuh tekan Alt+F4, lalu tutup jendela "MoodLens server".

Halaman Detect otomatis kembali ke tampilan awal jika tidak ada wajah di depan kamera dan layar tidak disentuh selama 1 menit. Aplikasi bisa berjalan tanpa internet.

Kirim ke HP lewat QR (Google Drive)
Pengunjung bisa menekan "Send to Phone" di hasil meme, lalu scan QR untuk membuka mememu di HP. Meme disimpan di Google Drive akun pameran dan otomatis dihapus permanen setelah 7 hari. Laptop pameran harus terhubung ke internet (hotspot HP cukup). Tanpa pengaturan di bawah, tombol "Send to Phone" tidak muncul dan fitur lain tetap berjalan.

1. Buat akun Gmail khusus pameran (jangan akun pribadi atau akun @unair.ac.id), lalu login di browser.

2. Buka https://script.google.com, klik "New project", lalu ganti nama project menjadi "MoodLens Share".

3. Hapus isi Code.gs di editor, salin seluruh isi file apps-script/Code.gs dari project ini ke sana, lalu klik Save.

4. Pilih fungsi "setup" di dropdown sebelah tombol Run, lalu klik Run.
   Saat diminta izin: Review permissions > pilih akun pameran > Advanced > Go to MoodLens Share (unsafe) > Allow.
   Peringatan "Google hasn't verified this app" muncul karena script ini buatan sendiri, bukan aplikasi publik.

5. Di Execution log akan muncul baris DRIVE_UPLOAD_TOKEN=..., salin nilainya. Fungsi setup juga membuat folder "MoodLens Memes" di Drive dan jadwal penghapusan otomatis setiap jam.

6. Klik Deploy > New deployment > ikon roda gigi > Web app, lalu atur:
   Execute as: Me
   Who has access: Anyone
   Klik Deploy, lalu salin "Web app URL" (berakhiran /exec).
   Untuk mengecek, buka URL itu di browser. Jika muncul {"ok":true,...} berarti sudah benar.

7. Di folder moodlens-app, salin file .env.example menjadi .env, lalu isi:
   DRIVE_UPLOAD_URL=(Web app URL dari langkah 6)
   DRIVE_UPLOAD_TOKEN=(token dari langkah 5)
   Jangan bagikan file .env ke siapa pun. File ini tidak ikut ter-commit ke git.

8. Install library baru, lalu restart server:
   .venv\Scripts\python -m pip install -r requirements.txt

Catatan:
- Jika isi Code.gs diubah, deploy ulang lewat Deploy > Manage deployments > ikon pensil > Version: New version > Deploy. URL-nya tetap sama.
- Semua meme yang dibagikan bisa dilihat di folder "MoodLens Memes" di Google Drive akun pameran.
