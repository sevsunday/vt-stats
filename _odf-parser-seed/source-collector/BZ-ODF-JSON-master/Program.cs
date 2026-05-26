using System.IO;
using System.Runtime.Versioning;
using System.Text;
using Microsoft.Win32;

namespace BZ_ODF_JSON
{
    class Program
    {
        private const ulong BZCCAPPID = 624970;
        private const ulong VSRMODID = 1325933293;
        private const ulong HADEANMODID = 2785542655;
        private const string steam32 = "SOFTWARE\\VALVE\\";
        private const string steam64 = "SOFTWARE\\Wow6432Node\\Valve\\";

        [SupportedOSPlatform("windows")]
        public static void Main(string[] args)
        {
            // Test Steam32 first, if that doesn't exist, switch to Steam64.
            var steamKey = Registry.LocalMachine.OpenSubKey(steam32);
            steamKey ??= Registry.LocalMachine.OpenSubKey(steam64);

            // Return early if the steamKey is null.
            if (steamKey == null)
            {
                Console.WriteLine("Error: Unable to find Steam installation.");
                return;
            }

            foreach (var subKeyName in steamKey.GetSubKeyNames())
            {
                using (var subKey = steamKey.OpenSubKey(subKeyName))
                {
                    if (subKey == null)
                    {
                        break;
                    }

                    var steamPath = subKey.GetValue("InstallPath");

                    if (steamPath == null)
                    {
                        break;
                    }

                    var steamPathString = steamPath.ToString();
                    var baseGamePath = $"{steamPathString}\\steamapps\\common\\BZ2R";
                    var vsrModPath = $"{steamPathString}\\steamapps\\workshop\\content\\{BZCCAPPID}\\{VSRMODID}";
                    var hadeanPackModPath = $"{steamPathString}\\steamapps\\workshop\\content\\{BZCCAPPID}\\{HADEANMODID}";

                    // Call each method.
                    HandleVehicleODFs(baseGamePath, vsrModPath, hadeanPackModPath);
                    HandleBuildingODFs(baseGamePath, vsrModPath, hadeanPackModPath);
                    HandleWeaponODFs(baseGamePath, vsrModPath, hadeanPackModPath);
                    HandleDataPakODFs(baseGamePath);
                    HandlePilotODFs(baseGamePath, vsrModPath, hadeanPackModPath);
                }
            }
        }

        private static void HandleVehicleODFs(string baseGamePath, string vsrModPath, string hadeanModPath)
        {
            // Filter for the files that we need for relevance.
            string[] vehicleInclusions = ["fv", "iv", "ev", "cv"];

            // Get Vehicles.
            var vehiclesPaths = new List<string>()
            {
                $"{baseGamePath}\\bz2r_res\\baked",
                $"{baseGamePath}\\bz2r_res\\objects",
                $"{vsrModPath}\\VSR\\Recycler Variants\\Standard",
                $"{hadeanModPath}\\Hadean\\Units"
            };

            // Keep track of the new file path for JSON.
            string vehicleFilePath = $"{Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)}/Vehicle-ODF-Data.json";

            // Check to see if the file exists first and remove it. 
            if (File.Exists(vehicleFilePath))
            {
                File.Delete(vehicleFilePath);
            }

            // If any files exist, create a JSON file on the user disk.
            var file = File.Create(vehicleFilePath);

            // Close the file.
            file.Close();

            List<Dictionary<string, string>> filteredVehicleODFFiles = [];

            foreach (var path in vehiclesPaths)
            {
                var odfFiles = FileHelper.GetFiles(path, "*.odf");
                
                if (!odfFiles.Any())
                {
                    break;
                }

                var filteredODFResult = odfFiles.Where(s => vehicleInclusions.Any(prefix => s.First().Key.StartsWith(prefix, StringComparison.CurrentCultureIgnoreCase) && !s.First().Key.Contains("_config", StringComparison.CurrentCultureIgnoreCase))).ToList();

                if (filteredODFResult == null || filteredODFResult.Count <= 0)
                {
                    Console.WriteLine("Error: Unable to find any ODF files for BZCC to process.");
                    break;
                }

                filteredVehicleODFFiles.AddRange(filteredODFResult);
            }

            if (filteredVehicleODFFiles?.Count > 0)
            {
                // Create a StringBuilder for the JSON Content.
                StringBuilder sb = new();
                sb.Append('{');

                // Run through each ODF file, convert it to JSON, add it to the file.
                for (int i = 0; i < filteredVehicleODFFiles.Count; i++)
                {
                    var odfFile = filteredVehicleODFFiles[i].First();

                    // See if we can open the file from the path that is part of the dictionary.
                    string contents = File.ReadAllText(odfFile.Value);

                    // Test to see if we can convert that to JSON.
                    string jsonContents = FileHelper.GetIniAsJson(odfFile.Key, contents, false, i == filteredVehicleODFFiles.Count - 1, true);

                    // Append the contents to a new line in the StringBuilder.
                    sb.AppendLine(jsonContents);
                }

                sb.Append('}');

                // Append that to the file we just wrote to the disk.
                File.AppendAllText(vehicleFilePath, sb.ToString());
            }
        }

