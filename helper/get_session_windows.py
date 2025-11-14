import sqlite3
import os
import win32crypt
import base64
import json
import urllib.parse
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
import sys
import subprocess
import time
import shutil
import tempfile
import argparse
import requests
from pathlib import Path
import warnings
import urllib3
import hashlib
import platform

# Selenium imports for browser login
# Note: These are in try/except because start.py imports this module but doesn't bundle Selenium
# PyInstaller will still detect them via hiddenimports in build-python.spec
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options as ChromeOptions
    from selenium.webdriver.chrome.service import Service as ChromeService
    from selenium.webdriver.firefox.options import Options as FirefoxOptions
    from selenium.webdriver.firefox.service import Service as FirefoxService
    from selenium.webdriver.edge.options import Options as EdgeOptions
    from selenium.webdriver.edge.service import Service as EdgeService
    SELENIUM_AVAILABLE = True
except ImportError:
    SELENIUM_AVAILABLE = False

# Try to import keyring for cross-platform secure storage
try:
    import keyring
    KEYRING_AVAILABLE = True
    print("[*] Using OS keyring for secure session storage", file=sys.stderr)
except ImportError:
    KEYRING_AVAILABLE = False
    print("[!] Warning: keyring module not available, using fallback encryption", file=sys.stderr)
    print("[!] Install with: pip install keyring", file=sys.stderr)

# Suppress all SSL warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
warnings.filterwarnings('ignore')

# --- Configuration ---
TARGET_DOMAIN = 'shippingmanager.cc'
TARGET_COOKIE_NAME = 'shipping_manager_session'

# Use LOCALAPPDATA for all user data (cross-platform support)
# Determine data directory based on execution mode
if getattr(sys, 'frozen', False):
    # Running as .exe - use LocalAppData
    DATA_ROOT = Path(os.environ.get('LOCALAPPDATA', os.path.expanduser('~/.local/share'))) / 'ShippingManagerCoPilot' / 'userdata'
else:
    # Running as .py - use userdata
    SCRIPT_DIR_PARENT = Path(__file__).parent.parent
    DATA_ROOT = SCRIPT_DIR_PARENT / 'userdata'

DATA_ROOT.mkdir(parents=True, exist_ok=True)
SETTINGS_DIR = DATA_ROOT / 'settings'
SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
SESSIONS_FILE = SETTINGS_DIR / 'sessions.json'
SERVICE_NAME = 'ShippingManagerCoPilot'

# Determine helper directory for finding other helper scripts
# When imported as module: __name__ != '__main__'  → use __file__ (points to sys._MEIPASS/helper/)
# When run as standalone: __name__ == '__main__' → use sys.executable.parent
if __name__ == '__main__':
    # Standalone mode: executable is in helper/ dir, other helpers are siblings
    HELPER_DIR = Path(sys.executable).parent
else:
    # Imported as module: __file__ points to extracted module location
    HELPER_DIR = Path(__file__).parent

# SCRIPT_DIR is the project root (parent of helper/)
if getattr(sys, 'frozen', False):
    # When running as frozen app, helper files are in installation dir
    SCRIPT_DIR = Path(sys.executable).parent.parent if Path(sys.executable).parent.name == 'helper' else Path(sys.executable).parent
else:
    # Running as .py script from helper/ folder
    SCRIPT_DIR = Path(__file__).parent.parent

# =============================================================================
# ENCRYPTION HELPERS
# =============================================================================

def encrypt_cookie(cookie, user_id):
    """Encrypt cookie using OS keyring or fallback encryption."""
    account_name = f"session_{user_id}"

    if KEYRING_AVAILABLE:
        try:
            # Delete old entry first to avoid duplicates (Windows Credential Manager issue)
            try:
                keyring.delete_password(SERVICE_NAME, account_name)
            except keyring.errors.PasswordDeleteError:
                pass  # Entry didn't exist, that's fine

            # Ensure cookie is a string (not bytes or other type)
            cookie_str = str(cookie) if not isinstance(cookie, str) else cookie

            # Store in OS credential manager (Windows/macOS/Linux)
            keyring.set_password(SERVICE_NAME, account_name, cookie_str)
            return f"KEYRING:{account_name}"
        except Exception as e:
            print(f"[!] Keyring storage failed, using fallback: {e}", file=sys.stderr)

    # Fallback: Basic obfuscation (not as secure as keyring!)
    # This is platform-specific but better than plaintext
    try:
        # Use machine-specific identifier as key
        machine_id = f"{platform.node()}{os.getlogin()}{platform.system()}"
        key = hashlib.sha256(machine_id.encode()).digest()

        # Simple XOR encryption (weak but better than plaintext)
        encrypted = bytes([b ^ key[i % len(key)] for i, b in enumerate(cookie.encode())])
        return f"v1:{base64.b64encode(encrypted).decode()}"
    except Exception as e:
        print(f"[!] Fallback encryption failed: {e}", file=sys.stderr)
        # Last resort: return plaintext (for backward compatibility)
        return cookie

def decrypt_cookie(encrypted_data, user_id):
    """Decrypt cookie from encrypted storage."""
    if not encrypted_data:
        return None

    # Check if stored in keyring
    if encrypted_data.startswith('KEYRING:'):
        if KEYRING_AVAILABLE:
            try:
                account_name = encrypted_data[8:]  # Remove "KEYRING:" prefix
                password = keyring.get_password(SERVICE_NAME, account_name)
                return password
            except Exception as e:
                print(f"[!] Keyring retrieval failed: {e}", file=sys.stderr)
                return None
        else:
            print("[!] Data in keyring but keyring module not available", file=sys.stderr)
            return None

    # Check if fallback encrypted
    if encrypted_data.startswith('v1:'):
        try:
            # Decrypt using machine-specific key
            machine_id = f"{platform.node()}{os.getlogin()}{platform.system()}"
            key = hashlib.sha256(machine_id.encode()).digest()

            encrypted_bytes = base64.b64decode(encrypted_data[3:])  # Remove "v1:" prefix
            decrypted = bytes([b ^ key[i % len(key)] for i, b in enumerate(encrypted_bytes)])
            return decrypted.decode()
        except Exception as e:
            print(f"[!] Fallback decryption failed: {e}", file=sys.stderr)
            return None

    # Assume plaintext (for migration/backward compatibility)
    print("[!] Warning: Detected plaintext cookie (not encrypted)", file=sys.stderr)
    return encrypted_data

def is_encrypted(data):
    """Check if data is encrypted."""
    if not data or not isinstance(data, str):
        return False
    return data.startswith('KEYRING:') or data.startswith('v1:')

# =============================================================================
# SESSION MANAGEMENT
# =============================================================================

