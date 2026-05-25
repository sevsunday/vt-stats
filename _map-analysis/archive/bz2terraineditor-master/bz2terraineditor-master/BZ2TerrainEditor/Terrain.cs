using System;
using System.IO;

namespace BZ2TerrainEditor
{
	/// <summary>
	/// Represents a BattleZone II terrain.
	/// </summary>
	public class Terrain
	{
        public readonly int CLUSTER_SIZE;

        #region Fields

        public Int16 GridMinX;
        public Int16 GridMinZ;
        public Int16 GridMaxX;
        public Int16 GridMaxZ;

        public int Width => GridMaxX - GridMinX;
        public int Height => GridMaxZ - GridMinZ;

        public readonly UInt32 Version;

        /// <summary>
        /// The width of the terrain.
        /// </summary>
        //public readonly int Width;
        /// <summary>
        /// The height of the terrain.
        /// </summary>
        //public readonly int Height;

        /// <summary>
        /// The height map.
        /// </summary>
        public readonly short[,] HeightMap;
        public readonly float[,] HeightMapFloat;

        /// <summary>
        /// The RGB color map.
        /// </summary>
        public readonly RGB[,] ColorMap;

		/// <summary>
		/// The normal map.
		/// </summary>
		public readonly byte[,] NormalMap;

		/// <summary>
		/// The alpha map for layer 1.
		/// </summary>
		public readonly byte[,] AlphaMap1;

		/// <summary>
		/// The alpha map for layer 2.
		/// </summary>
		public readonly byte[,] AlphaMap2;

		/// <summary>
		/// The alpha map for layer 3.
		/// </summary>
		public readonly byte[,] AlphaMap3;

		/// <summary>
		/// The cliff map?
		/// </summary>
		public readonly CellType[,] CellMap;

		/// <summary>
		/// Cluster info.
		/// Bits 0-3:   Tile index for layer 0.
		/// Bits 4-7:   Tile index for layer 1.
		/// Bits 8-11:  Tile index for layer 2.
		/// Bits 12-15: Tile index for layer 3.
		/// Bit 16:     Cluster Visibility for layer 0.
		/// Bit 17:     Cluster Visibility for layer 1.
		/// Bit 18:     Cluster Visibility for layer 2.
		/// Bit 19:     Cluster Visibility for layer 3.
		/// Bits 20-23: Cluster owner team.
		/// Bits 24-25: Cluster build type.
		/// </summary>
		public readonly uint[,] InfoMap;

        private short heightMapMin;
        private short heightMapMax;

        private Single heightMapFloatMin;
        private Single heightMapFloatMax;

        #endregion

        #region Properties

        public short HeightMapMin
		{
			get { return this.heightMapMin; }	
		}

		public short HeightMapMax
		{
			get { return this.heightMapMax; }
		}

        public Single HeightMapFloatMin
        {
            get { return this.heightMapFloatMin; }
        }

        public Single HeightMapFloatMax
        {
            get { return this.heightMapFloatMax; }
        }

        #endregion

        #region Constructors

        /// <summary>
        /// Creates a new Terrain.
        /// </summary>
        public Terrain(UInt32 version, Int16 gridMinX, Int16 gridMinZ, Int16 gridMaxX, Int16 gridMaxZ)
		{
            this.Version = version;

            if (version < 4) CLUSTER_SIZE = 4;
            if (version >= 4) CLUSTER_SIZE = 16;

            int width = gridMaxX - gridMinX;
            int height = gridMaxZ - gridMinZ;
            
            if (width % CLUSTER_SIZE != 0) throw new ArgumentException($"Width must be a multiple of {CLUSTER_SIZE}.", "width");
            if (height % CLUSTER_SIZE != 0) throw new ArgumentException($"Height must be a multiple of {CLUSTER_SIZE}.", "height");

            this.GridMinX = gridMinX;
            this.GridMinZ = gridMinZ;
            this.GridMaxX = gridMaxX;
            this.GridMaxZ = gridMaxZ;
            if (Version < 4)
            {
                this.HeightMap = new short[width, height];
            }
            else
            {
                this.HeightMapFloat = new Single[width, height];
            }
            this.ColorMap = new RGB[width, height];
			this.NormalMap = new byte[width, height];
			this.AlphaMap1 = new byte[width, height];
			this.AlphaMap2 = new byte[width, height];
			this.AlphaMap3 = new byte[width, height];
			this.CellMap = new CellType[width, height];
			this.InfoMap = new uint[width / CLUSTER_SIZE, height / CLUSTER_SIZE];

			this.Clear();

			this.heightMapMin = short.MaxValue;
			this.heightMapMax = short.MinValue;
            this.heightMapFloatMin = float.MaxValue;
            this.heightMapFloatMax = float.MinValue;

        }

