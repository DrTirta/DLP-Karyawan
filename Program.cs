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

class Program
{
    private static readonly HttpClient client = new HttpClient();
    private static readonly string ServerUrl = "http://127.0.0.1:3535/api/report-hardware";
    private static readonly string ActivityUrl = "http://127.0.0.1:3535/api/report-activity";
    private static readonly string ScreenshotUrl = "http://127.0.0.1:3535/api/report-screenshot"; 
    
    private static readonly string NamaKaryawan = "Tirta Anggara";
    private static readonly string DivisiKaryawan = "IT Security";
    private static string MacAddressPC = "";

    private static string _fileTerakhirTerdeteksi = "";
    private static DateTime _waktuTerakhirTerdeteksi = DateTime.MinValue;

    private static bool _sedangMemprosesGambar = false; 
    private static System.Timers.Timer? _timerScreenshot; 

    // WADAH CCTV GABUNGAN (Menampung Lapis 1 & Lapis 2 biar gak dihapus Windows)
    private static List<FileSystemWatcher> _pasukanCCTV = new List<FileSystemWatcher>();

    static async Task Main(string[] args)
    {
        Console.WriteLine("==================================================");
        Console.WriteLine("     PROYEK UJI COBA: AGEN AUTO SCREENSHOT ACTIVE ");
        Console.WriteLine("==================================================");

        MacAddressPC = AmbilMacAddress();
        string ipAddress = AmbilLocalIP();
        string cpuName = AmbilCpuNama();

        await KirimIdentitasKeServer(ipAddress, cpuName);

        // =========================================================================
        // LAPIS 1: MENGINTAI FOLDER VIP (100% SENSOR AKTIF)
        // =========================================================================
        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        string[] folderVIP = {
            Path.Combine(userProfile, "Desktop"),
            Path.Combine(userProfile, "Documents"),
            Path.Combine(userProfile, "Downloads"),
            Path.Combine(userProfile, "Pictures"),
            Path.Combine(userProfile, "Videos"),
            Path.Combine(userProfile, "Music")
        };

        Console.WriteLine("\n[SISTEM] Membangun pos pengintai Lapis 1 (VIP Folders)...");

        foreach (string folder in folderVIP)
        {
            if (Directory.Exists(folder))
            {
                FileSystemWatcher watcherVIP = new FileSystemWatcher();
                watcherVIP.Path = folder;
                watcherVIP.Filter = "*.*"; 
                watcherVIP.IncludeSubdirectories = true; 

                // Sensor Lapis 1: FULL ACTION (Boleh pantau Edit/Changed)
                watcherVIP.Created += OnChanged;
                watcherVIP.Deleted += OnChanged;
                watcherVIP.Changed += OnChanged;
                watcherVIP.Renamed += OnRenamed; 
                watcherVIP.EnableRaisingEvents = true;

                _pasukanCCTV.Add(watcherVIP); 
                Console.WriteLine($"[CCTV LAPIS 1 AKTIF] -> {folder}");
            }
        }

        // =========================================================================
        // LAPIS 2: PENGINTAI SAPUJAGAT C:\ (SENSOR DIBATASI / HEMAT ENERGI)
        // =========================================================================
        Console.WriteLine("\n[SISTEM] Membangun pos pengintai Lapis 2 (Sapujagat C:\\)...");
        
        FileSystemWatcher watcherSapujagat = new FileSystemWatcher();
        watcherSapujagat.Path = @"C:\";
        watcherSapujagat.Filter = "*.*"; 
        watcherSapujagat.IncludeSubdirectories = true; 

        // Sensor Lapis 2: HANYA PANTAU BARU, HAPUS & RENAME! 
        // (JANGAN MASUKIN EVENT .Changed DISINI BIAR LAPTOP KAGA MELEDAK!)
        watcherSapujagat.Created += OnChanged;
        watcherSapujagat.Deleted += OnChanged;
        watcherSapujagat.Renamed += OnRenamed; 
        watcherSapujagat.EnableRaisingEvents = true;

        _pasukanCCTV.Add(watcherSapujagat);
        Console.WriteLine($"[CCTV LAPIS 2 AKTIF] -> Jaring pengaman seluruh Drive C terpasang!");
        // =========================================================================

        _timerScreenshot = new System.Timers.Timer(60000); 
        _timerScreenshot.Elapsed += OnTimerJepretOtomatis;
        _timerScreenshot.AutoReset = true;
        _timerScreenshot.Enabled = true;

        Console.WriteLine($"\n[CCTV FILE AKTIF] Sedang mengintai 2 Lapis Keamanan.");
        Console.WriteLine("[CCTV GAMBAR AKTIF] Mengambil screenshot otomatis tiap 1 menit...");
        Console.WriteLine("Tekan ENTER di CMD ini jika ingin mematikan Agen.\n");
        
        Console.ReadLine();
    }

    private static async void OnTimerJepretOtomatis(object? sender, ElapsedEventArgs e)
    {
        if (_sedangMemprosesGambar) return; 
        await AmbilDanKirimScreenshot("ROUTINE");
    }

