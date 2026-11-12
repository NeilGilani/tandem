// Tandem for Windows: a tray icon that keeps the Tandem server running in the background
// (bundled with its own Node), and opens the app in its own window. Bots keep working
// when the window is closed. Quit from the tray icon stops everything.
//
// Built with the C# compiler that ships with Windows (see build.ps1), so it sticks to C# 5.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    static readonly string ExeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    static int port = 4747;
    static string appRoot, nodeExe, dataDir, logPath;
    static Process server;
    static volatile bool stopping;
    static NotifyIcon tray;
    static readonly object gate = new object();

    static string Url { get { return "http://127.0.0.1:" + port + "/"; } }

    [STAThread]
    static void Main(string[] args)
    {
        int p;
        if (int.TryParse(Environment.GetEnvironmentVariable("TANDEM_PORT"), out p)) port = p;
        bool first;
        using (var only = new Mutex(true, "Tandem.TrayApp." + port, out first))
        {
            // Already running: opening it again just shows the window.
            if (!first) { OpenWindow(); return; }
            Application.EnableVisualStyles();
            if (!Locate())
            {
                MessageBox.Show("Tandem's files are missing next to Tandem.exe. Download Tandem again.", "Tandem", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            Directory.CreateDirectory(dataDir);
            logPath = Path.Combine(dataDir, "tandem.log");

            tray = new NotifyIcon { Icon = RingsIcon(), Text = "Tandem", Visible = true, ContextMenuStrip = BuildMenu() };
            tray.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenWindow(); };

            // Start the server now, and again whenever it stops (a crash, or a restart it asked for).
            var watchdog = new System.Threading.Timer(delegate { Watch(); }, null, 0, 4000);
            bool background = Array.IndexOf(args, "--background") >= 0;
            if (!background) ThreadPool.QueueUserWorkItem(delegate { if (WaitUntilUp(40)) OpenWindow(); else Balloon("Tandem couldn't start", "Open the log from the tray icon to see why."); });

            Application.ApplicationExit += delegate { StopServer(); tray.Visible = false; };
            Application.Run();
            watchdog.Dispose();
            GC.KeepAlive(only);
        }
    }

    // ---- Where things are ---------------------------------------------------------------

    static bool Locate()
    {
        // Packaged: Tandem.exe sits beside app\ (the server and web app) and node\ (bundled Node).
        string packaged = Path.Combine(ExeDir, "app");
        if (File.Exists(Path.Combine(packaged, "server", "index.js"))) appRoot = packaged;
        else
        {
            // Built inside a checkout: use the checkout itself.
            for (var d = new DirectoryInfo(ExeDir); d != null && appRoot == null; d = d.Parent)
                if (File.Exists(Path.Combine(d.FullName, "server", "index.js"))) appRoot = d.FullName;
        }
        if (appRoot == null) return false;
        string bundled = Path.Combine(ExeDir, "node", "node.exe");
        nodeExe = File.Exists(bundled) ? bundled : "node.exe";

        // Keep using ~\tandem\data if Tandem was installed from the command line before.
        string env = Environment.GetEnvironmentVariable("TANDEM_DATA");
        string legacy = Path.Combine(Home, "tandem", "data");
        if (!string.IsNullOrEmpty(env)) dataDir = env;
        else if (File.Exists(Path.Combine(legacy, "tandem.db"))) dataDir = legacy;
        else dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tandem");
        return true;
    }

    // ---- Server process -----------------------------------------------------------------

    static bool IsUp()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(Url + "api/plan");
            req.Timeout = 1500; req.Proxy = null;
            using (var resp = (HttpWebResponse)req.GetResponse()) return resp.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static bool WaitUntilUp(int tries)
    {
        for (int i = 0; i < tries && !stopping; i++) { if (IsUp()) return true; Thread.Sleep(500); }
        return false;
    }

    static void Watch()
    {
        if (stopping || !Monitor.TryEnter(gate)) return;
        try
        {
            if (server != null && !server.HasExited) return;
            // Another Tandem (a terminal, the background service) is already serving: just use it.
            if (IsUp()) return;
            Launch();
        }
        catch (Exception e) { Log("Tandem app: " + e.Message); }
        finally { Monitor.Exit(gate); }
    }

    static void Launch()
    {
        var si = new ProcessStartInfo(nodeExe, "\"" + Path.Combine(appRoot, "server", "index.js") + "\"");
        si.WorkingDirectory = appRoot;
        si.UseShellExecute = false;
        si.CreateNoWindow = true;
        si.RedirectStandardOutput = true;
        si.RedirectStandardError = true;
        // Apps started at sign-in can get a short PATH; Claude Code and the bundled Node live here.
        string extra = Path.Combine(Home, ".local", "bin") + ";" + Path.Combine(ExeDir, "node") + ";" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm");
        si.EnvironmentVariables["PATH"] = extra + ";" + Environment.GetEnvironmentVariable("PATH");
        si.EnvironmentVariables["TANDEM_DATA"] = dataDir;
        si.EnvironmentVariables["PORT"] = port.ToString();
        si.EnvironmentVariables["TANDEM_APP"] = "windows";
        var p = new Process { StartInfo = si };
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Log(e.Data); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Log(e.Data); };
        try { p.Start(); }
        catch (Exception e)
        {
            Log("Could not start Node: " + e.Message);
            Balloon("Tandem needs Node", "Install Node 22.13 or newer from nodejs.org, then open Tandem again.");
            stopping = true;
            return;
        }
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        server = p;
    }

    static void StopServer()
    {
        stopping = true;
        var p = server;
        if (p == null) return;
        try
        {
            if (!p.HasExited)
            {
                // The whole tree: the server, the Bots' Claude Code runs and their helpers.
                var kill = new ProcessStartInfo("taskkill.exe", "/PID " + p.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false };
                using (var k = Process.Start(kill)) k.WaitForExit(5000);
            }
        }
        catch { }
    }

    static void Log(string line)
    {
        if (line == null) return;
        try { lock (gate2) File.AppendAllText(logPath, line + Environment.NewLine); } catch { }
    }
    static readonly object gate2 = new object();

    // ---- Window ---------------------------------------------------------------------------

    // The app opens as its own window (no tabs or address bar) in Edge or Chrome.
    static void OpenWindow()
    {
        string[] roots = { Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("LOCALAPPDATA") };
        string[] browsers = { @"Microsoft\Edge\Application\msedge.exe", @"Google\Chrome\Application\chrome.exe", @"BraveSoftware\Brave-Browser\Application\brave.exe" };
        foreach (string b in browsers)
            foreach (string r in roots)
            {
                if (string.IsNullOrEmpty(r)) continue;
                string exe = Path.Combine(r, b);
                if (!File.Exists(exe)) continue;
                try { Process.Start(new ProcessStartInfo(exe, "--app=" + Url + " --window-size=1240,820") { UseShellExecute = false }); return; } catch { }
            }
        try { Process.Start(Url); } catch { }
    }

    // ---- Tray -----------------------------------------------------------------------------

    static ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("Open Tandem", null, delegate { OpenWindow(); });
        open.Font = new Font(open.Font, FontStyle.Bold);
        var login = new ToolStripMenuItem("Start when I sign in", null, delegate { ToggleLogin(); });
        menu.Opening += delegate { login.Checked = LoginEnabled(); };
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(login);
        menu.Items.Add("Open data folder", null, delegate { try { Process.Start(dataDir); } catch { } });
        menu.Items.Add("View log", null, delegate { try { Process.Start("notepad.exe", "\"" + logPath + "\""); } catch { } });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Tandem", null, delegate { Quit(); });
        return menu;
    }

    static bool LoginEnabled()
    {
        using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) return k != null && k.GetValue("Tandem") != null;
    }

    static void ToggleLogin()
    {
        try
        {
            using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (k.GetValue("Tandem") != null) k.DeleteValue("Tandem");
                else k.SetValue("Tandem", "\"" + Application.ExecutablePath + "\" --background");
            }
        }
        catch (Exception e) { MessageBox.Show(e.Message, "Couldn't change Start when I sign in"); }
    }

    static void Quit()
    {
        var answer = MessageBox.Show("Your Bots stop working and routines won't run until you open Tandem again. To keep them going, just close the window instead.",
            "Quit Tandem?", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        if (answer == DialogResult.OK) Application.Exit();
    }

    static void Balloon(string title, string text)
    {
        try { tray.ShowBalloonTip(8000, title, text, ToolTipIcon.Info); } catch { }
    }

    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

    // Two linked rings on the Tandem purple, like the app icon.
    static Icon RingsIcon()
    {
        using (var bmp = new Bitmap(32, 32))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var path = new GraphicsPath())
                {
                    const int r = 14;
                    path.AddArc(0, 0, r, r, 180, 90); path.AddArc(31 - r, 0, r, r, 270, 90);
                    path.AddArc(31 - r, 31 - r, r, r, 0, 90); path.AddArc(0, 31 - r, r, r, 90, 90);
                    path.CloseFigure();
                    using (var fill = new SolidBrush(Color.FromArgb(0x6d, 0x5d, 0xfc))) g.FillPath(fill, path);
                }
                using (var white = new Pen(Color.White, 2.6f)) g.DrawEllipse(white, 6.2f, 10.2f, 11.6f, 11.6f);
                using (var soft = new Pen(Color.FromArgb(190, 255, 255, 255), 2.6f)) g.DrawEllipse(soft, 14.2f, 10.2f, 11.6f, 11.6f);
            }
            IntPtr h = bmp.GetHicon();
            try { return (Icon)Icon.FromHandle(h).Clone(); } finally { DestroyIcon(h); }
        }
    }
}