		#endregion

		#region Methods

		/// <summary>
		/// Updates the min/max values.
		/// </summary>
		public void UpdateMinMax()
		{
            this.heightMapMin = short.MaxValue;
            this.heightMapMax = short.MinValue;
            this.heightMapFloatMin = float.MaxValue;
            this.heightMapFloatMax = float.MinValue;
            if (Version < 4)
            {
                for (int y = 0; y < this.Height; y++)
                {
                    for (int x = 0; x < this.Width; x++)
                    {
                        if (this.HeightMap[x, y] < this.heightMapMin) this.heightMapMin = this.HeightMap[x, y];
                        if (this.HeightMap[x, y] > this.heightMapMax) this.heightMapMax = this.HeightMap[x, y];
                    }
                }
            }
            else
            {
                for (int y = 0; y < this.Height; y++)
                {
                    for (int x = 0; x < this.Width; x++)
                    {
                        if (this.HeightMapFloat[x, y] < this.heightMapFloatMin) this.heightMapFloatMin = this.HeightMapFloat[x, y];
                        if (this.HeightMapFloat[x, y] > this.heightMapFloatMax) this.heightMapFloatMax = this.HeightMapFloat[x, y];
                    }
                }
            }
		}

		/// <summary>
		/// Writes the terrain to the specified file.
		/// </summary>
		/// <param name="fileName">The name of the file.</param>
		public void Write(string fileName)
		{
			Stream stream = File.Create(fileName);
			this.Write(stream);
			stream.Close();
		}
		
