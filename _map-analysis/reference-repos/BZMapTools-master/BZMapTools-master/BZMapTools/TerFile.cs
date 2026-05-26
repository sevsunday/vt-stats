using System;

namespace Bz2TerFile;

public record Color24(byte R, byte G, byte B);

[Flags]
public enum CellType : byte
{
    Flat = 0x0,
    Cliff = 0x1,
    Water = 0x2,
    Building = 0x4,
    Lava = 0x8,
    Sloped = 0x10
}

public abstract class TerFileBase
{
    #region Properties
    public abstract int CLUSTER_SIZE { get; }
    public UInt32 Version { get; protected set; }
    public Int16 GridMinX { get; set; }
    public Int16 GridMinZ { get; set; }
    public Int16 GridMaxX { get; set; }
    public Int16 GridMaxZ { get; set; }
    public int Width { get { return GridMaxX - GridMinX; } }
    public int Height { get { return GridMaxZ - GridMinZ; } }
    public Color24[,] ColorMap { get; protected set; }
    public byte[][,] Alpha { get; protected set; }
    public CellType[,] Cell { get; protected set; }
    public UInt32[,] Info { get; protected set; }
    public byte[,] TextureLayer0 { get; protected set; }
    public byte[,] TextureLayer1 { get; protected set; }
    public byte[,] TextureLayer2 { get; protected set; }
    public byte[,] TextureLayer3 { get; protected set; }

    #endregion Properties

    protected TerFileBase(UInt32 version, Int16 gridMinX, Int16 gridMinZ, Int16 gridMaxX, Int16 gridMaxZ)
    {
        this.Version = version;
        this.GridMinX = gridMinX;
        this.GridMinZ = gridMinZ;
        this.GridMaxX = gridMaxX;
        this.GridMaxZ = gridMaxZ;

        ColorMap = new Color24[Height, Width];
        Alpha = new byte[3][,]
        {
            new byte[Height, Width],
            new byte[Height, Width],
            new byte[Height, Width]
        };
        Cell = new CellType[Height, Width];
        Info = new UInt32[Height / CLUSTER_SIZE, Width / CLUSTER_SIZE];
        TextureLayer0 = new byte[Height / CLUSTER_SIZE, Width / CLUSTER_SIZE];
        TextureLayer1 = new byte[Height / CLUSTER_SIZE, Width / CLUSTER_SIZE];
        TextureLayer2 = new byte[Height / CLUSTER_SIZE, Width / CLUSTER_SIZE];
        TextureLayer3 = new byte[Height / CLUSTER_SIZE, Width / CLUSTER_SIZE];
    }

    #region Read Methods
    public static TerFileBase Read(string filePath)//, bool lazy = false)
    {
        return Read(File.OpenRead(filePath));//, lazy);
    }
    public static TerFileBase Read(byte[] data)//, bool lazy = false)
    {
        return Read(new MemoryStream(data));//, lazy);
    }
    public static TerFileBase Read(Stream stream)//, bool lazy = false)
    {
        // TODO lazy not implemented

        using var reader = new BinaryReader(stream);
        if (reader.ReadUInt32() != 0x52524554u) // 'TERR'
            throw new InvalidDataException("Unknown TER file format.");

        UInt32 version = reader.ReadUInt32();
        Int16 gridMinX = reader.ReadInt16();
        Int16 gridMinZ = reader.ReadInt16();
        Int16 gridMaxX = reader.ReadInt16();
        Int16 gridMaxZ = reader.ReadInt16();

        TerFileBase ter;
        if (version < 4)
        {
            ter = new BZ2TerFile(version, gridMinX, gridMinZ, gridMaxX, gridMaxZ);
        }
        else
        {
            ter = new BZCCTerFile(version, gridMinX, gridMinZ, gridMaxX, gridMaxZ);
        }
        ter.ReadData(reader);

        return ter;
    }
    protected void ReadData(BinaryReader reader)
    {
        for (int y = 0; y < Height; y += CLUSTER_SIZE)
        {
            for (int x = 0; x < Width; x += CLUSTER_SIZE)
            {
                ReadClusterTruncateFlags(reader, out bool haveHeight, out bool haveColor, out bool haveAlpha1, out bool haveAlpha2, out bool haveAlpha3, out bool haveCell);
                ReadClusterHeights(reader, x, y, !haveHeight);
                ReadClusterNormals(reader, x, y); // Not in version 4+
                ReadClusterColors(reader, x, y, !haveColor);
                ReadClusterAlpha(reader, x, y, 0, !haveAlpha1);
                ReadClusterAlpha(reader, x, y, 1, !haveAlpha1);
                ReadClusterAlpha(reader, x, y, 2, !haveAlpha2);
                ReadClusterAlpha(reader, x, y, 3, !haveAlpha3);
                ReadClusterTile(reader, x, y);
                ReadClusterCell(reader, x, y, !haveCell);
                ReadClusterInfo(reader, x, y);
                if (Version < 3) reader.ReadBytes(25); // determine what these are for as they're not used in any release version
                if (Version == 2) reader.ReadByte(); // determine what these are for as they're not used in any release version
            }
        }
    }

