namespace BZ2TerrainEditor
{
    partial class HeightMapRescaleDialog
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
            this.infoLabel = new System.Windows.Forms.Label();
            this.label3 = new System.Windows.Forms.Label();
            this.valueSelectorMin1 = new System.Windows.Forms.TextBox();
            this.valueLabel = new System.Windows.Forms.Label();
            this.valueSelectorMax1 = new System.Windows.Forms.TextBox();
            this.groupBox1 = new System.Windows.Forms.GroupBox();
            this.groupBox2 = new System.Windows.Forms.GroupBox();
            this.valueSelectorMax2 = new System.Windows.Forms.TextBox();
            this.label1 = new System.Windows.Forms.Label();
            this.label2 = new System.Windows.Forms.Label();
            this.valueSelectorMin2 = new System.Windows.Forms.TextBox();
            this.cancelButton = new System.Windows.Forms.Button();
            this.okButton = new System.Windows.Forms.Button();
            this.groupBox1.SuspendLayout();
            this.groupBox2.SuspendLayout();
            this.SuspendLayout();
            // 
            // infoLabel
            // 
            this.infoLabel.Location = new System.Drawing.Point(12, 9);
            this.infoLabel.Name = "infoLabel";
            this.infoLabel.Size = new System.Drawing.Size(283, 17);
            this.infoLabel.TabIndex = 8;
            this.infoLabel.Text = "Rescale the height from one scale range to another.";
            // 
            // label3
            // 
            this.label3.Location = new System.Drawing.Point(6, 42);
            this.label3.Name = "label3";
            this.label3.Size = new System.Drawing.Size(27, 20);
            this.label3.TabIndex = 18;
            this.label3.Text = "Min";
            this.label3.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
            // 
            // valueSelectorMin1
            // 
            this.valueSelectorMin1.Location = new System.Drawing.Point(39, 42);
            this.valueSelectorMin1.Name = "valueSelectorMin1";
            this.valueSelectorMin1.Size = new System.Drawing.Size(108, 20);
            this.valueSelectorMin1.TabIndex = 17;
            this.valueSelectorMin1.TextChanged += new System.EventHandler(this.valueSelectorMin1_TextChanged);
            // 
            // valueLabel
            // 
            this.valueLabel.Location = new System.Drawing.Point(6, 16);
            this.valueLabel.Name = "valueLabel";
            this.valueLabel.Size = new System.Drawing.Size(27, 20);
            this.valueLabel.TabIndex = 16;
            this.valueLabel.Text = "Max";
            this.valueLabel.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
            // 
            // valueSelectorMax1
            // 
            this.valueSelectorMax1.Location = new System.Drawing.Point(39, 16);
            this.valueSelectorMax1.Name = "valueSelectorMax1";
            this.valueSelectorMax1.Size = new System.Drawing.Size(108, 20);
            this.valueSelectorMax1.TabIndex = 15;
            this.valueSelectorMax1.TextChanged += new System.EventHandler(this.valueSelectorMax1_TextChanged);
            // 
            // groupBox1
            // 
            this.groupBox1.Controls.Add(this.valueSelectorMax1);
            this.groupBox1.Controls.Add(this.label3);
            this.groupBox1.Controls.Add(this.valueLabel);
            this.groupBox1.Controls.Add(this.valueSelectorMin1);
            this.groupBox1.Location = new System.Drawing.Point(12, 29);
            this.groupBox1.Name = "groupBox1";
            this.groupBox1.Size = new System.Drawing.Size(157, 71);
            this.groupBox1.TabIndex = 19;
            this.groupBox1.TabStop = false;
            this.groupBox1.Text = "Original Range";
            // 
            // groupBox2
            // 
            this.groupBox2.Controls.Add(this.valueSelectorMax2);
            this.groupBox2.Controls.Add(this.label1);
            this.groupBox2.Controls.Add(this.label2);
            this.groupBox2.Controls.Add(this.valueSelectorMin2);
            this.groupBox2.Location = new System.Drawing.Point(177, 29);
            this.groupBox2.Name = "groupBox2";
            this.groupBox2.Size = new System.Drawing.Size(157, 71);
            this.groupBox2.TabIndex = 20;
            this.groupBox2.TabStop = false;
            this.groupBox2.Text = "New Range";
            // 
            // valueSelectorMax2
            // 
            this.valueSelectorMax2.Location = new System.Drawing.Point(39, 16);
            this.valueSelectorMax2.Name = "valueSelectorMax2";
            this.valueSelectorMax2.Size = new System.Drawing.Size(108, 20);
            this.valueSelectorMax2.TabIndex = 15;
            this.valueSelectorMax2.TextChanged += new System.EventHandler(this.valueSelectorMax2_TextChanged);
            // 
            // label1
            // 
            this.label1.Location = new System.Drawing.Point(6, 42);
            this.label1.Name = "label1";
            this.label1.Size = new System.Drawing.Size(27, 20);
            this.label1.TabIndex = 18;
            this.label1.Text = "Min";
            this.label1.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
            // 
            // label2
            // 
            this.label2.Location = new System.Drawing.Point(6, 16);
            this.label2.Name = "label2";
            this.label2.Size = new System.Drawing.Size(27, 20);
            this.label2.TabIndex = 16;
            this.label2.Text = "Max";
            this.label2.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
            // 
            // valueSelectorMin2
            // 
            this.valueSelectorMin2.Location = new System.Drawing.Point(39, 42);
            this.valueSelectorMin2.Name = "valueSelectorMin2";
            this.valueSelectorMin2.Size = new System.Drawing.Size(108, 20);
            this.valueSelectorMin2.TabIndex = 17;
            this.valueSelectorMin2.TextChanged += new System.EventHandler(this.valueSelectorMin2_TextChanged);
            // 
            // cancelButton
            // 
            this.cancelButton.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Left)));
            this.cancelButton.Location = new System.Drawing.Point(12, 109);
            this.cancelButton.Name = "cancelButton";
            this.cancelButton.Size = new System.Drawing.Size(152, 25);
            this.cancelButton.TabIndex = 21;
            this.cancelButton.Text = "&Cancel";
            this.cancelButton.UseVisualStyleBackColor = true;
            this.cancelButton.Click += new System.EventHandler(this.cancelButton_Click);
            // 
            // okButton
            // 
            this.okButton.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Left)));
            this.okButton.Location = new System.Drawing.Point(182, 109);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(152, 25);
            this.okButton.TabIndex = 22;
            this.okButton.Text = "&OK";
            this.okButton.UseVisualStyleBackColor = true;
            this.okButton.Click += new System.EventHandler(this.okButton_Click);
            // 
            // HeightMapRescaleDialog
            // 
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(346, 146);
            this.Controls.Add(this.cancelButton);
            this.Controls.Add(this.okButton);
            this.Controls.Add(this.groupBox2);
            this.Controls.Add(this.groupBox1);
            this.Controls.Add(this.infoLabel);
            this.FormBorderStyle = System.Windows.Forms.FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.Name = "HeightMapRescaleDialog";
            this.Text = "Height Map Normalize (Rescale)";
            this.groupBox1.ResumeLayout(false);
            this.groupBox1.PerformLayout();
            this.groupBox2.ResumeLayout(false);
            this.groupBox2.PerformLayout();
            this.ResumeLayout(false);

        }

        #endregion

        private System.Windows.Forms.Label infoLabel;
        private System.Windows.Forms.Label label3;
        private System.Windows.Forms.TextBox valueSelectorMin1;
        private System.Windows.Forms.Label valueLabel;
        private System.Windows.Forms.TextBox valueSelectorMax1;
        private System.Windows.Forms.GroupBox groupBox1;
        private System.Windows.Forms.GroupBox groupBox2;
        private System.Windows.Forms.TextBox valueSelectorMax2;
        private System.Windows.Forms.Label label1;
        private System.Windows.Forms.Label label2;
        private System.Windows.Forms.TextBox valueSelectorMin2;
        private System.Windows.Forms.Button cancelButton;
        private System.Windows.Forms.Button okButton;
    }
}