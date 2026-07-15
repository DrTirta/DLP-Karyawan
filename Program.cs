using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Timers; 
using System.Drawing; 
using System.Drawing.Imaging; 
using System.Windows.Forms;
using System.Runtime.InteropServices;

// =========================================================================
// KELAS KONFIGURASI IDENTITAS
// =========================================================================
public class ConfigKaryawan
{
    public string NamaKaryawan { get; set; } = "Karyawan Default";
    public string Divisi { get; set; } = "Umum";
    public string JenisPerangkat { get; set; } = "Komputer";
}

// =========================================================================
// KELAS MESIN UTAMA (CCTV & NETWORK) - BERISI KODE ASLI LU
// =========================================================================
public static class TrackerAgent
{
    private static readonly HttpClient client = new HttpClient();
    private static readonly string ServerUrl = "http://10.62.8.173:3535/api/report-hardware";
    private static readonly string ActivityUrl = "http://10.62.8.173:3535/api/report-activity";
    private static readonly string ScreenshotUrl = "http://10.62.8.173:3535/api/report-screenshot";
    // =========================================================================
    // VARIABEL AUTO-UPDATE
    // =========================================================================
    public const string APP_VERSION = "1.0.4"; 
    
    // Pastikan pakai 'e' di kata Check
    private static readonly string UpdateCheckUrl = "http://10.62.8.173:3535/api/check-update"; 
    
    public static ConfigKaryawan DataConfig = new ConfigKaryawan();
    public static string MacAddressPC = "";

    private static string _fileTerakhirTerdeteksi = "";
    private static DateTime _waktuTerakhirTerdeteksi = DateTime.MinValue;
    private static bool _sedangMemprosesGambar = false; 
    private static System.Timers.Timer? _timerScreenshot; 
    private static List<FileSystemWatcher> _pasukanCCTV = new List<FileSystemWatcher>();
    private static bool _sudahJalan = false;

    public static async Task MulaiSistemCCTV()
    {
        if (_sudahJalan) return;
        _sudahJalan = true;

        MacAddressPC = AmbilMacAddress();
        
        // Kirim identitas pertama kali saat aplikasi nyala
        await KirimIdentitasKeServer();

        // --- LAPIS 1: VIP FOLDERS ---
        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string[] folderVIP = {
            Path.Combine(userProfile, "Desktop"), Path.Combine(userProfile, "Documents"),
            Path.Combine(userProfile, "Downloads"), Path.Combine(userProfile, "Pictures"),
            Path.Combine(userProfile, "Videos"), Path.Combine(userProfile, "Music")
        };

        foreach (string folder in folderVIP)
        {
            if (Directory.Exists(folder))
            {
                FileSystemWatcher watcherVIP = new FileSystemWatcher();
                watcherVIP.Path = folder;
                watcherVIP.Filter = "*.*"; 
                watcherVIP.IncludeSubdirectories = true; 
                watcherVIP.Created += OnChanged;
                watcherVIP.Deleted += OnChanged;
                watcherVIP.Changed += OnChanged;
                watcherVIP.Renamed += OnRenamed; 
                watcherVIP.EnableRaisingEvents = true;
                _pasukanCCTV.Add(watcherVIP); 
            }
        }

        // --- LAPIS 2: SAPUJAGAT C:\ ---
        FileSystemWatcher watcherSapujagat = new FileSystemWatcher();
        watcherSapujagat.Path = @"C:\";
        watcherSapujagat.Filter = "*.*"; 
        watcherSapujagat.IncludeSubdirectories = true; 
        watcherSapujagat.Created += OnChanged;
        watcherSapujagat.Deleted += OnChanged;
        watcherSapujagat.Renamed += OnRenamed; 
        watcherSapujagat.EnableRaisingEvents = true;
        _pasukanCCTV.Add(watcherSapujagat);

        // --- TIMER SCREENSHOT ROUTINE ---
        _timerScreenshot = new System.Timers.Timer(60000); 
        _timerScreenshot.Elapsed += OnTimerJepretOtomatis;
        _timerScreenshot.AutoReset = true;
        _timerScreenshot.Enabled = true;

        // =================================================================
        // [FITUR BARU] TIMER HEARTBEAT: Lapor status ONLINE tiap 30 detik
        // =================================================================
        System.Timers.Timer timerHeartbeat = new System.Timers.Timer(30000);
        timerHeartbeat.Elapsed += async (s, ev) => await KirimIdentitasKeServer();
        timerHeartbeat.AutoReset = true;
        timerHeartbeat.Enabled = true;

        // =================================================================
        // [FITUR BARU] TIMER UPDATE: Cek versi baru tiap 1 Menit (60000 ms)
        // =================================================================
        System.Timers.Timer timerUpdate = new System.Timers.Timer(60000); 
        timerUpdate.Elapsed += async (s, ev) => await CekUpdateOtomatis();
        timerUpdate.AutoReset = true;
        timerUpdate.Enabled = true;
    }

