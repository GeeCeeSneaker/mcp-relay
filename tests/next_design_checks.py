"""Only the new WO10 design/compatibility proving lane, not the old 82-case run."""
import argparse
import asyncio
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ap=argparse.ArgumentParser()
ap.add_argument('--gateway-source',required=True)
ap.add_argument('--node-exe',default=shutil.which('node'))
args=ap.parse_args()
repo=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(pathlib.Path(args.gateway_source).resolve()/'src'))
from compatibility_proposal import run_checks

def ssh_parser(root):
    executable=shutil.which('ssh')
    if not executable:raise RuntimeError('OpenSSH parser unavailable')
    config=root/'empty-ssh-config';config.write_text('')
    # -G exits after config parsing: NO connection, key/auth/agent/host-file use.
    # -F empty suppresses user and system ssh config, including Match exec.
    command=[executable,'-G','-F',str(config),'-o','IdentityFile=none','-o','IdentitiesOnly=yes',
        '-o','UserKnownHostsFile=none','-o','GlobalKnownHostsFile=none','-o','BatchMode=yes',
        '-o','CanonicalizeHostname=no','-o','ProxyCommand=none','-o','ControlMaster=no',
        '-R','127.0.0.1:48001:127.0.0.1:49001','-R','127.0.0.1:48002:127.0.0.1:49002','fixture.invalid']
    output=subprocess.run(command,capture_output=True,text=True,timeout=10)
    if output.returncode:raise RuntimeError('OpenSSH config parser rejected the disposable plan')
    forwards=[line for line in output.stdout.splitlines() if line.startswith('remoteforward ')]
    assert len(forwards)==2 and all('127.0.0.1' in line for line in forwards)
    assert any('48001' in line and '49001' in line for line in forwards)
    assert any('48002' in line and '49002' in line for line in forwards)
    return {'case':'openssh_two_loopback_R_parser_only','pass':True,'real_connection':False}

def windows_supervisor(root):
    if not args.node_exe:raise RuntimeError('Pinned Node unavailable')
    compiler=pathlib.Path(os.environ['WINDIR'])/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    executable=root/'owned-forward-fixture.exe'
    compiled=subprocess.run([str(compiler),'/nologo','/target:exe','/main:MCPRelay.SecondForwardProposal',
        '/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/out:'+str(executable),
        str(repo/'app/windows/MCPRelay.cs'),str(repo/'tests/SecondForwardProposal.cs')],capture_output=True,text=True,timeout=30)
    if compiled.returncode:raise RuntimeError('Unchanged tray + fixture compilation failed')
    result=subprocess.run([str(executable),str(pathlib.Path(args.node_exe).resolve()),str(repo/'tests/second_forward_fixture.mjs'),str(root)],
        capture_output=True,text=True,timeout=50)
    # Only fixture labels/summary; no production/private paths or raw config.
    print(result.stdout,flush=True)
    if result.returncode:raise RuntimeError('Owned supervisor lifecycle fixture failed')
    summary=json.loads(next(line for line in result.stdout.splitlines() if line.startswith('{')))
    assert summary['launcher_checks']==16 and summary['owned_cleanup'] and not summary['real_ssh'] and not summary['installed_config_used']
    return summary

def main():
    # Preserve disposable evidence; no delete of any user/workspace path.
    root=pathlib.Path(tempfile.mkdtemp(prefix='wo10-next-design-')).resolve()
    results=asyncio.run(run_checks())
    try:results.append(ssh_parser(root))
    except Exception as error:results.append({'case':'openssh_parser','pass':False,'error':type(error).__name__})
    launcher=None
    if os.name=='nt':
        try:launcher=windows_supervisor(root)
        except Exception as error:results.append({'case':'windows_owned_supervisor','pass':False,'error':type(error).__name__})
    summary={'compatibility':results,'failed':sum(not r['pass'] for r in results),'windows_launcher':launcher,
        'windows_launcher_applicability':os.name=='nt','product_or_live_changed':False,'field_accepted':False,
        'prior_82_cases_rerun':False,'TLS_handshake_proven':False,'real_SSH_forwarding_proven':False}
    (root/'result.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps(summary),flush=True)
    return 1 if summary['failed'] else 0

if __name__=='__main__':sys.exit(main())