    private static async void OnChanged(object source, FileSystemEventArgs e)
    {
        // =========================================================================
        // EMERGENSI FILTER: Anti Infinite Loop
        // =========================================================================
        if (string.IsNullOrEmpty(e.FullPath) || 
            e.FullPath.IndexOf("xampp", StringComparison.OrdinalIgnoreCase) >= 0 ||
            e.FullPath.IndexOf("uji coba", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("dlp-karyawan", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("public", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("programdata", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("pagefile.sys", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("ib_logfile", StringComparison.OrdinalIgnoreCase) >= 0 ||
            e.FullPath.IndexOf("ibdata", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return; 
        }

        string pathMentah = e.FullPath.ToLower();
        string namaMentah = (e.Name ?? "").ToLower();

        if (pathMentah.Contains(@"c:\windows") || 
            pathMentah.Contains(@"c:\program files") || 
            pathMentah.Contains(@"c:\program data") || 
            pathMentah.Contains(@"\appdata\") ||
            pathMentah.Contains(@"\application data\") ||
            pathMentah.Contains(@"\local settings\") ||
            pathMentah.Contains(@"\onedrive\") || 
            pathMentah.Contains(@"microsoft\winsxs") ||
            pathMentah.Contains(@"\search\data\"))
        {
            return; 
        }

        if (namaMentah.StartsWith("~$") || 
            namaMentah.EndsWith(".tmp") ||
            namaMentah.EndsWith(".pfd") || 
            namaMentah.EndsWith(".log") || 
            namaMentah.EndsWith(".ini") || 
            namaMentah.EndsWith(".db") ||  
            namaMentah.EndsWith(".crdownload") || 
            namaMentah.Contains("~wrd") || 
            namaMentah.Contains("~wrl"))
        {
            return; 
        }

        string tipeAksi = e.ChangeType.ToString();

        if (e.ChangeType == WatcherChangeTypes.Changed)
        {
            var selisihWaktu = DateTime.Now - _waktuTerakhirTerdeteksi;
            if (e.FullPath == _fileTerakhirTerdeteksi && selisihWaktu.TotalMilliseconds < 300) { tipeAksi = "SAVE"; }
            else { tipeAksi = "EDIT"; }

            _fileTerakhirTerdeteksi = e.FullPath;
            _waktuTerakhirTerdeteksi = DateTime.Now;
        }

        Console.WriteLine($"[TERDETEKSI] File {tipeAksi}: {e.Name}");
        await KirimLogKeServer(tipeAksi, e.Name ?? "Unknown_File", e.FullPath);

        if (tipeAksi == "Deleted")
        {
            Console.WriteLine("[ALERT SYSTEM] File Dihapus! Memicu snapshot darurat...");
            await AmbilDanKirimScreenshot("ALERT");
        }
    }

    private static async void OnRenamed(object source, RenamedEventArgs e)
    {
        // =========================================================================
        // EMERGENSI FILTER: Anti Infinite Loop
        // =========================================================================
        if (string.IsNullOrEmpty(e.FullPath) || 
            e.FullPath.IndexOf("xampp", StringComparison.OrdinalIgnoreCase) >= 0 ||
            e.FullPath.IndexOf("uji coba", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("dlp-karyawan", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("public", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("programdata", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("pagefile.sys", StringComparison.OrdinalIgnoreCase) >= 0 || 
            e.FullPath.IndexOf("ib_logfile", StringComparison.OrdinalIgnoreCase) >= 0 ||
            e.FullPath.IndexOf("ibdata", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return; 
        }

        string pathMentah = e.FullPath.ToLower();
        string namaMentah = (e.Name ?? "").ToLower();

        if (pathMentah.Contains(@"c:\windows") || 
            pathMentah.Contains(@"c:\program files") || 
            pathMentah.Contains(@"c:\program data") || 
            pathMentah.Contains(@"\appdata\") ||
            pathMentah.Contains(@"\onedrive\"))
        {
            return; 
        }

        if (namaMentah.StartsWith("~$") || namaMentah.EndsWith(".tmp") || namaMentah.EndsWith(".log") || namaMentah.EndsWith(".ini")) return;
        
        Console.WriteLine($"[TERDETEKSI] Ganti nama file: {e.OldName} -> {e.Name}");
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
                    Console.WriteLine($"[CCTV GAMBAR] Berhasil kirim ({pemicu}) - Ukuran Optimal: {byteGambar.Length / 1024} KB");
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[CCTV GAMBAR OFF] Gagal jepret: {ex.Message}");
        }
        finally
        {
            _sedangMemprosesGambar = false; 
        }
    }

    private static async Task KirimLogKeServer(string aksi, string namaFile, string pathFile)
    {
        try
        {
            var logPayload = new { mac = MacAddressPC, tipe_aksi = aksi, nama_file = namaFile, path_file = pathFile };
            string jsonLog = JsonSerializer.Serialize(logPayload);
            var konten = new StringContent(jsonLog, Encoding.UTF8, "application/json");
            await client.PostAsync(ActivityUrl, konten);
        } catch {}
    }

    private static async Task KirimIdentitasKeServer(string ip, string cpu)
    {
        try {
            var payload = new { nama = NamaKaryawan, divisi = DivisiKaryawan, mac = MacAddressPC, ip = ip, cpu = cpu };
            string json = JsonSerializer.Serialize(payload);
            var konten = new StringContent(json, Encoding.UTF8, "application/json");
            await client.PostAsync(ServerUrl, konten);
            Console.WriteLine($"[SUKSES] Status Agen: ONLINE.");
        } catch {}
    }

    private static string AmbilMacAddress()
    {
        try { var interfaceAktif = NetworkInterface.GetAllNetworkInterfaces().FirstOrDefault(i => i.OperationalStatus == OperationalStatus.Up); return interfaceAktif != null ? string.Join(":", interfaceAktif.GetPhysicalAddress().GetAddressBytes().Select(b => b.ToString("X2"))) : "00:00:00:00:00:00"; } catch { return "ERROR_MAC"; }
    }
    private static string AmbilLocalIP() {
        try { var host = Dns.GetHostEntry(Dns.GetHostName()); return host.AddressList.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork)?.ToString() ?? "127.0.0.1"; } catch { return "Unknown IP"; }
    }
    private static string AmbilCpuNama() {
        try { return Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER") ?? "Windows Device"; } catch { return "Windows Device"; }
    }
}