    private static async void OnTimerJepretOtomatis(object? sender, ElapsedEventArgs e)
    {
        if (_sedangMemprosesGambar) return; 
        await AmbilDanKirimScreenshot("ROUTINE");
    }

    private static async void OnChanged(object source, FileSystemEventArgs e)
    {
        if (string.IsNullOrEmpty(e.FullPath) || 
            e.FullPath.IndexOf("$recycle.bin", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("recycle.bin", StringComparison.OrdinalIgnoreCase) >= 0 ||  
            e.FullPath.IndexOf("xampp", StringComparison.OrdinalIgnoreCase) >= 0 ||
            e.FullPath.IndexOf("uji coba", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("dlp-karyawan", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("public", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("programdata", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("pagefile.sys", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("ib_logfile", StringComparison.OrdinalIgnoreCase) >= 0 ||
            e.FullPath.IndexOf("ibdata", StringComparison.OrdinalIgnoreCase) >= 0)
        { return; }

        string pathMentah = e.FullPath.ToLower();
        string namaMentah = (e.Name ?? "").ToLower();

        if (pathMentah.Contains(@"c:\windows") || pathMentah.Contains(@"c:\program files") || 
            pathMentah.Contains(@"c:\program data") || pathMentah.Contains(@"\appdata\") ||
            pathMentah.Contains(@"\application data\") || pathMentah.Contains(@"\local settings\") ||
            pathMentah.Contains(@"\onedrive\") || pathMentah.Contains(@"microsoft\winsxs") ||
            pathMentah.Contains(@"\search\data\"))
        { return; }

        if (namaMentah.StartsWith("~$") || namaMentah.EndsWith(".tmp") ||
            namaMentah.EndsWith(".pfd") || namaMentah.EndsWith(".log") || 
            namaMentah.EndsWith(".ini") || namaMentah.EndsWith(".db") ||  
            namaMentah.EndsWith(".crdownload") || namaMentah.Contains("~wrd") || 
            namaMentah.Contains("~wrl"))
        { return; }

        string tipeAksi = e.ChangeType.ToString();

        if (e.ChangeType == WatcherChangeTypes.Changed)
        {
            var selisihWaktu = DateTime.Now - _waktuTerakhirTerdeteksi;
            if (e.FullPath == _fileTerakhirTerdeteksi && selisihWaktu.TotalMilliseconds < 300) { tipeAksi = "SAVE"; }
            else { tipeAksi = "EDIT"; }

            _fileTerakhirTerdeteksi = e.FullPath;
            _waktuTerakhirTerdeteksi = DateTime.Now;
        }

        await KirimLogKeServer(tipeAksi, e.Name ?? "Unknown_File", e.FullPath);

        if (tipeAksi == "Deleted")
        {
            await AmbilDanKirimScreenshot("ALERT");
        }
    }

    private static async void OnRenamed(object source, RenamedEventArgs e)
    {
        if (string.IsNullOrEmpty(e.FullPath) || 
            e.FullPath.IndexOf("$recycle.bin", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("recycle.bin", StringComparison.OrdinalIgnoreCase) >= 0 ||  
            e.FullPath.IndexOf("xampp", StringComparison.OrdinalIgnoreCase) >= 0 ||
            e.FullPath.IndexOf("uji coba", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("dlp-karyawan", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("public", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("programdata", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("pagefile.sys", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("ib_logfile", StringComparison.OrdinalIgnoreCase) >= 0 ||
            e.FullPath.IndexOf("ibdata", StringComparison.OrdinalIgnoreCase) >= 0)
        { return; }

        string pathMentah = e.FullPath.ToLower();
        string namaMentah = (e.Name ?? "").ToLower();

        if (pathMentah.Contains(@"c:\windows") || pathMentah.Contains(@"c:\program files") || 
            pathMentah.Contains(@"c:\program data") || pathMentah.Contains(@"\appdata\") ||
            pathMentah.Contains(@"\onedrive\"))
        { return; }

        if (namaMentah.StartsWith("~$") || namaMentah.EndsWith(".tmp") || 
            namaMentah.EndsWith(".pfd") || namaMentah.EndsWith(".log") || 
            namaMentah.EndsWith(".ini")) 
        { return; }
        
        await KirimLogKeServer("EDIT", e.Name ?? "Unknown_File", e.FullPath);
    }

    private static async Task AmbilDanKirimScreenshot(string pemicu)
    {
        _sedangMemprosesGambar = true; 
        try
        {
            int lebarAsli = 1920; 
            int tinggiAsli = 1080;

            using (Bitmap bitmapAsli = new Bitmap(lebarAsli, tinggiAsli))
            {
                using (Graphics gAsli = Graphics.FromImage(bitmapAsli))
                {
                    gAsli.CopyFromScreen(0, 0, 0, 0, bitmapAsli.Size);
                }

                ImageCodecInfo jpegCodec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
                EncoderParameters parameterKompresi = new EncoderParameters(1);
                parameterKompresi.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 35L); 

                using (MemoryStream ms = new MemoryStream())
                {
                    bitmapAsli.Save(ms, jpegCodec, parameterKompresi);
                    byte[] byteGambar = ms.ToArray();
                    string stringBase64 = Convert.ToBase64String(byteGambar);

                    var payloadSS = new {
                        mac = MacAddressPC,
                        tipe_pemicu = pemicu, 
                        gambar_base64 = stringBase64
                    };

                    string jsonSS = JsonSerializer.Serialize(payloadSS);
                    var konten = new StringContent(jsonSS, Encoding.UTF8, "application/json");
                    await client.PostAsync(ScreenshotUrl, konten);
                }
            }
        }
        catch { }
        finally { _sedangMemprosesGambar = false; }
    }

    private static async Task KirimLogKeServer(string aksi, string namaFile, string pathFile)
    {
        try {
            var logPayload = new { mac = MacAddressPC, tipe_aksi = aksi, nama_file = namaFile, path_file = pathFile };
            string jsonLog = JsonSerializer.Serialize(logPayload);
            var konten = new StringContent(jsonLog, Encoding.UTF8, "application/json");
            await client.PostAsync(ActivityUrl, konten);
        } catch {}
    }

    // FITUR BARU: Metode dibuat public agar FormSetting bisa memanggil ulang saat disave
    public static async Task KirimIdentitasKeServer()
    {
        try {
            var payload = new { 
                nama = DataConfig.NamaKaryawan, 
                divisi = DataConfig.Divisi, 
                jenis_perangkat = DataConfig.JenisPerangkat, 
                mac = MacAddressPC, 
                ip = AmbilLocalIP(), 
                cpu = AmbilCpuNama() 
            };
            string json = JsonSerializer.Serialize(payload);
            var konten = new StringContent(json, Encoding.UTF8, "application/json");
            await client.PostAsync(ServerUrl, konten);
        } catch {}
    }

    // =========================================================================
    // FUNGSI AUTO-UPDATE SILUMAN
    // =========================================================================
    private static async Task CekUpdateOtomatis()
    {
        try {
            string response = await client.GetStringAsync(UpdateCheckUrl);
            var json = JsonDocument.Parse(response);
            string serverVersion = json.RootElement.GetProperty("version").GetString() ?? "1.0.0";
            string downloadUrl = json.RootElement.GetProperty("download_url").GetString() ?? "";

            // Kalau versi di server lebih baru dari versi lokal, jalankan update!
            if (serverVersion != APP_VERSION && !string.IsNullOrEmpty(downloadUrl)) {
                await ProsesUpdateNinja(downloadUrl);
            }
        } catch {}
    }

    private static async Task ProsesUpdateNinja(string urlFileBaru)
    {
        try {
            string exeLama = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName ?? "ujicoba.exe";
            string exeBaru = exeLama + ".new";
            string batFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "updater_ninja.bat");

            // 1. Download file .exe versi baru diam-diam
            byte[] fileBytes = await client.GetByteArrayAsync(urlFileBaru);
            File.WriteAllBytes(exeBaru, fileBytes);

            // 2. Buat script BATCH untuk numpuk file lama
            string namaExe = Path.GetFileName(exeLama);
            string batCode = $@"
@echo off
timeout /t 3 /nobreak > NUL
del ""{exeLama}""
ren ""{exeBaru}"" ""{namaExe}""
start """" ""{exeLama}""
del ""%~f0""
";
            File.WriteAllText(batFile, batCode);

            // 3. Eksekusi script BATCH di background tanpa layar CMD
            var info = new System.Diagnostics.ProcessStartInfo(batFile) {
                WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
                CreateNoWindow = true
            };
            System.Diagnostics.Process.Start(info);

            // 4. Matikan aplikasi ini sekarang biar filenya nggak ke-lock dan bisa dihapus
            Environment.Exit(0);
        } catch {}
    }

    // =========================================================================
    // KODE BAWAAN LU YANG ASLI (JANGAN DIHAPUS)
    // =========================================================================
    private static string AmbilMacAddress() {
        try { var interfaceAktif = NetworkInterface.GetAllNetworkInterfaces().FirstOrDefault(i => i.OperationalStatus == OperationalStatus.Up); return interfaceAktif != null ? string.Join(":", interfaceAktif.GetPhysicalAddress().GetAddressBytes().Select(b => b.ToString("X2"))) : "00:00:00:00:00:00"; } catch { return "ERROR_MAC"; }
    }
    private static string AmbilLocalIP() {
        try { var host = Dns.GetHostEntry(Dns.GetHostName()); return host.AddressList.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork)?.ToString() ?? "127.0.0.1"; } catch { return "Unknown IP"; }
    }
    private static string AmbilCpuNama() {
        try { return Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER") ?? "Windows Device"; } catch { return "Windows Device"; }
    }
}

// =========================================================================
// UI SILUMAN & HOTKEY LISTENER (CTRL + SHIFT + U)
// =========================================================================
public class HiddenForm : Form
{
    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, int fsModifiers, int vk);
    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int MOD_ALT = 0x0001;
    private const int MOD_CONTROL = 0x0002;
    private const int MOD_SHIFT = 0x0004;
    private const int WM_HOTKEY = 0x0312;
    private const int HOTKEY_ID = 9000;

    private static string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json");

    public HiddenForm()
    {
        // Menyembunyikan form 100%
        this.Opacity = 0;
        this.ShowInTaskbar = false;
        this.WindowState = FormWindowState.Minimized;
        this.FormBorderStyle = FormBorderStyle.None;

        MuatConfig();

        // Mendaftarkan Hotkey: Ctrl + Shift + U
        RegisterHotKey(this.Handle, HOTKEY_ID, MOD_CONTROL | MOD_SHIFT, (int)Keys.U);

        // Menjalankan CCTV secara asinkron di background
        _ = TrackerAgent.MulaiSistemCCTV();
    }

    private void MuatConfig()
    {
        if (File.Exists(configPath))
        {
            try {
                string json = File.ReadAllText(configPath);
                TrackerAgent.DataConfig = JsonSerializer.Deserialize<ConfigKaryawan>(json) ?? new ConfigKaryawan();
            } catch {}
        }
    }

    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID)
        {
            MunculkanFormSetting();
        }
    }

    private void MunculkanFormSetting()
    {
        FormSetting settingForm = new FormSetting();
        settingForm.ShowDialog(); 
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        UnregisterHotKey(this.Handle, HOTKEY_ID);
        base.OnFormClosing(e);
    }
}

// =========================================================================
// UI POP-UP PENGATURAN (MUNCUL SAAT HOTKEY DITEKAN)
// =========================================================================
public class FormSetting : Form
{
    private TextBox txtNama;
    private TextBox txtDivisi;
    private ComboBox cmbPerangkat;
    private Button btnSimpan;

    public FormSetting()
    {
        this.Text = "Admin Setup - Identitas Agen";
        this.Size = new Size(350, 310); 
        this.StartPosition = FormStartPosition.CenterScreen;
        this.FormBorderStyle = FormBorderStyle.FixedToolWindow;
        this.TopMost = true; 
        
        // =========================================================
        // [BUG FIX] Sembunyi dari Taskbar biar turun ke "Background Processes"
        // =========================================================
        this.ShowInTaskbar = false; 

        // =========================================================
        // [LANGKAH 1 - FITUR IMMORTAL] Cegah mati saat tombol X (Silang) ditekan
        // =========================================================
        this.FormClosing += (s, e) => {
            if (e.CloseReason == CloseReason.UserClosing) {
                e.Cancel = true; // Batalin perintah mati
                this.Hide();     // Sembunyi ke Background
            }
        };

        Label lblNama = new Label() { Text = "Nama Karyawan:", Left = 20, Top = 20, Width = 100 };
        txtNama = new TextBox() { Left = 120, Top = 20, Width = 180, Text = TrackerAgent.DataConfig.NamaKaryawan };

        Label lblDivisi = new Label() { Text = "Divisi / Jabatan:", Left = 20, Top = 60, Width = 100 };
        txtDivisi = new TextBox() { Left = 120, Top = 60, Width = 180, Text = TrackerAgent.DataConfig.Divisi };

        Label lblPerangkat = new Label() { Text = "Jenis Perangkat:", Left = 20, Top = 100, Width = 100 };
        cmbPerangkat = new ComboBox() { Left = 120, Top = 100, Width = 180, DropDownStyle = ComboBoxStyle.DropDownList };
        cmbPerangkat.Items.AddRange(new string[] { "Laptop", "Komputer" });
        cmbPerangkat.SelectedItem = TrackerAgent.DataConfig.JenisPerangkat;

        btnSimpan = new Button() { Text = "SIMPAN & KIRIM", Left = 120, Top = 140, Width = 180, BackColor = Color.LightGreen };
        btnSimpan.Click += BtnSimpan_Click;

        // Tombol Kill Switch
        Button btnMati = new Button() { Text = "MATIKAN AGEN", Left = 120, Top = 180, Width = 180, BackColor = Color.LightCoral, ForeColor = Color.White };
        btnMati.Click += (s, e) => {
            MessageBox.Show("Agen dihentikan secara manual.", "System Offline", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Environment.Exit(0); 
        };

        // =========================================================
        // [FITUR BARU v1.0.3] : INFO VERSI & TOMBOL CHANGELOG
        // =========================================================
        Label lblVersi = new Label() { 
            Text = "v" + TrackerAgent.APP_VERSION, 
            Left = 10, Top = 230, Width = 50, ForeColor = Color.Gray 
        };

        Button btnLog = new Button() { 
            Text = "?", Left = 60, Top = 225, Width = 25, Height = 25, BackColor = Color.LightGray 
        };
        btnLog.Click += (s, e) => {
            string pesanLog = "Update Log " + TrackerAgent.APP_VERSION + ":\n\n" +
                              "- Fix: Immortal mode (Anti tombol X)\n" +
                              "- Fix: Stealth mode (Turun ke Background Processes)\n" +
                              "- Fitur: Teks versi & Tombol log update\n" +
                              "- Fitur: Kill Switch (Tombol Matikan Agen)\n" +
                              "- Fitur: Auto-Update Engine (OTA)\n" +
                              "- Fitur: Heartbeat (Status Online akurat)";
            MessageBox.Show(pesanLog, "Changelog " + TrackerAgent.APP_VERSION, MessageBoxButtons.OK, MessageBoxIcon.Information);
        };

        this.Controls.Add(lblNama); this.Controls.Add(txtNama);
        this.Controls.Add(lblDivisi); this.Controls.Add(txtDivisi);
        this.Controls.Add(lblPerangkat); this.Controls.Add(cmbPerangkat);
        this.Controls.Add(btnSimpan);
        this.Controls.Add(btnMati); 
        this.Controls.Add(lblVersi); 
        this.Controls.Add(btnLog);
    }

    private void BtnSimpan_Click(object? sender, EventArgs e)
    {
        TrackerAgent.DataConfig.NamaKaryawan = txtNama.Text;
        TrackerAgent.DataConfig.Divisi = txtDivisi.Text;
        TrackerAgent.DataConfig.JenisPerangkat = cmbPerangkat.SelectedItem?.ToString() ?? "Komputer";

        string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json");
        File.WriteAllText(configPath, JsonSerializer.Serialize(TrackerAgent.DataConfig, new JsonSerializerOptions { WriteIndented = true }));

        MessageBox.Show("Data diupdate! Mengirim ke server...", "Sukses", MessageBoxButtons.OK, MessageBoxIcon.Information);
        
        // Panggil ulang fungsi kirim identitas biar database langsung update
        _ = TrackerAgent.KirimIdentitasKeServer();

        // =========================================================
        // [LANGKAH 2] Ubah this.Close() menjadi this.Hide()
        // Biar habis disave, dia langsung masuk ke Background Processes
        // =========================================================
        this.Hide(); 
    }
}

// =========================================================================
// ENTRY POINT APLIKASI
// =========================================================================
static class ProgramUtama
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // Memulai aplikasi dengan menjalankan form siluman
        Application.Run(new HiddenForm()); 
    }
}