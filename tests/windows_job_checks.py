"""Compile actual Windows app + native faults, then real TCP lifecycle fixture.

Never runs the tray/Config.Load, build installer, installed services or SSH.
"""
import argparse,json,os,pathlib,subprocess,sys,tempfile

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--node-exe',required=True);ap.add_argument('--r2-only',action='store_true');args=ap.parse_args()
    if os.name!='nt':raise SystemExit('Windows-native evidence requires Windows; not a Linux pass')
    repo=pathlib.Path(__file__).resolve().parents[1]
    root=pathlib.Path(tempfile.mkdtemp(prefix='wo10-native-job-')).resolve()
    compiler=pathlib.Path(os.environ['WINDIR'])/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    def compile(name,main=None,test=None):
        path=root/name
        cmd=[str(compiler),'/nologo','/target:exe' if main else '/target:winexe',
            '/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/out:'+str(path)]
        if main:cmd.append('/main:MCPRelay.'+main)
        cmd.append(str(repo/'app/windows/MCPRelay.cs'))
        if test:cmd.append(str(repo/'tests'/test))
        result=subprocess.run(cmd,capture_output=True,text=True,timeout=30)
        (root/(name+'.compile.txt')).write_text(result.stdout+result.stderr)
        if result.returncode:raise RuntimeError('actual app/test compilation failed: '+name)
        return path
    def execute(command,label,timeout):
        # A real file cannot hang communicate() draining inherited Win32 pipe
        # handles after a timed-out fixture. Preserve partial evidence on failure.
        logfile=root/(label+'-result.txt')
        with logfile.open('w') as stream:
            with subprocess.Popen(command,stdout=stream,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW) as process:
                try:code=process.wait(timeout)
                except subprocess.TimeoutExpired:
                    process.kill();process.wait(5)
                    print(logfile.read_text(),flush=True)
                    raise RuntimeError(label+' exceeded existing bounded test deadline') from None
        output=logfile.read_text();print(output,flush=True)
        return subprocess.CompletedProcess(command,code,output,'')
    compile('MCPRelay-candidate.exe')
    native=compile('native-tests.exe','JobOwnershipTests','JobOwnershipTests.cs')
    result=execute([str(native)]+(['r2-only'] if args.r2_only else [])+[str(root/'native')],'native',90)
    if result.returncode:raise RuntimeError('native ownership failure tests failed')
    summary=json.loads(next(line for line in result.stdout.splitlines() if line.startswith('{"native_checks":')))
    assert summary['r2_cases']==2 and summary['owned_cleanup'] and not summary['fallback_used'] and summary['real_win32']
    if args.r2_only:return 0
    assert summary['native_checks']==92
    lifecycle=compile('lifecycle-tests.exe','SecondForwardProposal','SecondForwardProposal.cs')
    (root/'lifecycle').mkdir()
    result=execute([str(lifecycle),str(pathlib.Path(args.node_exe).resolve()),str(repo/'tests/second_forward_fixture.mjs'),str(root/'lifecycle')],'lifecycle',60)
    if result.returncode:raise RuntimeError('actual supervisor TCP lifecycle tests failed')
    legacy=json.loads(next(line for line in result.stdout.splitlines() if line.startswith('{')))
    assert legacy['launcher_checks']==16 and legacy['owned_cleanup']
    print(json.dumps({'native_checks':summary['native_checks'],'r2_cases':summary['r2_cases'],'tcp_lifecycle_checks':16,'owned_cleanup':True,'fallback_used':False,'real_ssh':False,'installed_config_used':False,'full_wo_accepted':False}),flush=True)
    return 0

if __name__=='__main__':sys.exit(main())