    protected void ReadClusterTruncateFlags(BinaryReader reader, out bool haveHeight, out bool haveColor, out bool haveAlpha1, out bool haveAlpha2, out bool haveAlpha3, out bool haveCell)
    {
        haveHeight = true;
        haveColor = true;
        haveAlpha1 = true;
        haveAlpha2 = true;
        haveAlpha3 = true;
        haveCell = true;
        if (Version >= 5)
        {
            byte CompressionData = reader.ReadByte();
            haveHeight = (CompressionData & 1) != 0;
            haveColor = (CompressionData & (1 << 1)) != 0;
            haveAlpha1 = (CompressionData & (1 << 2)) != 0;
            haveAlpha2 = (CompressionData & (1 << 3)) != 0;
            haveAlpha3 = (CompressionData & (1 << 4)) != 0;
            haveCell = (CompressionData & (1 << 5)) != 0;
        }
    }
    protected abstract void ReadClusterHeights(BinaryReader reader, int x, int y, bool compressed);
    protected abstract void ReadClusterNormals(BinaryReader reader, int x, int y);
    protected void ReadClusterColors(BinaryReader reader, int x, int y, bool compressed)
    {
        if (compressed)
        {
            byte R = reader.ReadByte();
            byte G = reader.ReadByte();
            byte B = reader.ReadByte();
            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
            {
                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                {
                    ColorMap[y + cy, x + cx] = new Color24(R, G, B);
                }
            }
        }
        else
        {
            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
            {
                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                {
                    byte R = reader.ReadByte();
                    byte G = reader.ReadByte();
                    byte B = reader.ReadByte();

                    ColorMap[y + cy, x + cx] = new Color24(R, G, B);
                }
                if (Version < 3) reader.ReadBytes(3); // 5th vertex (from next cluster)
            }
            if (Version < 3) reader.ReadBytes(15); // 5th row of vertecies (from next cluster)
            // TODO figure out what to do with data outside the map bounds, if we can synthesize it
        }
    }
    protected void ReadClusterAlpha(BinaryReader reader, int x, int y, int layer, bool compressed)
    {
        if (layer == 0)
        {
            if (Version < 3)
                reader.BaseStream.Seek((CLUSTER_SIZE + 1) * (CLUSTER_SIZE + 1), SeekOrigin.Current); // skip all of layer 0 alphas
            return;
        }

        if (compressed)
        {
            byte value = reader.ReadByte();
            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
            {
                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                {
                    Alpha[layer - 1][y + cy, x + cx] = value;
                }
            }
        }
        else
        {
            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
            {
                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                {
                    byte value = reader.ReadByte();
                    Alpha[layer - 1][y + cy, x + cx] = value;
                }
                if (Version < 3) reader.BaseStream.Seek(1, SeekOrigin.Current); // 5th vertex (from next cluster)
            }
            if (Version < 3) reader.BaseStream.Seek(5, SeekOrigin.Current); // 5th row of vertecies (from next cluster)
            // TODO figure out what to do with data outside the map bounds, if we can synthesize it
        }
    }
    protected void ReadClusterTile(BinaryReader reader, int x, int y)
    {
        if (Version >= 3)
            return;

        // this is a legacy data block that was later stored in Info data
        byte t0 = reader.ReadByte();
        byte t1 = reader.ReadByte();
        byte t2 = reader.ReadByte();
        byte t3 = reader.ReadByte();
        Info[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = (UInt32)(t3 << 24 | t2 << 16 | t1 << 8 | t0);
        TextureLayer0[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = t0;
        TextureLayer1[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = t1;
        TextureLayer2[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = t2;
        TextureLayer3[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = t3;
    }
    protected void ReadClusterCell(BinaryReader reader, int x, int y, bool compressed)
    {
        if (Version < 3)
        {
            if (Version > 0)
                reader.BaseStream.Seek((CLUSTER_SIZE + 1) * (CLUSTER_SIZE + 1), SeekOrigin.Current); // Skip "cluster cell values"
            if (Version > 1)
                reader.BaseStream.Seek(1, SeekOrigin.Current); // Skip "cluster build value"
            return;
        }

        if (compressed)
        {
            byte value = reader.ReadByte();
            CellType cellType = (CellType)value;
            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
            {
                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                {
                    Cell[y + cy, x + cx] = cellType;
                }
            }
        }
        else
        {
            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
            {
                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                {
                    byte value = reader.ReadByte();
                    CellType cellType = (CellType)value;
                    Cell[y + cy, x + cx] = cellType;
                }
                if (Version < 3) reader.BaseStream.Seek(1, SeekOrigin.Current); // 5th vertex (from next cluster)
            }
            if (Version < 3) reader.BaseStream.Seek(5, SeekOrigin.Current); // 5th row of vertecies (from next cluster)
            // TODO figure out what to do with data outside the map bounds, if we can synthesize it
        }
    }
    protected void ReadClusterInfo(BinaryReader reader, int x, int y)
    {
        if (Version < 3)
        {
            // cluster info is stored entirely differently in version 0-2 and is actually before the cell data
            return;
        }

        UInt32 value = reader.ReadUInt32();
        Info[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = value;
        TextureLayer0[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = (byte)(value & 0xF);
        TextureLayer1[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = (byte)((value >> 4) & 0xF);
        TextureLayer2[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = (byte)((value >> 8) & 0xF);
        TextureLayer3[y / CLUSTER_SIZE, x / CLUSTER_SIZE] = (byte)((value >> 12) & 0xF);
    }
    #endregion Read Methods
}

public class BZ2TerFile : TerFileBase
{
    #region Properties
    public override int CLUSTER_SIZE => 4;
    public Int16[,] HeightMap { get; protected set; }
    public byte[,] NormalMap { get; protected set; }
    #endregion Properties

    public BZ2TerFile(UInt32 version, Int16 gridMinX, Int16 gridMinZ, Int16 gridMaxX, Int16 gridMaxZ) : base(version, gridMinX, gridMinZ, gridMaxX, gridMaxZ)
    {
        HeightMap = new Int16[Height, Width];
        NormalMap = new byte[Height, Width];
    }

    protected override void ReadClusterHeights(BinaryReader reader, int x, int y, bool compressed)
    {
        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
        {
            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
            {
                short value = reader.ReadInt16();
                HeightMap[y + cy, x + cx] = value;
            }
            if (Version < 3) reader.ReadInt16(); // 5th vertex (from next cluster)
        }
        if (Version < 3) reader.ReadBytes(10); // 5th row of vertecies (from next cluster)
        // TODO figure out what to do with data outside the map bounds, if we can synthesize it
    }
    protected override void ReadClusterNormals(BinaryReader reader, int x, int y)
    {
        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
        {
            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
            {
                byte value = reader.ReadByte();
                NormalMap[y + cy, x + cx] = value;
            }
            if (Version < 3) reader.BaseStream.Seek(1, SeekOrigin.Current); // 5th vertex (from next cluster)
        }
        if (Version < 3) reader.BaseStream.Seek(5, SeekOrigin.Current); // 5th row of vertecies (from next cluster)
        // TODO figure out what to do with data outside the map bounds, if we can synthesize it
    }
}

public class BZCCTerFile : TerFileBase
{
    #region Properties
    public override int CLUSTER_SIZE => 16;
    public float[,] HeightMap { get; protected set; }
    #endregion Properties

    public BZCCTerFile(UInt32 version, Int16 gridMinX, Int16 gridMinZ, Int16 gridMaxX, Int16 gridMaxZ) : base(version, gridMinX, gridMinZ, gridMaxX, gridMaxZ)
    {
        HeightMap = new float[Height, Width];
    }

    protected override void ReadClusterHeights(BinaryReader reader, int x, int y, bool compressed)
    {
        if (compressed)
        {
            float value = reader.ReadSingle();
            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
            {
                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                {
                    HeightMap[y + cy, x + cx] = value;
                }
            }
        }
        else
        {
            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
            {
                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                {
                    float value = reader.ReadSingle();
                    HeightMap[y + cy, x + cx] = value;
                }
            }
        }
    }
    protected override void ReadClusterNormals(BinaryReader reader, int x, int y) { }
}
