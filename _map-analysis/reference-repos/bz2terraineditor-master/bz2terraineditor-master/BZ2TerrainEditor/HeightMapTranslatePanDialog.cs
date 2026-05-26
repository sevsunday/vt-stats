using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Drawing;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace BZ2TerrainEditor
{
	public partial class HeightMapTranslatePanDialog : Form
	{
		#region Fields

		private Point value;
		
		#endregion

		#region Properties

		public Point Value
		{
			get { return this.value; }
		}

		#endregion

		#region Constructors

		Terrain terrain;

		public HeightMapTranslatePanDialog(Terrain terrain)
		{
			this.InitializeComponent();

			this.terrain = terrain;

			lblMapDim.Text = "Existing Dimensions:\r\n"
				           + $"{terrain.GridMinX} to {terrain.GridMaxX} for width {terrain.Width}\r\n"
			               + $"{terrain.GridMinZ} to {terrain.GridMaxZ} for height {terrain.Height}";

			valueSelectorX.Value = terrain.GridMinX / 16 * 16;
			valueSelectorX.Maximum = terrain.Width;
			valueSelectorX.Minimum = -terrain.Width;
			valueSelectorX.Increment = terrain.CLUSTER_SIZE;

			valueSelectorZ.Value = terrain.GridMinZ / 16 * 16;
			valueSelectorZ.Maximum = terrain.Height;
			valueSelectorZ.Minimum = -terrain.Height;
			valueSelectorZ.Increment = terrain.CLUSTER_SIZE;

			UpdateText();
		}

		private void UpdateText()
        {
			lblX.Text = $" to {terrain.Width + valueSelectorX.Value} for width {terrain.Width}";
			lblZ.Text = $" to {terrain.Height + valueSelectorZ.Value} for height {terrain.Height}";
        }

		#endregion

		#region Methods

		private void cancelButton_Click(object sender, EventArgs e)
		{
			this.DialogResult = DialogResult.Cancel;
		}
		
		private void okButton_Click(object sender, EventArgs e)
		{
			this.value = new Point((short)this.valueSelectorX.Value, (short)this.valueSelectorZ.Value);
			this.DialogResult = DialogResult.OK;
		}

        #endregion

        private void valueSelectorX_ValueChanged(object sender, EventArgs e)
        {
			UpdateText();
		}

        private void valueSelectorZ_ValueChanged(object sender, EventArgs e)
        {
			UpdateText();
		}
    }
}