def load_sessions():
    """Load saved sessions from sessions.json."""
    try:
        if SESSIONS_FILE.exists():
            with open(SESSIONS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {}
    except Exception as e:
        print(f"[!] Error loading sessions: {e}", file=sys.stderr)
        return {}

def save_session(user_id, cookie, company_name, login_method):
    """Save session to sessions.json with encrypted cookie."""
    try:
        sessions = load_sessions()

        # Encrypt the cookie before storing
        encrypted_cookie = encrypt_cookie(cookie, user_id)

        sessions[str(user_id)] = {
            'cookie': encrypted_cookie,
            'timestamp': int(time.time()),
            'company_name': company_name,
            'login_method': login_method
        }

        # Ensure directory exists
        SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)

        with open(SESSIONS_FILE, 'w', encoding='utf-8') as f:
            json.dump(sessions, f, indent=2)
            f.flush()  # Flush buffer to OS
            os.fsync(f.fileno())  # Force OS to write to disk immediately

        # Brief delay to ensure file system has updated (especially on Windows)
        time.sleep(0.5)

        encryption_type = "OS keyring" if encrypted_cookie.startswith('KEYRING:') else "fallback encryption"
        print(f"[+] Session saved for user {company_name} (ID: {user_id}, Method: {login_method}, Encryption: {encryption_type})", file=sys.stderr)
        print(f"[+] File flushed and synced to disk", file=sys.stderr)
    except Exception as e:
        print(f"[!] Error saving session: {e}", file=sys.stderr)

