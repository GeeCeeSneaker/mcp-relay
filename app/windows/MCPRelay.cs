// MCPRelay node app (Windows): tray app + supervisor for the node runtime.
//
// Starts, as the logged-in user and without console windows:
//   * the local capability server (node server.mjs, ADR-0004), and
//   * the reverse tunnel (Windows OpenSSH ssh.exe -R to the VPS),
// restarts either on exit with backoff, restarts a server that stops answering
// health checks, restarts the tunnel after resume or a network change, and kills
// every child process tree when it exits (Job Objects). An unexpected exception
// in the app itself restarts the app. Closing the window hides it to the tray.
//
// Built with the .NET Framework 4.x compiler that ships with Windows
// (packaging/windows/build.ps1); C# 5 language level on purpose.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("MCPRelay")]
[assembly: System.Reflection.AssemblyProduct("MCPRelay")]
[assembly: System.Reflection.AssemblyVersion("1.3.0")]

namespace MCPRelay
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            bool restarted = Array.IndexOf(args, "--restarted") >= 0;
            using (var mutex = new Mutex(true, @"Local\MCPRelay.Singleton", out created))
            using (var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\MCPRelay.Show"))
            {
                if (!created && restarted)
                {
                    // Self-restart after a crash: wait for the previous instance to go away.
                    try { created = mutex.WaitOne(15000); } catch (AbandonedMutexException) { created = true; }
                }
                if (!created) { showEvent.Set(); return; }
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += (s, e) => MainForm.CrashRestart(e.Exception);
                AppDomain.CurrentDomain.UnhandledException += (s, e) => MainForm.CrashRestart(e.ExceptionObject as Exception);
                // csc-built assemblies run with legacy TLS defaults; allow TLS 1.2/1.3.
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                bool minimized = Array.IndexOf(args, "--minimized") >= 0;
                Application.Run(new MainForm(minimized, showEvent));
            }
        }
    }

    // ------------------------------------------------------------------ config
    class Config
    {
        public string NodeName = "node";
        public string VpsHost = "";
        public string TunnelUser = "mcptunnel";
        public int RemotePort;
        public int LocalPort = 18001;
        public string SshKey = "";
        public string KnownHosts = "";
        public string PublicUrl = "";
        public string BridgeScript = "";   // optional override (development)
        public string NodeExe = "";        // optional override (development)
        public string AllowedDirs = "";    // file-tool roots, ';'-separated (default: user profile)
        public string ProtectedDirs = "";  // extra never-read/never-change folders for file tools
        public string ReadOnlyDirs = "";   // extra read-only folders for file tools

        public static string Dir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "MCPRelay"); } }
        public static string FilePath { get { return Path.Combine(Dir, "config.json"); } }
        public static string TokenPath { get { return Path.Combine(Dir, "bridge.token"); } }

        public static Config Load(out string error)
        {
            error = null;
            var c = new Config();
            if (!File.Exists(FilePath)) { error = "Missing " + FilePath; return c; }
            try
            {
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(FilePath));
                Func<string, string> s = k => d.ContainsKey(k) && d[k] != null ? Convert.ToString(d[k]) : "";
                c.NodeName = s("nodeName") != "" ? s("nodeName") : c.NodeName;
                c.VpsHost = s("vpsHost");
                if (s("tunnelUser") != "") c.TunnelUser = s("tunnelUser");
                int p;
                if (int.TryParse(s("remotePort"), out p)) c.RemotePort = p;
                if (int.TryParse(s("localPort"), out p)) c.LocalPort = p;
                c.SshKey = Environment.ExpandEnvironmentVariables(s("sshKey"));
                c.KnownHosts = Environment.ExpandEnvironmentVariables(s("knownHosts"));
                c.PublicUrl = s("publicUrl").TrimEnd('/');
                c.BridgeScript = Environment.ExpandEnvironmentVariables(s("bridgeScript"));
                c.NodeExe = Environment.ExpandEnvironmentVariables(s("nodeExe"));
                c.AllowedDirs = Environment.ExpandEnvironmentVariables(s("allowedDirs"));
                c.ProtectedDirs = Environment.ExpandEnvironmentVariables(s("protectedDirs"));
                c.ReadOnlyDirs = Environment.ExpandEnvironmentVariables(s("readOnlyDirs"));
            }
            catch (Exception e) { error = "Invalid config.json: " + e.Message; return c; }
            if (c.VpsHost == "" || c.RemotePort <= 0) error = "config.json needs vpsHost and remotePort";
            else if (!File.Exists(c.SshKey)) error = "SSH key not found: " + c.SshKey;
            else if (!File.Exists(c.KnownHosts)) error = "known_hosts not found: " + c.KnownHosts;
            else if (!File.Exists(TokenPath)) error = "Bridge token not found: " + TokenPath;
            return c;
        }
    }

    // --------------------------------------------------------- job objects
    // Each supervised process runs in its own Job Object: terminating the job
    // kills the whole tree (node server -> shells -> commands), and closing the
    // last handle (app exit or crash) does the same.
    static class Jobs
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll")]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")]
        static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr h);

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic;
            public IO_COUNTERS Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        public static IntPtr CreateKillOnClose(Process p)
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            // KILL_ON_JOB_CLOSE | BREAKAWAY_OK. Breakaway is only used by the process helper's
            // spawn (ADR-0008): programs started through it must survive a node server restart.
            // Everything else (start_process sessions, ssh) stays in the job and dies with it.
            info.Basic.LimitFlags = 0x2000 | 0x800;
            SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            AssignProcessToJobObject(job, p.Handle);
            return job;
        }

        public static void Kill(IntPtr job)
        {
            if (job == IntPtr.Zero) return;
            TerminateJobObject(job, 1);
            CloseHandle(job);
        }
    }

    // ----------------------------------------------------------- supervisor
    class Supervised
    {
        public readonly string Name;
        readonly Func<ProcessStartInfo> makeStartInfo;
        readonly int[] backoffSeconds;
        readonly object gate = new object();
        Process proc;
        IntPtr job = IntPtr.Zero;
        System.Threading.Timer restartTimer;
        int attempt;
        bool stopped = true;
        public DateTime? RunningSince;
        public int Restarts;
        public string LastExit = "";
        public event Action<string, string> Line;   // source, text
        public event Action Exited;

        public Supervised(string name, Func<ProcessStartInfo> makeStartInfo, int[] backoffSeconds)
        {
            Name = name;
            this.makeStartInfo = makeStartInfo;
            this.backoffSeconds = backoffSeconds;
        }

        public bool IsRunning { get { lock (gate) { return proc != null && !proc.HasExited; } } }

        public void Start()
        {
            lock (gate) { stopped = false; }
            Launch();
        }

        void Launch()
        {
            lock (gate)
            {
                if (stopped || (proc != null && !proc.HasExited)) return;
                ProcessStartInfo psi;
                try { psi = makeStartInfo(); }
                catch (Exception e) { Emit("cannot start: " + e.Message); ScheduleRestart(); return; }
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.OutputDataReceived += (s, e) => { if (e.Data != null) Emit(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) Emit(e.Data); };
                p.Exited += OnExited;
                try
                {
                    p.Start();
                    job = Jobs.CreateKillOnClose(p);
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    proc = p;
                    RunningSince = DateTime.Now;
                    Emit("started (pid " + p.Id + ")");
                }
                catch (Exception e)
                {
                    Emit("start failed: " + e.Message);
                    ScheduleRestart();
                }
            }
            var h = Exited; if (h != null) h();
        }

        void OnExited(object sender, EventArgs e)
        {
            lock (gate)
            {
                var p = (Process)sender;
                if (p != proc) return;
                int code = -1;
                try { code = p.ExitCode; } catch { }
                bool longRun = RunningSince.HasValue && (DateTime.Now - RunningSince.Value).TotalSeconds > 60;
                if (longRun) attempt = 0;
                LastExit = DateTime.Now.ToString("HH:mm:ss") + " (code " + code + ")";
                Emit("exited with code " + code);
                Jobs.Kill(job); job = IntPtr.Zero;
                proc = null;
                RunningSince = null;
                if (!stopped) { Restarts++; ScheduleRestart(); }
            }
            var h = Exited; if (h != null) h();
        }

        void ScheduleRestart()
        {
            int delay = backoffSeconds[Math.Min(attempt, backoffSeconds.Length - 1)];
            attempt++;
            Emit("restarting in " + delay + "s");
            if (restartTimer != null) restartTimer.Dispose();
            restartTimer = new System.Threading.Timer(_ => Launch(), null, delay * 1000, Timeout.Infinite);
        }

        // Kill the current tree; the exit handler restarts it immediately.
        public void Restart()
        {
            lock (gate)
            {
                attempt = 0;
                if (proc == null) { if (!stopped) { if (restartTimer != null) restartTimer.Dispose(); ThreadPool.QueueUserWorkItem(_ => Launch()); } return; }
                Emit("restart requested");
                Jobs.Kill(job); job = IntPtr.Zero;
            }
        }

        public void Stop()
        {
            lock (gate)
            {
                stopped = true;
                if (restartTimer != null) restartTimer.Dispose();
                Jobs.Kill(job); job = IntPtr.Zero;
            }
        }

        void Emit(string text) { var h = Line; if (h != null) h(Name, text); }
    }

    // ------------------------------------------------------------- main form
    class MainForm : Form
    {
        const int MaxLogLines = 800;
        readonly EventWaitHandle showEvent;
        readonly NotifyIcon tray = new NotifyIcon();
        readonly TextBox logBox = new TextBox();
        readonly Label bridgeLabel = new Label(), tunnelLabel = new Label(), publicLabel = new Label(), identityLabel = new Label();
        readonly CheckBox autostartBox = new CheckBox();
        readonly ToolStripMenuItem autostartItem = new ToolStripMenuItem("Start with Windows");
        readonly System.Windows.Forms.Timer healthTimer = new System.Windows.Forms.Timer();
        readonly Queue<string> pendingLines = new Queue<string>();
        readonly Icon iconOk = MakeIcon(Color.FromArgb(46, 160, 67)), iconWarn = MakeIcon(Color.FromArgb(219, 171, 9)), iconBad = MakeIcon(Color.FromArgb(207, 34, 46));
        readonly string logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MCPRelay", "logs");
        readonly object logLock = new object();
        Config config;
        string configError;
        Supervised bridge, tunnel;
        volatile bool dcUp, publicUp;
        volatile bool publicChecked;
        DateTime? tunnelAuthAt;
        bool quitting, hintShown;
        int healthTicks;
        volatile int healthFailures;
        static MainForm current;
        static int crashing;

        // Unexpected exception anywhere in the app: log it, stop the children and
        // start a fresh instance (which waits for this one's mutex), then exit.
        public static void CrashRestart(Exception ex)
        {
            if (Interlocked.Exchange(ref crashing, 1) != 0) return;
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MCPRelay", "logs");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "mcprelay.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " [app] CRASH, restarting: " + ex + Environment.NewLine, Encoding.UTF8);
                if (current != null)
                {
                    if (current.bridge != null) current.bridge.Stop();
                    if (current.tunnel != null) current.tunnel.Stop();
                    current.tray.Visible = false;
                }
                Process.Start(Application.ExecutablePath, "--minimized --restarted");
            }
            catch { }
            Environment.Exit(1);
        }

        public MainForm(bool startMinimized, EventWaitHandle showEvent)
        {
            this.showEvent = showEvent;
            current = this;
            Directory.CreateDirectory(logDir);
            config = Config.Load(out configError);
            BuildUi();
            if (startMinimized) { WindowState = FormWindowState.Minimized; ShowInTaskbar = false; }

            var waiter = new Thread(() => { while (showEvent.WaitOne()) BeginInvoke((Action)ShowWindow); }) { IsBackground = true };
            waiter.Start();

            SystemEvents.PowerModeChanged += (s, e) =>
            {
                if (e.Mode == PowerModes.Resume && tunnel != null) { Log("app", "resumed from sleep; reconnecting tunnel"); tunnel.Restart(); }
            };
            NetworkChange.NetworkAvailabilityChanged += (s, e) =>
            {
                if (e.IsAvailable && tunnel != null && !TunnelConnected) { Log("app", "network available; reconnecting tunnel"); tunnel.Restart(); }
            };

            if (configError != null) Log("app", "NOT CONFIGURED: " + configError);
            else StartServices();

            healthTimer.Interval = 5000;
            healthTimer.Tick += (s, e) => CheckHealth();
            healthTimer.Start();
            CheckHealth();
        }

        protected override void SetVisibleCore(bool value)
        {
            // Start hidden in the tray when launched with --minimized.
            if (!IsHandleCreated && WindowState == FormWindowState.Minimized) { CreateHandle(); value = false; }
            base.SetVisibleCore(value);
        }

        void BuildUi()
        {
            Text = "MCPRelay - " + config.NodeName;
            Width = 760; Height = 520;
            MinimumSize = new Size(560, 380);
            StartPosition = FormStartPosition.CenterScreen;
            Icon = iconWarn;
            Font = new Font("Segoe UI", 9f);

            var status = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 1, Padding = new Padding(10, 10, 10, 4) };
            foreach (var l in new[] { bridgeLabel, tunnelLabel, publicLabel, identityLabel }) { l.AutoSize = true; l.Margin = new Padding(0, 2, 0, 2); status.Controls.Add(l); }
            identityLabel.Text = "Runs as: " + Environment.UserDomainName + "\\" + Environment.UserName;

            var buttons = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(8, 0, 8, 4) };
            var restart = new Button { Text = "Restart services", AutoSize = true };
            restart.Click += (s, e) => RestartServices();
            var openLogs = new Button { Text = "Open logs folder", AutoSize = true };
            openLogs.Click += (s, e) => Process.Start("explorer.exe", "\"" + logDir + "\"");
            var openCfg = new Button { Text = "Open config folder", AutoSize = true };
            openCfg.Click += (s, e) => { Directory.CreateDirectory(Config.Dir); Process.Start("explorer.exe", "\"" + Config.Dir + "\""); };
            autostartBox.Text = "Start with Windows"; autostartBox.AutoSize = true; autostartBox.Margin = new Padding(12, 7, 0, 0);
            autostartBox.Checked = Autostart;
            autostartBox.CheckedChanged += (s, e) => SetAutostart(autostartBox.Checked);
            buttons.Controls.AddRange(new Control[] { restart, openLogs, openCfg, autostartBox });

            logBox.Multiline = true; logBox.ReadOnly = true; logBox.ScrollBars = ScrollBars.Vertical; logBox.WordWrap = false;
            logBox.Dock = DockStyle.Fill; logBox.Font = new Font("Consolas", 8.5f); logBox.BackColor = SystemColors.Window;

            Controls.Add(logBox);
            Controls.Add(buttons);
            Controls.Add(status);

            var menu = new ContextMenuStrip();
            menu.Items.Add("Open MCPRelay", null, (s, e) => ShowWindow());
            menu.Items.Add("Restart services", null, (s, e) => RestartServices());
            menu.Items.Add(new ToolStripSeparator());
            autostartItem.Checked = Autostart;
            autostartItem.Click += (s, e) => SetAutostart(!Autostart);
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit MCPRelay", null, (s, e) => Quit());
            tray.ContextMenuStrip = menu;
            tray.Icon = iconWarn;
            tray.Text = "MCPRelay";
            tray.Visible = true;
            tray.DoubleClick += (s, e) => ShowWindow();

            var flush = new System.Windows.Forms.Timer { Interval = 300 };
            flush.Tick += (s, e) => FlushLog();
            flush.Start();
        }

        // --------------------------------------------------------- services
        string AppDir { get { return AppDomain.CurrentDomain.BaseDirectory; } }

        void StartServices()
        {
            string nodeExe = config.NodeExe != "" ? config.NodeExe : Path.Combine(AppDir, @"runtime\node\node.exe");
            if (!File.Exists(nodeExe)) nodeExe = "node.exe";
            string bridgeScript = config.BridgeScript != "" ? config.BridgeScript : Path.Combine(AppDir, @"runtime\app\server.mjs");
            string ssh = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"OpenSSH\ssh.exe");

            bridge = new Supervised("server", () =>
            {
                var psi = new ProcessStartInfo(nodeExe, Quote(bridgeScript) + " --port " + config.LocalPort);
                psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                psi.EnvironmentVariables["MCPRELAY_BRIDGE_TOKEN"] = File.ReadAllText(Config.TokenPath).Trim();
                if (config.AllowedDirs != "") psi.EnvironmentVariables["MCPRELAY_ALLOWED_DIRS"] = config.AllowedDirs;
                if (config.ProtectedDirs != "") psi.EnvironmentVariables["MCPRELAY_PROTECTED_DIRS"] = config.ProtectedDirs;
                if (config.ReadOnlyDirs != "") psi.EnvironmentVariables["MCPRELAY_READONLY_DIRS"] = config.ReadOnlyDirs;
                psi.EnvironmentVariables["MCPRELAY_NODE_NAME"] = config.NodeName;
                // Per-call audit trail (no arguments), size-capped by the server (~2 MB).
                psi.EnvironmentVariables["MCPRELAY_AUDIT_LOG"] = Path.Combine(logDir, "audit.log");
                return psi;
            }, new[] { 1, 2, 5, 10, 30 });

            tunnel = new Supervised("tunnel", () =>
            {
                string args = "-N -T -i " + Quote(config.SshKey) +
                    " -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes" +
                    " -o UserKnownHostsFile=" + Quote(config.KnownHosts) +
                    " -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes" +
                    " -o ConnectTimeout=15 -o LogLevel=VERBOSE" +
                    " -R 127.0.0.1:" + config.RemotePort + ":127.0.0.1:" + config.LocalPort +
                    " " + config.TunnelUser + "@" + config.VpsHost;
                return new ProcessStartInfo(ssh, args);
            }, new[] { 1, 2, 5, 10, 15 });

            bridge.Line += Log; tunnel.Line += Log;
            tunnel.Line += (src, text) => { if (text.Contains("Authenticated to")) tunnelAuthAt = DateTime.Now; };
            tunnel.Exited += () => { if (!tunnel.IsRunning) tunnelAuthAt = null; };
            bridge.Start();
            tunnel.Start();
        }

        void RestartServices()
        {
            if (bridge == null)
            {
                config = Config.Load(out configError);
                if (configError != null) { Log("app", "NOT CONFIGURED: " + configError); return; }
                StartServices();
                return;
            }
            Log("app", "restarting services");
            bridge.Restart();
            tunnel.Restart();
        }

        bool TunnelConnected
        {
            get { var t = tunnelAuthAt; return tunnel != null && tunnel.IsRunning && t.HasValue && (DateTime.Now - t.Value).TotalSeconds >= 2; }
        }

        void CheckHealth()
        {
            healthTicks++;
            if (bridge != null)
            {
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    dcUp = HttpOk("http://127.0.0.1:" + config.LocalPort + "/healthz", 3000);
                    // A server that is running but not answering (hung) is restarted after
                    // 3 consecutive failed checks (~15 s), once it had 20 s to start.
                    var since = bridge.RunningSince;
                    if (dcUp || !bridge.IsRunning || !since.HasValue || (DateTime.Now - since.Value).TotalSeconds < 20) { healthFailures = 0; return; }
                    if (++healthFailures >= 3)
                    {
                        healthFailures = 0;
                        Log("app", "server not answering health checks; restarting it");
                        bridge.Restart();
                    }
                });
                if (config.PublicUrl != "" && (healthTicks % 12 == 1))
                    ThreadPool.QueueUserWorkItem(_ => { publicUp = HttpOk(config.PublicUrl + "/healthz", 10000); publicChecked = true; });
            }
            UpdateStatus();
        }

        static bool HttpOk(string url, int timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = timeoutMs; req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;
                using (var resp = (HttpWebResponse)req.GetResponse()) return resp.StatusCode == HttpStatusCode.OK;
            }
            catch { return false; }
        }

        void UpdateStatus()
        {
            if (configError != null)
            {
                bridgeLabel.Text = "Not configured: " + configError;
                tunnelLabel.Text = ""; publicLabel.Text = "";
                SetTray(iconBad, "MCPRelay - not configured");
                return;
            }
            bool bridgeRunning = bridge != null && bridge.IsRunning;
            bridgeLabel.Text = "Local server: " + (bridgeRunning ? (dcUp ? "running" : "starting") + Since(bridge.RunningSince) : "stopped") + RestartInfo(bridge);
            bool connected = TunnelConnected;
            tunnelLabel.Text = "Tunnel to VPS: " + (connected ? "connected" + Since(tunnelAuthAt) : tunnel != null && tunnel.IsRunning ? "connecting" : "disconnected") + RestartInfo(tunnel);
            publicLabel.Text = config.PublicUrl == "" ? "" : "Public endpoint: " + (!publicChecked ? "checking" : publicUp ? "reachable" : "unreachable") + "  (" + config.PublicUrl + ")";
            if (bridgeRunning && dcUp && connected) SetTray(iconOk, "MCPRelay - connected");
            else if (bridgeRunning || (tunnel != null && tunnel.IsRunning)) SetTray(iconWarn, "MCPRelay - " + (!dcUp ? "starting bridge" : "connecting tunnel"));
            else SetTray(iconBad, "MCPRelay - stopped");
        }

        static string Since(DateTime? t) { return t.HasValue ? " since " + t.Value.ToString("MM-dd HH:mm:ss") : ""; }
        static string RestartInfo(Supervised s) { return s != null && s.Restarts > 0 ? "   (restarts: " + s.Restarts + ", last exit " + s.LastExit + ")" : ""; }

        void SetTray(Icon icon, string text)
        {
            if (tray.Icon != icon) { tray.Icon = icon; Icon = icon; }
            tray.Text = text.Length > 63 ? text.Substring(0, 63) : text;
        }

        // ------------------------------------------------------------ logging
        void Log(string source, string text)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " [" + source + "] " + text;
            lock (logLock)
            {
                pendingLines.Enqueue(line);
                try
                {
                    string file = Path.Combine(logDir, "mcprelay.log");
                    if (File.Exists(file) && new FileInfo(file).Length > 2 * 1024 * 1024)
                    {
                        string old = file + ".1";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(file, old);
                    }
                    File.AppendAllText(file, line + Environment.NewLine, Encoding.UTF8);
                }
                catch { }
            }
        }

        void FlushLog()
        {
            string[] lines;
            lock (logLock) { if (pendingLines.Count == 0) return; lines = pendingLines.ToArray(); pendingLines.Clear(); }
            logBox.AppendText(string.Join(Environment.NewLine, lines) + Environment.NewLine);
            if (logBox.Lines.Length > MaxLogLines)
            {
                var keep = new string[MaxLogLines];
                Array.Copy(logBox.Lines, logBox.Lines.Length - MaxLogLines, keep, 0, MaxLogLines);
                logBox.Lines = keep;
                logBox.SelectionStart = logBox.TextLength; logBox.ScrollToCaret();
            }
        }

        // ---------------------------------------------------------- autostart
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        bool Autostart
        {
            get { using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) return k != null && k.GetValue("MCPRelay") != null; }
        }
        void SetAutostart(bool on)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) k.SetValue("MCPRelay", "\"" + Application.ExecutablePath + "\" --minimized");
                else k.DeleteValue("MCPRelay", false);
            }
            autostartBox.Checked = on; autostartItem.Checked = on;
            Log("app", "start with Windows: " + (on ? "on" : "off"));
        }

        // ------------------------------------------------------------ window
        void ShowWindow()
        {
            ShowInTaskbar = true;
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!quitting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                if (!hintShown) { tray.ShowBalloonTip(3000, "MCPRelay", "Still running in the tray. Right-click the icon to quit.", ToolTipIcon.Info); hintShown = true; }
                return;
            }
            base.OnFormClosing(e);
        }

        void Quit()
        {
            quitting = true;
            Log("app", "quitting; stopping services");
            if (bridge != null) bridge.Stop();
            if (tunnel != null) tunnel.Stop();
            tray.Visible = false;
            Application.Exit();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (bridge != null) bridge.Stop();
            if (tunnel != null) tunnel.Stop();
            tray.Visible = false;
            base.OnFormClosed(e);
        }

        static string Quote(string s) { return "\"" + s + "\""; }

        static Icon MakeIcon(Color color)
        {
            using (var bmp = new Bitmap(32, 32))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (var b = new SolidBrush(color)) g.FillEllipse(b, 3, 3, 26, 26);
                    using (var p = new Pen(Color.White, 3f)) g.DrawLine(p, 10, 16, 22, 16);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }
    }
}
