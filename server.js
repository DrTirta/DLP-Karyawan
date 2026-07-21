require('dotenv').config();
const express = require('express');
const mysql = require('mysql2'); 
const fs = require('fs');        
const path = require('path');    

const app = express();
const PORT = 3535;

// Batasi ukuran data kiriman karena string gambar Base64 itu lumayan panjang
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Daftarkan folder public agar file gambar di dalamnya bisa diakses langsung lewat browser
app.use(express.static('public'));

// =========================================================================
// KONEKSI DATABASE MENGGUNAKAN .ENV v1.0.9
// =========================================================================
const db = mysql.createPool({
    host: process.env.DB_HOST,         // Mengambil dari file .env
    user: process.env.DB_USER,         // Mengambil dari file .env
    password: process.env.DB_PASS,     // Mengambil dari file .env
    database: process.env.DB_NAME,     // Mengambil dari file .env
    waitForConnections: true,
    connectionLimit: 20,   
    queueLimit: 0
});

db.getConnection((err, koneksiAwal) => {
    if (err) {
        console.error('==================================================');
        console.error('[EROR] Gagal koneksi ke MySQL: ' + err.message);
        console.error('==================================================');
        return;
    }
    console.log('==================================================');
    console.log('[OK] BERHASIL TERHUBUNG KE DATABASE MYSQL VIA POOL');
    console.log('==================================================');
    koneksiAwal.release(); 
});

// MEMORI SEMENTARA 
let daftarAgenKomputer = {};

// =========================================================================
// 1. ENDPOINT POST: SIMPAN HARDWARE
// =========================================================================
app.post('/api/report-hardware', (req, res) => {
    const dataMasuk = req.body;
    if (dataMasuk && dataMasuk.mac) {
        const mac = dataMasuk.mac;
        const nama = dataMasuk.nama || "Tanpa Nama";
        const divisi = dataMasuk.divisi || "Umum";
        
        // [TAMBAHAN BARU] Tangkap data jenis perangkat dari C#
        const jenis_perangkat = dataMasuk.jenis_perangkat || "Komputer"; 
        
        const ip = dataMasuk.ip || "0.0.0.0";
        const cpu = dataMasuk.cpu || "Windows Device";

        // [TAMBAHAN BARU] Masukkan jenis_perangkat ke memori sementara
        daftarAgenKomputer[mac] = {
            nama_karyawan: nama, divisi: divisi, jenis_perangkat: jenis_perangkat, mac: mac, ip: ip, cpu: cpu,
            status: "ONLINE", waktu_update: new Date().toLocaleTimeString()
        };

        // [TAMBAHAN BARU] Tambahkan kolom jenis_perangkat ke Query SQL
        const queryHardware = `
            INSERT INTO komputer_karyawan (mac, nama_karyawan, divisi, jenis_perangkat, ip_address, cpu_name, status)
            VALUES (?, ?, ?, ?, ?, ?, 'ONLINE')
            ON DUPLICATE KEY UPDATE 
                nama_karyawan = ?, divisi = ?, jenis_perangkat = ?, ip_address = ?, cpu_name = ?, status = 'ONLINE'
        `;

        // [TAMBAHAN BARU] Sisipkan variabel jenis_perangkat ke dalam array db.query (diisi 2x untuk INSERT dan UPDATE)
        db.query(queryHardware, [mac, nama, divisi, jenis_perangkat, ip, cpu, nama, divisi, jenis_perangkat, ip, cpu], (err, result) => {
            if (err) {
                console.error("Error SQL Hardware:", err.message); 
                return res.status(500).json({ status: "GAGAL" });
            }
            // console.log(`[DATABASE SPEK] Identitas ${jenis_perangkat} milik ${nama} berhasil dikunci ke DB.`);
            return res.json({ status: "OK" });
        });
    } else {
        res.status(400).json({ status: "GAGAL" });
    }
});

