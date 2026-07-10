const express = require('express');
const mysql = require('mysql2'); // Memanggil pustaka mysql2
const app = express();
const PORT = 3535;

// Batasi ukuran data kiriman karena string gambar Base64 itu lumayan panjang
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Daftarkan folder public agar file gambar di dalamnya bisa diakses langsung lewat browser
app.use(express.static('public'));

// =========================================================================
// [PERBAIKAN] : GANTI KONEKSI TUNGGAL MENJADI CONNECTION POOL (ANTI-CRASH)
// Keterangan: Manajemen 20 antrean otomatis biar MySQL XAMPP kaga pingsan lagi
// =========================================================================
const db = mysql.createPool({
    host: 'localhost',
    user: 'root',          // User bawaan XAMPP
    password: '',          // Password bawaan XAMPP kosong
    database: 'db_monitoring', // Nama database lu
    waitForConnections: true,
    connectionLimit: 20,   // Membuka hingga 20 pintu antrean paralel jika data padat
    queueLimit: 0
});

// Jalankan tes pengecekan koneksi pool saat server pertama kali dinyalakan
db.getConnection((err, koneksiAwal) => {
    if (err) {
        console.error('==================================================');
        console.error('[EROR] Gagal koneksi ke MySQL XAMPP: ' + err.message);
        console.error('==================================================');
        return;
    }
    console.log('==================================================');
    console.log('[OK] BERHASIL TERHUBUNG KE DATABASE MYSQL VIA POOL');
    console.log('==================================================');
    koneksiAwal.release(); // Kembalikan koneksi awal ke dalam antrean pool
});

// MEMORI SEMENTARA (Hanya untuk penampung list komputer aktif di halaman depan)
let daftarAgenKomputer = {};

// 2. ENDPOINT POST: Menerima register hardware & simpan langsung ke DATABASE
app.post('/api/report-hardware', (req, res) => {
    const dataMasuk = req.body;
    if (dataMasuk && dataMasuk.mac) {
        const mac = dataMasuk.mac;
        const nama = dataMasuk.nama || "Tanpa Nama";
        const divisi = dataMasuk.divisi || "Umum";
        const ip = dataMasuk.ip || "0.0.0.0";
        const cpu = dataMasuk.cpu || "Windows Device";

        // Amankan juga di memori ram sementara untuk status ONLINE aktif
        daftarAgenKomputer[mac] = {
            nama_karyawan: nama,
            divisi: divisi,
            mac: mac,
            ip: ip,
            cpu: cpu,
            status: "ONLINE",
            waktu_update: new Date().toLocaleTimeString()
        };

        // Query SQL sakti: Jika MAC sudah ada, otomatis UPDATE datanya. Jika belum, INSERT baru!
        const queryHardware = `
            INSERT INTO komputer_karyawan (mac, nama_karyawan, divisi, ip_address, cpu_name, status)
            VALUES (?, ?, ?, ?, ?, 'ONLINE')
            ON DUPLICATE KEY UPDATE 
                nama_karyawan = ?, divisi = ?, ip_address = ?, cpu_name = ?, status = 'ONLINE'
        `;

        db.query(queryHardware, [mac, nama, divisi, ip, cpu, nama, divisi, ip, cpu], (err, result) => {
            if (err) {
                console.error('[EROR] Gagal simpan spek hardware ke DB: ', err.message);
                return res.status(500).json({ status: "GAGAL" });
            }
            console.log(`[DATABASE SPEK] Identitas komputer ${nama} berhasil dikunci ke DB.`);
            return res.json({ status: "OK" });
        });
    } else {
        res.status(400).json({ status: "GAGAL" });
    }
});

