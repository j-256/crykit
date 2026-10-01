using System.Reflection;
using System.Runtime.Loader;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;

const int MaxBytes = 32 * 1024 * 1024;
const int MaxEntries = 100_000;
if (args.Length != 3) throw new ArgumentException("Expected installation, copied assembly, output");
var installation = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context, name) => {
    var dependency = Path.Combine(installation, name.Name + ".dll");
    return File.Exists(dependency) ? context.LoadFromAssemblyPath(dependency) : null;
};
var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.GetFullPath(args[1]));
var entityType = assembly.GetType("Sang.SangEntity.SangEntityData", true)!;
var deserialize = assembly.GetType("Sang.SangEntity.EntitySerializer", true)!.GetMethods(BindingFlags.Public | BindingFlags.Static)
    .Single(method => method.GetParameters()[1].ParameterType.GetElementType() == entityType);
object? ProjectFields(object? value) {
    if (value == null) return null;
    var type = value.GetType();
    if (type.IsEnum) return value.ToString();
    if (type.IsPrimitive || value is string) return value;
    if (value is System.Collections.IEnumerable items) return items.Cast<object?>().Select(ProjectFields).ToArray();
    return type.GetFields(BindingFlags.Public | BindingFlags.Instance).ToDictionary(field => field.Name, field => ProjectFields(field.GetValue(value)));
}
int Count(BinaryReader reader, int limit = MaxEntries) {
    var count = reader.ReadInt32();
    if (count < 0 || count > limit) throw new InvalidDataException("Invalid count or length");
    return count;
}
byte[] Exact(BinaryReader reader, int count) {
    var result = reader.ReadBytes(count);
    if (result.Length != count) throw new InvalidDataException("Truncated world data");
    return result;
}
byte[] Expand(ZipArchiveEntry entry) {
    if (entry.Length > MaxBytes) throw new InvalidDataException("Expanded entry exceeds size limit");
    using var reader = new BinaryReader(entry.Open());
    var result = Exact(reader, checked((int)entry.Length));
    if (reader.ReadBytes(1).Length != 0) throw new InvalidDataException("Unexpected entry length");
    return result;
}
var path = Path.Combine(installation, "Content", "Worlds", "field.dat");
var bytes = File.ReadAllBytes(path);
if (bytes.Length < 2 || bytes.Length > MaxBytes || bytes[0] != 5 || bytes[1] != 0) throw new InvalidDataException("Incompatible world header");
using var world = new ZipArchive(new MemoryStream(bytes, 2, bytes.Length - 2), ZipArchiveMode.Read);
using var br = new BinaryReader(new MemoryStream(Expand(world.GetEntry("field.dat") ?? throw new InvalidDataException("Missing field entry"))));
Exact(br, Count(br, MaxBytes));
var ledgerText = System.Text.Encoding.UTF8.GetString(Exact(br, Count(br, MaxBytes))).TrimStart('\uFEFF');
var ledger = new Dictionary<int, string>();
foreach (var line in ledgerText.Split('\n', StringSplitOptions.RemoveEmptyEntries)) {
    var parts = line.Trim().TrimEnd(';').Split(':');
    if (parts.Length != 3 || !int.TryParse(parts[0], out var id) || !ledger.TryAdd(id, parts[1])) throw new InvalidDataException("Invalid or duplicate ledger ID");
}
var regions = new List<(int X, int Z, int Offset, int Length)>();
var regionKeys = new HashSet<(int, int)>();
var regionCount = Count(br);
for (int i = 0; i < regionCount; i++) {
    var region = (X: br.ReadInt32(), Z: br.ReadInt32(), Offset: br.ReadInt32(), Length: br.ReadInt32());
    if (!regionKeys.Add((region.X, region.Z))) throw new InvalidDataException("Duplicate region");
    regions.Add(region);
}
br.ReadInt32();
var data = Exact(br, Count(br, MaxBytes));
if (br.BaseStream.Position != br.BaseStream.Length) throw new InvalidDataException("Trailing world bytes");
var records = new List<JsonObject>();
var ids = new HashSet<int>();
foreach (var region in regions) {
    if (region.Offset < 0 || region.Length < 0 || (long)region.Offset + region.Length > data.Length) throw new InvalidDataException("Region outside world data");
    using var zip = new ZipArchive(new MemoryStream(data, region.Offset, region.Length), ZipArchiveMode.Read);
    var names = new HashSet<string>();
    foreach (var entry in zip.Entries) {
        if (!names.Add(entry.FullName)) throw new InvalidDataException("Duplicate ZIP entry");
        if (!entry.Name.EndsWith("e.dat", StringComparison.Ordinal)) continue;
        using var reader = new BinaryReader(new MemoryStream(Expand(entry)));
        if (reader.ReadByte() != 0) throw new InvalidDataException("Incompatible entity header");
        var count = Count(reader);
        for (int i = 0; i < count; i++) {
            object?[] invokeArgs = { reader, Activator.CreateInstance(entityType, true) };
            deserialize.Invoke(null, invokeArgs);
            var entity = JsonSerializer.SerializeToNode(ProjectFields(invokeArgs[1]))!.AsObject();
            var id = entity["ID"]!.GetValue<int>();
            var coord = entity["Coord"]!.AsObject();
            var coordKey = string.Join(",", new[] { "X", "Y", "Z" }.Select(key => coord[key]!.GetValue<int>()));
            if (!ids.Add(id) || !ledger.TryGetValue(id, out var expected) || expected != coordKey) throw new InvalidDataException("Entity ID or coordinates differ from ledger");
            var type = entity["EntityType"]!.GetValue<string>();
            var record = new JsonObject { ["ID"] = id, ["EntityType"] = type, ["BiomeID"] = entity["BiomeID"]!.DeepClone(), ["Coord"] = coord.DeepClone() };
            string? name = null; string? source = null;
            void Copy(string target, JsonNode? value) => record[target] = value?.DeepClone();
            switch (type) {
                case "Npc":
                    var npc = entity["NpcData"]!; var outfits = npc["Outfits"]!.AsArray();
                    Copy("NpcKey", npc["Key"]); Copy("NpcLinkedKey", npc["LinkedKey"]);
                    record["NpcOutfitNames"] = new JsonArray(outfits.Select(outfit => outfit!["Name"]?.DeepClone()).ToArray());
                    record["NpcOutfitTextureKeys"] = new JsonArray(outfits.Select(outfit => outfit!["TextureKey"]?.DeepClone()).ToArray());
                    if (!string.IsNullOrEmpty(npc["Key"]?.GetValue<string>())) { name = npc["Key"]!.GetValue<string>(); source = "NpcData.Key"; }
                    else if (outfits.Count > 0 && !string.IsNullOrEmpty(outfits[0]!["Name"]?.GetValue<string>())) { name = outfits[0]!["Name"]!.GetValue<string>(); source = "NpcData.Outfits[0].Name"; }
                    break;
                case "HomePoint": name = entity["HomePointData"]!["Name"]?.GetValue<string>(); source = "HomePointData.Name"; break;
                case "Marker": name = entity["MarkerData"]!["Key"]?.GetValue<string>(); source = "MarkerData.Key"; break;
                case "Sign": name = entity["SignData"]!["Title"]?.GetValue<string>(); source = "SignData.Title"; break;
                case "Crystal": Copy("JobID", entity["CrystalData"]!["JobID"]); break;
                case "Spark":
                    Copy("SparkID", entity["SparkData"]!["SparkID"]);
                    record["TroopIDs"] = new JsonArray(entity["SparkData"]!["TroopPages"]!.AsArray().Select(page => page!["TroopID"]?.DeepClone()).ToArray()); break;
                case "Treasure": Copy("LootType", entity["TreasureData"]!["LootType"]); Copy("LootValue", entity["TreasureData"]!["LootValue"]); break;
                case "Door": Copy("DoorType", entity["DoorData"]!["DoorType"]); Copy("RequiredItemID", entity["DoorData"]!["RequiredItemID"]); break;
                default: throw new InvalidDataException("Unknown entity type");
            }
            record["Name"] = string.IsNullOrEmpty(name) ? type : name;
            record["NameSource"] = string.IsNullOrEmpty(name) ? "EntityType" : source;
            records.Add(record);
        }
        if (reader.BaseStream.Position != reader.BaseStream.Length) throw new InvalidDataException("Trailing entity bytes");
    }
}
if (ids.Count != ledger.Count) throw new InvalidDataException("Entity coverage differs from ledger");
File.WriteAllText(args[2], JsonSerializer.Serialize(records.OrderBy(record => record["ID"]!.GetValue<int>())));