// =========================================================================
// 2. ENDPOINT POST: SIMPAN LOG AKTIVITAS FILE (DIPERBAIKI) v1.0.9
// =========================================================================
app.post('/api/report-activity', (req, res) => {
    const logBaru = req.body;

    if (logBaru && logBaru.mac) {
        const infoKaryawan = daftarAgenKomputer[logBaru.mac] || { nama_karyawan: "Tanpa Nama", divisi: "Umum", ip: "0.0.0.0" };
        const namaKaryawan = infoKaryawan.nama_karyawan;
        const divisi = infoKaryawan.divisi;
        const mac = logBaru.mac;
        const ip = infoKaryawan.ip || "0.0.0.0";
        const tipeAksi = logLogAktivitasTipe(logBaru.tipe_aksi);
        const namaFile = logBaru.nama_file;
        const pathFile = logBaru.path_file || "Lokasi tidak diketahui";

        const queryInsert = `
            INSERT INTO log_pantau_karyawan (nama_karyawan, divisi, mac_address, ip_address, tipe_aksi, nama_file, path_file, waktu_kejadian) 
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `;

        db.query(queryInsert, [namaKaryawan, divisi, mac, ip, tipeAksi, namaFile, pathFile], (err, result) => {
            if (err) {
                console.error("Error SQL Activity Log:", err.message);
                return res.status(500).json({ status: "GAGAL" });
            }
            console.log(`[DATABASE AMAN] Berhasil mencatat aksi ${tipeAksi} untuk file: ${namaFile} dari ${namaKaryawan}`);
            return res.json({ status: "OK" });
        });
    } else {
        res.status(400).json({ status: "GAGAL" });
    }
});

function logLogAktivitasTipe(aksi) {
    if (aksi === "Created") return "DI-COPY/PINDAH MASUK";
    if (aksi === "Deleted") return "DIHAPUS";
    if (aksi === "EDIT") return "DI-EDIT (FILE MODIFIED)";
    if (aksi === "SAVE") return "DI-SAVE (DATA RECORDED)";
    return aksi;
}