		/// <summary>
		/// Writes the terrain to the specified stream.
		/// </summary>
		/// <param name="stream">The destination stream.</param>
		public void Write(Stream stream)
		{
			BinaryWriter writer = new BinaryWriter(stream);

            if (Version > 0)
            {
                writer.Write(0x52524554u); // 'TERR'
                if (Version < 4)
                {
                    writer.Write(0x00000003u); // version
                }
                else
                {
                    writer.Write(Version); // version
                }
                writer.Write(GridMinX);
                writer.Write(GridMinZ);
                writer.Write(GridMaxX);
                writer.Write(GridMaxZ);
            }

			for (int y = 0; y < this.Height; y += CLUSTER_SIZE)
			{
				for (int x = 0; x < this.Width; x += CLUSTER_SIZE)
				{
                    bool haveHeight = true;
                    bool haveColor = true;
                    bool haveAlpha1 = true;
                    bool haveAlpha2 = true;
                    bool haveAlpha3 = true;
                    bool haveCell = true;

                    if (Version >= 5)
                    {
                        haveHeight = false;
                        haveColor = false;
                        haveAlpha1 = false;
                        haveAlpha2 = false;
                        haveAlpha3 = false;
                        haveCell = false;

                        float height = this.HeightMapFloat[x, y];
                        RGB color = this.ColorMap[x, y];
                        byte alpha1 = this.AlphaMap1[x, y];
                        byte alpha2 = this.AlphaMap2[x, y];
                        byte alpha3 = this.AlphaMap3[x, y];
                        CellType cell = this.CellMap[x, y];

                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            if (!haveHeight)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    if (height != this.HeightMapFloat[x + cx, y + cy])
                                    {
                                        haveHeight = true;
                                        break;
                                    }
                                }
                            }
                        }

                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            if (!haveColor)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    if (color.R != this.ColorMap[x + cx, y + cy].R ||
                                        color.G != this.ColorMap[x + cx, y + cy].G ||
                                        color.B != this.ColorMap[x + cx, y + cy].B)
                                    {
                                        haveColor = true;
                                        break;
                                    }
                                }
                            }
                        }

                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            if (!haveAlpha1)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    if (alpha1 != this.AlphaMap1[x + cx, y + cy])
                                    {
                                        haveAlpha1 = true;
                                        break;
                                    }
                                }
                            }
                        }

                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            if (!haveAlpha2)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    if (alpha2 != this.AlphaMap2[x + cx, y + cy])
                                    {
                                        haveAlpha2 = true;
                                        break;
                                    }
                                }
                            }
                        }

                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            if (!haveAlpha3)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    if (alpha3 != this.AlphaMap3[x + cx, y + cy])
                                    {
                                        haveAlpha3 = true;
                                        break;
                                    }
                                }
                            }
                        }

                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            if (!haveCell)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    if (cell != this.CellMap[x + cx, y + cy])
                                    {
                                        haveCell = true;
                                        break;
                                    }
                                }
                            }
                        }

                        byte Compression = 0;
                        if (haveHeight) Compression += 1;
                        if (haveColor) Compression += (1 << 1);
                        if (haveAlpha1) Compression += (1 << 2);
                        if (haveAlpha2) Compression += (1 << 3);
                        if (haveAlpha3) Compression += (1 << 4);
                        if (haveCell) Compression += (1 << 5);
                        writer.Write(Compression);
                    }

                    if (Version < 3)
                    {
                        for (int cy = 0; cy < (CLUSTER_SIZE + 1); cy++)
                        {
                            for (int cx = 0; cx < (CLUSTER_SIZE + 1); cx++)
                            {
                                int _cx = cx;
                                int _cy = cy;
                                if ((x + cx) == this.Width) _cx--;
                                if ((x + cy) == this.Width) _cy--;
                                writer.Write(this.HeightMap[x + _cx, y + _cy]);
                            }
                        }
                    }
                    else if (Version < 4)
                    {
                        // height map
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                writer.Write(this.HeightMap[x + cx, y + cy]);
                            }
                        }
                    }
                    else
                    {
                        // height map
                        if (haveHeight)
                        {
                            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    writer.Write(this.HeightMapFloat[x + cx, y + cy]);
                                }
                            }
                        }
                        else
                        {
                            writer.Write(this.HeightMapFloat[x, y]);
                        }
                    }

                    if (Version < 3)
                    {
                        for (int cy = 0; cy < (CLUSTER_SIZE + 1); cy++)
                        {
                            for (int cx = 0; cx < (CLUSTER_SIZE + 1); cx++)
                            {
                                int _cx = cx;
                                int _cy = cy;
                                if ((x + cx) == this.Width) _cx--;
                                if ((x + cy) == this.Width) _cy--;
                                writer.Write(this.NormalMap[x + _cx, y + _cy]);
                            }
                        }
                    }
                    else if (Version < 4)
                    {
                        // normal map
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                writer.Write(this.NormalMap[x + cx, y + cy]);
                            }
                        }
                    }

                    // color map
                    if (Version < 3)
                    {
                        for (int cy = 0; cy < (CLUSTER_SIZE + 1); cy++)
                        {
                            for (int cx = 0; cx < (CLUSTER_SIZE + 1); cx++)
                            {
                                int _cx = cx;
                                int _cy = cy;
                                if ((x + cx) == this.Width) _cx--;
                                if ((x + cy) == this.Width) _cy--;
                                writer.Write(this.ColorMap[x + _cx, y + _cy].R);
                                writer.Write(this.ColorMap[x + _cx, y + _cy].G);
                                writer.Write(this.ColorMap[x + _cx, y + _cy].B);
                            }
                        }
                    }
                    else //if (Version < 4)
                    {
                        if (haveColor)
                        {
                            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    writer.Write(this.ColorMap[x + cx, y + cy].R);
                                    writer.Write(this.ColorMap[x + cx, y + cy].G);
                                    writer.Write(this.ColorMap[x + cx, y + cy].B);
                                }
                            }
                        }
                        else
                        {
                            writer.Write(this.ColorMap[x, y].R);
                            writer.Write(this.ColorMap[x, y].G);
                            writer.Write(this.ColorMap[x, y].B);
                        }
                    }

                    // alpha map 1
                    if (Version < 3)
                    {
                        for (int cy = 0; cy < (CLUSTER_SIZE + 1); cy++)
                        {
                            for (int cx = 0; cx < (CLUSTER_SIZE + 1); cx++)
                            {
                                int _cx = cx;
                                int _cy = cy;
                                if ((x + cx) == this.Width) _cx--;
                                if ((x + cy) == this.Width) _cy--;
                                writer.Write(this.AlphaMap1[x + _cx, y + _cy]);
                            }
                        }
                    }
                    else //if (Version < 4)
                    {
                        if (haveAlpha1)
                        {
                            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    writer.Write(this.AlphaMap1[x + cx, y + cy]);
                                }
                            }
                        }
                        else
                        {
                            writer.Write(this.AlphaMap1[x, y]);
                        }
                    }

                    // alpha map 2
                    if (Version < 3)
                    {
                        for (int cy = 0; cy < (CLUSTER_SIZE + 1); cy++)
                        {
                            for (int cx = 0; cx < (CLUSTER_SIZE + 1); cx++)
                            {
                                int _cx = cx;
                                int _cy = cy;
                                if ((x + cx) == this.Width) _cx--;
                                if ((x + cy) == this.Width) _cy--;
                                writer.Write(this.AlphaMap2[x + _cx, y + _cy]);
                            }
                        }
                    }
                    else //if (Version < 4)
                    {
                        if (haveAlpha2)
                        {
                            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    writer.Write(this.AlphaMap2[x + cx, y + cy]);
                                }
                            }
                        }
                        else
                        {
                            writer.Write(this.AlphaMap2[x, y]);
                        }
                    }

                    // alpha map 3
                    if (Version < 3)
                    {
                        for (int cy = 0; cy < (CLUSTER_SIZE + 1); cy++)
                        {
                            for (int cx = 0; cx < (CLUSTER_SIZE + 1); cx++)
                            {
                                int _cx = cx;
                                int _cy = cy;
                                if ((x + cx) == this.Width) _cx--;
                                if ((x + cy) == this.Width) _cy--;
                                writer.Write(this.AlphaMap3[x + _cx, y + _cy]);
                            }
                        }
                    }
                    else //if (Version < 4)
                    {
                        if (haveAlpha3)
                        {
                            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    writer.Write(this.AlphaMap3[x + cx, y + cy]);
                                }
                            }
                        }
                        else
                        {
                            writer.Write(this.AlphaMap3[x, y]);
                        }
                    }

                    // cliff map
                    if (Version < 3)
                    {
                        for (int cy = 0; cy < (CLUSTER_SIZE + 1); cy++)
                        {
                            for (int cx = 0; cx < (CLUSTER_SIZE + 1); cx++)
                            {
                                int _cx = cx;
                                int _cy = cy;
                                if ((x + cx) == this.Width) _cx--;
                                if ((x + cy) == this.Width) _cy--;
                                writer.Write((byte)this.CellMap[x + _cx, y + _cy]);
                            }
                        }
                    }
                    else //if (Version < 4)
                    {
                        if (haveCell)
                        {
                            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    writer.Write((byte)this.CellMap[x + cx, y + cy]);
                                }
                            }
                        }
                        else
                        {
                            writer.Write((byte)this.CellMap[x, y]);
                        }
                    }

					// info map
					writer.Write(this.InfoMap[x / CLUSTER_SIZE, y / CLUSTER_SIZE]);

                    // ???
                    if (Version > 0)
                    {
                        if (Version < 3) for (int i = 0; i < 25; i++) writer.Write(0x00);
                        if (Version == 2) writer.Write(0x00);
                    }
                }
			}
		}

		/// <summary>
		/// Clears the terrain.
		/// </summary>
		public void Clear()
		{
			for (int y = 0; y < this.Height; y++)
			{
				for (int x = 0; x < this.Width; x++)
				{
                    if (this.Version < 4)
                    {
                        this.HeightMap[x, y] = 0;
                    }
                    else
                    {
                        this.HeightMapFloat[x, y] = 0f;
                    }
					this.NormalMap[x, y] = 0;
					this.ColorMap[x, y].R = this.ColorMap[x, y].G = this.ColorMap[x, y].B = 255;
					this.AlphaMap1[x, y] = this.AlphaMap2[x, y] = this.AlphaMap3[x, y] = 0;
					this.CellMap[x, y] = 0;
				}	
			}

			for (int y = 0; y < this.Height / CLUSTER_SIZE; y++)
			{
				for (int x = 0; x < this.Width / CLUSTER_SIZE; x++)
				{
					this.InfoMap[x, y] = 0;
				}
			}
		}

		/// <summary>
		/// Reads a terrain from the specified file.
		/// </summary>
		/// <param name="fileName">The name of the file.</param>
		/// <returns></returns>
		public static Terrain Read(string fileName)
		{
			Stream stream = File.OpenRead(fileName);
			try
			{
				Terrain terrain = Read(stream);
				return terrain;
			}
			finally
			{
				stream.Close();
			}
		}

		/// <summary>
		/// Reads a terrain from a stream.
		/// </summary>
		/// <param name="stream">The data stream.</param>
		/// <returns></returns>
		public static Terrain Read(Stream stream)
        {
            int CLUSTER_SIZE = 4;

            BinaryReader reader = new BinaryReader(stream);

            bool version0 = false;

            if (reader.ReadUInt32() != 0x52524554u) // 'TERR'
            {
                reader.BaseStream.Seek(0, SeekOrigin.Begin);
                version0 = true;
                //throw new Exception("Invalid magic number.");
            }

            UInt32 version = 0;
            if (!version0) version = reader.ReadUInt32();

			if(version < 0 || version > 5)
				throw new NotSupportedException(string.Format("Version {0} is not supported.", version));

            if (version >= 4) CLUSTER_SIZE = 16;

            Int16 gridMinX = 0;
            Int16 gridMinZ = 0;
            Int16 gridMaxX = 0;
            Int16 gridMaxZ = 0;

            if (version > 0)
            {
                gridMinX = reader.ReadInt16();
                gridMinZ = reader.ReadInt16();
                gridMaxX = reader.ReadInt16();
                gridMaxZ = reader.ReadInt16();
            }
            else
            {
                long ClusterCount = (stream.Length / 0xfd);
                ClusterCount = (long)Math.Sqrt(ClusterCount);

                gridMinX = (Int16)(-ClusterCount / 2);
                gridMinZ = (Int16)(-ClusterCount / 2);
                gridMaxX = (Int16)(ClusterCount / 2);
                gridMaxZ = (Int16)(ClusterCount / 2);
            }

            int width = gridMaxX - gridMinX;
            int height = gridMaxZ - gridMinZ;

            Terrain terrain = new Terrain(version, gridMinX, gridMinZ, gridMaxX, gridMaxZ);

            for (int y = 0; y < height; y += CLUSTER_SIZE)
			{
				for (int x = 0; x < width; x += CLUSTER_SIZE)
				{
                    bool haveHeight = true;
                    bool haveColor = true;
                    bool haveAlpha1 = true;
                    bool haveAlpha2 = true;
                    bool haveAlpha3 = true;
                    bool haveCell = true;

                    if (version >= 5)
                    {
                        byte CompressionData = reader.ReadByte();
                        haveHeight = (CompressionData & 1) != 0;
                        haveColor = (CompressionData & (1 << 1)) != 0;
                        haveAlpha1 = (CompressionData & (1 << 2)) != 0;
                        haveAlpha2 = (CompressionData & (1 << 3)) != 0;
                        haveAlpha3 = (CompressionData & (1 << 4)) != 0;
                        haveCell = (CompressionData & (1 << 5)) != 0;
                    }

                    // height map
                    if (version < 4)
                    {
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                short value = reader.ReadInt16();
                                terrain.HeightMap[x + cx, y + cy] = value;
                                if (value < terrain.heightMapMin) terrain.heightMapMin = value;
                                if (value > terrain.heightMapMax) terrain.heightMapMax = value;
                            }
                            if (version < 3) reader.ReadInt16(); // 5th vertex (from next cluster)
                        }
                        if (version < 3) reader.ReadBytes(10); // 5th row of vertecies (from next cluster)
                    }
                    else
                    {
                        if (haveHeight)
                        {
                            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    Single value = reader.ReadSingle();
                                    terrain.HeightMapFloat[x + cx, y + cy] = value;
                                    if (value < terrain.heightMapFloatMin) terrain.heightMapFloatMin = value;
                                    if (value > terrain.heightMapFloatMax) terrain.heightMapFloatMax = value;
                                }
                            }
                        }
                        else
                        {
                            Single value = reader.ReadSingle();
                            for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                            {
                                for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                                {
                                    terrain.HeightMapFloat[x + cx, y + cy] = value;
                                }
                            }
                            if (value < terrain.heightMapFloatMin) terrain.heightMapFloatMin = value;
                            if (value > terrain.heightMapFloatMax) terrain.heightMapFloatMax = value;
                        }
                    }

                    // normal map
                    if (version < 4)
                    {
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                byte value = reader.ReadByte();
                                terrain.NormalMap[x + cx, y + cy] = value;
                            }
                            if (version < 3) reader.ReadByte(); // 5th vertex (from next cluster)
                        }
                        if (version < 3) reader.ReadBytes(5); // 5th row of vertecies (from next cluster)
                    }

                    // color map
                    if (haveColor)
                    {
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                byte R = reader.ReadByte();
                                byte G = reader.ReadByte();
                                byte B = reader.ReadByte();

                                terrain.ColorMap[x + cx, y + cy].R = R;
                                terrain.ColorMap[x + cx, y + cy].G = G;
                                terrain.ColorMap[x + cx, y + cy].B = B;
                            }
                            if (version < 3) reader.ReadBytes(3); // 5th vertex (from next cluster)
                        }
                        if (version < 3) reader.ReadBytes(15); // 5th row of vertecies (from next cluster)
                    }
                    else
                    {
                        byte R = reader.ReadByte();
                        byte G = reader.ReadByte();
                        byte B = reader.ReadByte();
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                terrain.ColorMap[x + cx, y + cy].R = R;
                                terrain.ColorMap[x + cx, y + cy].G = G;
                                terrain.ColorMap[x + cx, y + cy].B = B;
                            }
                        }
                    }

                    // alpha map 1
                    if (haveAlpha1)
                    {
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                byte value = reader.ReadByte();
                                terrain.AlphaMap1[x + cx, y + cy] = value;
                            }
                            if (version < 3) reader.ReadByte(); // 5th vertex (from next cluster)
                        }
                        if (version < 3) reader.ReadBytes(5); // 5th row of vertecies (from next cluster)
                    }
                    else
                    {
                        byte value = reader.ReadByte();
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                terrain.AlphaMap1[x + cx, y + cy] = value;
                            }
                        }
                    }

                    // alpha map 2
                    if (haveAlpha2)
                    {
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                byte value = reader.ReadByte();
                                terrain.AlphaMap2[x + cx, y + cy] = value;
                            }
                            if (version < 3) reader.ReadByte(); // 5th vertex (from next cluster)
                        }
                        if (version < 3) reader.ReadBytes(5); // 5th row of vertecies (from next cluster)
                    }
                    else
                    {
                        byte value = reader.ReadByte();
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                terrain.AlphaMap2[x + cx, y + cy] = value;
                            }
                        }
                    }

                    // alpha map 3
                    if (haveAlpha3)
                    {
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                byte value = reader.ReadByte();
                                terrain.AlphaMap3[x + cx, y + cy] = value;
                            }
                            if (version < 3) reader.ReadByte(); // 5th vertex (from next cluster)
                        }
                        if (version < 3) reader.ReadBytes(5); // 5th row of vertecies (from next cluster)
                    }
                    else
                    {
                        byte value = reader.ReadByte();
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                terrain.AlphaMap3[x + cx, y + cy] = value;
                            }
                        }
                    }

                    // cliff map
                    if (haveCell)
                    {
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                CellType value = (CellType)reader.ReadByte();
                                terrain.CellMap[x + cx, y + cy] = value;
                            }
                            if (version < 3) reader.ReadByte(); // 5th vertex (from next cluster)
                        }
                        if (version < 3) reader.ReadBytes(5); // 5th row of vertecies (from next cluster)
                    }
                    else
                    {
                        CellType value = (CellType)reader.ReadByte();
                        for (int cy = 0; cy < CLUSTER_SIZE; cy++)
                        {
                            for (int cx = 0; cx < CLUSTER_SIZE; cx++)
                            {
                                terrain.CellMap[x + cx, y + cy] = value;
                            }
                        }
                    }

                    // info map
                    {
                        UInt32 value = reader.ReadUInt32();
                        terrain.InfoMap[x / CLUSTER_SIZE, y / CLUSTER_SIZE] = value;
                    }

                    // ???
                    if (version > 0)
                    {
                        if (version < 3) reader.ReadBytes(25);
                        if (version == 2) reader.ReadByte();
                    }
				}
			}

			return terrain;
		}

		public void Translate(int translation)
		{
			for (int y = 0; y < this.Height; y++)
			{
				for (int x = 0; x < this.Width; x++)
				{
                    if (this.Version < 4)
                    {
                        int newValue = this.HeightMap[x, y];
                        newValue += translation;

                        if (newValue < short.MinValue)
                            newValue = short.MinValue;
                        else if (newValue > short.MaxValue)
                            newValue = short.MaxValue;

                        this.HeightMap[x, y] = (short)newValue;
                    }
                    else
                    {
                        Single newValue = this.HeightMapFloat[x, y];
                        newValue += translation;

                        if (newValue < Single.MinValue)
                            newValue = Single.MinValue;
                        else if (newValue > Single.MaxValue)
                            newValue = Single.MaxValue;

                        this.HeightMapFloat[x, y] = (Single)newValue;
                    }
				}
			}

			this.UpdateMinMax();
        }

        public void RescaleHeight(float min1, float max1, float min2, float max2)
        {
            float scale = (max2 - min2) / (max1 - min1);

            for (int y = 0; y < this.Height; y++)
            {
                for (int x = 0; x < this.Width; x++)
                {
                    if (this.Version < 4)
                    {
                        float newValue = this.HeightMap[x, y];

                        // rescale value based on translation of min1..max1 to min2..max2
                        newValue = (newValue - min1) * scale + min2;

                        // clamp values if limited to short
                        if (newValue < short.MinValue)
                            newValue = short.MinValue;
                        else if (newValue > short.MaxValue)
                            newValue = short.MaxValue;

                        this.HeightMap[x, y] = (short)newValue;
                    }
                    else
                    {
                        float newValue = this.HeightMapFloat[x, y];

                        // rescale value based on translation of min1..max1 to min2..max2
                        newValue = (newValue - min1) * scale + min2;

                        this.HeightMapFloat[x, y] = newValue;
                    }
                }
            }

            this.UpdateMinMax();
        }

        public void SetPan(short GridMinX, short GridMinZ)
        {
            this.GridMaxX = (short)(GridMinX + this.Width);
            this.GridMaxZ = (short)(GridMinZ + this.Height);

            this.GridMinX = GridMinX;
            this.GridMinZ = GridMinZ;
        }

        #endregion
    }
}
