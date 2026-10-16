#!/usr/bin/env python3
"""Lidl Plus (IE) receipt spike for cents. - prove the account pull BEFORE app code.

Commands (run from this folder):

    python lidl-spike.py probe              # unauthenticated liveness - no login, no deps
    python lidl-spike.py auth               # one-time: drives a browser, your phone OTP,
                                            # saves a refresh token (gitignored, never committed)
    python lidl-spike.py fetch              # pulls your receipts -> one JSON file
    python lidl-spike.py serve [--mock]     # local relay the app pulls from (CORS is
                                            # absent, so the browser needs this)

Setup for auth/fetch (one time):

    pip install "lidl-plus[auth]"           # the reverse-engineered client + its browser stack

auth credentials (phone + password) can come from an environment file instead
of prompts - same shapes as the Tesco spike:

    --env=/path/to/file       or env vars LIDL_PHONE / LIDL_PASSWORD
    or ./.env (gitignored)    or ./lidl-spike-out/lidl.env (template, ready to fill)

The SMS/email code cannot be pre-supplied: pass --otp-file and the login waits
for the code to be written into ./lidl-spike-out/otp.txt (consumed on read,
so a stale code is never reused). Without --otp-file on a real terminal it
asks exactly as before.

Why this exists: cents. only builds the in-app Lidl pull after one real IE receipt
has been fetched end to end. The client is UNOFFICIAL (github.com/Andre0512/lidl-plus)
and can stop working at any time - that is exactly what this spike measures.

Every output lands in ./lidl-spike-out/, which is gitignored and kept off the
deploy by .assetsignore, so a refresh token or a receipt can never be committed
or published with the static site. Data stays on this machine - same rule the
app itself follows. (The local dev server does serve the folder, so treat a
running serve as machine-local, not a URL to share.)
"""
import json
import os
import re
import socket
import sys
import time
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / 'lidl-spike-out'
TOKEN_FILE = OUT_DIR / 'lidl-refresh-token.txt'
RECEIPTS_FILE = OUT_DIR / 'lidl-receipts.json'
DEFAULT_COUNTRY = 'ie'   # Lidl Ireland
DEFAULT_LANGUAGE = 'en'
ENV_KEYS = ('LIDL_PHONE', 'LIDL_PASSWORD')
REPO_ENV = Path(__file__).resolve().parent / '.env'
OUT_ENV = OUT_DIR / 'lidl.env'    # the template lives here (gitignored)
OTP_FILE = OUT_DIR / 'otp.txt'    # --otp-file waits for the code here


def _fail(msg, code=1):
    print(f'ERROR: {msg}', file=sys.stderr)
    sys.exit(code)


def _out_dir():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    return OUT_DIR


def _read_env_file(path):
    """KEY=VALUE lines, '#' comments, quotes optional. Only our own keys are read."""
    vals = {}
    try:
        text = path.read_text(encoding='utf-8')
    except OSError as exc:  # noqa: BLE001
        _fail(f'env file unreadable: {path} ({exc})')
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith('#') or '=' not in s:
            continue
        key, _, val = s.partition('=')
        key = key.strip()
        if key.startswith('export '):
            key = key[7:].strip()
        if key not in ENV_KEYS:
            continue
        val = val.strip()
        if len(val) > 1 and val[0] == val[-1] and val[0] in '\"':
            val = val[1:-1]                      # quoted: literal, '#' kept
        else:
            val = re.split(r'\s+#', val, 1)[0].strip()   # bare: ' #' starts a comment
        vals[key] = val
    return vals


def _load_env(argv):
    """phone + password from the FIRST source that has both. An environment
    file that mentions our keys but is half-empty is an error, not a fallthrough."""
    for a in argv:
        if a.startswith('--env='):
            path = Path(a[len('--env='):]).expanduser()
            if not path.is_file():
                _fail(f'env file not found: {path}')
            vals = _read_env_file(path)
            missing = [k for k in ENV_KEYS if not vals.get(k, '').strip()]
            if missing:
                _fail(f'{path} is missing {", ".join(missing)} - fill them in.')
            return vals
    if os.environ.get(ENV_KEYS[0], '').strip() and os.environ.get(ENV_KEYS[1], '').strip():
        return {k: os.environ[k].strip() for k in ENV_KEYS}
    for path in (REPO_ENV, OUT_ENV):
        if not path.is_file():
            continue
        vals = _read_env_file(path)
        if not any(k in vals for k in ENV_KEYS):
            continue  # some other file's env file - not ours to read
        missing = [k for k in ENV_KEYS if not vals.get(k, '').strip()]
        if missing:
            _fail(f'{path} has {", ".join(missing)} empty - fill them in\n'
                  '       (or delete the file to be prompted for them interactively)')
        return vals
    return {}