// =========================================================================
// 3. ENDPOINT POST: SIMPAN SCREENSHOT KE FOLDER & MYSQL
// =========================================================================
app.post('/api/report-screenshot', (req, res) => {
    const { mac, tipe_pemicu, gambar_base64 } = req.body;

    if (!mac || !gambar_base64) {
        return res.status(400).json({ status: "GAGAL", pesan: "Data tidak lengkap" });
    }

    try {
        const timestamp = Math.floor(Date.now() / 1000);
        const infoKaryawan = daftarAgenKomputer[mac] || { nama_karyawan: "Karyawan_Unknown" };
        const namaUser = infoKaryawan.nama_karyawan.replace(/\s+/g, '_'); 
        const kategoriAksi = tipe_pemicu === "ALERT" ? "ALERT" : "ROUTINE";

        // 1. Ambil tanggal hari ini (Otomatis format YYYY-MM-DD, cth: 2026-07-21)
        const tanggalHariIni = new Date().toISOString().slice(0, 10);

        const namaFileGambar = `ss_${timestamp}.jpg`;
        
        // 2. Susun path hierarki baru: public > screenshots > NamaUser > Tanggal > Kategori (ALERT/ROUTINE)
        const folderTujuan = path.join(__dirname, 'public', 'screenshots', namaUser, tanggalHariIni, kategoriAksi);
        
        if (!fs.existsSync(folderTujuan)) {
            fs.mkdirSync(folderTujuan, { recursive: true });
        }

        const pathLengkapGambar = path.join(folderTujuan, namaFileGambar);
        const dataGambarMurni = gambar_base64.replace(/^data:image\/\w+;base64,/, "");
        
        fs.writeFileSync(pathLengkapGambar, dataGambarMurni, 'base64');
        const bufferGambar = Buffer.from(dataGambarMurni, 'base64');

        // 3. Sesuaikan juga string path yang masuk ke database (opsional tapi bagus disamakan)
        const jalurSimpanDatabase = `${namaUser}/${tanggalHariIni}/${kategoriAksi}/${namaFileGambar}`;
        const querySimpanSS = "INSERT INTO log_screenshot (mac_address, nama_file_gambar, tipe_pemicu, gambar_blob) VALUES (?, ?, ?, ?)";
        
        db.query(querySimpanSS, [mac, jalurSimpanDatabase, kategoriAksi, bufferGambar], (err, result) => {
            if (err) {
                // INI YANG DITAMBAH: Biar server ngasih tau errornya apa
                console.error("⚠️ GAGAL SIMPAN SS KE MYSQL:", err.message); 
                return res.status(500).json({ status: "GAGAL" });
            }
            console.log(`[DATABASE] Screenshot saved to folder & MySQL Blob (${tanggalHariIni} - ${kategoriAksi}).`);
            return res.json({ status: "OK" });
        });

    } catch (error) {
        console.error('[CRASH]:', error.message);
        res.status(500).json({ status: "ERROR" });
    }
});
// =========================================================================
// 4. ENDPOINT GET: AMBIL DAFTAR HARDWARE UNTUK DASHBOARD UTAMA
// =========================================================================
app.get('/api/get-hardware-data', (req, res) => {
    const queryAmbilHW = "SELECT * FROM komputer_karyawan";
    
    db.query(queryAmbilHW, (err, rows) => {
        if (err) return res.json(Object.values(daftarAgenKomputer));

        const hasilSistem = rows.map(row => {
            const isOnline = daftarAgenKomputer[row.mac];
            return {
                nama: row.nama_karyawan,
                nama_karyawan: row.nama_karyawan,
                divisi: row.divisi,
                
                // [TAMBAHAN BARU] Kirim data jenis perangkat ke Dashboard index.html
                jenis_perangkat: row.jenis_perangkat || "Komputer", 
                
                mac: row.mac,
                ip: row.ip_address,
                cpu: row.cpu_name,
                status: isOnline ? "ONLINE" : "OFFLINE", 
                waktu_update: isOnline ? isOnline.waktu_update : "-"
            };
        });

        res.json(hasilSistem);
    });
});

// =========================================================================
// [MESIN BARU] 5. ENDPOINT GET: AMBIL LOG FILE + FILTER AKSI & TANGGAL
// =========================================================================
app.get('/api/get-activity-logs', (req, res) => {
    const mac = req.query.mac;
    if (!mac) return res.json([]);

    const limit = parseInt(req.query.limit) || 100; // Default tampil 100 baris
    const offset = parseInt(req.query.offset) || 0;
    
    const tglAwal = req.query.tgl_awal;
    const tglAkhir = req.query.tgl_akhir;
    const tipeAksi = req.query.tipe_aksi; // Menangkap request filter (Hapus/Edit/Baru)

    let queryParams = [mac];
    let filterSQL = "WHERE mac_address = ?";

    if (tglAwal && tglAkhir) {
        filterSQL += " AND DATE(waktu_kejadian) BETWEEN ? AND ?";
        queryParams.push(tglAwal, tglAkhir);
    }
    
    // Kalau web minta filter Hapus/Baru/Edit, tambahkan ke SQL
    if (tipeAksi) {
        filterSQL += " AND tipe_aksi LIKE ?";
        queryParams.push(`%${tipeAksi}%`);
    }

    const querySelect = `
        SELECT * FROM log_pantau_karyawan 
        ${filterSQL} 
        ORDER BY waktu_kejadian DESC 
        LIMIT ? OFFSET ?
    `;
    
    queryParams.push(limit, offset);

    db.query(querySelect, queryParams, (err, rows) => {
        if (err) return res.json([]);
        
        const formatLogs = rows.map(row => ({
            mac: row.mac_address,
            tipe_aksi: row.tipe_aksi,
            nama_file: row.nama_file,
            // FITUR BARU: Menampilkan jalur asli dari database
            path_file: `[IP: ${row.ip_address}] Lokasi: ${row.path_file || "Belum terekam"}`,
            waktu: new Date(row.waktu_kejadian).toLocaleString('id-ID')
        }));

        res.json(formatLogs);
    });
});

