// mcprelay-proc.exe: Windows process helper for the MCPRelay node capability
// server (ADR-0008). The server runs it once per operation: one JSON request on
// stdin, one JSON result on stdout.
//
//   {"op":"inspect","all":true} | {"op":"inspect","pids":[1,2]}
//     -> {"ok":true,"processes":[{pid,ppid,name,exe,cmd,cwd,start,start_iso,wow64?,access?}]}
//   {"op":"stop","pid":n,"start":"<key>","graceful":"auto|console_ctrl|close|none",
//    "graceful_ms":n,"force":bool,"tree":bool}
//     -> {"ok":true,"result":"stopped|still_running|identity_mismatch|not_found|access_denied",
//         "graceful":"ctrl_c|ctrl_c+ctrl_break|wm_close"|null,"forced":bool,...}
//   {"op":"spawn","exe":"...","args":[...],"cwd":"...","log":"..."}
//     -> {"ok":true,"pid":n,"start":"<key>","start_iso":"...","in_job":bool,"breakaway":bool}
//
// A process is identified by its PID plus its creation time ("start": microseconds
// since 1601 UTC). stop checks the creation time on an open process handle and
// terminates through that same handle, so a reused PID is never hit.
// spawn starts the program without a console window but with its own (hidden)
// console, so it can later be stopped with Ctrl+C, and outside the supervisor's
// Job Object (CREATE_BREAKAWAY_FROM_JOB), so it outlives the node server.
//
// Built with the .NET Framework 4.x csc that ships with Windows, /platform:x64;
// C# 5 language level on purpose (same as MCPRelay.cs).

using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

