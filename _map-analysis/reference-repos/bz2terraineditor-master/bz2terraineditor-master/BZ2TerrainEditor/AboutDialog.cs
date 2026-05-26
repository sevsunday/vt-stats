using System;
using System.Diagnostics;
using System.Reflection;
using System.Windows.Forms;

namespace BZ2TerrainEditor
{
	public partial class AboutDialog : Form
	{
		#region Fields

		#endregion

		#region Properties

		#endregion

		#region Constructors

		public AboutDialog()
		{
			Assembly assembly = Assembly.GetExecutingAssembly();
			this.InitializeComponent();
			this.versionLabel.Text = string.Format(this.versionLabel.Text, assembly.GetName().Version);
		}

		#endregion

		#region Methods

		private void authorLabel_LinkClicked(object sender, LinkLabelLinkClickedEventArgs e)
		{
			Process.Start("http://nxs.re/");
		}

		private void iconsLabel_LinkClicked(object sender, LinkLabelLinkClickedEventArgs e)
		{
			Process.Start("http://p.yusukekamiyamane.com/");
		}

        private void updatedLabel_LinkClicked(object sender, LinkLabelLinkClickedEventArgs e)
        {
            Process.Start("http://nielk1.com/");
        }

        #endregion
    }
}
