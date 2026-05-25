using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace BZ2TerrainEditor
{
    public partial class HeightMapRescaleDialog : Form
    {
        public decimal OriginalMin
        {
            get { decimal v; return decimal.TryParse(valueSelectorMin1.Text, NumberStyles.Any, CultureInfo.InvariantCulture, out v) ? v : 0 ; }
            set { valueSelectorMin1.Text = value.ToString(CultureInfo.InvariantCulture); }
        }
        public decimal OriginalMax
        {
            get { decimal v; return decimal.TryParse(valueSelectorMax1.Text, NumberStyles.Any, CultureInfo.InvariantCulture, out v) ? v : 0 ; }
            set { valueSelectorMax1.Text = value.ToString(CultureInfo.InvariantCulture); }
        }
        public decimal NewMin
        {
            get { decimal v; return decimal.TryParse(valueSelectorMin2.Text, NumberStyles.Any, CultureInfo.InvariantCulture, out v) ? v : 0 ; }
            set { valueSelectorMin2.Text = value.ToString(CultureInfo.InvariantCulture); }
        }
        public decimal NewMax
        {
            get { decimal v; return decimal.TryParse(valueSelectorMax2.Text, NumberStyles.Any, CultureInfo.InvariantCulture, out v) ? v : 0 ; }
            set { valueSelectorMax2.Text = value.ToString(CultureInfo.InvariantCulture); }
        }

        public HeightMapRescaleDialog()
        {
            InitializeComponent();
        }

        private void cancelButton_Click(object sender, EventArgs e)
        {
            this.DialogResult = DialogResult.Cancel;
        }

        private void okButton_Click(object sender, EventArgs e)
        {
            this.DialogResult = DialogResult.OK;
        }

        private void valueSelectorMax1_TextChanged(object sender, EventArgs e)
        {
            valueSelectorMax1.Text = new string(valueSelectorMax1.Text.Where(c => char.IsDigit(c) || c == '.' || c == '-').ToArray());
        }

        private void valueSelectorMin1_TextChanged(object sender, EventArgs e)
        {
            valueSelectorMin1.Text = new string(valueSelectorMin1.Text.Where(c => char.IsDigit(c) || c == '.' || c == '-').ToArray());
        }

        private void valueSelectorMax2_TextChanged(object sender, EventArgs e)
        {
            valueSelectorMax2.Text = new string(valueSelectorMax2.Text.Where(c => char.IsDigit(c) || c == '.' || c == '-').ToArray());
        }

        private void valueSelectorMin2_TextChanged(object sender, EventArgs e)
        {
            valueSelectorMin2.Text = new string(valueSelectorMin2.Text.Where(c => char.IsDigit(c) || c == '.' || c == '-').ToArray());
        }
    }
}