// 3. ENDPOINT POST: MENYIMPAN AKTIVITAS FILE LANGSUNG KE DATABASE (8 KOLOM)
app.post('/api/report-activity', (req, res) => {
    const logBaru = req.body;

    if (logBaru && logBaru.mac) {
        // Ambil data karyawan dari memori sementara berdasarkan MAC Address-nya
        const infoKaryawan = daftarAgenKomputer[logBaru.mac] || { nama_karyawan: "Unknown", divisi: "Unknown" };

        const namaKaryawan = infoKaryawan.nama_karyawan;
        const divisi = infoKaryawan.divisi;
        const mac = logBaru.mac;
        const ip = infoKaryawan.ip || "0.0.0.0";
        const tipeAksi = logLogAktivitasTipe(logBaru.tipe_aksi);
        const namaFile = logBaru.nama_file;

        // Perintah SQL INSERT untuk memasukkan data pas ke 7 kolom (ID nomor 1 otomatis terisi)
        const queryInsert = `
            INSERT INTO log_pantau_karyawan (nama_karyawan, divisi, mac_address, ip_address, tipe_aksi, nama_file, waktu_kejadian) 
            VALUES (?, ?, ?, ?, ?, ?, NOW())
        `;

        db.query(queryInsert, [namaKaryawan, divisi, mac, ip, tipeAksi, namaFile], (err, result) => {
            if (err) {
                console.error('[EROR] Gagal simpan log ke DB: ', err);
                return res.status(500).json({ status: "GAGAL" });
            }
            console.log(`[DATABASE AMAN] Berhasil mencatat aksi ${tipeAksi} untuk file: ${namaFile}`);
            return res.json({ status: "OK" });
        });
    } else {
        res.status(400).json({ status: "GAGAL" });
    }
});

// Helper teks status yang disesuaikan
function logLogAktivitasTipe(aksi) {
    if (aksi === "Created") return "DI-COPY/PINDAH MASUK";
    if (aksi === "Deleted") return "DIHAPUS";
    if (aksi === "EDIT") return "DI-EDIT (FILE MODIFIED)";
    if (aksi === "SAVE") return "DI-SAVE (DATA RECORDED)";
    return aksi;
}

// 4. ENDPOINT GET: Mengambil daftar komputer dari database untuk halaman utama
app.get('/api/get-hardware-data', (req, res) => {
    // Ambil semua daftar komputer karyawan yang terdaftar di database
    const queryAmbilHW = "SELECT * FROM komputer_karyawan";
    
    db.query(queryAmbilHW, (err, rows) => {
        if (err) {
            return res.json(Object.values(daftarAgenKomputer));
        }

        // Map data database untuk dicocokkan dengan status real-time di RAM server
        const hasilSistem = rows.map(row => {
            const isOnline = daftarAgenKomputer[row.mac];
            return {
                nama: row.nama_karyawan,
                nama_karyawan: row.nama_karyawan,
                divisi: row.divisi,
                mac: row.mac,
                ip: row.ip_address,
                cpu: row.cpu_name,
                // Status otomatis ONLINE jika ram mendeteksi ping aktif, jika tidak maka OFFLINE
                status: isOnline ? "ONLINE" : "OFFLINE", 
                waktu_update: isOnline ? isOnline.waktu_update : "-"
            };
        });

        res.json(hasilSistem);
    });
});

// 5. ENDPOINT GET: MENGAMBIL LOG AKTIVITAS DARI DATABASE (URUTAN KRONOLOGIS DARI AWAL KEBANAH)
app.get('/api/get-activity-logs', (req, res) => {
    // Kita ubah ORDER BY menjadi ASC biar aksi pertama ada di paling atas, dan aksi terbaru makin ke bawah
    const querySelect = "SELECT * FROM log_pantau_karyawan ORDER BY waktu_kejadian ASC";
    
    db.query(querySelect, (err, rows) => {
        if (err) {
            return res.json([]);
        }
        
        // Ubah format data dari database agar sesuai dengan penamaan di index.html lu
        const formatLogs = rows.map(row => ({
            mac: row.mac_address,
            tipe_aksi: row.tipe_aksi,
            nama_file: row.nama_file,
            path_file: `IP: ${row.ip_address} | Terpantau otomatis di sistem database`,
            waktu: new Date(row.waktu_kejadian).toLocaleTimeString()
        }));

        res.json(formatLogs);
    });
});
const fs = require('fs');
const path = require('path');