def validate_session_cookie(cookie, user_id=None):
    """Validate session cookie with API. Returns user data if valid, None otherwise.

    Args:
        cookie: Either plaintext cookie or encrypted cookie data
        user_id: User ID (required if cookie is encrypted)
    """
    # Decrypt if encrypted
    if is_encrypted(cookie):
        if not user_id:
            print("[!] Cannot decrypt cookie without user_id", file=sys.stderr)
            return None
        cookie = decrypt_cookie(cookie, user_id)
        if not cookie:
            return None

    try:
        response = requests.post(
            f"https://{TARGET_DOMAIN}/api/user/get-user-settings",
            headers={
                'Cookie': f'{TARGET_COOKIE_NAME}={cookie}',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout=10,
            verify=False  # Disable SSL verification
        )

        if response.status_code == 200:
            data = response.json()
            if data.get('user', {}).get('id'):
                return data['user']
        return None
    except Exception as e:
        print(f"[!] Session validation error: {e}", file=sys.stderr)
        return None

def validate_all_sessions():
    """Validate all saved sessions. Returns list of valid sessions with their data."""
    sessions = load_sessions()

    if not sessions:
        print("[*] No saved sessions found", file=sys.stderr)
        return []

    print(f"[*] Found {len(sessions)} saved session(s)", file=sys.stderr)
    print(f"[*] Validating all sessions...", file=sys.stderr)

    valid_sessions = []

    # Try each session (newest first by timestamp)
    sorted_sessions = sorted(
        sessions.items(),
        key=lambda x: x[1].get('timestamp', 0),
        reverse=True
    )

    for user_id, session_data in sorted_sessions:
        encrypted_cookie = session_data.get('cookie')
        company_name = session_data.get('company_name', 'Unknown')
        login_method = session_data.get('login_method', 'unknown')

        print(f"[*] Validating {company_name} (ID: {user_id})...", file=sys.stderr)

        # Check if we can decrypt the cookie first (credential must exist)
        if is_encrypted(encrypted_cookie):
            plaintext_cookie = decrypt_cookie(encrypted_cookie, user_id)
            if not plaintext_cookie:
                print(f"  Skipped (Credential missing - cannot decrypt)", file=sys.stderr)
                continue  # Skip this session entirely - do not add to valid or expired
        else:
            plaintext_cookie = encrypted_cookie

        # Decrypt cookie before validation
        user_data = validate_session_cookie(plaintext_cookie, user_id)
        if user_data:
            print(f"  Valid", file=sys.stderr)
            valid_sessions.append({
                'user_id': user_id,
                'cookie': plaintext_cookie,  # Return decrypted cookie for use
                'company_name': user_data.get('company_name', company_name),
                'user_data': user_data,
                'login_method': login_method  # Include login method
            })
        else:
            print(f"  Expired (Method: {login_method})", file=sys.stderr)

    print(f"[*] {len(valid_sessions)} valid session(s) found", file=sys.stderr)
    return valid_sessions

def show_session_selector(valid_sessions, expired_sessions=None, show_action_buttons=True):
    """Show session selector dialog. Returns selected session or None."""
    try:
        selector_exe = SCRIPT_DIR / 'helper' / 'session-selector.exe'
        selector_script = SCRIPT_DIR / 'helper' / 'session_selector.py'

        # Prepare active session data for dialog
        session_list = [
            {
                'user_id': str(s['user_id']),
                'company_name': s['company_name'],
                'login_method': s.get('login_method', 'unknown')
            }
            for s in valid_sessions
        ]

        # Prepare expired session data for dialog
        expired_list = []
        if expired_sessions:
            expired_list = [
                {
                    'user_id': str(s['user_id']),
                    'company_name': s['company_name'],
                    'login_method': s.get('login_method', 'unknown')
                }
                for s in expired_sessions
            ]

        session_json = json.dumps(session_list)
        expired_json = json.dumps(expired_list)
        show_buttons_str = str(show_action_buttons)

        # Run dialog in subprocess to avoid Tkinter threading issues
        import subprocess

        # Use CREATE_NO_WINDOW flag on Windows to prevent terminal window
        # Use CREATE_BREAKAWAY_FROM_JOB to allow killing the process tree
        creationflags = 0
        if sys.platform == 'win32':
            creationflags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_BREAKAWAY_FROM_JOB

        if getattr(sys, 'frozen', False):
            # Running as .exe - session-selector.exe is in helper directory
            selector_exe = HELPER_DIR / 'session-selector.exe'
            proc = subprocess.Popen(
                [str(selector_exe), session_json, expired_json, show_buttons_str],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                creationflags=creationflags
            )

            try:
                stdout, stderr = proc.communicate(timeout=300)
                result_code = proc.returncode
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate()
                result_code = -1
        else:
            # Running as .py - check if compiled .exe exists, otherwise use .py
            selector_exe = SCRIPT_DIR / 'dist' / 'session-selector.exe'
            if selector_exe.exists():
                # Use compiled .exe with icon
                proc = subprocess.Popen(
                    [str(selector_exe), session_json, expired_json, show_buttons_str],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    creationflags=creationflags
                )
            else:
                # Fallback to .py script
                selector_script = SCRIPT_DIR / 'helper' / 'session_selector.py'
                proc = subprocess.Popen(
                    [sys.executable, str(selector_script), session_json, expired_json, show_buttons_str],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    creationflags=creationflags
                )


            try:
                stdout, stderr = proc.communicate(timeout=300)
                result_code = proc.returncode
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate()
                result_code = -1

        print(f"[get_session_windows] Subprocess result_code: {result_code}", file=sys.stderr)
        print(f"[get_session_windows] Subprocess stdout: {repr(stdout)}", file=sys.stderr)
        print(f"[get_session_windows] Subprocess stderr: {repr(stderr)}", file=sys.stderr)

        if result_code == 0 and stdout.strip():
            parsed_result = json.loads(stdout.strip())
            print(f"[get_session_windows] Parsed JSON result: {parsed_result}", file=sys.stderr)
            return parsed_result
        else:
            print("[-] User cancelled session selection or subprocess failed", file=sys.stderr)
            return None

    except Exception as e:
        print(f"[-] Error showing session selector: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None

# Login method is now stored with each session in sessions.json
# No need for separate login-method.json file

def get_expired_sessions_with_methods():
    """Get all expired sessions (includes sessions with unknown method)."""
    sessions = load_sessions()

    if not sessions:
        return []

    expired_with_methods = []

    for user_id, session_data in sessions.items():
        encrypted_cookie = session_data.get('cookie')
        company_name = session_data.get('company_name', 'Unknown')
        login_method = session_data.get('login_method', 'unknown')

        # Check if session is expired (decrypt for validation)
        user_data = validate_session_cookie(encrypted_cookie, user_id)
        if not user_data:
            # Session expired - add to list (even if method unknown)
            expired_with_methods.append({
                'user_id': user_id,
                'company_name': company_name,
                'login_method': login_method if login_method in ['steam', 'browser'] else 'unknown'
            })

    return expired_with_methods

def get_user_from_cookie(cookie):
    """Get user data from a validated cookie."""
    return validate_session_cookie(cookie)

def show_login_dialog():
    """Show login dialog and return user selection."""
    try:
        import subprocess

        # Use CREATE_NO_WINDOW flag on Windows to prevent terminal window
        creationflags = 0
        if sys.platform == 'win32':
            creationflags = subprocess.CREATE_NO_WINDOW

        if getattr(sys, 'frozen', False):
            # Running as .exe - login-dialog.exe is in helper directory
            dialog_exe = HELPER_DIR / 'login-dialog.exe'
            result = subprocess.run(
                [str(dialog_exe)],
                capture_output=True,
                text=True,
                timeout=300,
                creationflags=creationflags
            )
        else:
            # Running as .py - check if compiled .exe exists, otherwise use .py
            dialog_exe = SCRIPT_DIR / 'dist' / 'login-dialog.exe'
            if dialog_exe.exists():
                # Use compiled .exe with icon
                result = subprocess.run(
                    [str(dialog_exe)],
                    capture_output=True,
                    text=True,
                    timeout=300,
                    creationflags=creationflags
                )
            else:
                # Fallback to .py script
                dialog_script = SCRIPT_DIR / 'helper' / 'login_dialog.py'
                result = subprocess.run(
                    [sys.executable, str(dialog_script)],
                    capture_output=True,
                    text=True,
                    timeout=300,
                    creationflags=creationflags
                )

        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        else:
            print("[-] User cancelled login dialog", file=sys.stderr)
            return None
    except Exception as e:
        print(f"[-] Error showing login dialog: {e}", file=sys.stderr)
        return None

def show_expired_sessions_dialog(expired_sessions):
    """Show expired sessions renewal dialog."""
    try:
        import subprocess

        # Use CREATE_NO_WINDOW flag on Windows to prevent terminal window
        creationflags = 0
        if sys.platform == 'win32':
            creationflags = subprocess.CREATE_NO_WINDOW

        sessions_json = json.dumps(expired_sessions)

        if getattr(sys, 'frozen', False):
            # Running as .exe - expired-sessions-dialog.exe is in helper directory
            dialog_exe = HELPER_DIR / 'expired-sessions-dialog.exe'
            result = subprocess.run(
                [str(dialog_exe), sessions_json],
                capture_output=True,
                text=True,
                timeout=300,
                creationflags=creationflags
            )
        else:
            # Running as .py - check if compiled .exe exists, otherwise use .py
            dialog_exe = SCRIPT_DIR / 'dist' / 'expired-sessions-dialog.exe'
            if dialog_exe.exists():
                # Use compiled .exe with icon
                result = subprocess.run(
                    [str(dialog_exe), sessions_json],
                    capture_output=True,
                    text=True,
                    timeout=300,
                    creationflags=creationflags
                )
            else:
                # Fallback to .py script
                dialog_script = SCRIPT_DIR / 'helper' / 'expired_sessions_dialog.py'
                result = subprocess.run(
                    [sys.executable, str(dialog_script), sessions_json],
                    capture_output=True,
                    text=True,
                    timeout=300,
                    creationflags=creationflags
                )

        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        else:
            print("[-] User cancelled expired sessions dialog", file=sys.stderr)
            return None
    except Exception as e:
        print(f"[-] Error showing expired sessions dialog: {e}", file=sys.stderr)
        return None

# --- Steam Cookie Paths ---
COOKIE_PATH = os.path.join(
    os.environ['USERPROFILE'],
    'AppData',
    'Local',
    'Steam',
    'htmlcache',
    'Network',
    'Cookies'
)
LOCAL_PREFS_PATH = os.path.join(
    os.environ['USERPROFILE'],
    'AppData',
    'Local',
    'Steam',
    'htmlcache',
    'LocalPrefs.json'
)

# =============================================================================
# STEAM LOGIN METHOD
# =============================================================================

def decrypt_aes_gcm(encrypted_value: bytes, key: bytes) -> str | None:
    """Decrypts the encrypted cookie value using AES-256-GCM."""
    try:
        encrypted_value_bytes = encrypted_value[3:]
        nonce = encrypted_value_bytes[:12]
        ciphertext_with_tag = encrypted_value_bytes[12:]
        tag = ciphertext_with_tag[-16:]
        ciphertext = ciphertext_with_tag[:-16]

        cipher = Cipher(algorithms.AES(key), modes.GCM(nonce, tag), backend=default_backend())
        decryptor = cipher.decryptor()
        decrypted_payload = decryptor.update(ciphertext) + decryptor.finalize()

        return decrypted_payload.decode('utf-8')
    except Exception:
        return None

def get_aes_key(prefs_path: str) -> bytes | None:
    """Extracts and decrypts the DPAPI-protected AES key from LocalPrefs.json."""
    try:
        with open(prefs_path, 'r', encoding='utf-8') as f:
            prefs_data = json.load(f)
        encrypted_key_b64 = prefs_data['os_crypt']['encrypted_key']
        encrypted_key_bytes = base64.b64decode(encrypted_key_b64)
        _, decrypted_key = win32crypt.CryptUnprotectData(
            encrypted_key_bytes[5:],
            None,
            None,
            None,
            0
        )
        return decrypted_key
    except Exception as e:
        print(f"[-] ERROR decrypting AES key (DPAPI): {e}", file=sys.stderr)
        return None

def get_steam_cookie(db_path: str, prefs_path: str, domain: str, target_name: str):
    """Extract cookie from Steam's Chromium cache."""
    aes_key = get_aes_key(prefs_path)
    if not aes_key:
        print("[-] CRITICAL ERROR: Failed to retrieve AES key. Aborting.", file=sys.stderr)
        return None

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        # Use parameterized query to prevent SQL injection
        cursor.execute("SELECT name, encrypted_value FROM cookies WHERE host_key LIKE ?", (f'%{domain}',))
        results = cursor.fetchall()

        if not results:
            print(f"[-] ERROR: No cookies found for domain '{domain}'.", file=sys.stderr)
            return None

        for name, encrypted_value in results:
            decrypted_payload_utf8 = decrypt_aes_gcm(encrypted_value, aes_key)
            if decrypted_payload_utf8 is None:
                continue

            final_token = urllib.parse.unquote(decrypted_payload_utf8).strip()
            if name == target_name and final_token:
                conn.close()
                return final_token

        conn.close()
        return None

    except sqlite3.OperationalError as e:
        print("[*] Database locked by Steam. Using fallback method...", file=sys.stderr)
        try:
            temp_dir = tempfile.gettempdir()
            source_dir = os.path.dirname(db_path)
            source_file = os.path.basename(db_path)

            # Use CREATE_NO_WINDOW to prevent terminal window
            creationflags_robocopy = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0

            result = subprocess.run(
                ['robocopy', source_dir, temp_dir, source_file, '/R:1', '/W:1'],
                capture_output=True,
                encoding='latin-1',
                errors='ignore',
                timeout=5,
                creationflags=creationflags_robocopy
            )

            temp_db_actual = os.path.join(temp_dir, source_file)
            if os.path.exists(temp_db_actual):
                print("[*] Database copied successfully, reading from copy...", file=sys.stderr)
                cookie = get_steam_cookie(temp_db_actual, prefs_path, domain, target_name)
                try:
                    os.remove(temp_db_actual)
                except:
                    pass
                return cookie
            else:
                print("[*] Copy failed. Gracefully closing Steam and games...", file=sys.stderr)

                # Use CREATE_NO_WINDOW for all Steam/tasklist/taskkill commands
                creationflags_steam = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0

                try:
                    subprocess.run(['cmd', '/c', 'start', 'steam://exit'], capture_output=True, timeout=2, creationflags=creationflags_steam)
                    print("[*] Sent exit signal to Steam, waiting for graceful shutdown...", file=sys.stderr)
                except:
                    pass

                for i in range(10):
                    time.sleep(1)
                    result = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq steam.exe'],
                                          capture_output=True, encoding='utf-8', errors='ignore', creationflags=creationflags_steam)
                    if result.stdout and 'steam.exe' not in result.stdout:
                        print("[+] Steam closed gracefully", file=sys.stderr)
                        break
                    if i == 4:
                        print("[*] Sending close signal to Steam windows...", file=sys.stderr)
                        subprocess.run(['taskkill', '/IM', 'steam.exe'], capture_output=True, creationflags=creationflags_steam)
                else:
                    print("[!] Steam didn't close gracefully, forcing shutdown...", file=sys.stderr)
                    subprocess.run(['taskkill', '/F', '/IM', 'steam.exe'], capture_output=True, creationflags=creationflags_steam)
                    time.sleep(2)

                time.sleep(1)

                print("[*] Reading cookie from unlocked database...", file=sys.stderr)
                conn2 = sqlite3.connect(db_path)
                cursor2 = conn2.cursor()
                # Use parameterized query to prevent SQL injection
                cursor2.execute("SELECT name, encrypted_value FROM cookies WHERE host_key LIKE ?", (f'%{domain}',))
                results2 = cursor2.fetchall()

                cookie_found = None
                for name, encrypted_value in results2:
                    decrypted_payload_utf8 = decrypt_aes_gcm(encrypted_value, aes_key)
                    if decrypted_payload_utf8 and name == target_name:
                        final_token = urllib.parse.unquote(decrypted_payload_utf8).strip()
                        if final_token:
                            cookie_found = final_token
                            print("[+] Cookie successfully extracted!", file=sys.stderr)
                            break

                conn2.close()

                print("[*] Restarting Steam (minimized)...", file=sys.stderr)
                steam_path = r"C:\Program Files (x86)\Steam\steam.exe"
                if not os.path.exists(steam_path):
                    steam_path = r"C:\Program Files\Steam\steam.exe"

                if os.path.exists(steam_path):
                    # Use CREATE_NO_WINDOW to prevent terminal window when restarting Steam
                    creationflags_popen = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
                    subprocess.Popen([steam_path, '-silent'], creationflags=creationflags_popen)
                    print("[+] Steam restarted successfully (minimized)", file=sys.stderr)
                else:
                    print("[!] Could not find Steam executable, please restart Steam manually", file=sys.stderr)

                return cookie_found

        except Exception as fallback_error:
            print(f"[-] Fallback failed: {fallback_error}", file=sys.stderr)
            return None

    except Exception as e:
        print(f"[-] CRITICAL ERROR during cookie decryption: {e}", file=sys.stderr)
        return None

def steam_login():
    """Main function for Steam login method. Returns cookie or None."""
    print(f"[*] Starting Steam cookie extraction for '{TARGET_DOMAIN}'...", file=sys.stderr)

    if not os.path.exists(COOKIE_PATH):
        print(f"[-] CRITICAL ERROR: Cookies database not found at {COOKIE_PATH}", file=sys.stderr)
        print("[-] Please ensure Steam is installed and you have logged into Shipping Manager via Steam browser.", file=sys.stderr)
        return None
    elif not os.path.exists(LOCAL_PREFS_PATH):
        print(f"[-] CRITICAL ERROR: LocalPrefs.json not found at {LOCAL_PREFS_PATH}", file=sys.stderr)
        return None

    cookie = get_steam_cookie(COOKIE_PATH, LOCAL_PREFS_PATH, TARGET_DOMAIN, TARGET_COOKIE_NAME)

    if cookie:
        print("[+] Steam login successful!", file=sys.stderr)
        return cookie
    else:
        print("[-] Failed to extract cookie from Steam", file=sys.stderr)
        return None

# =============================================================================
# BROWSER LOGIN METHOD (SELENIUM)
# =============================================================================

def detect_browser():
    """Detect available compatible browser and return appropriate driver."""
    system = platform.system()

    print("[*] Detecting available browsers...", file=sys.stderr)

    # Check if Selenium is available (imported at module level)
    if not SELENIUM_AVAILABLE:
        print("[-] ERROR: Selenium not installed. Please run: pip install selenium", file=sys.stderr)
        sys.exit(1)

    # Determine if running as PyInstaller bundle
    if getattr(sys, 'frozen', False):
        # Running as compiled executable - webdrivers are in helper/webdrivers/
        webdriver_dir = os.path.join(HELPER_DIR, 'webdrivers')
    else:
        # Running as script
        script_dir = os.path.dirname(os.path.abspath(__file__))
        webdriver_dir = os.path.join(script_dir, 'webdrivers')

    # WebDriver paths
    chromedriver_path = os.path.join(webdriver_dir, 'chromedriver.exe')
    edgedriver_path = os.path.join(webdriver_dir, 'msedgedriver.exe')
    geckodriver_path = os.path.join(webdriver_dir, 'geckodriver.exe')

    # Get default browser if possible
    default_browser = None
    try:
        if system == 'Windows':
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice')
            value, _ = winreg.QueryValueEx(key, 'ProgId')
            default_browser = value.lower()
            winreg.CloseKey(key)
        elif system == 'Darwin':  # macOS
            import subprocess
            result = subprocess.run(['defaults', 'read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers'],
                                  capture_output=True, text=True)
            if 'chrome' in result.stdout.lower():
                default_browser = 'chrome'
            elif 'firefox' in result.stdout.lower():
                default_browser = 'firefox'
        elif system == 'Linux':
            import subprocess
            result = subprocess.run(['xdg-settings', 'get', 'default-web-browser'],
                                  capture_output=True, text=True)
            default_browser = result.stdout.strip().lower()
    except Exception as e:
        print(f"[*] Could not detect default browser: {e}", file=sys.stderr)

    # Priority list based on default browser
    browsers_to_try = []

    if default_browser:
        if 'chrome' in default_browser or 'chromium' in default_browser:
            browsers_to_try = ['chrome', 'chromium', 'firefox', 'edge']
        elif 'firefox' in default_browser:
            browsers_to_try = ['firefox', 'chrome', 'chromium', 'edge']
        elif 'edge' in default_browser:
            browsers_to_try = ['edge', 'chrome', 'chromium', 'firefox']
        else:
            # Unknown or unsupported default, use standard order
            browsers_to_try = ['chrome', 'chromium', 'firefox', 'edge']
    else:
        browsers_to_try = ['chrome', 'chromium', 'firefox', 'edge']

    # Try each browser in order
    for browser_name in browsers_to_try:
        try:
            if browser_name == 'chrome':
                print(f"[*] Trying Chrome...", file=sys.stderr)
                options = ChromeOptions()
                options.add_argument("--start-maximized")
                options.add_argument("--disable-blink-features=AutomationControlled")
                options.add_experimental_option("excludeSwitches", ["enable-automation"])
                options.add_experimental_option('useAutomationExtension', False)

                # Use bundled ChromeDriver if available
                if os.path.exists(chromedriver_path):
                    service = ChromeService(executable_path=chromedriver_path)
                    driver = webdriver.Chrome(service=service, options=options)
                else:
                    driver = webdriver.Chrome(options=options)

                print(f"[+] Using Chrome browser", file=sys.stderr)
                return driver

            elif browser_name == 'chromium':
                print(f"[*] Trying Chromium...", file=sys.stderr)
                options = ChromeOptions()
                options.binary_location = '/usr/bin/chromium-browser' if system == 'Linux' else None
                options.add_argument("--start-maximized")
                options.add_argument("--disable-blink-features=AutomationControlled")
                options.add_experimental_option("excludeSwitches", ["enable-automation"])
                options.add_experimental_option('useAutomationExtension', False)

                # Use bundled ChromeDriver if available
                if os.path.exists(chromedriver_path):
                    service = ChromeService(executable_path=chromedriver_path)
                    driver = webdriver.Chrome(service=service, options=options)
                else:
                    driver = webdriver.Chrome(options=options)

                print(f"[+] Using Chromium browser", file=sys.stderr)
                return driver

            elif browser_name == 'firefox':
                print(f"[*] Trying Firefox...", file=sys.stderr)
                options = FirefoxOptions()
                options.set_preference("dom.webdriver.enabled", False)

                # Use bundled GeckoDriver if available
                if os.path.exists(geckodriver_path):
                    service = FirefoxService(executable_path=geckodriver_path)
                    driver = webdriver.Firefox(service=service, options=options)
                else:
                    driver = webdriver.Firefox(options=options)

                print(f"[+] Using Firefox browser", file=sys.stderr)
                return driver

            elif browser_name == 'edge' and system == 'Windows':
                print(f"[*] Trying Edge...", file=sys.stderr)
                options = EdgeOptions()
                options.add_argument("--start-maximized")
                options.add_experimental_option("excludeSwitches", ["enable-automation"])

                # Use bundled EdgeDriver if available
                if os.path.exists(edgedriver_path):
                    service = EdgeService(executable_path=edgedriver_path)
                    driver = webdriver.Edge(service=service, options=options)
                else:
                    driver = webdriver.Edge(options=options)

                print(f"[+] Using Edge browser", file=sys.stderr)
                return driver

        except Exception as e:
            print(f"[*] {browser_name.capitalize()} not available: {str(e)[:50]}...", file=sys.stderr)
            continue

    # No browser found
    print("[-] ERROR: No compatible browser found!", file=sys.stderr)
    print("[-] Please install one of the following browsers:", file=sys.stderr)
    print("[-]   - Google Chrome", file=sys.stderr)
    print("[-]   - Chromium", file=sys.stderr)
    print("[-]   - Mozilla Firefox", file=sys.stderr)
    if system == 'Windows':
        print("[-]   - Microsoft Edge", file=sys.stderr)
    print("[-]", file=sys.stderr)
    print("[-] Also ensure the corresponding WebDriver is installed:", file=sys.stderr)
    print("[-]   pip install selenium", file=sys.stderr)
    sys.exit(1)

def browser_login_native():
    """
    Windows-native browser login using C# WebView2 (BrowserLogin.exe).
    Returns cookie or None.
    Automatically falls back to Selenium if BrowserLogin.exe is not available.
    """
    import subprocess
    import os
    import platform

    # Check if we're on Windows
    if platform.system() != 'Windows':
        print("[*] Not on Windows, using Selenium fallback...", file=sys.stderr)
        return None  # Fallback to Selenium

    # Check if BrowserLogin.exe exists
    # When running as PyInstaller exe, this module is embedded in ShippingManagerCoPilot.exe
    # sys.executable points to ShippingManagerCoPilot.exe in the installation directory
    if getattr(sys, 'frozen', False):
        # Running as compiled exe - sys.executable is the main exe
        # e.g., C:\Users\Bob\AppData\Local\ShippingManagerCoPilot\ShippingManagerCoPilot.exe
        install_dir = os.path.dirname(os.path.abspath(sys.executable))
        helper_dir = os.path.join(install_dir, 'helper')
    else:
        # Running as .py script - use script directory
        script_dir = os.path.dirname(os.path.abspath(__file__))
        helper_dir = script_dir

    browser_login_exe = os.path.join(helper_dir, 'BrowserLogin.exe')

    if not os.path.exists(browser_login_exe):
        print(f"[*] BrowserLogin.exe not found at: {browser_login_exe}", file=sys.stderr)
        print("[*] Using Selenium fallback...", file=sys.stderr)
        return None  # Fallback to Selenium

    print(f"[*] Using native Windows browser login (WebView2)...", file=sys.stderr)
    print(f"[*] Starting browser login for '{TARGET_DOMAIN}'...", file=sys.stderr)

    try:
        # Call BrowserLogin.exe with arguments
        result = subprocess.run(
            [browser_login_exe, '--url', f'https://{TARGET_DOMAIN}', '--timeout', '300'],
            capture_output=True,
            text=True,
            timeout=310  # Slightly longer than the internal timeout
        )

        # Check exit code
        if result.returncode == 0:
            # Success - cookie is in stdout
            cookie = result.stdout.strip()
            if cookie:
                print("[+] Browser login successful! Session cookie extracted.", file=sys.stderr)
                print(f"[+] Cookie length: {len(cookie)}", file=sys.stderr)
                return cookie
            else:
                print("[-] ERROR: Empty cookie received from BrowserLogin.exe", file=sys.stderr)
                return None
        elif result.returncode == 1:
            print("[-] ERROR: Login timeout - no valid session found within 5 minutes", file=sys.stderr)
            return None
        elif result.returncode == 2:
            print("[-] Login cancelled by user", file=sys.stderr)
            return None
        elif result.returncode == 3:
            print(f"[-] ERROR: BrowserLogin.exe error", file=sys.stderr)
            if result.stderr:
                print(f"[-] Details: {result.stderr}", file=sys.stderr)
            return None
        else:
            print(f"[-] ERROR: Unknown exit code from BrowserLogin.exe: {result.returncode}", file=sys.stderr)
            return None

    except subprocess.TimeoutExpired:
        print("[-] ERROR: BrowserLogin.exe timeout (exceeded 310 seconds)", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[-] ERROR: Failed to run BrowserLogin.exe: {e}", file=sys.stderr)
        print("[*] Falling back to Selenium...", file=sys.stderr)
        return None

def browser_login():
    """Browser-based login using Selenium. Returns cookie or None."""
    # Import subprocess and os at module level (sys is already imported globally)
    import subprocess
    import os

    # Try native Windows login first if available
    native_cookie = browser_login_native()
    if native_cookie:
        return native_cookie

    # Fallback to Selenium
    print("[*] Using Selenium browser automation...", file=sys.stderr)
    print(f"[*] Starting browser login for '{TARGET_DOMAIN}'...", file=sys.stderr)

    # Suppress browser output (Chrome DevTools messages)
    original_devnull = os.devnull
    devnull = open(os.devnull, 'w')

    # Store original stderr (sys is already imported at module level)
    original_stderr = sys.stderr

    driver = None
    try:
        # Suppress stderr during detect_browser() (Chrome DevTools spam)
        sys.stderr = devnull

        driver = detect_browser()

        # Restore stderr for our messages
        sys.stderr = original_stderr

        print(f"[*] Navigating to https://{TARGET_DOMAIN}...", file=sys.stderr)
        driver.get(f"https://{TARGET_DOMAIN}")

        print("[*] Waiting for successful login...", file=sys.stderr)
        print("[*] Please log in to Shipping Manager in the browser window.", file=sys.stderr)

        cookie = None
        max_wait = 300
        start_time = time.time()
        last_status = None

        while time.time() - start_time < max_wait:
            try:
                # Check if browser is still open
                try:
                    driver.current_url  # This will throw if browser closed
                except Exception:
                    print("", file=sys.stderr)
                    print("[-] Browser was closed by user", file=sys.stderr)
                    if driver:
                        try:
                            driver.quit()
                        except:
                            pass
                    return None

                # Get current cookies
                cookies = driver.get_cookies()
                temp_cookie = None
                debug_log = []
                for c in cookies:
                    if c['name'] == TARGET_COOKIE_NAME:
                        # Debug: Log cookie at each step
                        raw_cookie = c['value']
                        debug_log.append(f"=== COOKIE DEBUG LOG ===")
                        debug_log.append(f"\n1. Cookie from driver.get_cookies():")
                        debug_log.append(f"   Value: {raw_cookie[:60]}...{raw_cookie[-20:]}")
                        debug_log.append(f"   Length: {len(raw_cookie)}")
                        debug_log.append(f"   Contains %: {('%' in raw_cookie)}")

                        # Decode
                        decoded_cookie = urllib.parse.unquote(raw_cookie).strip()
                        debug_log.append(f"\n2. After urllib.parse.unquote():")
                        debug_log.append(f"   Value: {decoded_cookie[:60]}...{decoded_cookie[-20:]}")
                        debug_log.append(f"   Length: {len(decoded_cookie)}")
                        debug_log.append(f"   Contains %: {('%' in decoded_cookie)}")
                        debug_log.append(f"   Changed: {raw_cookie != decoded_cookie}")

                        temp_cookie = decoded_cookie
                        break

                # If we have a cookie, validate it
                if temp_cookie:
                    try:
                        test_response = requests.post(
                            f"https://{TARGET_DOMAIN}/api/user/get-user-settings",
                            headers={
                                'Cookie': f'{TARGET_COOKIE_NAME}={temp_cookie}',
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                            },
                            timeout=10,
                            verify=False  # Disable SSL verification
                        )

                        if test_response.status_code == 200:
                            # Check if we got valid user data
                            data = test_response.json()

                            # User object is at top level, not under data
                            if data.get('user', {}).get('id'):
                                print("[+] Login successful! Session validated.", file=sys.stderr)
                                print(f"[+] User: {data['user'].get('company_name', 'Unknown')} (ID: {data['user']['id']})", file=sys.stderr)
                                cookie = temp_cookie
                                break
                            else:
                                if last_status != "no_user_data":
                                    print("[*] Cookie found but no user data yet...", file=sys.stderr)
                                    print(f"[DEBUG] Response keys: {list(data.keys())}", file=sys.stderr)
                                    last_status = "no_user_data"
                        else:
                            if last_status != test_response.status_code:
                                print(f"[*] Waiting for login... (API status: {test_response.status_code})", file=sys.stderr)
                                last_status = test_response.status_code
                    except Exception as e:
                        if last_status != "api_error":
                            print(f"[*] Waiting for login to complete...", file=sys.stderr)
                            last_status = "api_error"
                else:
                    if last_status != "no_cookie":
                        print("[*] Waiting for session cookie...", file=sys.stderr)
                        last_status = "no_cookie"

                time.sleep(2)

            except Exception as e:
                print(f"[!] Error: {e}", file=sys.stderr)
                time.sleep(2)

        if not cookie:
            print("[-] ERROR: Login not completed after 5 minutes.", file=sys.stderr)
            print("[-] Please ensure you log in successfully to Shipping Manager.", file=sys.stderr)
            if driver:
                driver.quit()
            return None

        print("[+] Session cookie successfully validated!", file=sys.stderr)

        try:
            driver.execute_script("""
                const overlay = document.createElement('div');
                overlay.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.9);
                    z-index: 999999;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                `;

                const message = document.createElement('div');
                message.style.cssText = `
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    padding: 40px 60px;
                    border-radius: 20px;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
                    text-align: center;
                    color: white;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                `;

                message.innerHTML = `
                    <div style="font-size: 72px; margin-bottom: 20px;">✅</div>
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 10px;">Login successful!</div>
                    <div style="font-size: 18px; opacity: 0.9;">You can close the browser now</div>
                `;

                overlay.appendChild(message);
                document.body.appendChild(overlay);
            """)
            print("[*] Success message displayed in browser.", file=sys.stderr)
        except Exception as e:
            print(f"[!] Could not display message in browser: {e}", file=sys.stderr)

        print("[*] Browser will remain open. You can close it manually or continue playing.", file=sys.stderr)

        time.sleep(3)

        # Re-extract cookie to ensure we have the latest version
        # (Game might have updated the cookie after initial validation)
        print("[*] Re-extracting cookie to ensure latest version...", file=sys.stderr)
        try:
            final_cookies = driver.get_cookies()
            for c in final_cookies:
                if c['name'] == TARGET_COOKIE_NAME:
                    final_cookie = urllib.parse.unquote(c['value']).strip()
                    if final_cookie != cookie:
                        print(f"[!] Cookie changed during login process!", file=sys.stderr)
                        print(f"[!] Old cookie length: {len(cookie)}", file=sys.stderr)
                        print(f"[!] New cookie length: {len(final_cookie)}", file=sys.stderr)
                        cookie = final_cookie
                    else:
                        print("[+] Cookie unchanged - using validated cookie", file=sys.stderr)
                    break
        except Exception as e:
            print(f"[!] Could not re-extract cookie: {e}", file=sys.stderr)
            print("[!] Using initially validated cookie", file=sys.stderr)

        # Debug: Log final cookie before return
        debug_log.append(f"\n3. Final cookie to be returned:")
        debug_log.append(f"   Value: {cookie[:60]}...{cookie[-20:]}")
        debug_log.append(f"   Length: {len(cookie)}")
        debug_log.append(f"   Contains %: {('%' in cookie)}")


        print("[+] Browser login successful!", file=sys.stderr)
        return cookie

    except Exception as e:
        # Restore stderr before printing error
        sys.stderr = original_stderr
        print(f"[-] CRITICAL ERROR during browser login: {e}", file=sys.stderr)
        if driver:
            try:
                driver.quit()
            except:
                pass
        return None
    finally:
        # Always restore stderr and close devnull
        sys.stderr = original_stderr
        try:
            devnull.close()
        except:
            pass

# =============================================================================
# MAIN
# =============================================================================

def main(save_only=False):
    """Main entry point with session management and smart login flow."""
    # STEP 1: Validate all saved sessions
    print("[1/4] Checking for saved sessions...", file=sys.stderr)
    valid_sessions = validate_all_sessions()

    user_chose_add_new = False  # Track if user clicked "Add New" in expired dialog

    # Get expired sessions for selector
    expired_sessions = get_expired_sessions_with_methods()

    # Main loop - show selector if we have valid sessions OR expired sessions
    # If neither exists, skip to login dialog
    while len(valid_sessions) > 0 or len(expired_sessions) > 0:
        print("", file=sys.stderr)

        selector_result = None

        # Always show selector to display active/expired sessions and provide exit/refresh/add new options
        print("[*] Showing session selector...", file=sys.stderr)

        # Show session selector with both active and expired sessions
        selector_result = show_session_selector(valid_sessions, expired_sessions)

        if not selector_result:
            # User cancelled or pressed Exit
            print("[-] Session selection cancelled", file=sys.stderr)
            if __name__ == "__main__":
                sys.exit(0)
            else:
                return None

        action = selector_result.get('action')

        if action == 'new_session':
            # User wants to add a new session
            print("[*] User chose to add new session", file=sys.stderr)
            user_chose_add_new = True
            break

        if action == 'refresh_sessions':
            # User wants to refresh a session
            print("[*] Select session to refresh...", file=sys.stderr)

            # Show ALL sessions (active + expired) for selection
            all_sessions_for_refresh = valid_sessions + expired_sessions

            if not all_sessions_for_refresh:
                print("[!] No sessions available to refresh", file=sys.stderr)
                continue  # Back to selector

            # Show session selector with all sessions (no action buttons to avoid loop)
            refresh_selector_result = show_session_selector(all_sessions_for_refresh, [], show_action_buttons=False)

            if not refresh_selector_result:
                # User cancelled
                continue  # Back to main selector

            refresh_action = refresh_selector_result.get('action')

            if refresh_action == 'use_session':
                # User selected a session to refresh
                selected_user_id = refresh_selector_result.get('user_id')

                # Find the session
                session_to_refresh = None
                for s in all_sessions_for_refresh:
                    if s['user_id'] == selected_user_id:
                        session_to_refresh = s
                        break

                if session_to_refresh:
                    print("", file=sys.stderr)
                    print(f"Refreshing: {session_to_refresh['company_name']} (Method: {session_to_refresh.get('login_method', 'unknown')})", file=sys.stderr)

                    # Execute login based on saved method
                    renewal_method = session_to_refresh.get('login_method', 'unknown')

                    if renewal_method == 'unknown':
                        # Ask for login method
                        login_choice = show_login_dialog()
                        if not login_choice or login_choice.get('action') == 'cancel':
                            print("[-] Login cancelled - returning to session selector", file=sys.stderr)
                            continue  # Back to selector
                        renewal_method = login_choice.get('method')

                    # Execute login
                    renewal_cookie = None
                    if renewal_method == 'steam':
                        renewal_cookie = steam_login()
                    elif renewal_method == 'browser':
                        renewal_cookie = browser_login()

                    if renewal_cookie:
                        # Validate and save
                        renewal_user_data = get_user_from_cookie(renewal_cookie)
                        if renewal_user_data and str(renewal_user_data.get('id')) == str(selected_user_id):
                            # Debug: Log cookie before save
                            debug_append = []
                            debug_append.append(f"\n4. Before save_session() [REFRESH]:")
                            debug_append.append(f"   Value: {renewal_cookie[:60]}...{renewal_cookie[-20:]}")
                            debug_append.append(f"   Length: {len(renewal_cookie)}")
                            debug_append.append(f"   Contains %: {('%' in renewal_cookie)}")

                            save_session(
                                str(renewal_user_data['id']),
                                renewal_cookie,
                                renewal_user_data.get('company_name', 'Unknown'),
                                renewal_method
                            )

                            # Debug: Test what was saved by reading it back
                            try:
                                sessions = load_sessions()
                                if str(renewal_user_data['id']) in sessions:
                                    encrypted = sessions[str(renewal_user_data['id'])]['cookie']
                                    retrieved_cookie = decrypt_cookie(encrypted, renewal_user_data['id'])
                                    if retrieved_cookie:
                                        debug_append.append(f"\n5. After keyring.get_password() (read back) [REFRESH]:")
                                        debug_append.append(f"   Value: {retrieved_cookie[:60]}...{retrieved_cookie[-20:]}")
                                        debug_append.append(f"   Length: {len(retrieved_cookie)}")
                                        debug_append.append(f"   Contains %: {('%' in retrieved_cookie)}")
                                        debug_append.append(f"   MATCHES INPUT: {retrieved_cookie == renewal_cookie}")

                            except Exception as e:
                                print(f"[DEBUG] Could not test save/retrieve: {e}", file=sys.stderr)

                            print(f"[+] Session refreshed for {renewal_user_data.get('company_name')}", file=sys.stderr)
                        else:
                            print(f"[-] Refresh failed - wrong account", file=sys.stderr)
                    else:
                        print(f"[-] Failed to get cookie", file=sys.stderr)

                    # After refresh, reload sessions and return to selector
                    valid_sessions = validate_all_sessions()
                    expired_sessions = get_expired_sessions_with_methods()
                    continue

            # If action is not 'use_session', go back to main selector
            continue

        if action == 'use_session':
            # User selected an existing session
            selected_user_id = selector_result.get('user_id')
            print(f"[+] Using session for user ID: {selected_user_id}", file=sys.stderr)

            # Find the session data
            cookie = None
            user_data = None
            for session in valid_sessions:
                if str(session['user_id']) == str(selected_user_id):
                    cookie = session['cookie']
                    user_data = session['user_data']
                    break

            # User selected a session - exit with success
            if not cookie or not user_data:
                print(f"[-] ERROR: Session data not found for user {selected_user_id}", file=sys.stderr)
                sys.exit(1)

            print("", file=sys.stderr)
            print(f"Logged in as: {user_data.get('company_name', 'Unknown')}", file=sys.stderr)

            # Always output only user_id (secure mode)
            if __name__ == "__main__":
                # Running as script - print to stdout and exit
                print(selected_user_id)
                sys.exit(0)
            else:
                # Imported as module - return user_id
                return selected_user_id

        elif selector_result.get('action') == 'new_session':
            # User wants to add a new session - continue to login flow
            print("[+] Adding new session...", file=sys.stderr)
            # Break out of loop to continue to normal login flow below
            break
        else:
            print("[-] Invalid selector result", file=sys.stderr)
            sys.exit(1)

    # STEP 2: Determine login method
    method = None
    # Sessions are always saved (no checkbox needed)

    if user_chose_add_new:
        # User clicked "Add New" - show login dialog
        print("", file=sys.stderr)
        print("[2/3] Showing login dialog...", file=sys.stderr)

        dialog_result = show_login_dialog()

        if not dialog_result or dialog_result.get('action') == 'cancel':
            print("[-] Login cancelled", file=sys.stderr)
            # Check if we have any valid sessions to go back to
            valid_sessions = validate_all_sessions()
            if valid_sessions:
                # Return to session selector
                print("[-] Returning to session selector", file=sys.stderr)
                main()
                return
            else:
                # No sessions available - exit
                print("[-] No sessions available - exiting", file=sys.stderr)
                if __name__ == "__main__":
                    sys.exit(0)
                else:
                    return None

        method = dialog_result.get('method')

        print(f"[+] User selected: {method}", file=sys.stderr)
    else:
        # Normal flow - check for expired sessions with known methods
        print("", file=sys.stderr)
        print("[2/3] Checking for expired sessions with known login methods...", file=sys.stderr)
        expired_sessions = get_expired_sessions_with_methods()

        if len(expired_sessions) == 1:
            # Only one expired session - auto-renew with saved method
            expired = expired_sessions[0]
            print(f"[+] Found expired session for {expired['company_name']}", file=sys.stderr)
            print(f"[+] Auto-renewing with saved method: {expired['login_method']}", file=sys.stderr)
            method = expired['login_method']
            # Sessions are always saved
        elif len(expired_sessions) > 1:
            # Multiple expired sessions - user should select which to renew via selector
            print(f"[*] Found {len(expired_sessions)} expired sessions", file=sys.stderr)
            print(f"[*] Please use session selector to choose which to renew", file=sys.stderr)
            # Fall through to dialog
        else:
            # No expired sessions with known methods
            print("[*] No expired sessions with known methods found", file=sys.stderr)

        # If no method selected yet, show dialog
        if not method:
            print("", file=sys.stderr)
            print("[2/3] Showing login dialog...", file=sys.stderr)

            dialog_result = show_login_dialog()

            if not dialog_result or dialog_result.get('action') == 'cancel':
                print("[-] Login cancelled", file=sys.stderr)
                # Check if we have any valid sessions to go back to
                valid_sessions_check = validate_all_sessions()
                if valid_sessions_check:
                    # Return to session selector
                    print("[-] Returning to session selector", file=sys.stderr)
                    main()
                    return
                else:
                    # No sessions available - exit
                    print("[-] No sessions available - exiting", file=sys.stderr)
                    if __name__ == "__main__":
                        sys.exit(0)
                    else:
                        return None

            method = dialog_result.get('method')

            print(f"[+] User selected: {method}", file=sys.stderr)

    # STEP 3: Execute login
    print("", file=sys.stderr)
    print(f"[3/3] Executing {method} login...", file=sys.stderr)

    if method == 'steam':
        cookie = steam_login()
    elif method == 'browser':
        cookie = browser_login()
    else:
        print(f"[-] ERROR: Invalid method '{method}'", file=sys.stderr)
        if __name__ == "__main__":
            sys.exit(1)
        else:
            return None

    if not cookie:
        print("", file=sys.stderr)
        print("[-] Login failed - no cookie obtained", file=sys.stderr)
        if __name__ == "__main__":
            sys.exit(1)
        else:
            return None

    # STEP 5: Get user data from cookie
    print("", file=sys.stderr)
    print("[*] Validating session and retrieving user data...", file=sys.stderr)
    user_data = get_user_from_cookie(cookie)

    if not user_data:
        print("[-] ERROR: Failed to validate session cookie", file=sys.stderr)
        if __name__ == "__main__":
            sys.exit(1)
        else:
            return None

    user_id = user_data.get('id')
    company_name = user_data.get('company_name', 'Unknown')

    print(f"[+] Logged in as: {company_name} (ID: {user_id})", file=sys.stderr)

    # STEP 4: Always save session for future use
    print(f"[*] Saving session for future use...", file=sys.stderr)

    # Debug: Log cookie before save
    debug_append = []
    debug_append.append(f"\n4. Before save_session():")
    debug_append.append(f"   Value: {cookie[:60]}...{cookie[-20:]}")
    debug_append.append(f"   Length: {len(cookie)}")
    debug_append.append(f"   Contains %: {('%' in cookie)}")

    save_session(user_id, cookie, company_name, method)

    # Debug: Test what was saved by reading it back
    try:
        sessions = load_sessions()
        if str(user_id) in sessions:
            encrypted = sessions[str(user_id)]['cookie']
            retrieved_cookie = decrypt_cookie(encrypted, user_id)
            if retrieved_cookie:
                debug_append.append(f"\n5. After keyring.get_password() (read back):")
                debug_append.append(f"   Value: {retrieved_cookie[:60]}...{retrieved_cookie[-20:]}")
                debug_append.append(f"   Length: {len(retrieved_cookie)}")
                debug_append.append(f"   Contains %: {('%' in retrieved_cookie)}")
                debug_append.append(f"   MATCHES INPUT: {retrieved_cookie == cookie}")

    except Exception as e:
        print(f"[DEBUG] Could not test save/retrieve: {e}", file=sys.stderr)

    # STEP 5: Output result and exit
    print("", file=sys.stderr)
    print("  ✓ Login Complete", file=sys.stderr)

    # When called as subprocess: print user_id to stdout
    # When imported as module: return user_id
    if __name__ == "__main__":
        print(user_id)
        sys.exit(0)
    else:
        return user_id

def get_user_session():
    """
    API function for importing this module directly.
    Returns user_id (str) on success, None on failure/cancellation.
    """
    try:
        return main(save_only=True)
    except SystemExit:
        # User cancelled or error occurred
        return None
    except KeyboardInterrupt:
        return None

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Shipping Manager Session Manager - Secure session storage')
    parser.add_argument(
        '--save-only',
        action='store_true',
        help='(Deprecated - now always on) Save session to encrypted storage'
    )

    args = parser.parse_args()

    # Always use secure session management mode
    try:
        main(save_only=True)  # Always save-only mode
    except KeyboardInterrupt:
        # User pressed Ctrl+C - exit gracefully
        sys.exit(0)
