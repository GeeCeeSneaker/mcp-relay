#!/usr/bin/env python3
"""AT-PUBLIC: drive the gateway's OAuth 2.1 flow the way ChatGPT does.

Covers discovery (RFC 9728/8414), DCR, authorization code + PKCE S256 with the
RFC 8707 resource parameter, login/consent, and the token exchange, plus
negative checks. Runs wherever httpx is available (e.g. the gateway venv).

    oauth-e2e.py --base https://<mcp-domain> --user <name> --password-file <file> [--token-out <file>]

The password is read from a file and never printed. With --token-out, the access
token is written (0600) for a follow-up MCP smoke run; delete it afterwards.
"""
import argparse
import base64
import hashlib
import os
import secrets
import sys
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

ap = argparse.ArgumentParser()
ap.add_argument('--base', required=True)
ap.add_argument('--user', required=True)
ap.add_argument('--password-file', required=True)
ap.add_argument('--token-out')
opt = ap.parse_args()
base = opt.base.rstrip('/')
password = open(opt.password_file).read().strip()
failures = 0


def report(ok, name, detail=''):
    global failures
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  -- ' + detail if detail else ''}", file=sys.stderr)
    return ok


c = httpx.Client(timeout=20, follow_redirects=False)
REDIRECT = 'http://127.0.0.1:53682/callback'

# 1. Unauthenticated MCP request must be rejected with discovery pointer.
r = c.post(f'{base}/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
           headers={'accept': 'application/json, text/event-stream'})
www = r.headers.get('www-authenticate', '')
report(r.status_code == 401 and 'resource_metadata' in www, 'unauthenticated /mcp -> 401 + resource_metadata', f'{r.status_code}')
report(c.post(f'{base}/mcp', json={}, headers={'authorization': 'Bearer invalid-token'}).status_code == 401,
       'invalid bearer token -> 401')

# 2. Discovery.
prm_url = www.split('resource_metadata="')[1].split('"')[0] if 'resource_metadata="' in www else f'{base}/.well-known/oauth-protected-resource/mcp'
prm = c.get(prm_url).json()
resource = prm.get('resource')
as_url = prm['authorization_servers'][0].rstrip('/')
report(bool(resource) and bool(as_url), 'protected resource metadata (RFC 9728)', f'resource={urlparse(resource).path}')
asm = c.get(f'{as_url}/.well-known/oauth-authorization-server').json()
report('S256' in asm.get('code_challenge_methods_supported', []), 'AS metadata advertises PKCE S256')
report(bool(asm.get('registration_endpoint')), 'AS metadata advertises DCR')
report(bool(asm.get('client_id_metadata_document_supported')), 'AS metadata advertises CIMD')

# 3. DCR: allowed and disallowed redirect URIs.
reg = {'client_name': 'mcprelay-e2e', 'redirect_uris': [REDIRECT], 'token_endpoint_auth_method': 'none',
       'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code']}
r = c.post(asm['registration_endpoint'], json=reg)
report(r.status_code in (200, 201), 'DCR with allowed redirect URI', f'{r.status_code}')
client_id = r.json().get('client_id')
# The gateway enforces allowed_client_redirect_uris when a client *uses* a
# redirect URI (authorize), so a rogue registration cannot obtain a code.
BAD_REDIRECT = 'https://attacker.example/callback'
r = c.post(asm['registration_endpoint'], json=dict(reg, redirect_uris=[BAD_REDIRECT]))
if r.status_code >= 400:
    report(True, 'non-allow-listed redirect URI rejected at registration')
else:
    bad_id = r.json().get('client_id')
    probe = {'response_type': 'code', 'client_id': bad_id, 'redirect_uri': BAD_REDIRECT, 'code_challenge': 'x' * 43,
             'code_challenge_method': 'S256', 'state': 's'}
    r = c.get(asm['authorization_endpoint'] + '?' + urlencode(probe))
    loc = r.headers.get('location', '')
    report(not loc.startswith(BAD_REDIRECT) and '/ui/authorize' not in loc,
           'non-allow-listed redirect URI refused at authorize', f'{r.status_code}')

# 4. Authorization request (PKCE + resource).
verifier = secrets.token_urlsafe(48)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
state = secrets.token_urlsafe(16)
q = {'response_type': 'code', 'client_id': client_id, 'redirect_uri': REDIRECT, 'code_challenge': challenge,
     'code_challenge_method': 'S256', 'state': state, 'resource': resource}
r = c.get(asm['authorization_endpoint'] + '?' + urlencode(q))
loc = r.headers.get('location', '')
txn = parse_qs(urlparse(loc).query).get('txn', [None])[0]
report(r.status_code in (302, 303) and txn, 'authorize redirects to login/consent UI', f'{r.status_code}')

# 5. Login (wrong password first), consent.
report(c.post(f'{base}/auth/api/login', json={'username': opt.user, 'password': 'wrong-' + secrets.token_hex(4)}).status_code == 401,
       'wrong password rejected')
r = c.post(f'{base}/auth/api/login', json={'username': opt.user, 'password': password})
report(r.status_code == 200, 'login with configured user', f'{r.status_code}')
r = c.post(f'{base}/auth/api/consent', json={'txn_id': txn, 'approve': True})
redirect_to = r.json().get('redirect_to', '') if r.status_code == 200 else ''
cb = parse_qs(urlparse(redirect_to).query)
report(redirect_to.startswith(REDIRECT) and cb.get('state', [''])[0] == state and 'code' in cb,
       'consent returns code + state to registered redirect URI')
# Recommended (not required) by ChatGPT; a known gateway gap (ADR-0002 F2). Warn only.
print(f"{'PASS' if 'iss' in cb else 'WARN'}  authorization response carries iss (RFC 9207, recommended)"
      f"  -- {'present' if 'iss' in cb else 'absent'}", file=sys.stderr)

# 6. Token exchange; wrong verifier must fail first (code stays unused? it is single-use, so test on a copy).
code = cb.get('code', [''])[0]
tok = {'grant_type': 'authorization_code', 'code': code, 'redirect_uri': REDIRECT, 'client_id': client_id,
       'code_verifier': verifier, 'resource': resource}
r = c.post(asm['token_endpoint'], data=tok)
body = r.json() if r.headers.get('content-type', '').startswith('application/json') else {}
access = body.get('access_token')
report(r.status_code == 200 and access and body.get('refresh_token'), 'token exchange (code + PKCE verifier)', f'{r.status_code}')
report(c.post(asm['token_endpoint'], data=tok).status_code >= 400, 'authorization code is single-use')

# 7. Authenticated MCP initialize through the public edge.
r = c.post(f'{base}/mcp', headers={'authorization': f'Bearer {access}', 'accept': 'application/json, text/event-stream'},
           json={'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                 'params': {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'mcprelay-e2e', 'version': '0'}}})
report(r.status_code == 200, 'authenticated MCP initialize', f'{r.status_code}')

if opt.token_out and access:
    fd = os.open(opt.token_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, access.encode())
    os.close(fd)

print(f"\n{'ALL CHECKS PASSED' if failures == 0 else f'{failures} CHECK(S) FAILED'}", file=sys.stderr)
sys.exit(1 if failures else 0)
