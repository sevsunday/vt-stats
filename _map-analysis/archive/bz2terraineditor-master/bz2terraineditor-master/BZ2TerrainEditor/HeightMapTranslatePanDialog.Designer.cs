namespace BZ2TerrainEditor
{
	partial class HeightMapTranslatePanDialog
	{
		/// <summary>
		/// Required designer variable.
		/// </summary>
		private System.ComponentModel.IContainer components = null;

		/// <summary>
		/// Clean up any resources being used.
		/// </summary>
		/// <param name="disposing">true if managed resources should be disposed; otherwise, false.</param>
		protected override void Dispose(bool disposing)
		{
			if (disposing && (components != null))
			{
				components.Dispose();
			}
			base.Dispose(disposing);
		}

		#region Windows Form Designer generated code

		/// <summary>
		/// Required method for Designer support - do not modify
		/// the contents of this method with the code editor.
		/// </summary>
		private void InitializeComponent()
		{
            this.cancelButton = new System.Windows.Forms.Button();
            this.okButton = new System.Windows.Forms.Button();
            this.valueLabel = new System.Windows.Forms.Label();
            this.valueSelectorX = new System.Windows.Forms.NumericUpDown();
            this.infoLabel = new System.Windows.Forms.Label();
            this.lblX = new System.Windows.Forms.Label();
            this.lblZ = new System.Windows.Forms.Label();
            this.label3 = new System.Windows.Forms.Label();
            this.valueSelectorZ = new System.Windows.Forms.NumericUpDown();
            this.lblMapDim = new System.Windows.Forms.Label();
            ((System.ComponentModel.ISupportInitialize)(this.valueSelectorX)).BeginInit();
            ((System.ComponentModel.ISupportInitialize)(this.valueSelectorZ)).BeginInit();
            this.SuspendLayout();
            // 
            // cancelButton
            // 
            this.cancelButton.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Left)));
            this.cancelButton.Location = new System.Drawing.Point(12, 141);
            this.cancelButton.Name = "cancelButton";
            this.cancelButton.Size = new System.Drawing.Size(152, 25);
            this.cancelButton.TabIndex = 10;
            this.cancelButton.Text = "&Cancel";
            this.cancelButton.UseVisualStyleBackColor = true;
            this.cancelButton.Click += new System.EventHandler(this.cancelButton_Click);
            // 
            // okButton
            // 
            this.okButton.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Left)));
            this.okButton.Location = new System.Drawing.Point(170, 141);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(152, 25);
            this.okButton.TabIndex = 11;
            this.okButton.Text = "&OK";
            this.okButton.UseVisualStyleBackColor = true;
            this.okButton.Click += new System.EventHandler(this.okButton_Click);
            // 
            // valueLabel
            // 
            this.valueLabel.Location = new System.Drawing.Point(12, 38);
            this.valueLabel.Name = "valueLabel";
            this.valueLabel.Size = new System.Drawing.Size(27, 20);
            this.valueLabel.TabIndex = 9;
            this.valueLabel.Text = "X:";
            this.valueLabel.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
            // 
            // valueSelectorX
            // 
            this.valueSelectorX.Location = new System.Drawing.Point(45, 38);
            this.valueSelectorX.Maximum = new decimal(new int[] {
            32767,
            0,
            0,
            0});
            this.valueSelectorX.Minimum = new decimal(new int[] {
            32768,
            0,
            0,
            -2147483648});
            this.valueSelectorX.Name = "valueSelectorX";
            this.valueSelectorX.Size = new System.Drawing.Size(108, 20);
            this.valueSelectorX.TabIndex = 8;
            this.valueSelectorX.ValueChanged += new System.EventHandler(this.valueSelectorX_ValueChanged);
            // 
            // infoLabel
            // 
            this.infoLabel.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this.infoLabel.Location = new System.Drawing.Point(12, 9);
            this.infoLabel.Name = "infoLabel";
            this.infoLabel.Size = new System.Drawing.Size(310, 26);
            this.infoLabel.TabIndex = 7;
            this.infoLabel.Text = "Map coordinate offset. The coordinate 0,0 must be inside the map. Using 0 for any" +
    " min/max is unstable in multiplayer.";
            // 
            // lblX
            // 
            this.lblX.AutoSize = true;
            this.lblX.Location = new System.Drawing.Point(159, 42);
            this.lblX.Name = "lblX";
            this.lblX.Size = new System.Drawing.Size(24, 13);
            this.lblX.TabIndex = 12;
            this.lblX.Text = "lblX";
            // 
            // lblZ
            // 
            this.lblZ.AutoSize = true;
            this.lblZ.Location = new System.Drawing.Point(159, 68);
            this.lblZ.Name = "lblZ";
            this.lblZ.Size = new System.Drawing.Size(24, 13);
            this.lblZ.TabIndex = 15;
            this.lblZ.Text = "lblZ";
            // 
            // label3
            // 
            this.label3.Location = new System.Drawing.Point(12, 64);
            this.label3.Name = "label3";
            this.label3.Size = new System.Drawing.Size(27, 20);
            this.label3.TabIndex = 14;
            this.label3.Text = "Z:";
            this.label3.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
            // 
            // valueSelectorZ
            // 
            this.valueSelectorZ.Location = new System.Drawing.Point(45, 64);
            this.valueSelectorZ.Maximum = new decimal(new int[] {
            32767,
            0,
            0,
            0});
            this.valueSelectorZ.Minimum = new decimal(new int[] {
            32768,
            0,
            0,
            -2147483648});
            this.valueSelectorZ.Name = "valueSelectorZ";
            this.valueSelectorZ.Size = new System.Drawing.Size(108, 20);
            this.valueSelectorZ.TabIndex = 13;
            this.valueSelectorZ.ValueChanged += new System.EventHandler(this.valueSelectorZ_ValueChanged);
            // 
            // lblMapDim
            // 
            this.lblMapDim.AutoSize = true;
            this.lblMapDim.Location = new System.Drawing.Point(12, 91);
            this.lblMapDim.Name = "lblMapDim";
            this.lblMapDim.Size = new System.Drawing.Size(35, 13);
            this.lblMapDim.TabIndex = 16;
            this.lblMapDim.Text = "label1";
            // 
            // HeightMapTranslatePanDialog
            // 
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(334, 178);
            this.Controls.Add(this.lblMapDim);
            this.Controls.Add(this.lblZ);
            this.Controls.Add(this.label3);
            this.Controls.Add(this.valueSelectorZ);
            this.Controls.Add(this.lblX);
            this.Controls.Add(this.cancelButton);
            this.Controls.Add(this.okButton);
            this.Controls.Add(this.valueLabel);
            this.Controls.Add(this.valueSelectorX);
            this.Controls.Add(this.infoLabel);
            this.FormBorderStyle = System.Windows.Forms.FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.Name = "HeightMapTranslatePanDialog";
            this.ShowInTaskbar = false;
            this.Text = "Height Map Translation";
            ((System.ComponentModel.ISupportInitialize)(this.valueSelectorX)).EndInit();
            ((System.ComponentModel.ISupportInitialize)(this.valueSelectorZ)).EndInit();
            this.ResumeLayout(false);
            this.PerformLayout();

		}

		#endregion

		private System.Windows.Forms.Button cancelButton;
		private System.Windows.Forms.Button okButton;
		private System.Windows.Forms.Label valueLabel;
		private System.Windows.Forms.NumericUpDown valueSelectorX;
		private System.Windows.Forms.Label infoLabel;
        private System.Windows.Forms.Label lblX;
        private System.Windows.Forms.Label lblZ;
        private System.Windows.Forms.Label label3;
        private System.Windows.Forms.NumericUpDown valueSelectorZ;
        private System.Windows.Forms.Label lblMapDim;
    }
}