// =========================================================================
// [MESIN BARU] 6. ENDPOINT GET: AMBIL SCREENSHOT + FILTER ALERT & TANGGAL
// =========================================================================
app.get('/api/get-screenshot-logs', (req, res) => {
    const mac = req.query.mac;
    if (!mac) return res.json([]);

    const limit = parseInt(req.query.limit) || 15; 
    const offset = parseInt(req.query.offset) || 0;             
    
    const tglAwal = req.query.tgl_awal;   
    const tglAkhir = req.query.tgl_akhir; 
    const tipePemicu = req.query.tipe_pemicu; // Menangkap filter khusus "ALERT"

    let queryParams = [mac];
    let filterSQL = "WHERE mac_address = ?";

    if (tglAwal && tglAkhir) {
        filterSQL += " AND DATE(waktu_kejadian) BETWEEN ? AND ?";
        queryParams.push(tglAwal, tglAkhir);
    }
    
    // Kalau web minta cuma gambar pas file dihapus (ALERT)
    if (tipePemicu) {
        filterSQL += " AND tipe_pemicu = ?";
        queryParams.push(tipePemicu);
    }

    const queryAmbilSS = `
        SELECT id, tipe_pemicu, waktu_kejadian, gambar_blob 
        FROM log_screenshot 
        ${filterSQL} 
        ORDER BY waktu_kejadian DESC 
        LIMIT ? OFFSET ?
    `;
    
    queryParams.push(limit, offset);

    db.query(queryAmbilSS, queryParams, (err, rows) => {
        if (err) return res.json([]);

        const formatSS = rows.map(row => {
            let stringBase64 = "";
            if (row.gambar_blob) {
                stringBase64 = `data:image/jpeg;base64,${Buffer.from(row.gambar_blob).toString('base64')}`;
            }

            return {
                id: row.id,
                tipe_pemicu: row.tipe_pemicu,
                tipe: row.tipe_pemicu,
                waktu: row.waktu_kejadian,
                gambar_url: stringBase64,
                url_gambar: stringBase64
            };
        });

        res.json(formatSS);
    });
});

// =========================================================================
// [FITUR BARU] : SISTEM AUTO UPDATE & CHANGELOG UNTUK AGEN C# v1.0.9
// =========================================================================
// Membaca versi dari file .env, jika kosong jadikan "1.0.9" sebagai cadangan
const APP_VERSION = process.env.APP_VERSION || "1.0.9";

// =========================================================================
// DATA TERPUSAT CHANGELOG (SEKARANG SUDAH KELUAR VERSI v1.0.7)
// =========================================================================
const dataChangelog = [
    {
        versi: "v1.0.5",
        tgl: "10/07/2026",
        perubahan: [
            "Fix: Immortal mode (Anti tombol X)",
            "Fix: Stealth mode (Turun ke Background Processes)",
            "Fitur: Teks versi & Tombol log update",
            "Fitur: Kill Switch (Tombol Matikan Agen)",
            "Fitur: Auto-Update Engine (OTA)",
            "Fitur: Heartbeat (Status Online akurat)"
        ]
    },
    {
        versi: "v1.0.6",
        tgl: "15/07/2026",
        perubahan: [
            "Fix: Screenshot headless mode (Anti kotak hitam)",
            "Fitur: Zoom In & Out gambar preview admin dashboard"
        ]
    },
    {
        versi: "v1.0.7",
        tgl: "15/07/2026", // Tanggal hari ini
        perubahan: [
            "Fitur: Dashboard global metrik statistik server (Ukuran folder SS & hitungan file)",
            "Fitur: Klasifikasi tabel terpisah antara PC Desktop Form vs Laptop Portable"
        ]
    },

    {
        versi: "v1.0.8",
        tgl: "17 Juli 2026",
        perubahan: [
            "Fix posisi kotak login admin tepat di tengah layar.",
            "Fix sidebar bocor (auto-ngumpet sebelum login sukses).",
            "Tombol Keluar & Changelog melayang global di semua menu.",
            "Proteksi tombol global tersembunyi total sebelum login.",
            "Sinkronisasi skema parameter database visual & log agen."
  ]
    },

    {
        versi: "v1.0.9",
        tgl: "21 Juli 2026",
        perubahan: [
            "New: Integrasi sistem environment variables (.env) untuk konfigurasi terpusat server.",
            "Fix: Perbaikan URL endpoint changelog agen dari localhost ke server pusat dinamis.",
            "Fix: Presisi trigger screenshot alert saat file dihapus.",
            "Fix: Sinkronisasi struktur folder hierarki screenshot berbasis tanggal harian.",
            "Optimasi penanganan tipe aksi log file agar tidak meleset."
    ]
    }

];

