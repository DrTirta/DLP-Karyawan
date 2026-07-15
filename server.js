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

// Buka gerbang folder 'update' biar file .exe bisa di-download agen
app.use('/update', express.static('update'));

// =========================================================================
// [PERBAIKAN] : KONEKSI DATABASE POOL (ANTI-CRASH)
// =========================================================================
const db = mysql.createPool({
    host: 'localhost',
    user: 'root',          
    password: '',          
    database: 'db_monitoring', 
    waitForConnections: true,
    connectionLimit: 20,   
    queueLimit: 0
});

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
                console.error("Error SQL Hardware:", err.message); // Tambahan console log biar gampang debug
                return res.status(500).json({ status: "GAGAL" });
            }
            console.log(`[DATABASE SPEK] Identitas ${jenis_perangkat} milik ${nama} berhasil dikunci ke DB.`);
            return res.json({ status: "OK" });
        });
    } else {
        res.status(400).json({ status: "GAGAL" });
    }
});

// =========================================================================
// 2. ENDPOINT POST: SIMPAN LOG AKTIVITAS FILE (DITAMBAH PATH ASLI)
// =========================================================================
app.post('/api/report-activity', (req, res) => {
    const logBaru = req.body;

    if (logBaru && logBaru.mac) {
        const infoKaryawan = daftarAgenKomputer[logBaru.mac] || { nama_karyawan: "Unknown", divisi: "Unknown" };
        const namaKaryawan = infoKaryawan.nama_karyawan;
        const divisi = infoKaryawan.divisi;
        const mac = logBaru.mac;
        const ip = infoKaryawan.ip || "0.0.0.0";
        const tipeAksi = logLogAktivitasTipe(logBaru.tipe_aksi);
        const namaFile = logBaru.nama_file;
        
        // FITUR BARU: Menangkap jalur file asli
        const pathFile = logBaru.path_file || "Lokasi tidak diketahui";

        // FITUR BARU: SQL Insert ditambah kolom path_file
        const queryInsert = `
            INSERT INTO log_pantau_karyawan (nama_karyawan, divisi, mac_address, ip_address, tipe_aksi, nama_file, path_file, waktu_kejadian) 
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `;

        db.query(queryInsert, [namaKaryawan, divisi, mac, ip, tipeAksi, namaFile, pathFile], (err, result) => {
            if (err) return res.status(500).json({ status: "GAGAL" });
            console.log(`[DATABASE AMAN] Berhasil mencatat aksi ${tipeAksi} untuk file: ${namaFile}`);
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

        const namaFileGambar = `ss_${timestamp}.jpg`;
        const folderTujuan = path.join(__dirname, 'public', 'screenshots', namaUser, kategoriAksi);
        
        if (!fs.existsSync(folderTujuan)) {
            fs.mkdirSync(folderTujuan, { recursive: true });
        }

        const pathLengkapGambar = path.join(folderTujuan, namaFileGambar);
        const dataGambarMurni = gambar_base64.replace(/^data:image\/\w+;base64,/, "");
        
        fs.writeFileSync(pathLengkapGambar, dataGambarMurni, 'base64');
        const bufferGambar = Buffer.from(dataGambarMurni, 'base64');

        const jalurSimpanDatabase = `${namaUser}/${kategoriAksi}/${namaFileGambar}`;
        const querySimpanSS = "INSERT INTO log_screenshot (mac_address, nama_file_gambar, tipe_pemicu, gambar_blob) VALUES (?, ?, ?, ?)";
        
        db.query(querySimpanSS, [mac, jalurSimpanDatabase, kategoriAksi, bufferGambar], (err, result) => {
            if (err) return res.status(500).json({ status: "GAGAL" });
            console.log(`[DATABASE] Screenshot saved to MySQL Blob (${kategoriAksi}).`);
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
// [FITUR BARU] : SISTEM AUTO UPDATE UNTUK AGEN C#
// =========================================================================
const APP_VERSION = "1.0.3"; // Ubah angka ini kalau lu naruh update file .exe baru

// Daftarkan folder 'update' (Lu harus bikin folder bernama 'update' di sebelah server.js)
app.use('/update', express.static(path.join(__dirname, 'update')));

app.get('/api/check-update', (req, res) => {
    res.json({
        version: APP_VERSION,
        download_url: `http://${req.hostname}:${PORT}/update/ujicoba.exe` // Sesuaikan nama .exe lu
    });
});

// =========================================================================
// JALANKAN SERVER (HARUS DI PALING BAWAH FILE)
// =========================================================================
// Gw tambahin '0.0.0.0' biar server lu siap nerima koneksi dari jaringan LAN/Wi-Fi
app.listen(PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(` SERVER DATABASE CONNECTED: Port ${PORT} `);
    console.log(`==================================================`);
});