        private static void HandleBuildingODFs(string baseGamePath, string vsrModPath, string hadeanModPath)
        {
            string[] buildingInclusions = ["fb", "ib", "eb", "cb"];

            // Get Buildings.
            var buildingsPath = new List<string>()
            {
                $"{baseGamePath}\\bz2r_res\\baked",
                $"{baseGamePath}\\bz2r_res\\objects",
                $"{vsrModPath}\\VSR\\Recycler Variants\\Standard",
                $"{hadeanModPath}\\Hadean\\Buildings"
            };

            // Keep track of the new file path for JSON.
            string buildingFilePath = $"{Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)}/Building-ODF-Data.json";

            // Check to see if the file exists first and remove it. 
            if (File.Exists(buildingFilePath))
            {
                File.Delete(buildingFilePath);
            }

            // If any files exist, create a JSON file on the user disk.
            var file = File.Create(buildingFilePath);

            // Close the file.
            file.Close();

            List<Dictionary<string, string>> filteredBuildingODFFiles = [];

            foreach (var path in buildingsPath)
            {
                var odfFiles = FileHelper.GetFiles(path, "*.odf");

                if (!odfFiles.Any())
                {
                    break;
                }

                var filteredODFResult = odfFiles.Where(s => buildingInclusions.Any(prefix => s.First().Key.StartsWith(prefix, StringComparison.CurrentCultureIgnoreCase))).ToList();

                if (filteredODFResult == null || filteredODFResult.Count <= 0)
                {
                    Console.WriteLine("Error: Unable to find any ODF files for BZCC to process.");
                    break;
                }

                filteredBuildingODFFiles.AddRange(filteredODFResult);
            }

            if (filteredBuildingODFFiles?.Count > 0)
            {
                // Create a StringBuilder for the JSON Content.
                StringBuilder sb = new();
                sb.Append('{');

                // Run through each ODF file, convert it to JSON, add it to the file.
                for (int i = 0; i < filteredBuildingODFFiles.Count; i++)
                {
                    var odfFile = filteredBuildingODFFiles[i].First();

                    // See if we can open the file from the path that is part of the dictionary.
                    string contents = File.ReadAllText(odfFile.Value);

                    // Test to see if we can convert that to JSON.
                    string jsonContents = FileHelper.GetIniAsJson(odfFile.Key, contents, false, i == filteredBuildingODFFiles.Count - 1, true);

                    // Append the contents to a new line in the StringBuilder.
                    sb.AppendLine(jsonContents);
                }

                sb.Append('}');

                // Append that to the file we just wrote to the disk.
                File.AppendAllText(buildingFilePath, sb.ToString());
            }
        }

        private static void HandleWeaponODFs(string baseGamePath, string vsrModPath, string hadeanModPath)
        {
            // Get Weapons.
            var weaponsPath = new List<string>()
            {
                $"{baseGamePath}\\bz2r_res\\baked\\Scion\\Weapons",
                $"{baseGamePath}\\bz2r_res\\baked\\ISDF\\Weapons",
                $"{baseGamePath}\\bz2r_res\\weapons",
                $"{baseGamePath}\\bz2r_res\\objects\\POWERUPS",
                $"{vsrModPath}\\VSR\\Recycler Variants\\Standard\\Scion\\Weapons",
                $"{vsrModPath}\\VSR\\Recycler Variants\\Standard\\ISDF\\Weapons",
                $"{vsrModPath}\\VSR\\Recycler Variants\\Standard\\Hadean\\Weapons",
                $"{hadeanModPath}\\Hadean\\Weapons"
            };

            // Keep track of the new file path for JSON.
            string weaponFilePath = $"{Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)}/Weapon-ODF-Data.json";

            // Check to see if the file exists first and remove it. 
            if (File.Exists(weaponFilePath))
            {
                File.Delete(weaponFilePath);
            }

            // If any files exist, create a JSON file on the user disk.
            var file = File.Create(weaponFilePath);

            // Close the file.
            file.Close();

            List<Dictionary<string, string>> filteredWeaponODFFiles = [];

            foreach (var path in weaponsPath)
            {
                var odfFiles = FileHelper.GetFiles(path, "*.odf");

                if (!odfFiles.Any())
                {
                    break;
                }

                filteredWeaponODFFiles.AddRange(odfFiles);
            }

            if (filteredWeaponODFFiles?.Count > 0)
            {
                // Create a StringBuilder for the JSON Content.
                StringBuilder sb = new();
                sb.Append('{');

                // Run through each ODF file, convert it to JSON, add it to the file.
                for (int i = 0; i < filteredWeaponODFFiles.Count; i++)
                {
                    var odfFile = filteredWeaponODFFiles[i].First();

                    // See if we can open the file from the path that is part of the dictionary.
                    string contents = File.ReadAllText(odfFile.Value);

                    // Test to see if we can convert that to JSON.
                    string jsonContents = FileHelper.GetIniAsJson(odfFile.Key, contents, false, i == filteredWeaponODFFiles.Count - 1, false);

                    // Append the contents to a new line in the StringBuilder.
                    sb.AppendLine(jsonContents);
                }

                sb.Append('}');

                // Append that to the file we just wrote to the disk.
                File.AppendAllText(weaponFilePath, sb.ToString());
            }
        }

