// Disposable proving executable, compiled WITH the unchanged MCPRelay.cs.
// No Config.Load, tray, real SSH, credentials, host inventory or installed file.
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Diagnostics;
using System.Collections.Generic;
using System.Threading;
using System.Web.Script.Serialization;

namespace MCPRelay
{
    class ProposedForward
    {
        public readonly int localPort, remotePort;
        public ProposedForward(int local, int remote) { localPort=local; remotePort=remote; }
        public string Arg { get { return "127.0.0.1:"+remotePort+":127.0.0.1:"+localPort; } }
    }
    class ProposedPlan
    {
        public readonly ProposedForward Primary, Secondary;
        public ProposedPlan(ProposedForward primary, ProposedForward secondary)
        {
            foreach (var f in new [] { primary, secondary })
                if (f!=null && (f.localPort<1 || f.localPort>65535 || f.remotePort<1 || f.remotePort>65535))
                    throw new ArgumentException("Port outside supported range");
            if (primary==null || (secondary!=null && (primary.localPort==secondary.localPort || primary.remotePort==secondary.remotePort)))
                throw new ArgumentException("Missing or overlapping loopback forward");
            Primary=primary; Secondary=secondary;
        }
        public ProposedForward[] Pairs { get { return Secondary==null ? new [] {Primary} : new [] {Primary,Secondary}; } }
        public static void ValidateReplacement(ProposedPlan active,ProposedPlan expected,ProposedPlan replacement)
        {
            if(!Object.ReferenceEquals(active,expected) || active.Primary.Arg!=replacement.Primary.Arg)
                throw new ArgumentException("Stale plan or changed primary forward");
        }
    }
    class SecondForwardProposal
    {
        static JavaScriptSerializer json=new JavaScriptSerializer();
        static int checks;
        static object ownedGate=new object();
        static Dictionary<int,DateTime> owned=new Dictionary<int,DateTime>();
        static void Track(Supervised supervisor)
        {
            supervisor.Line+=(name,line)=>{
                if(!line.StartsWith("started (pid "))return;
                int pid;if(!Int32.TryParse(line.Substring(13).TrimEnd(')'),out pid))return;
                try{using(var p=Process.GetProcessById(pid)){lock(ownedGate)owned[pid]=p.StartTime.ToUniversalTime();}}
                catch(ArgumentException){} // already exited: no live owned child
            };
        }
        static bool CleanupOwnedFallback()
        {
            bool used=false;
            lock(ownedGate)foreach(var item in owned)try{using(var p=Process.GetProcessById(item.Key)){
                if(!p.HasExited && p.StartTime.ToUniversalTime()==item.Value){used=true;p.Kill();p.WaitForExit(2000);}
            }}catch(ArgumentException){} // gone; never select by name or a reused PID
            return used;
        }
        static void Check(bool ok,string label) { if(!ok)throw new Exception(label); checks++; Console.WriteLine("PASS "+label); }
        static string Q(string s) { if(s.Contains("\""))throw new ArgumentException("Quote in owned path");return "\""+s+"\""; }
        static int FreePort() { var l=new TcpListener(IPAddress.Loopback,0);l.Start();int p=((IPEndPoint)l.LocalEndpoint).Port;l.Stop();return p; }
        static Dictionary<string,object> Ready(string path)
        { try{return json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path));}catch(IOException){return null;}catch(ArgumentException){return null;} }
        static bool Wait(Func<bool> check)
        { var watch=Stopwatch.StartNew();while(watch.ElapsedMilliseconds<6000){if(check())return true;Thread.Sleep(30);}return false; }
        static bool Reachable(int port)
        {
            try { using(var c=new TcpClient()) {
                var connect=c.BeginConnect(IPAddress.Loopback,port,null,null);
                if(!connect.AsyncWaitHandle.WaitOne(400))return false;c.EndConnect(connect);
                c.ReceiveTimeout=400;var b=new byte[64];int n=c.GetStream().Read(b,0,b.Length);
                return System.Text.Encoding.UTF8.GetString(b,0,n)=="OWNED_FIXTURE";
            }}catch(SocketException){return false;}catch(IOException){return false;}
        }
        public static int Main(string[] args)
        {
            if(args.Length!=3)return 2;
            string node=args[0],script=args[1],root=Path.GetFullPath(args[2]);
            var bridgeReady=Path.Combine(root,"bridge.json");var probeReady=Path.Combine(root,"probe.json");
            var tunnelReady=Path.Combine(root,"tunnel.json");var planPath=Path.Combine(root,"plan.json");
            Func<string,string,ProcessStartInfo> start=(mode,ready)=>new ProcessStartInfo(node,Q(script)+" "+mode+" "+Q(ready)+" "+Q(planPath));
            var bridge=new Supervised("fixture-bridge",()=>start("backend",bridgeReady),new []{1});
            var probe=new Supervised("fixture-probe",()=>start("backend",probeReady),new []{1});
            Track(bridge);Track(probe);
            Supervised tunnel=null;int bridgePid=0,probePid=0,tunnelPid=0;
            try
            {
                bridge.Start();probe.Start();
                Check(Wait(()=>Ready(bridgeReady)!=null && Ready(probeReady)!=null),"owned_backends_started");
                var br=Ready(bridgeReady);var pr=Ready(probeReady);bridgePid=Convert.ToInt32(br["pid"]);probePid=Convert.ToInt32(pr["pid"]);
                var identity=Process.GetProcessById(bridgePid).StartTime.ToUniversalTime();
                int direct=Convert.ToInt32(br["port"]), probePort=Convert.ToInt32(pr["port"]), first=FreePort(), second=FreePort();
                while(second==first)second=FreePort();
                var original=new ProposedPlan(new ProposedForward(direct,first),null);
                var added=new ProposedPlan(original.Primary,new ProposedForward(probePort,second));
                File.WriteAllText(planPath,json.Serialize(original.Pairs));
                tunnel=new Supervised("fixture-tunnel",()=>start("tunnel",tunnelReady),new []{1});Track(tunnel);tunnel.Start();
                Check(Wait(()=>Reachable(first)),"original_forward_reachable");tunnelPid=Convert.ToInt32(Ready(tunnelReady)["pid"]);
                Check(added.Primary.Arg==original.Primary.Arg,"primary_argument_preserved_exactly");
                int oldTunnel=tunnelPid;File.WriteAllText(planPath,json.Serialize(added.Pairs));tunnel.Restart();
                Check(Wait(()=>Ready(tunnelReady)!=null && Convert.ToInt32(Ready(tunnelReady)["pid"])!=oldTunnel && Reachable(first) && Reachable(second)),"second_forward_after_tunnel_only_restart");
                tunnelPid=Convert.ToInt32(Ready(tunnelReady)["pid"]);
                Check(bridge.IsRunning && Process.GetProcessById(bridgePid).StartTime.ToUniversalTime()==identity,"bridge_pid_start_preserved");
                probe.Stop();Check(Wait(()=>!probe.IsRunning && !Reachable(second) && Reachable(first)),"probe_outage_isolated_from_primary");
                probe.Start();
                Check(Wait(()=>Ready(probeReady)!=null && Convert.ToInt32(Ready(probeReady)["pid"])!=probePid),"exact_owned_probe_restarted");
                // A fresh fixture can choose a new ephemeral backend port. An
                // explicit reviewed plan update is required; no dynamic registry.
                probePid=Convert.ToInt32(Ready(probeReady)["pid"]);probePort=Convert.ToInt32(Ready(probeReady)["port"]);
                var recovered=new ProposedPlan(original.Primary,new ProposedForward(probePort,second));
                File.WriteAllText(planPath,json.Serialize(recovered.Pairs));oldTunnel=tunnelPid;tunnel.Restart();
                Check(Wait(()=>Convert.ToInt32(Ready(tunnelReady)["pid"])!=oldTunnel && Reachable(first) && Reachable(second)),"explicit_reconnect_plan_recovers_both");
                tunnelPid=Convert.ToInt32(Ready(tunnelReady)["pid"]);
                foreach(var expected in new [] {original,added}) {
                    bool rejected=false;
                    try { ProposedPlan.ValidateReplacement(recovered,expected,original); }
                    catch(ArgumentException) { rejected=true; }
                    Check(rejected,"stale_plan_refused_before_tunnel_restart");
                }
                bool primaryRejected=false;
                try { ProposedPlan.ValidateReplacement(recovered,recovered,new ProposedPlan(new ProposedForward(direct,second),null)); }
                catch(ArgumentException) { primaryRejected=true; }
                Check(primaryRejected && tunnel.IsRunning && Reachable(first),"changed_primary_refused_without_disruption");
                foreach(var bad in new [] { new ProposedForward(0,second),new ProposedForward(probePort,first),new ProposedForward(direct,second) }) {
                    bool rejected=false;try{new ProposedPlan(original.Primary,bad);}catch(ArgumentException){rejected=true;}
                    Check(rejected,"invalid_or_overlapping_pair_rejected");
                }
                ProposedPlan.ValidateReplacement(recovered,recovered,original);
                oldTunnel=tunnelPid;File.WriteAllText(planPath,json.Serialize(original.Pairs));tunnel.Restart();
                Check(Wait(()=>Convert.ToInt32(Ready(tunnelReady)["pid"])!=oldTunnel && Reachable(first) && !Reachable(second)),"rollback_removes_only_second_forward");
                tunnelPid=Convert.ToInt32(Ready(tunnelReady)["pid"]);
                Check(Process.GetProcessById(bridgePid).StartTime.ToUniversalTime()==identity,"rollback_preserves_bridge_identity");
            }
            catch(Exception error){Console.WriteLine("FAIL "+error.GetType().Name+": "+error.Message);return 1;}
            finally
            {
                if(tunnel!=null)tunnel.Stop();probe.Stop();bridge.Stop();
                bool supervisorStopped=Wait(()=>!bridge.IsRunning && !probe.IsRunning && (tunnel==null || !tunnel.IsRunning));
                bool fallback=CleanupOwnedFallback();
                if(!supervisorStopped || fallback)throw new Exception("Supervisor cleanup failed; exact owned fallback attempted");
            }
            Console.WriteLine("{\"launcher_checks\":"+checks+",\"real_ssh\":false,\"installed_config_used\":false,\"owned_cleanup\":true}");
            return 0;
        }
    }
}
