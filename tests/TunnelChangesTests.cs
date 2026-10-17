// Compiled with the actual app. Disposable files / native Jobs / loopback TCP;
// no installed config, token, SSH connection, tray or production process.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Web.Script.Serialization;

namespace MCPRelay
{
    class TunnelChangesTests
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static int checks;
        static string nodeExe, script, root;
        static void Check(bool ok, string label) { if (!ok) throw new Exception(label); checks++; Console.WriteLine("PASS " + label); }
        static void Reject(Action action, string label)
        { bool rejected = false; try { action(); } catch (ArgumentException) { rejected = true; } catch (InvalidOperationException) { rejected = true; } Check(rejected, label); }
        static bool Wait(Func<bool> check)
        { var watch = Stopwatch.StartNew(); do { if (check()) return true; Thread.Sleep(20); } while (watch.ElapsedMilliseconds < 5000); return false; }
        static int Port() { var l = new TcpListener(IPAddress.Loopback, 0); l.Start(); int p = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return p; }
        static Dictionary<string, object> Read(string path)
        { try { return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path)); } catch (IOException) { return null; } catch (ArgumentException) { return null; } }
        static bool Reachable(int port)
        {
            try { using (var c = new TcpClient()) {
                var pending = c.BeginConnect(IPAddress.Loopback, port, null, null);
                using (pending.AsyncWaitHandle) if (!pending.AsyncWaitHandle.WaitOne(300)) return false;
                c.EndConnect(pending); c.ReceiveTimeout = 300;
                byte[] bytes = new byte[64]; int n = c.GetStream().Read(bytes, 0, bytes.Length);
                return Encoding.UTF8.GetString(bytes, 0, n) == "OWNED_FIXTURE";
            } } catch (SocketException) { return false; } catch (IOException) { return false; }
        }
        static string Q(string text) { if (text.Contains("\"")) throw new ArgumentException("Quote in owned path"); return "\"" + text + "\""; }
        class Faults : Jobs.Calls
        {
            public bool FailStop, FailCreate, FailWait;
            public override bool Terminate(IntPtr job) { return !FailStop && base.Terminate(job); }
            public override IntPtr Create() { return FailCreate ? IntPtr.Zero : base.Create(); }
            public override uint WaitForExit(Process process) { return FailWait ? 258u : base.WaitForExit(process); }
            public override int Error { get { return 5; } }
        }
        class Writes : TunnelFileWrites
        {
            public int Failures;
            public override void Write(FileStream file, byte[] bytes)
            {
                if (Failures-- > 0) { file.SetLength(1); file.Flush(true); throw new IOException("owned write fault"); }
                base.Write(file, bytes);
            }
        }
        sealed class Fixture : IDisposable
        {
            public readonly string Dir, FilePath, Proposal;
            public readonly Supervised Node, Probe;
            public readonly List<Supervised> Tunnels = new List<Supervised>();
            public readonly List<Faults> Calls = new List<Faults>();
            readonly Dictionary<int, long> owned = new Dictionary<int, long>();
            public readonly Writes Writes = new Writes();
            public TunnelChanges Changes;
            public TunnelConfigSnapshot Original, Added;
            public int Primary, Secondary, Local, ProbePort, Launches;
            public string NodeId;
            public int BadStart, BadReady, BadCreate, BadStop;
            public bool BadRollbackReady;
            public readonly ManualResetEvent Entered = new ManualResetEvent(false), Continue = new ManualResetEvent(false);
            public bool Pause;
            public Fixture(string name)
            {
                Dir = Path.Combine(root, name); Directory.CreateDirectory(Dir);
                FilePath = Path.Combine(Dir, "config.json"); Proposal = Path.Combine(Dir, "proposed.json");
                string nr = Path.Combine(Dir, "node.json"), pr = Path.Combine(Dir, "probe.json");
                Node = new Supervised("owned-node", () => Start("backend", nr, "unused"), new[] { 1 });
                Probe = new Supervised("owned-probe", () => Start("backend", pr, "unused"), new[] { 1 });
                Track(Node); Track(Probe); Node.Start(); Probe.Start();
                if (!Wait(() => Read(nr) != null && Read(pr) != null)) throw new Exception("Fixture backend timeout");
                Local = Convert.ToInt32(Read(nr)["port"]); ProbePort = Convert.ToInt32(Read(pr)["port"]);
                Primary = Port(); do { Secondary = Port(); } while (Secondary == Primary);
                Original = Snapshot(false); Added = Snapshot(true);
                File.WriteAllBytes(FilePath, Original.Bytes); File.WriteAllBytes(Proposal, Added.Bytes);
                var initial = Create(Original, true); initial.Process.Start();
                if (!Wait(() => initial.Ready() && Reachable(Primary))) throw new Exception("Fixture tunnel timeout");
                NodeId = Node.Identity;
                Changes = new TunnelChanges(FilePath, Original, Node, initial, Create, p => { }, 650, Writes);
            }
            ProcessStartInfo Start(string mode, string ready, string plan)
            { return new ProcessStartInfo(nodeExe, Q(script) + " " + mode + " " + Q(ready) + " " + Q(plan)); }
            void Track(Supervised process)
            {
                process.Line += (name, text) => {
                    if (!text.StartsWith("started (pid ")) return;
                    var identity = process.Identity;
                    if (identity != null) { var parts = identity.Split(':'); lock (owned) owned[Int32.Parse(parts[0])] = Int64.Parse(parts[1]); }
                };
            }
            public TunnelConfigSnapshot Snapshot(bool second)
            {
                return new TunnelConfigSnapshot(Encoding.UTF8.GetBytes(Json.Serialize(new {
                    nodeName = "owned-fixture", vpsHost = "not-used.invalid", tunnelUser = "fixture", localPort = Local,
                    remotePort = Primary, sshKey = "not-read", knownHosts = "not-read", custom = new { preserved = true },
                    secondLocalPort = second ? ProbePort : 0, secondRemotePort = second ? Secondary : 0
                })));
            }
            TunnelInstance Create(TunnelConfigSnapshot snapshot, bool retry)
            {
                int ordinal = ++Launches;
                var calls = new Faults { FailCreate = ordinal == BadCreate, FailStop = ordinal == BadStop }; Calls.Add(calls);
                var c = snapshot.Settings;
                string ready = Path.Combine(Dir, "ready-" + ordinal + ".json"), plan = Path.Combine(Dir, "tcp-" + ordinal + ".json");
                var pairs = new List<object> { new { localPort = c.LocalPort, remotePort = c.RemotePort } };
                if (c.SecondLocalPort != 0) pairs.Add(new { localPort = c.SecondLocalPort, remotePort = c.SecondRemotePort });
                File.WriteAllText(plan, Json.Serialize(pairs));
                var process = new Supervised("owned-tunnel-" + ordinal,
                    () => ordinal == BadStart ? new ProcessStartInfo(Path.Combine(Dir, "missing.exe")) : Start("tunnel", ready, plan),
                    new[] { 0 }, calls, retry);
                Tunnels.Add(process); Track(process);
                return new TunnelInstance(process, () => {
                    if (Pause && ordinal == 2) { Entered.Set(); if (!Continue.WaitOne(3000)) throw new Exception("Concurrent test timeout"); }
                    if (ordinal == BadReady || (ordinal == 3 && BadRollbackReady)) return false;
                    var data = Read(ready); var identity = process.Identity;
                    return data != null && identity != null && identity.StartsWith(Convert.ToString(data["pid"]) + ":") &&
                        Reachable(Primary) && (c.SecondLocalPort == 0 || Reachable(Secondary));
                });
            }
            public TunnelChange Prepare() { return Changes.Prepare(Proposal, Changes.Active.FileHash, Changes.Active.PlanHash); }
            public void Dispose()
            {
                Continue.Set(); foreach (var calls in Calls) { calls.FailStop = false; calls.FailWait = false; }
                foreach (var process in Tunnels) process.Stop(); Node.Stop(); Probe.Stop();
                // Only PIDs recorded from this fixture's actual supervisor starts.
                // No broad cleanup, process-name selection or fallback kill.
                bool gone = Wait(() => { lock (owned) foreach (var pair in owned) {
                    try { using (var p = Process.GetProcessById(pair.Key)) if (!p.HasExited && p.StartTime.ToUniversalTime().Ticks == pair.Value) return false; }
                    catch (ArgumentException) { }
                } return true; });
                Check(gone, "all_exact_owned_processes_released");
                Entered.Dispose(); Continue.Dispose();
            }
        }
        static void SerializedValidation()
        {
            string primary = "\"vpsHost\":\"fixture.invalid\",\"remotePort\":22001,\"localPort\":18001";
            Func<string, TunnelConfigSnapshot> snapshot = pair => new TunnelConfigSnapshot(Encoding.UTF8.GetBytes("{" + primary + pair + "}"));
            var legacy = snapshot(""); var zero = snapshot(",\"secondLocalPort\":0,\"secondRemotePort\":0");
            Check(legacy.PlanHash == zero.PlanHash && legacy.FileHash != zero.FileHash, "legacy_absent_and_zero_pair_same_serialized_plan");
            Check(new TunnelConfigSnapshot(legacy.Bytes).FileHash == legacy.FileHash, "file_hash_roundtrip");
            var mutable = legacy.Settings; mutable.RemotePort++; var bytes = legacy.Bytes; bytes[0] = 0;
            Check(legacy.Settings.RemotePort == 22001 && new TunnelConfigSnapshot(legacy.Bytes).PlanHash == legacy.PlanHash, "snapshot_immutable_copies");
            foreach (var pair in new[] {
                ",\"secondLocalPort\":18002", ",\"secondRemotePort\":22002",
                ",\"secondLocalPort\":0,\"secondRemotePort\":22002", ",\"secondLocalPort\":18002,\"secondRemotePort\":0",
                ",\"secondLocalPort\":-1,\"secondRemotePort\":22002", ",\"secondLocalPort\":65536,\"secondRemotePort\":22002",
                ",\"secondLocalPort\":18002,\"secondRemotePort\":65536", ",\"secondLocalPort\":18001,\"secondRemotePort\":22002",
                ",\"secondLocalPort\":18002,\"secondRemotePort\":22001", ",\"secondLocalPort\":\"18002\",\"secondRemotePort\":22002",
                ",\"secondLocalPort\":18002.0,\"secondRemotePort\":22002", ",\"secondLocalPort\":true,\"secondRemotePort\":22002",
                ",\"secondLocalPort\":null,\"secondRemotePort\":22002" }) Reject(() => snapshot(pair), "strict_pair_refused");
            var dual = snapshot(",\"secondLocalPort\":18002,\"secondRemotePort\":22002");
            string oldArgs = TunnelConfigSnapshot.Arguments(legacy.Settings), newArgs = TunnelConfigSnapshot.Arguments(dual.Settings);
            Check(newArgs.Replace(" -R 127.0.0.1:22002:127.0.0.1:18002", "") == oldArgs, "primary_auth_keepalive_arguments_exactly_preserved");
            Check(dual.PlanHash == TunnelConfigSnapshot.Hash(dual.PlanJson) && dual.PlanHash != legacy.PlanHash, "actual_serialized_plan_hash_changes_with_pair");
            Check(snapshot(",\"secondLocalPort\":1,\"secondRemotePort\":65535").Settings.SecondRemotePort == 65535, "strict_pair_valid_range_boundaries");
        }
        public static int Main(string[] args)
        {
            if (args.Length != 3) return 2; nodeExe = args[0]; script = args[1]; root = args[2];
            try
            {
                SerializedValidation();
                using (var f = new Fixture("apply-remove")) {
                    var change = f.Prepare(); string old = f.Tunnels[0].Identity;
                    Check(change.Hash == TunnelConfigSnapshot.Hash(change.Serialized) && change.Serialized.Contains(f.Added.PlanHash), "serialized_change_binds_file_plan_and_process_hashes");
                    Reject(() => f.Changes.Apply(change, "wrong"), "wrong_receipt_hash_refused");
                    Check(f.Changes.Apply(change, change.Hash) == "applied", "real_config_add_pair_applied");
                    Check(TunnelConfigSnapshot.Read(f.FilePath).FileHash == f.Added.FileHash && f.Changes.Active.PlanHash == f.Added.PlanHash, "disk_and_active_plan_commit_readback");
                    Check(f.Node.Identity == f.NodeId && f.Tunnels[0].Released && f.Tunnels[1].Identity != old, "node_preserved_old_exact_tunnel_released");
                    Check(Reachable(f.Primary) && Reachable(f.Secondary), "both_owned_tcp_forwards_recover");
                    Reject(() => f.Changes.Apply(change, change.Hash), "replayed_change_refused");
                    File.WriteAllBytes(f.Proposal, f.Original.Bytes); change = f.Prepare();
                    Check(f.Changes.Apply(change, change.Hash) == "applied" && Reachable(f.Primary) && !Reachable(f.Secondary), "remove_pair_preserves_primary");
                    Check(f.Node.Identity == f.NodeId && f.Launches == 3, "remove_pair_does_not_restart_node");
                    change = f.Prepare();
                    Check(f.Changes.Apply(change, change.Hash) == "applied" && f.Launches == 4 && f.Node.Identity == f.NodeId, "explicit_same_plan_tunnel_only_restart");
                    Check(TunnelConfigSnapshot.Read(f.FilePath).PlanHash == f.Original.PlanHash && Reachable(f.Primary), "restart_from_saved_config_does_not_drift");
                }
                using (var f = new Fixture("drift")) {
                    Reject(() => f.Changes.Prepare(f.Proposal, f.Original.FileHash, "stale-plan"), "stale_expected_plan_refused");
                    var change = f.Prepare();
                    File.AppendAllText(f.FilePath, " "); Reject(() => f.Changes.Apply(change, change.Hash), "real_active_file_drift_refused");
                    File.WriteAllBytes(f.FilePath, f.Original.Bytes); File.AppendAllText(f.Proposal, " ");
                    Reject(() => f.Changes.Apply(change, change.Hash), "real_proposal_file_drift_refused");
                    File.WriteAllText(f.Proposal, Encoding.UTF8.GetString(f.Added.Bytes).Replace("owned-fixture", "different-node"));
                    Reject(() => f.Prepare(), "node_setting_edit_refused");
                    File.WriteAllText(f.Proposal, Encoding.UTF8.GetString(f.Added.Bytes).Replace("\"preserved\":true", "\"preserved\":false"));
                    Reject(() => f.Prepare(), "unknown_non_pair_setting_edit_refused");
                    File.WriteAllText(f.Proposal, Encoding.UTF8.GetString(f.Added.Bytes).Replace("\"remotePort\":" + f.Primary, "\"remotePort\":" + Port()));
                    Reject(() => f.Prepare(), "primary_port_edit_refused");
                    File.WriteAllBytes(f.Proposal, f.Added.Bytes); change = f.Prepare(); string old = f.Tunnels[0].Identity;
                    f.Tunnels[0].Restart(); Check(Wait(() => f.Tunnels[0].Identity != null && f.Tunnels[0].Identity != old && Reachable(f.Primary)), "ordinary_tunnel_retry_still_works");
                    Reject(() => f.Changes.Apply(change, change.Hash), "stale_exact_tunnel_identity_refused");
                    Check(f.Launches == 1 && f.Node.Identity == f.NodeId && Reachable(f.Primary), "drift_has_no_replacement_side_effect");
                    change = f.Prepare(); f.Node.Restart();
                    Check(Wait(() => f.Node.Identity != null && f.Node.Identity != f.NodeId), "owned_node_identity_changed_for_stale_check");
                    Reject(() => f.Changes.Apply(change, change.Hash), "stale_node_identity_refused");
                    Check(f.Launches == 1, "stale_node_has_no_tunnel_replacement");
                }
                using (var f = new Fixture("concurrent")) {
                    var change = f.Prepare(); f.Pause = true; string result = null; Exception error = null;
                    var thread = new Thread(() => { try { result = f.Changes.Apply(change, change.Hash); } catch (Exception e) { error = e; } }); thread.Start();
                    try {
                        Check(f.Entered.WaitOne(5000), "actual_apply_paused_with_config_handles_locked");
                        Reject(() => f.Changes.Apply(change, change.Hash), "concurrent_apply_refused");
                        Reject(() => f.Changes.Prepare(f.Proposal, f.Original.FileHash, f.Original.PlanHash), "concurrent_prepare_refused");
                        bool locked = false; try { File.WriteAllText(f.FilePath, "concurrent writer"); } catch (IOException) { locked = true; }
                        Check(locked, "active_config_writer_excluded");
                        locked = false; try { File.WriteAllText(f.Proposal, "concurrent proposal writer"); } catch (IOException) { locked = true; }
                        Check(locked, "proposal_writer_excluded");
                    } finally { f.Continue.Set(); Check(thread.Join(5000), "concurrent_thread_completed"); }
                    Check(error == null && result == "applied" && f.Launches == 2 && f.Node.Identity == f.NodeId, "single_bounded_apply_wins");
                }
                using (var f = new Fixture("failed-old-stop")) {
                    var change = f.Prepare(); f.Calls[0].FailStop = true;
                    Check(f.Changes.Apply(change, change.Hash).StartsWith("blocked:") && f.Changes.Blocked && f.Launches == 1, "failed_old_stop_no_replacement");
                    int maintenance = 0; f.Changes.Maintain(() => maintenance++);
                    Check(maintenance == 0 && TunnelConfigSnapshot.Read(f.FilePath).FileHash == f.Original.FileHash, "blocked_maintenance_and_config_preserved");
                    Reject(() => f.Prepare(), "blocked_change_cannot_retry");
                }
                using (var f = new Fixture("start-rollback")) {
                    f.BadStart = 2; var change = f.Prepare();
                    Check(f.Changes.Apply(change, change.Hash) == "rolled-back" && f.Launches == 3, "failed_start_one_checked_rollback");
                    Check(f.Tunnels[1].Released && Reachable(f.Primary) && !Reachable(f.Secondary) && f.Node.Identity == f.NodeId, "rollback_no_competing_candidate_node_preserved");
                    Check(TunnelConfigSnapshot.Read(f.FilePath).FileHash == f.Original.FileHash && !f.Changes.Blocked, "rollback_old_config_unchanged");
                }
                using (var f = new Fixture("unconfirmed-old-exit")) {
                    var change = f.Prepare(); f.Calls[0].FailWait = true;
                    Check(f.Changes.Apply(change, change.Hash).StartsWith("blocked:") && f.Launches == 1 && f.Changes.Blocked, "unconfirmed_old_exit_no_replacement");
                }
                using (var f = new Fixture("failed-rollback")) {
                    f.BadReady = 2; f.BadStart = 3; var change = f.Prepare();
                    Check(f.Changes.Apply(change, change.Hash).StartsWith("blocked:") && f.Changes.Blocked, "failed_rollback_blocks");
                    Thread.Sleep(200); Check(f.Launches == 3 && f.Tunnels[1].Released && f.Tunnels[2].Released && !Reachable(f.Primary), "failed_rollback_no_retry_or_competing_process");
                }
                using (var f = new Fixture("uncertain-candidate")) {
                    f.BadReady = 2; f.BadStop = 2; var change = f.Prepare();
                    Check(f.Changes.Apply(change, change.Hash).StartsWith("blocked:") && f.Changes.Blocked && f.Launches == 2, "uncertain_candidate_stop_no_rollback");
                    Check(f.Node.Identity == f.NodeId && TunnelConfigSnapshot.Read(f.FilePath).FileHash == f.Original.FileHash, "uncertain_candidate_preserves_node_and_file");
                }
                using (var f = new Fixture("uncertain-rollback-stop")) {
                    f.BadReady = 2; f.BadRollbackReady = true; f.BadStop = 3; var change = f.Prepare();
                    Check(f.Changes.Apply(change, change.Hash).StartsWith("blocked:") && f.Changes.Blocked && f.Launches == 3, "uncertain_rollback_stop_no_fourth_launch");
                    Check(f.Tunnels[2].OwnershipBlocked && f.Node.Identity == f.NodeId, "rollback_uncertainty_latched_node_preserved");
                }
                using (var f = new Fixture("uncertain-create")) {
                    f.BadCreate = 2; var change = f.Prepare();
                    Check(f.Changes.Apply(change, change.Hash).StartsWith("blocked:") && f.Launches == 2, "native_candidate_ownership_failure_blocks_rollback");
                }
                using (var f = new Fixture("write-rollback")) {
                    f.Writes.Failures = 1; var change = f.Prepare();
                    Check(f.Changes.Apply(change, change.Hash) == "rolled-back", "partial_config_write_restored_before_rollback");
                    Check(TunnelConfigSnapshot.Read(f.FilePath).FileHash == f.Original.FileHash && Reachable(f.Primary) && f.Tunnels[1].Released, "write_rollback_exact_bytes_and_primary_recovered");
                }
                using (var f = new Fixture("write-uncertain")) {
                    f.Writes.Failures = 2; var change = f.Prepare();
                    Check(f.Changes.Apply(change, change.Hash).StartsWith("blocked:") && f.Changes.Blocked && f.Launches == 2 && f.Tunnels[1].Released, "unconfirmed_file_restore_no_rollback_launch");
                }
                Console.WriteLine("{\"serialized_checks\":" + checks + ",\"real_win32\":true,\"owned_cleanup\":true,\"fallback_used\":false,\"real_ssh\":false,\"installed_config_used\":false}"); return 0;
            }
            catch (Exception e) { Console.WriteLine("FAIL " + e); return 1; }
        }
    }
}