static class Native
{
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsWow64Process(IntPtr h, out bool wow);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int retLen);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetConsoleProcessList(uint[] list, uint count);
    public delegate bool CtrlHandler(uint ev);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(CtrlHandler handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetConsoleCtrlHandler")] public static extern bool SetConsoleCtrlIgnore(IntPtr nullHandler, bool ignore);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct PROCESSENTRY32W
{
    public uint dwSize, cntUsage, th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
}
[StructLayout(LayoutKind.Sequential)]
struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct STARTUPINFO
{
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
}
[StructLayout(LayoutKind.Sequential)]
struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
[StructLayout(LayoutKind.Sequential)]
struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

static class ProcHelper
{
    const uint QUERY_LIMITED = 0x1000, VM_READ = 0x10, TERMINATE = 0x1, SYNCHRONIZE = 0x100000;
    static readonly IntPtr INVALID = new IntPtr(-1);
    static Native.CtrlHandler ignoreCtrl = delegate(uint ev) { return true; }; // keep referenced

    class Entry { public uint Pid, Ppid; public string Name; }

    static int Main()
    {
        // Capture stdout before any console attach/detach can change the standard handles.
        Stream output = Console.OpenStandardOutput();
        var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        object result;
        try
        {
            string input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)).ReadToEnd();
            var q = ser.Deserialize<Dictionary<string, object>>(input);
            string op = Str(q, "op", "");
            if (op == "inspect") result = InspectOp(q);
            else if (op == "stop") result = StopOp(q);
            else if (op == "spawn") result = SpawnOp(q);
            else result = Fail("unknown op: " + op);
        }
        catch (Exception e) { result = Fail(e.Message); }
        byte[] bytes = new UTF8Encoding(false).GetBytes(ser.Serialize(result));
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
        return 0;
    }

    // ------------------------------------------------------------ helpers
    static Dictionary<string, object> Fail(string message)
    {
        var r = new Dictionary<string, object>(); r["ok"] = false; r["error"] = message; return r;
    }
    static Dictionary<string, object> Ok() { var r = new Dictionary<string, object>(); r["ok"] = true; return r; }
    static string Str(Dictionary<string, object> q, string k, string dflt) { object v; return q.TryGetValue(k, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : dflt; }
    static int Int(Dictionary<string, object> q, string k, int dflt) { object v; return q.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v, CultureInfo.InvariantCulture) : dflt; }
    static bool Bool(Dictionary<string, object> q, string k, bool dflt) { object v; return q.TryGetValue(k, out v) && v is bool ? (bool)v : dflt; }

    static string Key(long filetime) { return (filetime / 10).ToString(CultureInfo.InvariantCulture); }
    static string Iso(long filetime)
    {
        return DateTime.FromFileTimeUtc(filetime / 10 * 10).ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture);
    }
    static bool StartOf(IntPtr h, out long ft) { long x, k, u; return Native.GetProcessTimes(h, out ft, out x, out k, out u) && ft != 0; }
    static long StartOfPid(uint pid)
    {
        IntPtr h = Native.OpenProcess(QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) return 0;
        try { long ft; return StartOf(h, out ft) ? ft : 0; } finally { Native.CloseHandle(h); }
    }
    static bool Exited(IntPtr h) { return Native.WaitForSingleObject(h, 0) == 0; }

    static List<Entry> Snapshot()
    {
        var list = new List<Entry>();
        IntPtr snap = Native.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if (snap == INVALID) throw new Win32Exception();
        try
        {
            var e = new PROCESSENTRY32W();
            e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            for (bool ok = Native.Process32FirstW(snap, ref e); ok; ok = Native.Process32NextW(snap, ref e))
                list.Add(new Entry { Pid = e.th32ProcessID, Ppid = e.th32ParentProcessID, Name = e.szExeFile });
        }
        finally { Native.CloseHandle(snap); }
        return list;
    }

    // Descendants of root (pid -> creation time). A child must have been created
    // after its parent, which excludes processes whose parent PID was reused.
    static Dictionary<uint, long> Descendants(List<Entry> snap, uint root, long rootStart)
    {
        var found = new Dictionary<uint, long>();
        var queue = new Queue<KeyValuePair<uint, long>>();
        queue.Enqueue(new KeyValuePair<uint, long>(root, rootStart));
        while (queue.Count > 0)
        {
            var cur = queue.Dequeue();
            foreach (var e in snap)
            {
                if (e.Ppid != cur.Key || e.Pid == root || found.ContainsKey(e.Pid)) continue;
                long st = StartOfPid(e.Pid);
                if (st == 0 || st < cur.Value) continue;
                found[e.Pid] = st;
                queue.Enqueue(new KeyValuePair<uint, long>(e.Pid, st));
            }
        }
        return found;
    }

    // ------------------------------------------------------------ inspect
    static object InspectOp(Dictionary<string, object> q)
    {
        var snap = Snapshot();
        HashSet<uint> want = null;
        object pids;
        if (!Bool(q, "all", false) && q.TryGetValue("pids", out pids) && pids is IEnumerable)
        {
            want = new HashSet<uint>();
            foreach (object p in (IEnumerable)pids) want.Add(Convert.ToUInt32(p, CultureInfo.InvariantCulture));
        }
        var rows = new List<object>();
        foreach (var e in snap)
            if (want == null || want.Contains(e.Pid)) rows.Add(Inspect(e));
        var r = Ok(); r["processes"] = rows; return r;
    }

    static Dictionary<string, object> Inspect(Entry e)
    {
        var r = new Dictionary<string, object>();
        r["pid"] = e.Pid; r["ppid"] = e.Ppid; r["name"] = e.Name;
        IntPtr h = Native.OpenProcess(QUERY_LIMITED | VM_READ, false, e.Pid);
        bool vm = h != IntPtr.Zero;
        if (!vm) h = Native.OpenProcess(QUERY_LIMITED, false, e.Pid);
        if (h == IntPtr.Zero) { r["access"] = "denied"; return r; }
        try
        {
            long ft;
            if (StartOf(h, out ft)) { r["start"] = Key(ft); r["start_iso"] = Iso(ft); }
            var sb = new StringBuilder(32768); uint n = (uint)sb.Capacity;
            if (Native.QueryFullProcessImageNameW(h, 0, sb, ref n)) r["exe"] = sb.ToString(0, (int)n);
            r["cmd"] = CommandLine(h);
            bool wow;
            if (Native.IsWow64Process(h, out wow) && wow) r["wow64"] = true;
            else if (vm) r["cwd"] = Cwd(h);
            if (!vm) r["access"] = "limited";
        }
        finally { Native.CloseHandle(h); }
        return r;
    }

    // ProcessCommandLineInformation (60, Windows 8.1+): needs only QUERY_LIMITED.
    static string CommandLine(IntPtr h)
    {
        int len;
        Native.NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out len);
        if (len <= 0 || len > 1 << 20) return null;
        IntPtr buf = Marshal.AllocHGlobal(len);
        try
        {
            if (Native.NtQueryInformationProcess(h, 60, buf, len, out len) != 0) return null;
            int bytes = Marshal.ReadInt16(buf) & 0xFFFF; // UNICODE_STRING.Length
            IntPtr text = Marshal.ReadIntPtr(buf, 8);
            return bytes == 0 ? "" : Marshal.PtrToStringUni(text, bytes / 2);
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    // Working directory from the 64-bit PEB: Peb->ProcessParameters (+0x20) ->
    // CurrentDirectory.DosPath (+0x38). Not available for 32-bit (WOW64) processes.
    static string Cwd(IntPtr h)
    {
        IntPtr pbi = Marshal.AllocHGlobal(48);
        try
        {
            int ret;
            if (Native.NtQueryInformationProcess(h, 0, pbi, 48, out ret) != 0) return null;
            IntPtr peb = Marshal.ReadIntPtr(pbi, 8);
            byte[] pp = Read(h, IntPtr.Add(peb, 0x20), 8);
            if (pp == null) return null;
            IntPtr parms = new IntPtr(BitConverter.ToInt64(pp, 0));
            byte[] us = Read(h, IntPtr.Add(parms, 0x38), 16);
            if (us == null) return null;
            int len = BitConverter.ToUInt16(us, 0);
            if (len == 0) return null;
            byte[] s = Read(h, new IntPtr(BitConverter.ToInt64(us, 8)), len);
            return s == null ? null : Encoding.Unicode.GetString(s);
        }
        finally { Marshal.FreeHGlobal(pbi); }
    }
    static byte[] Read(IntPtr h, IntPtr addr, int n)
    {
        if (addr == IntPtr.Zero) return null;
        var b = new byte[n]; IntPtr got;
        return Native.ReadProcessMemory(h, addr, b, new IntPtr(n), out got) && got.ToInt64() == n ? b : null;
    }

    // --------------------------------------------------------------- stop
    static object StopOp(Dictionary<string, object> q)
    {
        uint pid = (uint)Int(q, "pid", 0);
        string want = Str(q, "start", "");
        string mode = Str(q, "graceful", "auto");
        int ms = Math.Max(0, Math.Min(Int(q, "graceful_ms", 10000), 60000));
        bool force = Bool(q, "force", false), tree = Bool(q, "tree", true);
        var r = Ok(); r["pid"] = pid;
        IntPtr h = Native.OpenProcess(QUERY_LIMITED | SYNCHRONIZE | TERMINATE, false, pid);
        if (h == IntPtr.Zero)
        {
            int err = Marshal.GetLastWin32Error();
            r["result"] = err == 5 ? "access_denied" : "not_found";
            return r;
        }
        try
        {
            long ft;
            if (!StartOf(h, out ft) || Key(ft) != want)
            {
                r["result"] = "identity_mismatch";
                if (ft != 0) r["actual_start"] = Key(ft);
                return r;
            }
            if (Exited(h)) { r["result"] = "not_found"; r["note"] = "already exited"; return r; }
            var desc = tree ? Descendants(Snapshot(), pid, ft) : new Dictionary<uint, long>();
            var sw = Stopwatch.StartNew();
            string note = null, graceful = null;
            if (mode != "none") graceful = Graceful(mode, pid, desc, h, ms, out note);
            r["graceful"] = graceful;
            if (note != null) r["graceful_note"] = note;
            bool forced = false; int killed = 0;
            if (!Exited(h) && force)
            {
                Native.TerminateProcess(h, 1);
                forced = true;
                Native.WaitForSingleObject(h, 5000);
            }
            if (forced && tree)
            {
                foreach (var d in desc)
                {
                    IntPtr c = Native.OpenProcess(QUERY_LIMITED | TERMINATE, false, d.Key);
                    if (c == IntPtr.Zero) continue;
                    try { long cs; if (StartOf(c, out cs) && cs == d.Value && !Exited(c) && Native.TerminateProcess(c, 1)) killed++; }
                    finally { Native.CloseHandle(c); }
                }
            }
            r["forced"] = forced;
            r["children_killed"] = killed;
            r["waited_ms"] = sw.ElapsedMilliseconds;
            bool gone = Exited(h);
            r["result"] = gone ? "stopped" : "still_running";
            uint code;
            if (gone && Native.GetExitCodeProcess(h, out code)) r["exit_code"] = (long)code;
            if (graceful == null && !force && note == null && mode != "none") r["graceful_note"] = "no graceful method applied";
            return r;
        }
        finally { Native.CloseHandle(h); }
    }

    // Returns the graceful steps taken, or null when none applies (note says why).
    static string Graceful(string mode, uint pid, Dictionary<uint, long> desc, IntPtr h, int ms, out string note)
    {
        note = null;
        if (mode == "auto" || mode == "console_ctrl")
        {
            string why;
            if (AttachTargetConsole(pid, desc, out why))
            {
                try
                {
                    Native.SetConsoleCtrlHandler(ignoreCtrl, true);
                    Native.GenerateConsoleCtrlEvent(0, 0);  // CTRL_C to every process on that console
                    if (Native.WaitForSingleObject(h, (uint)(ms / 2)) == 0) return "ctrl_c";
                    Native.GenerateConsoleCtrlEvent(1, 0);  // CTRL_BREAK: a process cannot disable it
                    Native.WaitForSingleObject(h, (uint)(ms - ms / 2));
                    return "ctrl_c+ctrl_break";
                }
                finally { Native.FreeConsole(); }
            }
            note = why;
            if (mode == "console_ctrl") return null;
        }
        if (mode == "auto" || mode == "close")
        {
            var owners = new HashSet<uint>(desc.Keys); owners.Add(pid);
            int posted = 0;
            Native.EnumWindows(delegate(IntPtr w, IntPtr l)
            {
                uint wp; Native.GetWindowThreadProcessId(w, out wp);
                if (owners.Contains(wp) && Native.IsWindowVisible(w) && Native.GetWindow(w, 4) == IntPtr.Zero) // GW_OWNER
                {
                    Native.PostMessageW(w, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
                    posted++;
                }
                return true;
            }, IntPtr.Zero);
            if (posted > 0) { Native.WaitForSingleObject(h, (uint)ms); return "wm_close"; }
            note = (note == null ? "" : note + "; ") + "it has no visible top-level window";
        }
        return null;
    }

    // Ctrl+C goes to every process attached to a console, so it is only sent when
    // that console holds nothing but the target and its descendants.
    static bool AttachTargetConsole(uint pid, Dictionary<uint, long> desc, out string why)
    {
        why = null;
        Native.FreeConsole();
        if (!Native.AttachConsole(pid)) { why = "the process has no console"; return false; }
        var list = new uint[256];
        uint n = Native.GetConsoleProcessList(list, (uint)list.Length);
        uint self = (uint)Process.GetCurrentProcess().Id;
        if (n > list.Length) { Native.FreeConsole(); why = "its console is shared with many other processes"; return false; }
        for (int i = 0; i < n; i++)
        {
            uint p = list[i];
            if (p != pid && p != self && !desc.ContainsKey(p)) { Native.FreeConsole(); why = "its console is shared with another process (pid " + p + ")"; return false; }
        }
        return true;
    }

    // -------------------------------------------------------------- spawn
    static object SpawnOp(Dictionary<string, object> q)
    {
        string exe = Str(q, "exe", null), cwd = Str(q, "cwd", null), log = Str(q, "log", null);
        if (string.IsNullOrEmpty(exe)) return Fail("exe is required");
        var cmd = new StringBuilder(Quote(exe));
        object args;
        if (q.TryGetValue("args", out args) && args is IEnumerable && !(args is string))
            foreach (object a in (IEnumerable)args) cmd.Append(' ').Append(Quote(Convert.ToString(a, CultureInfo.InvariantCulture)));

        // The child inherits exactly two handles (PROC_THREAD_ATTRIBUTE_HANDLE_LIST): NUL as
        // stdin and the log (or NUL) as stdout/stderr. Nothing else, in particular not our
        // own stdio pipes: the server waits for those to close.
        var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
        IntPtr outH = IntPtr.Zero, nulH = IntPtr.Zero, attrs = IntPtr.Zero, list = IntPtr.Zero;
        try
        {
            nulH = Native.CreateFileW("NUL", 0x80000000 | 0x40000000, 3, ref sa, 3, 0, IntPtr.Zero); // GENERIC_READ|WRITE, OPEN_EXISTING
            if (nulH == INVALID) { nulH = IntPtr.Zero; return Fail("cannot open NUL: " + new Win32Exception().Message); }
            if (log != null)
            {
                // FILE_APPEND_DATA | SYNCHRONIZE, share read/write/delete, OPEN_ALWAYS
                outH = Native.CreateFileW(log, 0x4 | SYNCHRONIZE, 7, ref sa, 4, 0x80, IntPtr.Zero);
                if (outH == INVALID) { outH = IntPtr.Zero; return Fail("cannot open log " + log + ": " + new Win32Exception().Message); }
            }
            IntPtr size = IntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attrs = Marshal.AllocHGlobal(size);
            if (!Native.InitializeProcThreadAttributeList(attrs, 1, 0, ref size)) throw new Win32Exception();
            int count = outH != IntPtr.Zero ? 2 : 1;
            list = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(list, 0, nulH);
            Marshal.WriteIntPtr(list, IntPtr.Size, outH);
            if (!Native.UpdateProcThreadAttribute(attrs, 0, new IntPtr(0x20002), list, new IntPtr(IntPtr.Size * count), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();

            var si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
            si.StartupInfo.hStdInput = nulH;
            si.StartupInfo.hStdOutput = si.StartupInfo.hStdError = outH != IntPtr.Zero ? outH : nulH;
            si.lpAttributeList = attrs;
            // A console without a window (Ctrl+C can reach it later), outside the supervisor's job.
            // Children inherit "ignore Ctrl+C" from their parent; clear it so the new process gets it.
            Native.SetConsoleCtrlIgnore(IntPtr.Zero, false);
            // Without a console of our own, the child gets a new one. Sharing ours would tie it
            // to our console host, which lives in the supervisor's job and dies with it.
            Native.FreeConsole();
            const uint NO_WINDOW = 0x08000000, BREAKAWAY = 0x01000000, EXTENDED = 0x00080000;
            PROCESS_INFORMATION pi;
            bool breakaway = true;
            bool ok = Native.CreateProcessW(null, new StringBuilder(cmd.ToString()), IntPtr.Zero, IntPtr.Zero, true, NO_WINDOW | EXTENDED | BREAKAWAY, IntPtr.Zero, cwd, ref si, out pi);
            if (!ok && Marshal.GetLastWin32Error() == 5) // the job does not allow breakaway
            {
                breakaway = false;
                ok = Native.CreateProcessW(null, new StringBuilder(cmd.ToString()), IntPtr.Zero, IntPtr.Zero, true, NO_WINDOW | EXTENDED, IntPtr.Zero, cwd, ref si, out pi);
            }
            if (!ok) return Fail(new Win32Exception(Marshal.GetLastWin32Error()).Message);
            try
            {
                var r = Ok();
                r["pid"] = pi.dwProcessId;
                long ft;
                if (StartOf(pi.hProcess, out ft)) { r["start"] = Key(ft); r["start_iso"] = Iso(ft); }
                // Breakaway can succeed for an inner job (Node's own) yet leave the process in
                // an outer one, so report actual membership: in a job = dies with the server.
                bool inJob;
                r["in_job"] = !Native.IsProcessInJob(pi.hProcess, IntPtr.Zero, out inJob) || inJob;
                r["breakaway"] = breakaway;
                return r;
            }
            finally { Native.CloseHandle(pi.hThread); Native.CloseHandle(pi.hProcess); }
        }
        finally
        {
            if (attrs != IntPtr.Zero) { Native.DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (outH != IntPtr.Zero) Native.CloseHandle(outH);
            if (nulH != IntPtr.Zero) Native.CloseHandle(nulH);
        }
    }

    // Quotes one argument by the rules of CommandLineToArgvW / the MSVC runtime.
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in a)
        {
            if (c == '\\') { bs++; continue; }
            if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); }
            else { sb.Append('\\', bs); sb.Append(c); }
            bs = 0;
        }
        sb.Append('\\', bs * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