// =========================================================================
// ENDPOINT POST: Mode Full MySQL + Struktur Folder per User (ROUTINE / ALERT)
// =========================================================================
app.post('/api/report-screenshot', (req, res) => {
    const { mac, tipe_pemicu, gambar_base64 } = req.body;

    if (!mac || !gambar_base64) {
        return res.status(400).json({ status: "GAGAL", pesan: "Data tidak lengkap" });
    }

    try {
        const timestamp = Math.floor(Date.now() / 1000);
        
        // Ambil nama karyawan dari memori sementara berdasarkan MAC
        const infoKaryawan = daftarAgenKomputer[mac] || { nama_karyawan: "Karyawan_Unknown" };
        const namaUser = infoKaryawan.nama_karyawan.replace(/\s+/g, '_'); // Ganti spasi jadi underscore
        const kategoriAksi = tipe_pemicu === "ALERT" ? "ALERT" : "ROUTINE";

        const namaFileGambar = `ss_${timestamp}.jpg`;

        // STRUKTUR FOLDER: public/screenshots/Tirta_Anggara/ALERT atau ROUTINE
        const folderTujuan = path.join(__dirname, 'public', 'screenshots', namaUser, kategoriAksi);
        
        if (!fs.existsSync(folderTujuan)) {
            fs.mkdirSync(folderTujuan, { recursive: true });
        }

        const pathLengkapGambar = path.join(folderTujuan, namaFileGambar);
        const dataGambarMurni = gambar_base64.replace(/^data:image\/\w+;base64,/, "");
        
        // Tetap tulis ke folder buat review perbandingan
        fs.writeFileSync(pathLengkapGambar, dataGambarMurni, 'base64');

        // Basa data Base64 menjadi Buffer biner untuk MySQL LONGBLOB
        const bufferGambar = Buffer.from(dataGambarMurni, 'base64');

        // MASUKKAN SELURUH FISIK GAMBAR KE MYSQL!
        const jalurSimpanDatabase = `${namaUser}/${kategoriAksi}/${namaFileGambar}`;
        const querySimpanSS = "INSERT INTO log_screenshot (mac_address, nama_file_gambar, tipe_pemicu, gambar_blob) VALUES (?, ?, ?, ?)";
        
        db.query(querySimpanSS, [mac, jalurSimpanDatabase, kategoriAksi, bufferGambar], (err, result) => {
            if (err) {
                console.error('[DATABASE EROR] MySQL megap-megap masukin gambar:', err.message);
                return res.status(500).json({ status: "GAGAL" });
            }
            console.log(`[DATABASE] Screenshot saved to MySQL Blob (${kategoriAksi}).`);
            return res.json({ status: "OK" });
        });

    } catch (error) {
        console.error('[CRASH]:', error.message);
        res.status(500).json({ status: "ERROR" });
    }
});

// =========================================================================
// ENDPOINT GET: Membongkar Gambar Langsung dari Blob MySQL (SINKRON DASHBOARD)
// =========================================================================
app.get('/api/get-screenshot-logs', (req, res) => {
    const mac = req.query.mac;
    if (!mac) return res.json([]);

    // Tarik kolom gambar_blob langsung dari MySQL
    const queryAmbilSS = "SELECT id, tipe_pemicu, waktu_kejadian, gambar_blob FROM log_screenshot WHERE mac_address = ? ORDER BY waktu_kejadian DESC";
    db.query(queryAmbilSS, [mac], (err, rows) => {
        if (err) return res.json([]);

        const formatSS = rows.map(row => {
            // Ubah kembali data biner LONGBLOB dari MySQL menjadi string gambar yang bisa tampil di HTML
            let stringBase64 = "";
            if (row.gambar_blob) {
                stringBase64 = `data:image/jpeg;base64,${Buffer.from(row.gambar_blob).toString('base64')}`;
            }

            return {
                id: row.id,
                tipe_pemicu: row.tipe_pemicu, // <-- DISINKRONKAN
                tipe: row.tipe_pemicu,
                waktu: row.waktu_kejadian,   // <-- BIARKAN FORMAT ASLI BIAR DI-PARSE DI FRONTEND
                gambar_url: stringBase64,     // <-- DISINKRONKAN
                url_gambar: stringBase64
            };
        });

        res.json(formatSS);
    });
});

app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(` SERVER DATABASE CONNECTED: http://localhost:${PORT} `);
    console.log(`==================================================`);
});