// Folder tempat file update .exe lu berada
app.use('/update', express.static(path.join(__dirname, 'update')));

// Pintu 1: API Cek Update (Sudah diperbaiki IP + Port secara dinamis)
app.get('/api/check-update', (req, res) => {
    // Mengambil header Host utuh (termasuk port jika ada, misal: 10.62.8.173:3535)
    const hostUtuh = req.get('host') || `${req.hostname}:${PORT}`;
    
    res.json({
        version: APP_VERSION, // Pastikan di atas sudah dideklarasikan = "1.0.7"
        download_url: `http://${hostUtuh}/update/ujicoba.exe`
    });
});

// Pintu 2: API Baru untuk mengirim data catatan update di atas
app.get('/api/changelog', (req, res) => {
    res.json(dataChangelog); // Pastikan variabel dataChangelog sudah ada di atas
});

// =========================================================================
// [UPDATE v1.0.9] STATISTIK DATA SERVER BERBASIS DATABASE MYSQL & BLOB
// =========================================================================
app.get('/api/statistik', (req, res) => {
    const qJumlahSS = "SELECT COUNT(*) as total_ss FROM log_screenshot";
    const qAlertHapus = "SELECT COUNT(*) as total_alert FROM log_pantau_karyawan WHERE tipe_aksi LIKE '%DIHAPUS%'";

    db.query(qJumlahSS, (err, resSS) => {
        if (err) return res.json({ ukuran_ss: "0 MB", jumlah_ss: "0 Lembar", alert_hapus: "0 Aksi", disk_server: "Tersedia" });
        
        const jumlahSS = resSS[0].total_ss || 0;
        const perkiraanMB = ((jumlahSS * 150) / 1024).toFixed(2);

        db.query(qAlertHapus, (err2, resAlert) => {
            const jumlahAlert = resAlert && resAlert[0] ? resAlert[0].total_alert : 0;

            res.json({
                ukuran_ss: perkiraanMB + " MB",
                jumlah_ss: jumlahSS + " Lembar",
                alert_hapus: jumlahAlert + " Aksi",
                disk_server: "Tersedia"
            });
        });
    });
});

// =========================================================================
// FITUR v1.0.8: ENDPOINT LOG FILE GLOBAL (SEMUA KARYAWAN)
// =========================================================================
app.get('/api/global-file-logs', (req, res) => {
    // Kueri SQL untuk mengambil seluruh log file, diurutkan dari yang paling baru
    // Limit kita patok 200 baris dulu agar server tidak berat
    const sql = `
        SELECT fl.*, k.nama as nama_karyawan, k.divisi 
        FROM log_file fl
        JOIN karyawan k ON fl.mac = k.mac
        ORDER BY fl.waktu DESC 
        LIMIT 200
    `;
    
    db.query(sql, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// =========================================================================
// JALANKAN SERVER (HARUS DI PALING BAWAH FILE)
// =========================================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(` SERVER DATABASE CONNECTED: Port ${PORT} `);
    console.log(`==================================================`);
});