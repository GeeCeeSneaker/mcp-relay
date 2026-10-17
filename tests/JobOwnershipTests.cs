// Compiled WITH the actual MCPRelay.cs; never loads installed config or tray.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace MCPRelay
{
    class JobOwnershipTests
    {
        class Identity
        {
            public int Pid;
            public long Start;
            public Identity(Process p) { Pid=p.Id; Start=p.StartTime.ToUniversalTime().Ticks; }
            public Identity(int pid,long start) { Pid=pid; Start=start; }
        }
        // Faults affect one supervisor only. All other operations remain real
        // Win32 calls, including successful cleanup after a forced failure.
        class Calls : Jobs.Calls
        {
            public volatile string Fault;
            public int Creates, Configures, Assigns, Terminates, Closes;
            public List<Identity> Roots=new List<Identity>();
            public HashSet<IntPtr> Handles=new HashSet<IntPtr>();
            public override int Error { get { return 5; } }
            public override IntPtr Create()
            {
                Creates++;
                if(Fault=="create")return IntPtr.Zero;
                var h=base.Create();if(h!=IntPtr.Zero)Handles.Add(h);return h;
            }
            public override bool Configure(IntPtr job)
            { Configures++;return Fault!="configure" && base.Configure(job); }
            public override bool Assign(IntPtr job,Process process)
            {
                Assigns++;Roots.Add(new Identity(process));
                if(Fault=="assign")return false;
                bool assigned=base.Assign(job,process);
                return Fault!="assign_uncertain" && assigned;
            }
            public override bool Terminate(IntPtr job)
            {
                Terminates++;
                if(Fault=="terminate_throw")throw new InvalidOperationException("forced uncertain terminate");
                return Fault!="terminate" && base.Terminate(job);
            }
            public override bool Close(IntPtr job)
            {
                Closes++;
                if(Fault=="close")return false;
                bool closed=base.Close(job);if(closed)Handles.Remove(job);return closed;
            }
            public override uint WaitForExit(Process process)
            { return Fault=="wait_exit" ? 258u : base.WaitForExit(process); }
        }
        static List<Supervised> supervisors=new List<Supervised>();
        static List<Calls> apis=new List<Calls>();
        static List<Identity> descendants=new List<Identity>();
        static int checks;
        static string root, executable;
        static void Check(bool ok,string label)
        { if(!ok)throw new Exception(label);checks++;Console.WriteLine("PASS "+label); }
        static bool Wait(Func<bool> condition)
        { var w=Stopwatch.StartNew();while(w.ElapsedMilliseconds<6000){if(condition())return true;Thread.Sleep(25);}return false; }
        static string Q(string text)
        { if(text.Contains("\""))throw new ArgumentException("quote in owned path");return "\""+text+"\""; }
        static bool Alive(Identity id)
        {
            try { using(var p=Process.GetProcessById(id.Pid))return !p.HasExited && p.StartTime.ToUniversalTime().Ticks==id.Start; }
            catch(ArgumentException) { return false; }
        }
        static string[] Ready(string path)
        {
            try { var parts=File.ReadAllText(path).Split('|');return parts.Length==4 ? parts : null; }
            catch(IOException) { return null; }
        }
        static Identity Leaf(string path)
        {
            var parts=Ready(path);var id=new Identity(Int32.Parse(parts[2]),Int64.Parse(parts[3]));
            descendants.Add(id);return id;
        }
        static ProcessStartInfo Info(string mode,string path)
        { return new ProcessStartInfo(executable,"--"+mode+" "+Q(path)); }
        static Supervised Make(string label,Calls api,Func<ProcessStartInfo> factory)
        {
            var s=new Supervised(label,factory,new []{1},api);supervisors.Add(s);apis.Add(api);return s;
        }
        static void Latched(Supervised s,Calls api,string label)
        {
            int before=api.Creates, roots=api.Assigns;
            s.Start();s.Restart();Thread.Sleep(1250);s.Start();
            Check(api.Creates==before && api.Assigns==roots,label+"_no_timer_manual_or_restart_replacement");
            Check(s.OwnershipBlocked && !s.IsRunning && !s.RunningSince.HasValue,label+"_not_reported_contained");
        }
        static void StartFailures()
        {
            foreach(string fault in new []{"create","configure","assign","assign_uncertain"})
            {
                var api=new Calls { Fault=fault };int started=0;
                string ready=Path.Combine(root,fault+".txt");
                var s=Make(fault,api,()=>Info("idle",ready));
                s.Line+=(name,line)=>{if(line.StartsWith("started (pid "))started++;};
                s.Start();
                Check(s.OwnershipBlocked && started==0,fault+"_fails_closed_before_success_event");
                if(fault=="create" || fault=="configure")
                    Check(api.Assigns==0 && !File.Exists(ready),fault+"_no_child_started");
                else
                    Check(api.Roots.Count==1 && Wait(()=>!Alive(api.Roots[0])),fault+"_exact_root_cleanup");
                api.Fault=null;s.Stop();
                Check(api.Handles.Count==0,fault+"_job_handle_cleanup");
                Latched(s,api,fault);
            }
        }
        static void StopFailures()
        {
            foreach(string fault in new []{"terminate","terminate_throw","close","wait_exit"})
            {
                var api=new Calls();string ready=Path.Combine(root,fault+".txt");
                var s=Make(fault,api,()=>Info("tree",ready));s.Start();
                Check(Wait(()=>Ready(ready)!=null) && s.IsRunning,fault+"_real_tree_ready");
                var first=api.Roots[0];var leaf=Leaf(ready);int closeBefore=api.Closes;
                api.Fault=fault;s.Restart();
                Check(s.OwnershipBlocked,fault+"_restart_blocks_on_native_failure");
                if(fault=="terminate" || fault=="terminate_throw")
                    Check(Alive(first) && Alive(leaf) && api.Closes==closeBefore,fault+"_failed_terminate_retains_handle_and_tree");
                else if(fault=="close")
                    Check(Wait(()=>!Alive(first) && !Alive(leaf)) && api.Handles.Count==1,"failed_close_retains_uncertain_handle");
                else
                    Check(Wait(()=>!Alive(first) && !Alive(leaf)),"unconfirmed_exit_remains_blocked_after_native_stop");
                Latched(s,api,fault);
                // A later explicit Stop can retry exact owned cleanup, but it
                // cannot clear the uncertainty latch or start a new process.
                api.Fault=null;s.Stop();
                Check(Wait(()=>!Alive(first) && !Alive(leaf)) && api.Handles.Count==0,fault+"_explicit_cleanup_of_exact_job");
                Latched(s,api,fault+"_after_cleanup");
            }
        }
        static void RealLifecycle()
        {
            var api=new Calls();string ready=Path.Combine(root,"lifecycle.txt");
            var s=Make("lifecycle",api,()=>Info("tree",ready));s.Start();
            Check(Wait(()=>Ready(ready)!=null) && s.IsRunning,"real_assigned_tree_running");
            var next=api.Roots[0];var nextLeaf=Leaf(ready);
            for(int cycle=0;cycle<6;cycle++)
            {
                var old=next;var oldLeaf=nextLeaf;int count=api.Roots.Count;
                s.Restart();
                Check(Wait(()=>api.Roots.Count==count+1 && Ready(ready)!=null && Int32.Parse(Ready(ready)[0])!=old.Pid),"real_restart_cycle_"+cycle+"_new_exact_identity");
                next=api.Roots[count];nextLeaf=Leaf(ready);
                Check(!Alive(old) && !Alive(oldLeaf) && Alive(next) && Alive(nextLeaf),"real_restart_cycle_"+cycle+"_old_tree_gone_new_tree_contained");
            }
            s.Stop();Check(Wait(()=>!Alive(next) && !Alive(nextLeaf)) && !s.IsRunning,"real_stop_kills_root_and_descendant");
            Check(!s.OwnershipBlocked && api.Handles.Count==0,"real_success_path_not_latched_and_no_handle_leak");

            int attempts=0;var retryApi=new Calls();string retryReady=Path.Combine(root,"retry.txt");
            var retry=Make("ordinary-start-retry",retryApi,()=>++attempts==1 ? new ProcessStartInfo(Path.Combine(root,"does-not-exist.exe")) : Info("idle",retryReady));
            retry.Start();
            Check(Wait(()=>File.Exists(retryReady)) && attempts==2 && retry.IsRunning && !retry.OwnershipBlocked,"ordinary_process_start_failure_retains_backoff_retry");
            retry.Stop();Check(Wait(()=>!Alive(retryApi.Roots[0])) && retryApi.Handles.Count==0,"ordinary_retry_exact_cleanup");
        }
        static bool AllGone()
        {
            foreach(var api in apis)foreach(var id in api.Roots)if(Alive(id))return false;
            foreach(var id in descendants)if(Alive(id))return false;
            return true;
        }
        static int Child(string[] args)
        {
            if(args[0]=="--leaf") { Thread.Sleep(Timeout.Infinite);return 0; }
            if(args[0]=="--idle") { File.WriteAllText(args[1],"ready");Thread.Sleep(Timeout.Infinite);return 0; }
            using(var leaf=Process.Start(new ProcessStartInfo(executable,"--leaf") { UseShellExecute=false,CreateNoWindow=true }))
            using(var current=Process.GetCurrentProcess())
            {
                File.WriteAllText(args[1],current.Id+"|"+current.StartTime.ToUniversalTime().Ticks+"|"+leaf.Id+"|"+leaf.StartTime.ToUniversalTime().Ticks);
                Thread.Sleep(Timeout.Infinite);return 0;
            }
        }
        public static int Main(string[] args)
        {
            executable=System.Reflection.Assembly.GetExecutingAssembly().Location;
            if(args.Length>0 && args[0].StartsWith("--"))return Child(args);
            if(args.Length!=1)return 2;
            root=Path.GetFullPath(args[0]);Directory.CreateDirectory(root);int exit=0;bool fallback=false;
            try { StartFailures();StopFailures();RealLifecycle(); }
            catch(Exception error) { Console.WriteLine("FAIL "+error.GetType().Name+": "+error.Message);exit=1; }
            finally
            {
                foreach(var api in apis)api.Fault=null;
                foreach(var s in supervisors)s.Stop();
                if(!Wait(AllGone))
                {
                    // Emergency test cleanup is selected ONLY by recorded
                    // creation identity. Its use always fails the test run.
                    fallback=true;exit=1;
                    var ids=new List<Identity>(descendants);foreach(var api in apis)ids.AddRange(api.Roots);
                    foreach(var id in ids)if(Alive(id))using(var p=Process.GetProcessById(id.Pid))
                        if(p.StartTime.ToUniversalTime().Ticks==id.Start){p.Kill();p.WaitForExit(2000);}
                }
                foreach(var api in apis)if(api.Handles.Count!=0)exit=1;
                if(!AllGone())exit=1;
            }
            Console.WriteLine("{\"native_checks\":"+checks+",\"owned_cleanup\":"+(AllGone()?"true":"false")+",\"fallback_used\":"+(fallback?"true":"false")+",\"installed_config_used\":false,\"real_win32\":true}");
            return exit;
        }
    }
}
