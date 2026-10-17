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
using System.Security.Cryptography;
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
        public int SecondLocalPort, SecondRemotePort; // absent / both zero: legacy single forward
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
            try { c = Parse(File.ReadAllText(FilePath)); }
            catch (Exception e) { error = "Invalid config.json: " + e.Message; return c; }
            if (c.VpsHost == "" || c.RemotePort <= 0) error = "config.json needs vpsHost and remotePort";
            else if (!File.Exists(c.SshKey)) error = "SSH key not found: " + c.SshKey;
            else if (!File.Exists(c.KnownHosts)) error = "known_hosts not found: " + c.KnownHosts;
            else if (!File.Exists(TokenPath)) error = "Bridge token not found: " + TokenPath;
            return c;
        }

        // Parsing has no installed-file / credential probes. Shared by startup
        // and the serialized tunnel-only change path, including isolated tests.
        internal static Config Parse(string text)
        {
                var c = new Config();
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
                if (d == null) throw new ArgumentException("Config must be an object");
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
                bool local = d.ContainsKey("secondLocalPort"), remote = d.ContainsKey("secondRemotePort");
                if (local != remote) throw new ArgumentException("Second forward needs both ports");
                if (local)
                {
                    if (!(d["secondLocalPort"] is int) || !(d["secondRemotePort"] is int))
                        throw new ArgumentException("Second ports must be JSON integers");
                    c.SecondLocalPort = (int)d["secondLocalPort"]; c.SecondRemotePort = (int)d["secondRemotePort"];
                    if (c.SecondLocalPort != 0 || c.SecondRemotePort != 0)
                        if (c.SecondLocalPort < 1 || c.SecondLocalPort > 65535 || c.SecondRemotePort < 1 || c.SecondRemotePort > 65535 ||
                            c.SecondLocalPort == c.LocalPort || c.SecondRemotePort == c.RemotePort)
                            throw new ArgumentException("Invalid or overlapping second port pair");
                }
                return c;
        }
    }

    // --------------------------------------------------------- job objects
    // Each supervised process runs in its own Job Object: terminating the job
    // kills the whole tree (node server -> shells -> commands), and closing the
    // last handle (app exit or crash) does the same.
    static class Jobs
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

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

        // Instance-local Win32 seam for deterministic failures in the compiled
        // supervisor tests. Production always uses these native implementations;
        // no environment switch, global override, or alternate process launcher.
        internal class Calls
        {
            public virtual IntPtr Create() { return CreateJobObject(IntPtr.Zero, null); }
            public virtual bool Configure(IntPtr job)
            {
                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                // Preserve KILL_ON_JOB_CLOSE | BREAKAWAY_OK (ADR-0008).
                info.Basic.LimitFlags = 0x2000 | 0x800;
                return SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            }
            public virtual bool Assign(IntPtr job, Process process) { return AssignProcessToJobObject(job, process.Handle); }
            public virtual bool Terminate(IntPtr job) { return TerminateJobObject(job, 1); }
            public virtual bool Close(IntPtr job) { return CloseHandle(job); }
            public virtual uint WaitForExit(Process process) { return WaitForSingleObject(process.Handle, 2000); }
            public virtual int Error { get { return Marshal.GetLastWin32Error(); } }
        }

        internal static void CreateConfigured(ref IntPtr job, Calls calls)
        {
            job = calls.Create();
            if (job == IntPtr.Zero) throw new Win32Exception(calls.Error, "CreateJobObject failed");
            if (!calls.Configure(job)) throw new Win32Exception(calls.Error, "SetInformationJobObject failed");
        }

        internal static void Assign(IntPtr job, Process process, Calls calls)
        {
            if (!calls.Assign(job, process)) throw new Win32Exception(calls.Error, "AssignProcessToJobObject failed");
        }

        internal static void Kill(ref IntPtr job, Calls calls)
        {
            if (job == IntPtr.Zero) return;
            // Keep the exact handle on either failure. Closing after a failed
            // terminate would discard evidence and let a replacement race it.
            if (!calls.Terminate(job)) throw new Win32Exception(calls.Error, "TerminateJobObject failed");
            if (!calls.Close(job)) throw new Win32Exception(calls.Error, "CloseHandle failed");
            job = IntPtr.Zero;
        }
    }

    // ----------------------------------------------------------- supervisor
    class Supervised
    {
        public readonly string Name;
        readonly Func<ProcessStartInfo> makeStartInfo;
        readonly int[] backoffSeconds;
        readonly Jobs.Calls jobCalls;
        readonly object gate = new object();
        Process proc;
        IntPtr job = IntPtr.Zero;
        System.Threading.Timer restartTimer;
        int attempt;
        bool stopped = true;
        bool autoRetry = true;
        string ownershipError;
        public DateTime? RunningSince;
        public int Restarts;
        public string LastExit = "";
        public event Action<string, string> Line;   // source, text
        public event Action Exited;

        public Supervised(string name, Func<ProcessStartInfo> makeStartInfo, int[] backoffSeconds)
            : this(name, makeStartInfo, backoffSeconds, new Jobs.Calls()) { }

        internal Supervised(string name, Func<ProcessStartInfo> makeStartInfo, int[] backoffSeconds, Jobs.Calls jobCalls)
            : this(name, makeStartInfo, backoffSeconds, jobCalls, true) { }

        internal Supervised(string name, Func<ProcessStartInfo> makeStartInfo, int[] backoffSeconds, Jobs.Calls jobCalls, bool autoRetry)
        {
            Name = name;
            this.makeStartInfo = makeStartInfo;
            this.backoffSeconds = backoffSeconds;
            this.jobCalls = jobCalls;
            this.autoRetry = autoRetry;
        }

        internal string Identity { get { lock (gate) { return IdentityLocked(); } } }
        string IdentityLocked()
        {
            if (ownershipError != null || proc == null || proc.HasExited) return null;
            return proc.Id + ":" + proc.StartTime.ToUniversalTime().Ticks;
        }
        internal bool Released { get { lock (gate) { return ownershipError == null && proc == null && job == IntPtr.Zero; } } }
        internal bool StopExact(string expected)
        {
            lock (gate)
            {
                if (expected == null || IdentityLocked() != expected) return false;
                stopped = true;
                if (restartTimer != null) { restartTimer.Dispose(); restartTimer = null; }
                return StopOwned();
            }
        }
        internal bool EnableRetry(string expected)
        {
            lock (gate)
            {
                if (stopped || expected == null || IdentityLocked() != expected) return false;
                autoRetry = true; return true;
            }
        }

        public bool OwnershipBlocked { get { lock (gate) { return ownershipError != null; } } }
        // A physically alive but uncertain child must never look successfully
        // supervised. The error is latched for this instance, even after cleanup.
        public bool IsRunning { get { lock (gate) { return ownershipError == null && proc != null && !proc.HasExited; } } }

        void BlockOwnership(Exception error)
        {
            if (ownershipError == null) ownershipError = error.Message;
            stopped = true;
            RunningSince = null;
            if (restartTimer != null) { restartTimer.Dispose(); restartTimer = null; }
            Emit("ownership blocked: " + error.Message + "; replacement disabled");
        }

        bool StopOwned()
        {
            try
            {
                Jobs.Kill(ref job, jobCalls);
                // Process.WaitForExit can synchronously invoke Exited, whose
                // callback also takes gate. Wait on the held native handle to
                // avoid reversing the Process-event/gate lock order.
                if (proc != null && jobCalls.WaitForExit(proc) != 0)
                    throw new InvalidOperationException("Owned process exit unconfirmed");
                return true;
            }
            catch (Exception error) { BlockOwnership(error); return false; }
        }

        public void Start()
        {
            lock (gate) { if (ownershipError != null) return; stopped = false; }
            Launch();
        }

        void Launch()
        {
            lock (gate)
            {
                // Root exit is not tree cleanup: a delayed OnExited still owns
                // both identities. Only checked cleanup may clear them before
                // another launch; never overwrite an exited root's live Job.
                if (stopped || ownershipError != null || proc != null || job != IntPtr.Zero) return;
                ProcessStartInfo psi;
                try { psi = makeStartInfo(); }
                catch (Exception e) { Emit("cannot start: " + e.Message); ScheduleRestart(); return; }
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                // Configure containment BEFORE any process can start. A create /
                // setup failure therefore has no uncontained child to replace.
                try { Jobs.CreateConfigured(ref job, jobCalls); }
                catch (Exception error) { BlockOwnership(error); StopOwned(); return; }
                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.OutputDataReceived += (s, e) => { if (e.Data != null) Emit(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) Emit(e.Data); };
                p.Exited += OnExited;
                try { p.Start(); }
                catch (Exception error)
                {
                    p.Dispose();
                    Emit("start failed: " + error.Message);
                    if (StopOwned()) ScheduleRestart();
                    return;
                }
                proc = p;
                bool assigned = false;
                try
                {
                    Jobs.Assign(job, p, jobCalls);
                    assigned = true;
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    RunningSince = DateTime.Now;
                    Emit("started (pid " + p.Id + ")");
                }
                catch (Exception e)
                {
                    BlockOwnership(e);
                    // Assignment failure is NOT containment. Retain the exact
                    // Process handle, kill only that root if still unassigned,
                    // and latch the uncertainty even if root cleanup succeeds.
                    // Children that raced before assignment cannot be certified.
                    if (!assigned)
                    {
                        Emit("uncontained start (pid " + p.Id + "); no automatic recovery");
                        try { if (!p.HasExited) p.Kill(); }
                        catch (Exception cleanup) { BlockOwnership(cleanup); }
                    }
                    StopOwned();
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
                bool cleaned = StopOwned();
                if (cleaned) { proc = null; p.Dispose(); }
                RunningSince = null;
                if (cleaned && !stopped && ownershipError == null) { Restarts++; ScheduleRestart(); }
            }
            var h = Exited; if (h != null) h();
        }

        void ScheduleRestart()
        {
            if (stopped || ownershipError != null || !autoRetry) return;
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
                if (ownershipError != null) return;
                attempt = 0;
                if (proc == null) { if (!stopped && autoRetry) { if (restartTimer != null) restartTimer.Dispose(); ThreadPool.QueueUserWorkItem(_ => Launch()); } return; }
                Emit("restart requested");
                StopOwned();
            }
        }

        public void Stop()
        {
            lock (gate)
            {
                stopped = true;
                if (restartTimer != null) restartTimer.Dispose();
                StopOwned();
            }
        }

        void Emit(string text) { var h = Line; if (h != null) h(Name, text); }
    }

    // A snapshot binds exact file bytes, a serialized SSH plan and every setting
    // outside the optional pair. No registry, credential lookup or new transport.
    sealed class TunnelConfigSnapshot
    {
        readonly byte[] bytes;
        public readonly string FileHash, FixedHash, PlanJson, PlanHash;
        public Config Settings { get { return Config.Parse(Text(bytes)); } }
        public byte[] Bytes { get { return (byte[])bytes.Clone(); } }
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        internal static string Hash(byte[] value)
        { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
        internal static string Hash(string value) { return Hash(Encoding.UTF8.GetBytes(value)); }
        static string Text(byte[] value)
        { string text = new UTF8Encoding(false, true).GetString(value); return text.TrimStart('\ufeff'); }
        static string Canonical(object value)
        {
            var map = value as Dictionary<string, object>;
            if (map != null)
            {
                var keys = new List<string>(map.Keys); keys.Sort(StringComparer.Ordinal);
                var items = new List<string>(); foreach (string key in keys) items.Add(Json.Serialize(key) + ":" + Canonical(map[key]));
                return "{" + String.Join(",", items.ToArray()) + "}";
            }
            var array = value as System.Collections.IEnumerable;
            if (array != null && !(value is string))
            { var items = new List<string>(); foreach (object item in array) items.Add(Canonical(item)); return "[" + String.Join(",", items.ToArray()) + "]"; }
            return Json.Serialize(value);
        }
        public static TunnelConfigSnapshot Read(string path) { return new TunnelConfigSnapshot(File.ReadAllBytes(path)); }
        public TunnelConfigSnapshot(byte[] value)
        {
            bytes = (byte[])value.Clone(); var c = Settings;
            if (c.LocalPort < 1 || c.LocalPort > 65535 || c.RemotePort < 1 || c.RemotePort > 65535 || c.VpsHost == "")
                throw new ArgumentException("Invalid primary tunnel settings");
            FileHash = Hash(bytes);
            var fixedSettings = Json.Deserialize<Dictionary<string, object>>(Text(bytes));
            fixedSettings.Remove("secondLocalPort"); fixedSettings.Remove("secondRemotePort");
            FixedHash = Hash(Canonical(fixedSettings));
            PlanJson = "{\"version\":1,\"sshArguments\":" + Json.Serialize(Arguments(c)) + "}";
            PlanHash = Hash(PlanJson);
        }
        static string Q(string value) { return "\"" + value + "\""; }
        internal static string Arguments(Config c)
        {
            return "-N -T -i " + Q(c.SshKey) +
                " -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes" +
                " -o UserKnownHostsFile=" + Q(c.KnownHosts) +
                " -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes" +
                " -o ConnectTimeout=15 -o LogLevel=VERBOSE" +
                " -R 127.0.0.1:" + c.RemotePort + ":127.0.0.1:" + c.LocalPort +
                (c.SecondLocalPort == 0 ? "" : " -R 127.0.0.1:" + c.SecondRemotePort + ":127.0.0.1:" + c.SecondLocalPort) +
                " " + c.TunnelUser + "@" + c.VpsHost;
        }
    }

    sealed class TunnelInstance
    {
        public readonly Supervised Process;
        public readonly Func<bool> Ready;
        public TunnelInstance(Supervised process, Func<bool> ready) { Process = process; Ready = ready; }
    }

    // Exact, single-use review receipt. Neither reference equality nor a mutable
    // Config instance authorizes apply. Proposal bytes are re-read under a lock.
    sealed class TunnelChange
    {
        public readonly string ProposalPath, Serialized, Hash, NodeIdentity, TunnelIdentity;
        public readonly TunnelConfigSnapshot Before, After;
        public TunnelChange(string path, TunnelConfigSnapshot before, TunnelConfigSnapshot after, string node, string tunnel)
        {
            ProposalPath = path; Before = before; After = after; NodeIdentity = node; TunnelIdentity = tunnel;
            Serialized = new JavaScriptSerializer().Serialize(new { version = 1, beforeConfig = before.FileHash,
                beforePlan = before.PlanHash, afterConfig = after.FileHash, afterPlan = after.PlanHash,
                nodeIdentity = node, tunnelIdentity = tunnel });
            Hash = TunnelConfigSnapshot.Hash(Serialized);
        }
    }

    class TunnelFileWrites
    {
        public virtual void Write(FileStream file, byte[] bytes)
        { file.Position = 0; file.Write(bytes, 0, bytes.Length); file.SetLength(bytes.Length); file.Flush(true); }
    }

    // One synchronous, bounded tunnel replacement. Existing node supervision
    // remains independent. A new supervisor cannot exist until checked release
    // of its predecessor, and has no automatic retries until commit succeeds.
    sealed class TunnelChanges
    {
        readonly object gate = new object();
        readonly string configPath;
        readonly Supervised node;
        readonly Func<TunnelConfigSnapshot, bool, TunnelInstance> create;
        readonly Action<Supervised> select;
        readonly TunnelFileWrites writes;
        readonly int timeoutMs;
        TunnelConfigSnapshot active;
        TunnelInstance current;
        public bool Blocked { get; private set; }
        public string LastFailure { get; private set; }
        public TunnelConfigSnapshot Active { get { lock (gate) return active; } }
        public TunnelChanges(string path, TunnelConfigSnapshot snapshot, Supervised node, TunnelInstance tunnel,
            Func<TunnelConfigSnapshot, bool, TunnelInstance> create, Action<Supervised> select, int timeoutMs, TunnelFileWrites writes)
        { configPath = Path.GetFullPath(path); active = snapshot; this.node = node; current = tunnel;
            this.create = create; this.select = select; this.timeoutMs = timeoutMs; this.writes = writes; }
        // Resume/network callbacks cannot race the transition or revive its old
        // supervisor. Fail-closed also prevents maintenance after uncertainty.
        public void Maintain(Action action) { lock (gate) { if (!Blocked) action(); } }
        public TunnelChange Prepare(string proposalPath, string expectedConfig, string expectedPlan)
        {
            if (!Monitor.TryEnter(gate)) throw new InvalidOperationException("Tunnel change already in progress");
            try
            {
                if (Blocked) throw new InvalidOperationException("Tunnel changes blocked; inspect evidence");
                string path = Path.GetFullPath(proposalPath);
                if (String.Equals(path, configPath, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Use a separate proposed config file");
                var before = TunnelConfigSnapshot.Read(configPath); var after = TunnelConfigSnapshot.Read(path);
                Validate(before, after, expectedConfig, expectedPlan);
                string n = node.Identity, t = current.Process.Identity;
                if (n == null || t == null) throw new InvalidOperationException("Running owned node and tunnel required");
                return new TunnelChange(path, before, after, n, t);
            }
            finally { Monitor.Exit(gate); }
        }
        void Validate(TunnelConfigSnapshot before, TunnelConfigSnapshot after, string expectedConfig, string expectedPlan)
        {
            if (before.FileHash != expectedConfig || active.FileHash != expectedConfig || before.PlanHash != expectedPlan || active.PlanHash != expectedPlan)
                throw new InvalidOperationException("Stale active config or plan");
            if (before.FixedHash != after.FixedHash) throw new InvalidOperationException("Only the second port pair may change");
        }
        static byte[] Read(FileStream file)
        { file.Position = 0; using (var buffer = new MemoryStream()) { file.CopyTo(buffer); return buffer.ToArray(); } }
        bool Wait(Func<bool> predicate)
        {
            var watch = Stopwatch.StartNew();
            do { if (predicate()) return true; Thread.Sleep(20); } while (watch.ElapsedMilliseconds < timeoutMs);
            return false;
        }
        bool Retire(TunnelInstance instance, string expected)
        {
            if (expected != null) { if (!instance.Process.StopExact(expected)) return false; }
            else instance.Process.Stop(); // Only an uncommitted instance owned by this transaction.
            return Wait(() => instance.Process.Released);
        }
        string Ready(TunnelInstance instance, string nodeIdentity)
        {
            string identity = instance.Process.Identity;
            if (identity == null || !Wait(() => node.Identity != nodeIdentity || !instance.Process.IsRunning || instance.Ready())) return null;
            return node.Identity == nodeIdentity && instance.Process.Identity == identity && instance.Ready() ? identity : null;
        }
        TunnelInstance Launch(TunnelConfigSnapshot snapshot)
        {
            var instance = create(snapshot, false); current = instance; select(instance.Process); instance.Process.Start(); return instance;
        }
        public string Apply(TunnelChange change, string expectedHash)
        {
            if (!Monitor.TryEnter(gate)) throw new InvalidOperationException("Tunnel change already in progress");
            try
            {
                if (Blocked || change.Hash != expectedHash || TunnelConfigSnapshot.Hash(change.Serialized) != expectedHash)
                    throw new InvalidOperationException("Blocked or mismatched change receipt");
                using (var file = new FileStream(configPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                using (var proposed = new FileStream(change.ProposalPath, FileMode.Open, FileAccess.Read, FileShare.None))
                {
                    var before = new TunnelConfigSnapshot(Read(file)); var after = new TunnelConfigSnapshot(Read(proposed));
                    Validate(before, after, change.Before.FileHash, change.Before.PlanHash);
                    if (after.FileHash != change.After.FileHash || after.PlanHash != change.After.PlanHash ||
                        node.Identity != change.NodeIdentity || current.Process.Identity != change.TunnelIdentity)
                        throw new InvalidOperationException("Stale proposal or process identity");
                    LastFailure = null;
                    if (!Retire(current, change.TunnelIdentity)) { Blocked = true; LastFailure = "Old tunnel release unconfirmed"; return "blocked: old tunnel release unconfirmed"; }
                    TunnelInstance replacement = null;
                    try
                    {
                        if (node.Identity != change.NodeIdentity) throw new InvalidOperationException("Node identity changed");
                        replacement = Launch(after);
                        string identity = Ready(replacement, change.NodeIdentity);
                        if (identity == null) throw new InvalidOperationException("Replacement readiness unconfirmed");
                        writes.Write(file, after.Bytes);
                        if (TunnelConfigSnapshot.Hash(Read(file)) != after.FileHash) throw new IOException("Config write readback mismatch");
                        if (node.Identity != change.NodeIdentity || !replacement.Process.EnableRetry(identity))
                            throw new InvalidOperationException("Identity changed before commit");
                        active = after; return "applied";
                    }
                    catch (Exception failure)
                    {
                        LastFailure = failure.GetType().Name + ": " + failure.Message;
                        // Stop even a failed/unready candidate before touching rollback.
                        // A native ownership latch never permits another replacement.
                        if (replacement == null) replacement = current;
                        if (!Retire(replacement, null)) { Blocked = true; return "blocked: candidate release unconfirmed"; }
                        try
                        {
                            if (TunnelConfigSnapshot.Hash(Read(file)) != before.FileHash) writes.Write(file, before.Bytes);
                            if (TunnelConfigSnapshot.Hash(Read(file)) != before.FileHash || node.Identity != change.NodeIdentity)
                                throw new IOException("Rollback config or node identity unconfirmed");
                            var rollback = Launch(before);
                            string identity = Ready(rollback, change.NodeIdentity);
                            if (identity == null || !rollback.Process.EnableRetry(identity)) throw new IOException("Rollback readiness unconfirmed");
                            return "rolled-back";
                        }
                        catch (Exception rollbackFailure)
                        {
                            LastFailure += "; rollback " + rollbackFailure.GetType().Name + ": " + rollbackFailure.Message;
                            current.Process.Stop(); Wait(() => current.Process.Released);
                            Blocked = true; return "blocked: rollback unconfirmed; no retries";
                        }
                    }
                }
            }
            finally { Monitor.Exit(gate); }
        }
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
        TunnelChanges tunnelChanges;
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
                if (e.Mode == PowerModes.Resume && tunnelChanges != null) tunnelChanges.Maintain(() => { Log("app", "resumed from sleep; reconnecting tunnel"); tunnel.Restart(); });
            };
            NetworkChange.NetworkAvailabilityChanged += (s, e) =>
            {
                if (e.IsAvailable && tunnelChanges != null) tunnelChanges.Maintain(() => { if (!TunnelConnected) { Log("app", "network available; reconnecting tunnel"); tunnel.Restart(); } });
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
            menu.Items.Add("Apply tunnel-only config...", null, (s, e) => ApplyTunnelConfig());
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
            TunnelConfigSnapshot snapshot;
            try { snapshot = TunnelConfigSnapshot.Read(Config.FilePath); config = snapshot.Settings; }
            catch (Exception error) { configError = error.Message; Log("app", "NOT CONFIGURED: " + configError); return; }
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

            Func<TunnelConfigSnapshot, bool, TunnelInstance> makeTunnel = (plan, retry) =>
            {
                var c = plan.Settings;
                var process = new Supervised("tunnel", () => new ProcessStartInfo(ssh, TunnelConfigSnapshot.Arguments(c)),
                    new[] { 1, 2, 5, 10, 15 }, new Jobs.Calls(), retry);
                DateTime? authenticated = null; var authGate = new object();
                process.Line += Log;
                process.Line += (src, text) => { if (text.Contains("Authenticated to")) lock (authGate) {
                    authenticated = DateTime.Now; if (tunnel == process) tunnelAuthAt = authenticated;
                } };
                process.Exited += () => { if (!process.IsRunning) lock (authGate) {
                    authenticated = null; if (tunnel == process) tunnelAuthAt = null;
                } };
                return new TunnelInstance(process, () => { lock (authGate) return authenticated.HasValue && (DateTime.Now - authenticated.Value).TotalSeconds >= 2; });
            };

            var initial = makeTunnel(snapshot, true); tunnel = initial.Process;
            tunnelChanges = new TunnelChanges(Config.FilePath, snapshot, bridge, initial, makeTunnel,
                selected => { tunnelAuthAt = null; tunnel = selected; }, 20000, new TunnelFileWrites());
            bridge.Line += Log;
            bridge.Start();
            tunnel.Start();
        }

        void ApplyTunnelConfig()
        {
            if (tunnelChanges == null) { Log("app", "Tunnel-only apply requires configured running services"); return; }
            using (var picker = new OpenFileDialog { Title = "Select proposed config (only secondLocalPort / secondRemotePort may differ)", Filter = "JSON config|*.json" })
            {
                if (picker.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    var active = tunnelChanges.Active;
                    var change = tunnelChanges.Prepare(picker.FileName, active.FileHash, active.PlanHash);
                    if (MessageBox.Show(this, "Replace the SSH tunnel only? Existing primary TCP sessions will disconnect. The local server stays running.\n\nChange: " + change.Hash +
                        "\nPlan: " + change.Before.PlanHash + " -> " + change.After.PlanHash,
                        "Apply tunnel-only config", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
                    string result = tunnelChanges.Apply(change, change.Hash);
                    config = tunnelChanges.Active.Settings;
                    Log("app", "tunnel-only change " + change.Hash + ": " + result);
                    if (tunnelChanges.LastFailure != null) Log("app", "tunnel-only failure: " + tunnelChanges.LastFailure);
                }
                catch (Exception error) { Log("app", "tunnel-only apply refused: " + error.Message); }
            }
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
            tunnelChanges.Maintain(() => { bridge.Restart(); tunnel.Restart(); });
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
                        tunnelChanges.Maintain(() => bridge.Restart());
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
            bridgeLabel.Text = "Local server: " + (bridge != null && bridge.OwnershipBlocked ? "ownership blocked; inspect log" : bridgeRunning ? (dcUp ? "running" : "starting") + Since(bridge.RunningSince) : "stopped") + RestartInfo(bridge);
            bool connected = TunnelConnected;
            tunnelLabel.Text = "Tunnel to VPS: " + (tunnelChanges != null && tunnelChanges.Blocked ? "change blocked; inspect log" : tunnel != null && tunnel.OwnershipBlocked ? "ownership blocked; inspect log" : connected ? "connected" + Since(tunnelAuthAt) : tunnel != null && tunnel.IsRunning ? "connecting" : "disconnected") + RestartInfo(tunnel);
            publicLabel.Text = config.PublicUrl == "" ? "" : "Public endpoint: " + (!publicChecked ? "checking" : publicUp ? "reachable" : "unreachable") + "  (" + config.PublicUrl + ")";
            if ((tunnelChanges != null && tunnelChanges.Blocked) || (bridge != null && bridge.OwnershipBlocked) || (tunnel != null && tunnel.OwnershipBlocked)) SetTray(iconBad, "MCPRelay - ownership/change blocked");
            else if (bridgeRunning && dcUp && connected) SetTray(iconOk, "MCPRelay - connected");
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
