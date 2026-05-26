using System.Text;
using System.Web;

namespace BZ_ODF_JSON
{
    public static class FileHelper
    {
        public static string JavaScriptEncode(this string text)
        {
            return HttpUtility.JavaScriptStringEncode(text ?? string.Empty);
        }

        public static IEnumerable<Dictionary<string, string>> GetFiles(string root, string spec)
        {
            var pending = new Stack<string>([root]);

            while (pending.Count > 0)
            {
                var path = pending.Pop();
                IEnumerator<string>? fileIter;

                try
                {
                    fileIter = Directory.EnumerateFiles(path, spec, SearchOption.AllDirectories).GetEnumerator();
                }
                catch 
                {
                    throw;
                }

                using (fileIter)
                {
                    while (true)
                    {
                        try
                        {
                            if (!fileIter.MoveNext())
                            {
                                break;
                            }
                        }
                        catch
                        {
                            throw;
                        }

                        var dictionaryResult = new Dictionary<string, string>
                        {
                            { Path.GetFileName(fileIter.Current), fileIter.Current }
                        };

                        yield return dictionaryResult;
                    }
                }
            }
        }

        public static string GetIniAsJson(string fileName, string value, bool preserveComments, bool isLastFile, bool usePrefixFilter)
        {
            StringBuilder json = new();
            string[] lines = value.Split(["\r\n", "\n"], StringSplitOptions.None).Select(line => line.Trim()).ToArray();
            string section = string.Empty;
            int kvpIndex = 0, commentIndex = 0;

            void addComment(string comment, bool eol = false)
            {
                if (!preserveComments)
                {
                    return;
                }

                json.Append($"{(kvpIndex > 0 ? "," : "")}\"@c{++commentIndex}{(eol ? "eol" : "")}\":\"{comment.Trim().JavaScriptEncode()}\"");
                kvpIndex++;
            }

            string removeTrailingComment(string line)
            {
                // Remove any trailing comment from section line
                int index = line.IndexOf(';');

                if (index < 0)
                {
                    index = line.IndexOf("//");
                }

                if (index > -1)
                {
                    addComment(line.Substring(index), true);
                    line = line.Substring(0, index).Trim();
                }

                return line;
            }

            json.Append($"\"{fileName.JavaScriptEncode().ToLower()}\":{{");

            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i];
                
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                string lowerCaseLine = line.ToLower();
                string[] prefixes =
                [
                    "light",
                    "effect",
                    "anim",
                    "render",
                    "ainame",
                    "geometry",
                    "texture",
                    "start",
                    "end",
                    "sound",
                    "finish",
                    "emit",
                    "clear",
                    "lod",
                    "terrain",
                    "info",
                    "collision",
                    "always",
                    "ambeintsound",
                    "justflat",
                    "detect",
                    "trail",
                    "rotationrate",
                    "maxdist",
                    "maxradii",
                    "posroll",
                    "simulatebase",
                    "lifetime",
                    "tunnel",
                    "staywith",
                    "runanim",
                    "panel",
                    "cockpit",
                    "usecollision"
                ];

                // Check if the line starts with key words and don't bother processing them.
                if (usePrefixFilter && prefixes.Any(prefix => lowerCaseLine.StartsWith(prefix)))
                {
                    continue;
                }
                else if (line.StartsWith(';') || line.StartsWith("//") || line.StartsWith("/"))
                {
                    addComment(line);
                }
                else if (line.StartsWith('['))
                {
                    line = removeTrailingComment(line);

                    if (!line.EndsWith(']'))
                    {
                        throw new InvalidOperationException($"ODF section has an invalid format: \"{lines[i]}\"");
                    }

                    if (!string.IsNullOrWhiteSpace(section))
                    {
                        json.Append("},");
                    }
                    else if (commentIndex > 0)
                    {
                        json.Append(',');
                    }

                    section = line[1..^1].Trim();
                    json.Append($"\"{section.JavaScriptEncode()}\":{{");
                    kvpIndex = commentIndex = 0;
                }
                else
                {
                    line = removeTrailingComment(line);

                    string[] kvp = line.Split('=');

                    if (kvp.Length != 2)
                    {
                        Console.WriteLine($"WARNING: {fileName} has an invalid KVP length. Some values in this ODF JSON may be malformed.");
                    }

                    json.Append($"{(kvpIndex > 0 ? "," : "")}\"{kvp[0].Trim().JavaScriptEncode()}\":\"{kvp[1].Trim().JavaScriptEncode()}\"");
                    kvpIndex++;
                }
            }

            if (section is not null)
            {
                json.Append('}');
            }

            if (!isLastFile)
            {
                json.Append("},");
            }
            else
            {
                json.Append('}');
            }

            return json.ToString();
        }
    }
}