using System;
using System.IO;
using System.Management;

public static class HardwareMesin
{
    public static string AmbilSpesifikasiRealWindows() 
    {
        string cpuName = "Unknown CPU";
        string totalRamGB = "0GB";
        string totalStorageGB = "0GB";

        // 1. Ambil Info CPU (Diproteksi sendiri)
        try {
            using (ManagementObjectSearcher searcherCpu = new ManagementObjectSearcher("root\\CIMV2", "SELECT Name FROM Win32_Processor")) {
                foreach (ManagementObject obj in searcherCpu.Get()) {
                    cpuName = obj["Name"]?.ToString()?.Trim() ?? "Unknown CPU";
                    break;
                }
            }
        } catch {
            cpuName = "CPU Deteksi Gagal";
        }

        // 2. Ambil Info RAM (Diproteksi sendiri)
        try {
            using (ManagementObjectSearcher searcherRam = new ManagementObjectSearcher("root\\CIMV2", "SELECT TotalPhysicalMemory FROM Win32_ComputerSystem")) {
                foreach (ManagementObject obj in searcherRam.Get()) {
                    long bytesRam = Convert.ToInt64(obj["TotalPhysicalMemory"]);
                    totalRamGB = (bytesRam / (1024 * 1024 * 1024)).ToString() + "GB";
                    break;
                }
            }
        } catch {
            totalRamGB = "RAM ?";
        }

        // 3. Ambil Info Storage Drive C (Diproteksi sendiri)
        try {
            DriveInfo driveC = new DriveInfo("C");
            if (driveC.IsReady) {
                long bytesStorage = driveC.TotalSize;
                totalStorageGB = (bytesStorage / (1024 * 1024 * 1024)).ToString() + "GB";
            }
        } catch {
            totalStorageGB = "Storage ?";
        }

        return $"{cpuName}, RAM {totalRamGB}, Storage {totalStorageGB}";
    }
}