        private static void HandleDataPakODFs(string baseGamePath)
        {
            // Get DataPak.
            var dataPakPath = $"{baseGamePath}\\bz2r_res\\datapak";

            // Keep track of the new file path for JSON.
            string dataPakFilePath = $"{Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)}/DataPak-ODF-Data.json";

            // Check to see if the file exists first and remove it. 
            if (File.Exists(dataPakFilePath))
            {
                File.Delete(dataPakFilePath);
            }

            // If any files exist, create a JSON file on the user disk.
            var file = File.Create(dataPakFilePath);

            // Close the file.
            file.Close();

            var odfFiles = FileHelper.GetFiles(dataPakPath, "*.odf").ToList();

            if (!odfFiles.Any())
            {
                return;
            }

            // Create a StringBuilder for the JSON Content.
            StringBuilder sb = new();
            sb.Append('{');

            // Run through each ODF file, convert it to JSON, add it to the file.
            for (int i = 0; i < odfFiles.Count; i++)
            {
                var odfFile = odfFiles[i].First();

                // See if we can open the file from the path that is part of the dictionary.
                string contents = File.ReadAllText(odfFile.Value);

                // Test to see if we can convert that to JSON.
                string jsonContents = FileHelper.GetIniAsJson(odfFile.Key, contents, false, i == odfFiles.Count - 1, true);

                // Append the contents to a new line in the StringBuilder.
                sb.AppendLine(jsonContents);
            }

            sb.Append('}');

            // Append that to the file we just wrote to the disk.
            File.AppendAllText(dataPakFilePath, sb.ToString());
        }

        private static void HandlePilotODFs(string baseGamePath, string vsrModPath, string hadeanModPath)
        {
            // Filter for the files that we need for relevance.
            string[] pilotInclusions = ["fs", "is", "es", "cs"];

            // Get Vehicles.
            var pilotPaths = new List<string>()
            {
                $"{baseGamePath}\\bz2r_res\\baked\\ISDF\\Pilot",
                $"{baseGamePath}\\bz2r_res\\baked\\Scion\\Pilot",
                $"{baseGamePath}\\bz2r_res\\objects\\ISDF\\people",
                $"{baseGamePath}\\bz2r_res\\objects\\FURY\\people",
                $"{vsrModPath}\\VSR\\Recycler Variants\\Standard",
                $"{hadeanModPath}\\Hadean\\Pilot"
            };

            // Keep track of the new file path for JSON.
            string pilotFilePath = $"{Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)}/Pilot-ODF-Data.json";

            // Check to see if the file exists first and remove it. 
            if (File.Exists(pilotFilePath))
            {
                File.Delete(pilotFilePath);
            }

            // If any files exist, create a JSON file on the user disk.
            var file = File.Create(pilotFilePath);

            // Close the file.
            file.Close();

            List<Dictionary<string, string>> filteredPilotODFFiles = [];

            foreach (var path in pilotPaths)
            {
                var odfFiles = FileHelper.GetFiles(path, "*.odf");

                if (!odfFiles.Any())
                {
                    break;
                }

                var filteredODFResult = odfFiles.Where(s => pilotInclusions.Any(prefix => s.First().Key.StartsWith(prefix, StringComparison.CurrentCultureIgnoreCase))).ToList();

                if (filteredODFResult == null || filteredODFResult.Count <= 0)
                {
                    Console.WriteLine("Error: Unable to find any ODF files for BZCC to process.");
                    break;
                }

                filteredPilotODFFiles.AddRange(filteredODFResult);
            }

            if (filteredPilotODFFiles?.Count > 0)
            {
                // Create a StringBuilder for the JSON Content.
                StringBuilder sb = new();
                sb.Append('{');

                // Run through each ODF file, convert it to JSON, add it to the file.
                for (int i = 0; i < filteredPilotODFFiles.Count; i++)
                {
                    var odfFile = filteredPilotODFFiles[i].First();

                    // See if we can open the file from the path that is part of the dictionary.
                    string contents = File.ReadAllText(odfFile.Value);

                    // Test to see if we can convert that to JSON.
                    string jsonContents = FileHelper.GetIniAsJson(odfFile.Key, contents, false, i == filteredPilotODFFiles.Count - 1, true);

                    // Append the contents to a new line in the StringBuilder.
                    sb.AppendLine(jsonContents);
                }

                sb.Append('}');

                // Append that to the file we just wrote to the disk.
                File.AppendAllText(pilotFilePath, sb.ToString());
            }
        }
    }
}