def _wait_otp(timeout=600):
    """--otp-file mode: the code is written to OTP_FILE by hand, consumed on read."""
    print(f'Waiting for the code: write it into {OTP_FILE} (up to {timeout}s).',
          flush=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            code = OTP_FILE.read_text(encoding='utf-8').strip()
        except OSError:
            code = ''
        if code:
            try:
                OTP_FILE.unlink()
            except OSError:
                pass
            return code
        time.sleep(2)
    _fail(f'timed out after {timeout}s waiting for {OTP_FILE}')


def _api(refresh_token=''):
    try:
        from lidlplus import LidlPlusApi
    except ImportError:
        _fail('the lidl-plus package is not installed.\n'
              '       Run:  pip install "lidl-plus[auth]"   (from any folder)')
    return LidlPlusApi(language=DEFAULT_LANGUAGE, country=DEFAULT_COUNTRY,
                       refresh_token=refresh_token)


def cmd_probe(_argv):
    """Unauthenticated liveness, stdlib only. What this proves without a login:
       - accounts.lidl.com OIDC discovery answers (the auth server is standards-based)
       - the tickets route exists - but it 401s for ANY country path (IE, DE and a
         bogus XX all answer 401), so route-level 401 does NOT prove IE is served.
       Only `auth` + `fetch` can settle that; this just records the baseline."""
    import urllib.request
    targets = [
        ('OIDC discovery', 'https://accounts.lidl.com/.well-known/openid-configuration'),
        ('tickets route IE', 'https://tickets.lidlplus.com/api/v2/IE/tickets?pageNumber=1&onlyFavorite=false'),
        ('tickets route DE (control)', 'https://tickets.lidlplus.com/api/v2/DE/tickets?pageNumber=1&onlyFavorite=false'),
        ('tickets route XX (bogus control)', 'https://tickets.lidlplus.com/api/v2/XX/tickets?pageNumber=1&onlyFavorite=false'),
    ]
    print('Unauthenticated probe (no data is read, nothing is logged in):')
    for label, url in targets:
        req = urllib.request.Request(url, method='GET', headers={'User-Agent': 'cents-spike/1.0'})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                print(f'  {resp.status}  {label}')
        except urllib.error.HTTPError as exc:
            print(f'  {exc.code}  {label}')
        except Exception as exc:  # noqa: BLE001 - a spike report, not a library
            print(f'  ERR  {label}: {exc}')
    print('\nAll 401s means: route alive, auth checked before country, IE unproven.')
    print('Next: python lidl-spike.py auth')


def cmd_auth(argv):
    """Drive the app-login simulation once and keep only the refresh token."""
    _out_dir()
    headless = '--headed' not in argv
    file_otp = '--otp-file' in argv or not sys.stdin.isatty()
    env = _load_env(argv)
    phone = env.get(ENV_KEYS[0], '').strip()
    password = env.get(ENV_KEYS[1], '').strip()
    if file_otp and not (phone and password):
        _fail('a non-interactive login needs both LIDL_PHONE and LIDL_PASSWORD.\n'
              f'       Fill {OUT_ENV} (template), pass --env=PATH, or set the env vars.')
    print('One-time Lidl Plus login (browser opens'
          f'{" headless" if headless else " VISIBLE - you can watch it"}).')
    if not phone:
        print('You will be asked for your Lidl Plus phone number, password and an SMS/email code.')
        try:
            phone = input('Lidl Plus phone number (e.g. +353871234567): ').strip()
        except EOFError:
            _fail('no terminal to ask in - put LIDL_PHONE and LIDL_PASSWORD in an env file.')
        if not phone:
            _fail('no phone number given.')
    if not password:
        import getpass
        try:
            password = getpass.getpass('Lidl Plus password: ')
        except EOFError:
            _fail('no terminal to ask in - put LIDL_PHONE and LIDL_PASSWORD in an env file.')
        if not password:
            _fail('no password given.')

    def otp():
        if not file_otp:
            return input('Verification code just sent to you: ').strip()
        return _wait_otp()

    api = _api()
    api.login(phone=phone, password=password, verify_mode='phone',
              verify_token_func=otp, headless=headless)
    token = api.refresh_token
    if not token:
        _fail('login returned no refresh token - Lidl may have changed the flow.')
    TOKEN_FILE.write_text(token, encoding='ascii')
    print(f'\nOK. Refresh token saved (gitignored, never committed): {TOKEN_FILE}')
    print('It never enters this repository, the app, or any server.')
    print('Next: python lidl-spike.py fetch')


def _read_token():
    if not TOKEN_FILE.is_file():
        _fail(f'no refresh token at {TOKEN_FILE}\n       Run:  python lidl-spike.py auth')
    return TOKEN_FILE.read_text(encoding='ascii').strip()


def cmd_fetch(_argv):
    """Fetch the receipt list + full receipt details -> JSON (the shape the app imports)."""
    _out_dir()
    api = _api(refresh_token=_read_token())
    print('Refreshing token and listing receipts (IE)...')
    try:
        tickets = api.tickets()
    except Exception as exc:  # noqa: BLE001 - report exactly what Lidl said
        _fail(f'ticket list failed for country IE: {exc!r}\n'
              '       If this says 404/NOT_FOUND, Lidl does not serve IE through this API -'
              ' the spike has answered its question.')
    print(f'{len(tickets)} receipt(s) in the account.')
    if not tickets:
        _out_dir()
        RECEIPTS_FILE.write_text('[]', encoding='utf-8')
        print('Empty account - scan your Lidl Plus card at a till, then rerun fetch.')
        return
    details = []
    for t in tickets:
        tid = t.get('id') or t.get('ticketId') or t.get('ticket_id')
        if tid is None:
            continue
        details.append({'listEntry': t, 'detail': api.ticket(tid)})
    RECEIPTS_FILE.write_text(json.dumps(details, indent=2, ensure_ascii=False), encoding='utf-8')
    first = details[0]
    print(f'Wrote {len(details)} full receipt(s): {RECEIPTS_FILE}')
    print('List-entry fields:', sorted(first["listEntry"].keys()))
    print('Detail top-level fields:', sorted(first["detail"].keys()))
    print('\nThis JSON is what the app import will parse (date + total -> one entry per receipt).')


def _normalize(raw_list_entry, detail):
    """One Lidl ticket -> the app's shape: {id, date, total, store, count}.

    Field names below are best guesses until the first real fetch (the `fetch`
    command dumps the raw JSON so they can be corrected); anything unparseable
    comes back with parsed=False and the app skips it rather than guessing.
    """
    import re as _re
    src = {}
    src.update(raw_list_entry or {})
    if isinstance(detail, dict):
        src.update(detail)
    tid = str(src.get('id') or src.get('ticketId') or src.get('ticket_id') or '')
    date_val = ''
    for key in ('purchaseDate', 'date', 'transactionDate', 'ticketDate', 'createdDate'):
        v = src.get(key)
        if isinstance(v, str) and v:
            m = _re.search(r'(\d{4}-\d{2}-\d{2})|(\d{2})[/.](\d{2})[/.](\d{4})', v)
            if m:
                date_val = (m.group(1) or f'{m.group(4)}-{m.group(3)}-{m.group(2)}')
            break
    total_val = None
    for key in ('totalAmount', 'total', 'amount', 'grossAmount', 'netAmount'):
        v = src.get(key)
        if v is not None:
            try:
                total_val = round(float(str(v).replace(',', '.')), 2)
                break
            except (TypeError, ValueError):
                pass
    if total_val is None and isinstance(src.get('items'), list):
        # Fallback: the item lines the README example shows, summed.
        try:
            total_val = round(sum(float(str(it.get('currentUnitPrice', '0')).replace(',', '.'))
                                  * float(str(it.get('quantity', '1')).replace(',', '.'))
                                  for it in src['items'] if isinstance(it, dict)), 2)
        except (TypeError, ValueError):
            pass
    parsed = bool(tid and date_val and total_val is not None)
    return {
        'id': tid or None,
        'date': date_val,
        'total': total_val,
        'store': str(src.get('storeName') or src.get('store') or ''),
        'count': len(src.get('items')) if isinstance(src.get('items'), list) else None,
        'parsed': parsed,
    }


def _real_tickets():
    api = _api(_read_token())
    raw = api.tickets()
    out = []
    for t in raw:
        tid = t.get('id') or t.get('ticketId') or t.get('ticket_id')
        detail = None
        try:
            if tid is not None:
                detail = api.ticket(tid)
        except Exception:  # noqa: BLE001 - one bad ticket must not sink the pull
            detail = None
        out.append(_normalize(t, detail))
    return out


def _mock_tickets():
    """Three canned IE receipts, dates relative to today: inside the window,
    also inside, and far outside it (so the app's bounded catch-up is testable
    without a login). Ids are stable across runs so re-pull dedupe is testable."""
    from datetime import date, timedelta
    today = date.today()
    return [
        {'id': 'mock-1001', 'date': str(today - timedelta(days=2)), 'total': 42.17,
         'store': 'Dun Laoghaire', 'count': 12, 'parsed': True},
        {'id': 'mock-1002', 'date': str(today - timedelta(days=9)), 'total': 15.98,
         'store': 'Dun Laoghaire', 'count': 4, 'parsed': True},
        {'id': 'mock-1003', 'date': str(today - timedelta(days=50)), 'total': 88.44,
         'store': 'Sallynoggin', 'count': 20, 'parsed': True},
    ]


def cmd_serve(argv):
    """Local relay the BROWSER can reach (Lidl's API sends no CORS headers,
    and OPTIONS answers 405 - verified - so direct fetch is impossible).

    Binds 127.0.0.1 only. Real mode reads the refresh token on THIS machine and
    hands the page only normalized receipts - the token never reaches the
    browser, the site, or any server. --mock serves canned receipts so the app
    pipeline can be tried before anyone logs in.
    """
    import json as _json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    mock = '--mock' in argv
    port = 8787
    for a in argv:
        if a.startswith('--port='):
            port = int(a.split('=', 1)[1])
    if not mock and not TOKEN_FILE.is_file():
        _fail(f'no refresh token at {TOKEN_FILE}\n'
              '       Run:  python lidl-spike.py auth   - or serve with --mock')

    class Handler(BaseHTTPRequestHandler):
        def _cors(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', '*')

        def do_OPTIONS(self):  # noqa: N802 - http.server's name
            self.send_response(204)
            self._cors()
            self.end_headers()

        def _json(self, code, payload):
            body = _json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802 - http.server's name
            try:
                if self.path.startswith('/status'):
                    self._json(200, {'ok': True, 'mode': 'mock' if mock else 'real',
                                     'country': DEFAULT_COUNTRY})
                elif self.path.startswith('/tickets'):
                    tickets = _mock_tickets() if mock else _real_tickets()
                    self._json(200, {'tickets': tickets})
                else:
                    self._json(404, {'error': 'unknown route'})
            except Exception as exc:  # noqa: BLE001 - report Lidl's answer, never crash
                self._json(502, {'error': repr(exc)})

        def log_message(self, *args):  # keep the console readable
            pass

    # Bound on BOTH loopback families, because the app addresses this relay as
    # `localhost` — Chrome's Local Network Access refuses the IP literal from a
    # page (measured 16 Oct 2026 on one server, both spellings, side by side:
    # 127.0.0.1 answered `net::ERR_FAILED`, localhost answered) — and on Windows
    # `localhost` resolves to ::1 FIRST. An IPv4-only socket therefore leaves
    # the app talking to whatever else happens to hold ::1:port: measured here,
    # with another process on ::1:8787, the name reached THAT server and the
    # pull failed on its (absent) CORS headers while the relay was up and
    # answering on 127.0.0.1. Dual-stack '::' with IPV6_V6ONLY off answers both.
    class _DualStackServer(ThreadingHTTPServer):
        address_family = socket.AF_INET6

        def server_bind(self):
            try:
                self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            except OSError:
                pass  # a stack without the knob still binds the IPv6 side
            ThreadingHTTPServer.server_bind(self)

    try:
        srv = _DualStackServer(('::', port), Handler)
    except OSError:
        # No IPv6 on this machine: the IPv4 socket is still the relay, and
        # `localhost` reaching it is the browser's job (Chrome falls back).
        srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    mode = 'MOCK - canned receipts, no login' if mock else 'REAL - Lidl Plus (IE)'
    print(f'Lidl relay listening on http://localhost:{port}  [{mode}]')
    print('Ctrl+C to stop. The token (real mode) never leaves this machine.')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nRelay stopped.')


def main(argv):
    if len(argv) < 2 or argv[1] not in ('probe', 'auth', 'fetch', 'serve'):
        print(__doc__ or 'usage: lidl-spike.py probe|auth|fetch|serve [--mock]')
        return 2
    {'probe': cmd_probe, 'auth': cmd_auth, 'fetch': cmd_fetch, 'serve': cmd_serve}[argv[1]](argv[2:])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
