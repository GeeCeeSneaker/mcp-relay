"""Fetch only whitelisted fixed public package bytes; no Git authentication."""
import argparse, hashlib, io, json, pathlib, subprocess, urllib.request, zipfile

ap=argparse.ArgumentParser();ap.add_argument('--out',required=True);args=ap.parse_args()
repo=pathlib.Path(__file__).resolve().parents[1]
manifest=json.loads((repo/'tests/routing-gateway-source.json').read_text())
out=pathlib.Path(args.out).resolve()
if out.exists(): raise SystemExit('refuse to overwrite an existing source directory')
out.mkdir(parents=True)
url='https://codeload.github.com/R0Wi/mcp-gateway/zip/'+manifest['commit']
with urllib.request.urlopen(url,timeout=30) as response: data=response.read(8*1024*1024+1)
if len(data)>8*1024*1024: raise SystemExit('source download bound exceeded')
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    for entry in manifest['files']:
        relative=pathlib.PurePosixPath(entry['path'])
        if relative.is_absolute() or '..' in relative.parts: raise SystemExit('invalid source path')
        names=[n for n in archive.namelist() if n.endswith('/'+entry['path'])]
        if len(names)!=1: raise SystemExit('fixed source file unavailable')
        content=archive.read(names[0]);blob=hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()
        if blob!=entry['sha'] or len(content)!=entry['size']: raise SystemExit('fixed source hash mismatch')
        target=out.joinpath(*relative.parts);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
patches=[str(repo/'patches/mcp-gateway'/p) for p in ['0001-persistent-backend-client.patch','0002-backend-connect-retries.patch']]
for mode in ['--check',None]:
    cmd=['git','-c','core.autocrlf=false','-C',str(out),'apply']+([mode] if mode else [])+patches
    subprocess.run(cmd,check=True,capture_output=True)
print('PASS fixed gateway source and accepted patches verified')
