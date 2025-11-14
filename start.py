#!/usr/bin/env python3
"""
System Tray Icon for Shipping Manager CoPilot

Main application launcher that provides:
- System tray icon
- Session cookie extraction and selection
- Exit function
- Settings menu (port, host configuration)
- Save & Restart function

This is the main entry point for the compiled application.
"""

import os
import sys
import json
import subprocess
import threading
import time
import platform
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from pathlib import Path
from PIL import Image, ImageDraw
import pystray
import webbrowser
import socket
import urllib3
import ssl
import atexit
import signal
import zipfile
import shutil
from datetime import datetime

# Disable SSL warnings for self-signed certificate
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Python 3.13 fix: Create SSL context in main thread before any threading
# This prevents "GIL must be held" errors when requests tries to load SSL certs in threads
try:
    _ssl_context = ssl.create_default_context()
    _ssl_context.check_hostname = False
    _ssl_context.verify_mode = ssl.CERT_NONE
except Exception as e:
    print(f"[SM-CoPilot] Warning: Could not pre-initialize SSL context: {e}", file=sys.stderr)
    _ssl_context = None

try:
    import requests
except ImportError:
    print("[SM-CoPilot] ERROR: requests module not found. Installing...", file=sys.stderr)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests"])
    import requests

# Determine if running as compiled .exe or as script
IS_FROZEN = getattr(sys, 'frozen', False)
if IS_FROZEN:
    # Running as compiled .exe (PyInstaller sets sys.frozen)
    PROJECT_ROOT = Path(sys.executable).parent
    # For bundled resources, use PyInstaller's temp folder
    BUNDLE_DIR = Path(sys._MEIPASS)
    print(f"[DEBUG] Running as compiled .exe - sys.frozen = {IS_FROZEN}")
    print(f"[DEBUG] PROJECT_ROOT: {PROJECT_ROOT}")
else:
    # Running as .py script
    PROJECT_ROOT = Path(__file__).parent
    BUNDLE_DIR = PROJECT_ROOT
    print(f"[DEBUG] Running as Python script - sys.frozen = {IS_FROZEN}")
    print(f"[DEBUG] PROJECT_ROOT: {PROJECT_ROOT}")

# Settings location depends on execution mode
if IS_FROZEN:
    # Running as .exe - use LocalAppData
    DATA_ROOT = Path(os.environ['LOCALAPPDATA']) / 'ShippingManagerCoPilot'
    print(f"[DEBUG] Using LOCALAPPDATA: {DATA_ROOT}")
else:
    # Running as .py - use userdata
    DATA_ROOT = PROJECT_ROOT / 'userdata'
    print(f"[DEBUG] Using local data directory: {DATA_ROOT}")

DATA_ROOT.mkdir(parents=True, exist_ok=True)
SETTINGS_DIR = DATA_ROOT / 'settings'
SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = SETTINGS_DIR / 'settings.json'

# Icon path: use BUNDLE_DIR for .exe (temp extraction), PROJECT_ROOT for .py
ICON_PATH = BUNDLE_DIR / 'public' / 'favicon.ico'
PID_FILE = PROJECT_ROOT / 'server.pid'

# Default settings
DEFAULT_SETTINGS = {
    'port': 12345,
    'host': '127.0.0.1'  # localhost-only by default (secure)
}

# Global reference to server process
server_process = None

# Global flag to prevent multiple simultaneous restarts
_server_starting = False

_settings_logged = False

def load_settings():
    """Load settings from JSON file"""
    global _settings_logged
    try:
        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, 'r') as f:
                settings = json.load(f)
                # Merge with defaults to ensure all keys exist
                if not _settings_logged:
                    log_to_server_file('info', f'Startup settings loaded (port={settings.get("port", DEFAULT_SETTINGS["port"])}, host={settings.get("host", DEFAULT_SETTINGS["host"])})')
                    _settings_logged = True
                return {**DEFAULT_SETTINGS, **settings}
    except Exception as e:
        print(f"[SM-CoPilot] Error loading settings: {e}", file=sys.stderr)
        if not _settings_logged:
            log_to_server_file('error', f'Failed to load startup settings: {e}')
            _settings_logged = True

    if not _settings_logged:
        log_to_server_file('info', 'Using default startup settings')
        _settings_logged = True
    return DEFAULT_SETTINGS.copy()

def save_settings(settings):
    """Save settings to JSON file with explicit flush"""
    try:
        # Ensure all required fields are present
        settings_to_save = {
            'port': settings.get('port', DEFAULT_SETTINGS['port']),
            'host': settings.get('host', DEFAULT_SETTINGS['host']),
            'debugMode': settings.get('debugMode', False),
            'logLevel': settings.get('logLevel', 'info')
        }

        with open(SETTINGS_FILE, 'w') as f:
            json.dump(settings_to_save, f, indent=2)
            f.flush()  # Explicitly flush to disk
            os.fsync(f.fileno())  # Force OS to write to disk

        print(f"[SM-CoPilot] Settings saved to {SETTINGS_FILE}", file=sys.stderr)
        print(f"[SM-CoPilot] Saved: port={settings_to_save['port']}, host={settings_to_save['host']}, debugMode={settings_to_save['debugMode']}, logLevel={settings_to_save['logLevel']}", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[SM-CoPilot] Error saving settings: {e}", file=sys.stderr)
        return False

def load_tray_icon():
    """Load favicon.ico as the tray icon"""
    try:
        # Use ICON_PATH which handles both .exe and .py modes
        if ICON_PATH.exists():
            return Image.open(ICON_PATH)
        else:
            print(f"[SM-CoPilot] favicon.ico not found at {ICON_PATH}, using fallback", file=sys.stderr)
            # Fallback: Create a simple icon
            return create_fallback_icon()
    except Exception as e:
        print(f"[SM-CoPilot] Error loading favicon.ico: {e}, using fallback", file=sys.stderr)
        return create_fallback_icon()

def create_fallback_icon():
    """Create a simple fallback icon if favicon.ico is not available"""
    width = 64
    height = 64
    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # Draw a ship-like icon (simple representation)
    # Hull (blue)
    draw.rectangle([10, 35, 54, 54], fill=(41, 128, 185, 255))
    # Sail (white)
    draw.polygon([32, 15, 32, 35, 45, 35], fill=(255, 255, 255, 255))
    # Mast (brown)
    draw.rectangle([30, 15, 34, 45], fill=(139, 69, 19, 255))

    return image

def get_log_paths():
    """
    Get log file paths based on environment (dev vs packaged).
    Matches the logic in server/config.js getLogDir()
    """
    if getattr(sys, 'frozen', False):
        # Running as packaged .exe - use AppData/Local/userdata
        if platform.system() == 'Windows':
            log_dir = Path.home() / 'AppData' / 'Local' / 'ShippingManagerCoPilot' / 'userdata' / 'logs'
        else:
            # macOS/Linux
            log_dir = Path.home() / '.local' / 'share' / 'ShippingManagerCoPilot' / 'userdata' / 'logs'
    else:
        # Running from source - use project userdata
        log_dir = PROJECT_ROOT / 'userdata' / 'logs'

    return {
        'server_log': log_dir / 'server.log',
        'debug_log': log_dir / 'debug.log'
    }

def log_to_server_file(level, message):
    """
    Write to server.log with same format as Node.js Winston logger.
    Format: [YYYY-MM-DDTHH:MM:SS+TZ:TZ] [LEVEL] message
    """
    from datetime import datetime, timezone

    log_paths = get_log_paths()
    server_log = log_paths['server_log']

    # Ensure log directory exists
    server_log.parent.mkdir(parents=True, exist_ok=True)

    # Get local timezone offset
    now = datetime.now()
    local_tz = now.astimezone().strftime('%z')  # Format: +0100
    formatted_tz = f"{local_tz[:3]}:{local_tz[3:]}"  # Format: +01:00

    # Format timestamp to match Node.js Winston format
    timestamp = now.strftime(f'%Y-%m-%dT%H:%M:%S{formatted_tz}')

    # Map level to uppercase for consistency
    level_map = {
        'info': 'INFO',
        'warn': 'WARN',
        'error': 'ERROR',
        'fatal': 'FATAL'
    }
    level_str = level_map.get(level.lower(), level.upper())

    log_line = f"[{timestamp}] [{level_str}] [SM-CoPilot] {message}\n"

    try:
        with open(server_log, 'a', encoding='utf-8') as f:
            f.write(log_line)
    except Exception as e:
        print(f"[SM-CoPilot] Error writing to server.log: {e}", file=sys.stderr)

def open_file_with_default_app(filepath):
    """Open file with OS default application"""
    system = platform.system()

    try:
        if system == 'Windows':
            os.startfile(str(filepath))
        elif system == 'Darwin':  # macOS
            subprocess.call(['open', str(filepath)])
        elif system == 'Linux':
            subprocess.call(['xdg-open', str(filepath)])
        else:
            print(f"[SM-CoPilot] Unsupported operating system: {system}", file=sys.stderr)
    except Exception as e:
        print(f"[SM-CoPilot] Error opening file {filepath}: {e}", file=sys.stderr)

def prepare_session():
    """
    Prepare session using helper script.
    Script saves encrypted cookie to sessions.json and returns user_id.
    No plaintext cookie is exposed via stdout or ENV.
    """
    try:
        print("[SM-CoPilot] Preparing session (may show dialog)...", file=sys.stderr)
        log_to_server_file('info', 'Preparing session (extracting from Steam)')

        # Import and call helper module directly (no subprocess fork bomb!)
        if getattr(sys, 'frozen', False):
            # Running as compiled .exe - helper is in _MEIPASS
            helper_path = Path(sys._MEIPASS) / 'helper'
            if str(helper_path) not in sys.path:
                sys.path.insert(0, str(helper_path))
        else:
            # Running as .py script
            helper_path = PROJECT_ROOT / 'helper'
            if str(helper_path) not in sys.path:
                sys.path.insert(0, str(helper_path))

        # Import renamed module (no hyphens!)
        import get_session_windows
        user_id = get_session_windows.get_user_session()

        if user_id is not None:
            print(f"[SM-CoPilot] Session prepared for user ID: {user_id}", file=sys.stderr)
            log_to_server_file('info', f'Session prepared for user ID: {user_id}')

            # Verify session was actually saved to disk (race condition prevention)
            print(f"[SM-CoPilot] Verifying session file was written...", file=sys.stderr)
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    sessions = get_session_windows.load_sessions()
                    if str(user_id) in sessions:
                        print(f"[SM-CoPilot] Session verified in file for user ID: {user_id}", file=sys.stderr)
                        log_to_server_file('info', f'Session verified for user ID: {user_id}')
                        break
                    else:
                        print(f"[SM-CoPilot] Session not yet in file (attempt {attempt + 1}/{max_retries}), waiting...", file=sys.stderr)
                        time.sleep(1)
                except Exception as e:
                    print(f"[SM-CoPilot] Error verifying session (attempt {attempt + 1}/{max_retries}): {e}", file=sys.stderr)
                    time.sleep(1)
            else:
                # All retries failed
                print(f"[SM-CoPilot] WARNING: Could not verify session in file after {max_retries} attempts", file=sys.stderr)
                log_to_server_file('warn', f'Session verification failed after {max_retries} attempts')

            print("[SM-CoPilot] Cookie stored securely (encrypted)", file=sys.stderr)
            log_to_server_file('info', 'Cookie stored securely (encrypted)')
            return user_id
        else:
            print(f"[SM-CoPilot] User cancelled session selection", file=sys.stderr)
            log_to_server_file('fatal', 'User cancelled session selection')
            return None

    except Exception as e:
        print(f"[SM-CoPilot] Error preparing session: {e}", file=sys.stderr)
        log_to_server_file('error', f'Error preparing session: {e}')
        import traceback
        traceback.print_exc()
        return None

def get_browser_url(settings):
    """Get the URL to open in browser based on settings"""
    host = settings['host']
    port = settings['port']

    # Always use localhost for browser (consistent notification permissions)
    # Maps: 0.0.0.0 -> localhost, 127.0.0.1 -> localhost, other IPs -> keep as-is
    if host == '0.0.0.0' or host == '127.0.0.1':
        url_host = 'localhost'
    else:
        url_host = host

    return f"https://{url_host}:{port}/"

def start_server(settings):
    """Start the Node.js server with specified settings"""
    global server_process, _server_starting

    # Prevent multiple simultaneous starts/restarts
    if _server_starting:
        print("[SM-CoPilot] Server is already starting, ignoring duplicate start request", file=sys.stderr)
        return False

    _server_starting = True
    try:
        # Check if port is already in use
        port = settings['port']
        host = settings['host']

        if is_port_in_use(port, '0.0.0.0' if host == '0.0.0.0' else host):
            error_msg = f"Port {port} on {host} is already in use!\n\nPlease choose a different port or close the application using that port."
            print(f"[SM-CoPilot] ERROR: Port {port} is already in use", file=sys.stderr)
            # Show settings dialog with error
            show_settings_dialog(error_message=error_msg)
            return False

        # Prepare session (encrypt and save to sessions.json)
        user_id = prepare_session()

        if not user_id:
            # User cancelled or no session found - exit gracefully
            print("No session available. Exiting...", file=sys.stderr)
            log_to_server_file('fatal', 'No session available - application exiting')
            return False

        # Always use SETTINGS_FILE (AppData) for both .exe and .py mode
        # This ensures consistency with load_settings()
        settings_path = SETTINGS_FILE

        # Merge passed settings with defaults to ensure all required fields exist
        settings_to_write = {
            'port': port,
            'host': host,
            'debugMode': settings.get('debugMode', False),
            'logLevel': settings.get('logLevel', 'info')
        }

        print(f"[SM-CoPilot] start_server writing settings: {settings_to_write}", file=sys.stderr)
        print(f"[SM-CoPilot] (from passed settings: {settings})", file=sys.stderr)

        # Write back to AppData with explicit flush
        with open(settings_path, 'w') as f:
            json.dump(settings_to_write, f, indent=2)
            f.flush()
            os.fsync(f.fileno())

        print(f"[SM-CoPilot] Settings written to {settings_path}", file=sys.stderr)

        # Set environment variables for Node.js server
        env = os.environ.copy()
        env['SELECTED_USER_ID'] = str(user_id)  # Tell Node.js which session to use
        env['DEBUG_MODE'] = 'true' if settings.get('debugMode', False) else 'false'  # Pass debug mode setting
        # Note: Cookie is NOT passed via ENV - Node.js will read from encrypted sessions.json

        print(f"[SM-CoPilot] Starting server on {host}:{port}", file=sys.stderr)
        log_to_server_file('info', f'Python launcher starting Node.js server on {host}:{port}')

        # Clear the server log and debug log files before starting (so we only see current startup logs)
        if getattr(sys, 'frozen', False):
            # .exe mode - logs in LocalAppData/userdata
            server_log_path = Path(os.environ.get('LOCALAPPDATA', '')) / 'ShippingManagerCoPilot' / 'userdata' / 'logs' / 'server.log'
            debug_log_path = Path(os.environ.get('LOCALAPPDATA', '')) / 'ShippingManagerCoPilot' / 'userdata' / 'logs' / 'debug.log'
        else:
            # .py mode - logs in project userdata directory
            server_log_path = PROJECT_ROOT / 'userdata' / 'logs' / 'server.log'
            debug_log_path = PROJECT_ROOT / 'userdata' / 'logs' / 'debug.log'

        try:
            if server_log_path.exists():
                server_log_path.unlink()
                print(f"[SM-CoPilot] Cleared old server log", file=sys.stderr)
        except Exception as e:
            print(f"[SM-CoPilot] Warning: Could not clear server log: {e}", file=sys.stderr)

        try:
            if debug_log_path.exists():
                debug_log_path.unlink()
                print(f"[SM-CoPilot] Cleared old debug log", file=sys.stderr)
        except Exception as e:
            print(f"[SM-CoPilot] Warning: Could not clear debug log: {e}", file=sys.stderr)

        # Determine which server executable to use
        if getattr(sys, 'frozen', False):
            # Running as compiled .exe - use embedded server executable
            # PyInstaller extracts binaries to sys._MEIPASS temporary folder
            server_exe = Path(sys._MEIPASS) / 'ShippingManagerCoPilot-Server.exe'
            if not server_exe.exists():
                raise FileNotFoundError(f"Embedded server executable not found at {server_exe}")
            server_cmd = [str(server_exe)]
        else:
            # Running as .py script - use node with app.js
            server_cmd = ['node', 'app.js']

        # Start the server process - redirect stderr/stdout to server.log
        # This captures early crashes before Winston is initialized
        server_log_path.parent.mkdir(parents=True, exist_ok=True)
        log_handle = open(server_log_path, 'a', encoding='utf-8')  # append mode (after clear above)
        print(f"[SM-CoPilot] Server output -> {server_log_path}", file=sys.stderr)

        server_process = subprocess.Popen(
            server_cmd,
            cwd=str(PROJECT_ROOT),
            env=env,
            stdout=log_handle,  # All output to server.log
            stderr=log_handle,  # All errors to server.log
            stdin=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
        )

        print(f"[SM-CoPilot] Server started (PID: {server_process.pid})", file=sys.stderr)
        log_to_server_file('info', f'Node.js server process started (PID: {server_process.pid})')

        # Write PID to file for cleanup
        try:
            with open(PID_FILE, 'w') as f:
                f.write(str(server_process.pid))
        except Exception as e:
            print(f"[SM-CoPilot] Warning: Could not write PID file: {e}", file=sys.stderr)

        # Check if new certificates were generated and prompt for installation
        def check_and_prompt_certificate_installation():
            """Check if certificates need to be installed and prompt user"""
            try:
                # Import certificate manager
                if getattr(sys, 'frozen', False):
                    helper_path = Path(sys._MEIPASS) / 'helper'
                    if str(helper_path) not in sys.path:
                        sys.path.insert(0, str(helper_path))
                else:
                    helper_path = PROJECT_ROOT / 'helper'
                    if str(helper_path) not in sys.path:
                        sys.path.insert(0, str(helper_path))

                import certificate_manager

                # Check if certificates exist but are not installed
                if certificate_manager.check_certificate_update_needed():
                    print("[SM-CoPilot] New certificates detected, prompting user for installation...", file=sys.stderr)
                    log_to_server_file('info', 'New certificates detected, prompting user for installation')
                    certificate_manager.prompt_certificate_installation()
                else:
                    print("[SM-CoPilot] Certificates already installed or not needed", file=sys.stderr)

            except Exception as e:
                print(f"[SM-CoPilot] Error checking certificate status: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc()

        # Health check callback for loading dialog
        def health_check_callback(dialog_root):
            """Poll health endpoint until server is ready"""
            print("[SM-CoPilot] Waiting for server to be ready...", file=sys.stderr)
            log_to_server_file('info', 'Waiting for server to be ready...')
            timeout = 30  # 30 seconds timeout
            start_time = time.time()
            # For health check: always use localhost for 0.0.0.0 or 127.0.0.1 (matches browser URL)
            # (can't connect to 0.0.0.0 directly, and localhost ensures consistent permissions)
            health_host = 'localhost' if (host == '0.0.0.0' or host == '127.0.0.1') else host
            health_url = f"https://{health_host}:{port}/health"
            print(f"[SM-CoPilot] Health check URL: {health_url}", file=sys.stderr)

            try:
                while True:
                    # Check timeout
                    if time.time() - start_time > timeout:
                        error_msg = "Timeout waiting for server ready"
                        print(f"[SM-CoPilot] {error_msg}", file=sys.stderr)
                        log_to_server_file('fatal', error_msg)
                        log_to_server_file('fatal', 'Application exiting due to server startup timeout')
                        return False

                    # Check if process crashed
                    if server_process.poll() is not None:
                        # Read actual error from server.log
                        log_content = ""
                        try:
                            log_handle.flush()  # Ensure all output is written
                            if server_log_path.exists():
                                with open(server_log_path, 'r', encoding='utf-8') as f:
                                    # Get last 50 lines to show crash context
                                    lines = f.readlines()
                                    log_content = ''.join(lines[-50:]).strip()
                        except Exception as e:
                            print(f"[SM-CoPilot] Could not read server log: {e}", file=sys.stderr)

                        error_msg = f"Server process terminated unexpectedly (exit code: {server_process.returncode})"
                        print(f"[SM-CoPilot] {error_msg}", file=sys.stderr)
                        log_to_server_file('fatal', error_msg)

                        # Show the actual error from log if available
                        if log_content:
                            print(f"[SM-CoPilot] Server log output (last 50 lines):", file=sys.stderr)
                            print(log_content, file=sys.stderr)
                            log_to_server_file('fatal', f'Server crash log: {log_content}')
                        else:
                            print(f"[SM-CoPilot] No error output in {server_log_path}", file=sys.stderr)

                        log_to_server_file('fatal', 'Application exiting due to server crash')
                        return False

                    # Poll health endpoint
                    try:
                        response = requests.get(health_url, verify=False, timeout=2)
                        if response.status_code == 200:
                            data = response.json()
                            if data.get('ready'):
                                print("[SM-CoPilot] Server is ready for UI Clients", file=sys.stderr)
                                log_to_server_file('info', '[SM-CoPilot] Server is ready for UI Clients')

                                # Check if certificates need to be installed (after server is ready)
                                check_and_prompt_certificate_installation()

                                return True
                        else:
                            print(f"[SM-CoPilot] Health check status: {response.status_code}", file=sys.stderr)
                    except (requests.exceptions.RequestException, requests.exceptions.Timeout) as e:
                        # Server not ready yet, continue polling
                        print(f"[SM-CoPilot] Health check failed: {type(e).__name__}", file=sys.stderr)
                        pass

                    # Wait 500ms before next check
                    time.sleep(0.5)

            except Exception as e:
                error_msg = f"Error waiting for server ready: {e}"
                print(f"[SM-CoPilot] {error_msg}", file=sys.stderr)
                log_to_server_file('fatal', error_msg)
                log_to_server_file('fatal', 'Application exiting due to health check error')
                return False

        # Show loading dialog (will block until closed)
        show_loading_dialog(settings, health_check_callback)

        return True

    except Exception as e:
        print(f"[SM-CoPilot] Error starting server: {e}", file=sys.stderr)
        show_topmost_messagebox(messagebox.showerror, "Server Error", f"Failed to start server:\n{e}")
        return False
    finally:
        # Always clear the starting flag
        _server_starting = False

def kill_server_from_pid_file():
    """Kill server process using psutil (cross-platform, kills child processes)"""
    import psutil
    import time
    global server_process

    pid = None

    # Strategy 1: Try global server_process first (most reliable)
    if server_process is not None:
        try:
            pid = server_process.pid
            print(f"[SM-CoPilot] Using global server_process (PID: {pid})", file=sys.stderr)
        except Exception as e:
            print(f"[SM-CoPilot] Could not get PID from global process: {e}", file=sys.stderr)
            server_process = None

    # Strategy 2: Fallback to PID file
    if pid is None and PID_FILE.exists():
        try:
            with open(PID_FILE, 'r') as f:
                pid = int(f.read().strip())
            print(f"[SM-CoPilot] Using PID from file: {pid}", file=sys.stderr)
        except Exception as e:
            print(f"[SM-CoPilot] Could not read PID file: {e}", file=sys.stderr)

    # If still no PID, nothing to kill
    if pid is None:
        print("[SM-CoPilot] No server process found to kill", file=sys.stderr)
        try:
            PID_FILE.unlink()
        except:
            pass
        return

    # Kill the process and all children using psutil
    try:
        print(f"[SM-CoPilot] Killing server process (PID: {pid})", file=sys.stderr)

        process = psutil.Process(pid)

        # Get all child processes first (Node.js might spawn workers)
        children = process.children(recursive=True)

        # Try graceful shutdown first
        print(f"[SM-CoPilot] Sending terminate signal to process and {len(children)} child(ren)...", file=sys.stderr)
        process.terminate()
        for child in children:
            try:
                child.terminate()
            except psutil.NoSuchProcess:
                pass

        # Wait up to 5 seconds for graceful shutdown
        gone, alive = psutil.wait_procs([process] + children, timeout=5)

        # Force kill any remaining processes
        if alive:
            print(f"[SM-CoPilot] {len(alive)} process(es) still alive, force killing...", file=sys.stderr)
            for p in alive:
                try:
                    p.kill()
                except psutil.NoSuchProcess:
                    pass

            # Wait another 2 seconds
            psutil.wait_procs(alive, timeout=2)

        print("[SM-CoPilot] Server stopped", file=sys.stderr)
        server_process = None

    except psutil.NoSuchProcess:
        print("[SM-CoPilot] Process already terminated", file=sys.stderr)
        server_process = None
    except psutil.TimeoutExpired:
        print("[SM-CoPilot] WARNING: Some processes may still be running", file=sys.stderr)
        server_process = None
    except Exception as e:
        print(f"[SM-CoPilot] Error killing server: {e}", file=sys.stderr)
        server_process = None
    finally:
        # Clean up PID file
        try:
            PID_FILE.unlink()
        except:
            pass

def stop_server():
    """Stop the Node.js server"""
    global server_process

    # First try to kill from PID file
    kill_server_from_pid_file()

    # Also try to kill the process object if we have it
    if server_process:
        try:
            server_process.kill()
        except Exception as e:
            pass
        finally:
            server_process = None

def restart_server(settings):
    """Restart the server with new settings"""
    print("[SM-CoPilot] Restarting server...", file=sys.stderr)
    stop_server()
    return start_server(settings)

# Global reference to settings window
settings_window = None

# Global reference to loading dialog
loading_dialog = None

def show_topmost_messagebox(type_func, title, message, **kwargs):
    """
    Show a messagebox that appears on top of all windows.

    Args:
        type_func: messagebox function (showerror, showinfo, showwarning, askyesno, etc.)
        title: Dialog title
        message: Dialog message
        **kwargs: Additional arguments to pass to messagebox

    Returns:
        Result from messagebox function
    """
    # Create a temporary hidden root window
    temp_root = tk.Tk()
    temp_root.withdraw()  # Hide it
    temp_root.attributes('-topmost', True)  # Make it topmost
    temp_root.lift()
    temp_root.focus_force()

    try:
        # Show messagebox with temp_root as parent
        result = type_func(title, message, parent=temp_root, **kwargs)
        return result
    finally:
        # Clean up
        temp_root.destroy()

def get_available_ips():
    """Get list of available IP addresses on the system"""
    ips = ['0.0.0.0', '127.0.0.1']  # Default options

    try:
        # Get hostname
        hostname = socket.gethostname()

        # Get all local IP addresses
        for info in socket.getaddrinfo(hostname, None):
            ip = info[4][0]
            # Only include IPv4 addresses
            if '.' in ip and ip not in ips:
                ips.append(ip)

    except Exception as e:
        print(f"[SM-CoPilot] Could not get local IPs: {e}", file=sys.stderr)

    return ips

def is_port_in_use(port, host='0.0.0.0', retries=3, delay=2):
    """Check if a port is already in use (with retries for shutdown grace period)"""
    import socket
    import time

    for attempt in range(retries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return False  # Port is free
            except OSError:
                if attempt < retries - 1:
                    print(f"[SM-CoPilot] Port {port} still in use, waiting {delay}s... (attempt {attempt + 1}/{retries})", file=sys.stderr)
                    time.sleep(delay)
                else:
                    return True  # Still in use after all retries

    return True

def set_window_icon(window):
    """Set window icon to favicon.ico"""
    if ICON_PATH.exists():
        try:
            window.iconbitmap(str(ICON_PATH))
        except Exception as e:
            print(f"[SM-CoPilot] Could not set window icon: {e}", file=sys.stderr)

def show_settings_dialog(error_message=None):
    """Show settings dialog window with consistent design"""
    global settings_window, _server_starting

    # Prevent opening settings during server startup
    if _server_starting:
        print("[SM-CoPilot] Cannot open Settings while server is starting", file=sys.stderr)
        return

    # Prevent multiple settings windows
    if settings_window is not None:
        try:
            settings_window.lift()
            settings_window.attributes('-topmost', True)
            settings_window.after(100, lambda: settings_window.attributes('-topmost', False))
            settings_window.focus_force()
            return
        except:
            settings_window = None

    settings = load_settings()

    # Create settings window
    root = tk.Tk()
    settings_window = root

    # Hide while setting up
    root.withdraw()

    # Adjust height if error message present
    window_height = 380 if error_message else 330

    root.title("Shipping Manager CoPilot - Settings")
    root.resizable(False, False)

    # Always on top
    root.attributes('-topmost', True)

    # Set window icon
    set_window_icon(root)

    # Dark theme colors (matching session-selector)
    bg_color = "#111827"
    fg_color = "#e0e0e0"
    accent_color = "#3b82f6"
    card_bg = "#1f2937"
    input_bg = "#374151"
    input_fg = "#e0e0e0"

    root.configure(bg=bg_color)

    # Handle window close
    def on_close():
        global settings_window
        settings_window = None
        root.quit()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)

    # Error message (if present)
    if error_message:
        error_frame = tk.Frame(root, bg="#7f1d1d", relief=tk.SOLID, borderwidth=1)
        error_frame.pack(pady=(15, 5), padx=30, fill=tk.X)

        error_label = tk.Label(
            error_frame,
            text=error_message,
            font=("Segoe UI", 10, "bold"),
            bg="#7f1d1d",
            fg="#fecaca",
            wraplength=440,
            justify=tk.LEFT,
            padx=10,
            pady=8
        )
        error_label.pack()

    # Header
    header_frame = tk.Frame(root, bg=bg_color)
    header_frame.pack(pady=(20, 10), padx=30, fill=tk.X)

    title_label = tk.Label(
        header_frame,
        text="⚙️ Server Settings",
        font=("Segoe UI", 18, "bold"),
        bg=bg_color,
        fg=accent_color
    )
    title_label.pack()

    subtitle_label = tk.Label(
        header_frame,
        text="Configure server host and port",
        font=("Segoe UI", 10),
        bg=bg_color,
        fg="#9ca3af"
    )
    subtitle_label.pack(pady=(5, 0))

    # Settings form (centered, horizontal layout)
    form_frame = tk.Frame(root, bg=bg_color)
    form_frame.pack(pady=20, padx=40)

    # Host setting
    host_label = tk.Label(
        form_frame,
        text="Host:",
        font=("Segoe UI", 11),
        bg=bg_color,
        fg=fg_color
    )
    host_label.grid(row=0, column=0, sticky=tk.W, padx=(0, 10))

    # Get available IPs
    available_ips = get_available_ips()

    # Create combobox with default theme (more reliable clicking)
    host_var = tk.StringVar(value=settings['host'])

    host_combo = ttk.Combobox(
        form_frame,
        textvariable=host_var,
        values=available_ips,
        font=("Segoe UI", 11),
        state="readonly",
        width=15
    )
    host_combo.grid(row=0, column=1, sticky=tk.W, padx=(0, 20), ipady=3)

    # Set current value or default to first option
    if settings['host'] in available_ips:
        host_combo.set(settings['host'])
    else:
        host_combo.set(available_ips[0])

    # Port setting
    port_label = tk.Label(
        form_frame,
        text="Port:",
        font=("Segoe UI", 11),
        bg=bg_color,
        fg=fg_color
    )
    port_label.grid(row=0, column=2, sticky=tk.W, padx=(0, 10))

    port_var = tk.StringVar()
    port_entry = tk.Entry(
        form_frame,
        textvariable=port_var,
        font=("Segoe UI", 11),
        bg=input_bg,
        fg=input_fg,
        insertbackground=fg_color,
        relief=tk.FLAT,
        borderwidth=0,
        width=8
    )
    port_entry.grid(row=0, column=3, sticky=tk.W, ipady=5, ipadx=10)

    # Set port value explicitly
    port_var.set(str(settings['port']))

    # Info label (centered)
    info_frame = tk.Frame(root, bg=bg_color)
    info_frame.pack(pady=10, padx=40, fill=tk.X)

    info_label = tk.Label(
        info_frame,
        text="0.0.0.0 = all interfaces | 127.0.0.1 = localhost only",
        font=("Segoe UI", 9),
        bg=bg_color,
        fg="#6b7280"
    )
    info_label.pack()

    # Button frame (centered)
    button_frame = tk.Frame(root, bg=bg_color)
    button_frame.pack(pady=20)

    def save_and_restart():
        """Save settings and restart server"""
        global settings_window
        try:
            port = int(port_var.get())
            if port < 1 or port > 65535:
                raise ValueError("Port must be between 1 and 65535")

            host = host_var.get().strip()
            if not host:
                raise ValueError("Host cannot be empty")

            # Load current settings first to preserve debugMode and logLevel
            current_settings = load_settings()

            # Merge with new port/host values
            new_settings = {
                'port': port,
                'host': host,
                'debugMode': current_settings.get('debugMode', False),
                'logLevel': current_settings.get('logLevel', 'info')
            }

            if save_settings(new_settings):
                # Close settings window first
                settings_window = None
                root.destroy()

                # Restart server in a NEW thread to avoid Tkinter threading issues
                def do_restart():
                    if restart_server(new_settings):
                        print(f"[SM-CoPilot] Settings saved! Server restarted on {host}:{port}", file=sys.stderr)
                    else:
                        print(f"[SM-CoPilot] Settings saved but server failed to restart", file=sys.stderr)

                thread = threading.Thread(target=do_restart, daemon=True)
                thread.start()
            else:
                messagebox.showerror("Error", "Failed to save settings", parent=root)

        except ValueError as e:
            messagebox.showerror("Invalid Input", str(e), parent=root)

    def cancel():
        """Close settings window"""
        global settings_window
        settings_window = None
        root.destroy()

    # Save & Restart button (blue)
    save_btn = tk.Button(
        button_frame,
        text="Save & Restart",
        command=save_and_restart,
        font=("Segoe UI", 11, "bold"),
        bg=accent_color,
        fg="white",
        activebackground="#2563eb",
        activeforeground="white",
        relief=tk.RAISED,
        borderwidth=2,
        cursor="hand2",
        width=22,
        pady=10
    )
    save_btn.pack(side=tk.LEFT, padx=8)

    # Cancel button (gray)
    cancel_btn = tk.Button(
        button_frame,
        text="Cancel",
        command=cancel,
        font=("Segoe UI", 11),
        bg="#4b5563",
        fg="white",
        activebackground="#6b7280",
        activeforeground="white",
        relief=tk.RAISED,
        borderwidth=2,
        cursor="hand2",
        width=22,
        pady=10
    )
    cancel_btn.pack(side=tk.LEFT, padx=8)

    # Position window in bottom-right corner AFTER all widgets are added
    root.update_idletasks()
    width = 500
    padding = 10
    taskbar_height = 60  # Conservative estimate for taskbar
    x = root.winfo_screenwidth() - width - padding
    y = root.winfo_screenheight() - window_height - taskbar_height - padding

    # Make sure window doesn't go off-screen
    if y < 0:
        y = padding
    if x < 0:
        x = padding

    root.geometry(f'{width}x{window_height}+{x}+{y}')

    # Show window
    root.deiconify()

    # Show window in foreground
    root.attributes('-topmost', True)
    root.focus_force()
    root.after(100, lambda: root.attributes('-topmost', False))

    # Run mainloop (will block until window is closed)
    root.mainloop()

def show_loading_dialog(settings, on_ready_callback):
    """Show loading dialog with animation that transitions to ready state"""
    global loading_dialog

    # Create window
    root = tk.Tk()
    loading_dialog = root  # Store global reference

    # Hide window while we set it up
    root.withdraw()

    root.title("Shipping Manager CoPilot")
    root.resizable(False, False)

    # Always on top
    root.attributes('-topmost', True)

    # Set window icon
    set_window_icon(root)

    # Dark theme colors
    bg_color = "#111827"
    fg_color = "#e0e0e0"
    accent_color = "#3b82f6"

    root.configure(bg=bg_color)

    # Handle window close
    def on_close():
        global loading_dialog
        loading_dialog = None
        try:
            root.quit()  # Stop mainloop first
        except:
            pass
        root.destroy()  # Then destroy window

    root.protocol("WM_DELETE_WINDOW", on_close)

    # Main content frame
    content_frame = tk.Frame(root, bg=bg_color)
    content_frame.pack(fill=tk.BOTH, expand=True, padx=40, pady=40)

    # Canvas for pirate scene animation (wider for two islands)
    canvas = tk.Canvas(
        content_frame,
        width=400,
        height=200,
        bg=bg_color,
        highlightthickness=0
    )
    canvas.pack(pady=(0, 20))

    # Loading text
    status_label = tk.Label(
        content_frame,
        text="Starting server...",
        font=("Segoe UI", 14, "bold"),
        fg=fg_color,
        bg=bg_color
    )
    status_label.pack(pady=(0, 5))

    # Subtitle
    subtitle_label = tk.Label(
        content_frame,
        text="Please wait",
        font=("Segoe UI", 10),
        fg="#9ca3af",
        bg=bg_color
    )
    subtitle_label.pack(pady=(0, 5))

    # URL label (initially hidden)
    url = get_browser_url(settings)
    url_label = tk.Label(
        content_frame,
        text=url,
        font=("Segoe UI", 10),
        fg="#fbbf24",  # Yellowish/amber color
        bg=bg_color
    )

    # Treasure chest canvas (initially hidden) - drawn treasure chest
    def launch_and_close():
        webbrowser.open(url)
        try:
            root.quit()
        except:
            pass
        root.destroy()

    treasure_canvas = tk.Canvas(
        content_frame,
        width=200,
        height=90,
        bg=bg_color,
        highlightthickness=0
    )

    def draw_treasure_chest():
        """Draw a pixel-art treasure chest"""
        cx, cy = 100, 30  # Center position

        # Main chest body (brown wood)
        chest_color = "#8b4513"
        chest_dark = "#654321"

        # Bottom half of chest
        treasure_canvas.create_rectangle(
            cx - 40, cy - 10,
            cx + 40, cy + 30,
            fill=chest_color, outline=chest_dark, width=2
        )

        # Top lid (closed)
        lid_points = [
            cx - 42, cy - 10,
            cx - 38, cy - 25,
            cx + 38, cy - 25,
            cx + 42, cy - 10
        ]
        treasure_canvas.create_polygon(
            lid_points,
            fill=chest_dark, outline="#3e2723", width=2
        )

        # Metal bands (decorative)
        band_color = "#c0c0c0"
        for band_y in [cy - 5, cy + 10, cy + 25]:
            treasure_canvas.create_rectangle(
                cx - 40, band_y - 2,
                cx + 40, band_y + 2,
                fill=band_color, outline="#808080"
            )

        # Lock (gold)
        lock_color = "#ffd700"
        treasure_canvas.create_rectangle(
            cx - 8, cy + 5,
            cx + 8, cy + 20,
            fill=lock_color, outline="#b8860b", width=2
        )
        treasure_canvas.create_oval(
            cx - 6, cy + 8,
            cx + 6, cy + 17,
            fill="#1a1a1a", outline=""
        )

        # "Open Chest" text
        treasure_canvas.create_text(
            cx, cy + 45,
            text="Open Chest",
            font=("Segoe UI", 11, "bold"),
            fill="#ffd700"
        )

    draw_treasure_chest()

    # Make canvas clickable with pirate-themed cursor
    treasure_canvas.bind("<Button-1>", lambda e: launch_and_close())
    treasure_canvas.config(cursor="pirate")  # pirate cursor style

    # Animation state
    animation_frame = [0]
    animation_running = [True]
    animation_state = ['LOADING']  # States: LOADING, SUCCESS, ERROR
    success_animation_frame = [0]  # Tracks progress in success animation
    error_particles = []  # Stores explosion particles
    pirate_position = [None, None]  # Pirate x, y position

    def draw_scene():
        """Draw pirate scene with state-based animations"""
        if not animation_running[0]:
            return

        canvas.delete("all")
        frame = animation_frame[0]
        state = animation_state[0]

        import math

        # Canvas dimensions
        canvas_width = 400
        canvas_height = 200

        # === COMMON BACKGROUND (all states) ===
        # Dark stormy sky
        canvas.create_rectangle(0, 0, canvas_width, 90, fill="#1a1a2e", outline="")

        # Storm clouds
        for cloud_idx, (cx, cy, speed) in enumerate([(70, 25, 0.2), (250, 35, 0.35), (170, 45, 0.15)]):
            cloud_x = cx + (frame * speed) % (canvas_width + 80) - 40
            cloud_color = "#2d2d44"
            for ox, oy, r in [(-15, 3, 10), (-5, -3, 12), (5, 0, 11), (15, 4, 9)]:
                canvas.create_oval(
                    cloud_x + ox - r, cy + oy - r,
                    cloud_x + ox + r, cy + oy + r,
                    fill=cloud_color, outline=""
                )

        # Ocean waves (darker, stormy)
        for wave_layer in range(3):
            wave_y = 120 + wave_layer * 15
            if wave_layer == 0:
                wave_color = "#16213e"
            elif wave_layer == 1:
                wave_color = "#1a2847"
            else:
                wave_color = "#0f1620"

            wave_points = []
            for x in range(0, canvas_width + 20, 8):
                offset = wave_layer * 60
                amplitude = 7 - wave_layer * 2
                y = wave_y + math.sin((x + frame * 4 + offset) * 0.08) * amplitude
                wave_points.extend([x, y])

            wave_points.extend([canvas_width, canvas_height, 0, canvas_height])
            if len(wave_points) >= 6:
                canvas.create_polygon(wave_points, fill=wave_color, outline="", smooth=True)

        # === DRAW ISLAND (LOADING & SUCCESS states) ===
        if state in ['LOADING', 'SUCCESS']:
            # Calculate wind sway (gentle sine wave)
            wind_sway = math.sin(frame * 0.05) * 2  # Sway ±2 degrees
            # RIGHT ISLAND ONLY
            draw_island(canvas, 350, 140, 'right', wind_sway)

        # === STATE-SPECIFIC RENDERING ===
        if state == 'LOADING':
            # Ship sails slowly from left to right towards island
            # Speed: ~0.8 pixels per frame (reaches anchor point in ~18 seconds)
            # Stops at x=250 (anchors before island, not too close!)
            ship_x = 50 + min(frame * 0.8, 200)  # Start at x=50, anchor at x=250
            ship_y = 115 + math.sin(frame * 0.05) * 4  # Gentle bobbing
            draw_pirate_ship(canvas, ship_x, ship_y, frame)

        elif state == 'SUCCESS':
            # Success animation sequence (ship already at island from LOADING)
            success_frame = success_animation_frame[0]

            if success_frame < 20:  # Pirate walks to island (0-20 frames = 1 second)
                ship_x = 250  # Anchored before island
                ship_y = 115
                draw_pirate_ship(canvas, ship_x, ship_y, frame)
                # Pirate walking from ship to island (starts from right side of ship)
                walk_progress = success_frame / 20
                pirate_x = (ship_x + 50) + (45 * walk_progress)  # Start from right 1/5 of ship
                pirate_y = (ship_y + 10) + (10 * walk_progress)  # Higher start, less drop
                draw_pirate(canvas, pirate_x, pirate_y, frame)
                pirate_position[0] = pirate_x
                pirate_position[1] = pirate_y
                success_animation_frame[0] += 1

            else:  # Pirate on beach, waving (20+ frames)
                ship_x = 250
                ship_y = 115
                draw_pirate_ship(canvas, ship_x, ship_y, frame)
                # Pirate waving on beach (higher position)
                pirate_x = pirate_position[0] or (ship_x + 95)
                pirate_y = pirate_position[1] or (ship_y + 20)
                draw_pirate(canvas, pirate_x, pirate_y, frame, waving=True)

        elif state == 'ERROR':
            # Explosion animation
            if len(error_particles) == 0:
                # Initialize explosion particles
                ship_x = 200
                ship_y = 115
                import random
                for _ in range(30):
                    particle = {
                        'x': ship_x,
                        'y': ship_y,
                        'vx': random.uniform(-5, 5),
                        'vy': random.uniform(-8, -2),
                        'life': random.randint(40, 80),
                        'size': random.randint(3, 8),
                        'type': random.choice(['wood', 'sail', 'fire'])
                    }
                    error_particles.append(particle)

            # Update and draw particles
            alive_particles = []
            for particle in error_particles:
                particle['x'] += particle['vx']
                particle['y'] += particle['vy']
                particle['vy'] += 0.3  # Gravity
                particle['life'] -= 1

                if particle['life'] > 0:
                    # Draw particle
                    alpha = int(255 * (particle['life'] / 80))
                    if particle['type'] == 'wood':
                        color = f"#{min(139, 139):02x}{min(69, 69):02x}{min(19, 19):02x}"
                    elif particle['type'] == 'sail':
                        color = f"#{min(245, 245):02x}{min(245, 245):02x}{min(220, 220):02x}"
                    else:  # fire
                        color = f"#{min(255, 255):02x}{min(100, 100):02x}{min(0, 0):02x}"

                    canvas.create_oval(
                        particle['x'] - particle['size'], particle['y'] - particle['size'],
                        particle['x'] + particle['size'], particle['y'] + particle['size'],
                        fill=color, outline=""
                    )
                    alive_particles.append(particle)

            error_particles.clear()
            error_particles.extend(alive_particles)

            # Stop animation after all particles are gone
            if len(alive_particles) == 0:
                animation_running[0] = False
                root.after(2000, lambda: os._exit(1))  # Exit after 2 seconds

        # Update frame counter
        animation_frame[0] = (animation_frame[0] + 1) % 360

        # Schedule next frame
        if animation_running[0]:
            root.after(50, draw_scene)

    def draw_island(canvas, x, y, side, wind_sway=0):
        """Draw detailed pixel-art island with sand, rocks, and palms"""
        import math
        # Sandy beach (main body)
        beach_color = "#c2b280"
        beach_dark = "#a89968"

        # Main island shape (oval)
        island_width = 60
        island_height = 35
        canvas.create_oval(
            x - island_width, y - island_height,
            x + island_width, y,
            fill=beach_color, outline=beach_dark, width=2
        )

        # Rocks (gray stones scattered)
        rock_color = "#7a7a7a"
        if side == 'left':
            rocks = [(x-30, y-15, 8), (x-10, y-20, 6), (x+15, y-18, 7)]
        else:
            rocks = [(x-20, y-18, 7), (x+10, y-20, 6), (x+35, y-15, 8)]

        for rx, ry, size in rocks:
            canvas.create_oval(
                rx - size, ry - size,
                rx + size, ry + size,
                fill=rock_color, outline="#5a5a5a"
            )

        # Palm tree - positioned on island (not in water)
        if side == 'left':
            palms = [(x-15, y-80), (x+20, y-82)]
        else:
            palms = [(x+5, y-82)]  # Single palm on right island

        for px, py in palms:
            # Trunk (brown with texture) - medium height
            trunk_color = "#8b4513"
            trunk_dark = "#654321"

            # Main trunk (50px tall)
            canvas.create_rectangle(
                px - 5, py,
                px + 5, py + 50,
                fill=trunk_color, outline=trunk_dark, width=1
            )

            # Trunk segments (horizontal lines for texture)
            for segment_y in range(int(py + 5), int(py + 50), 6):
                canvas.create_line(
                    px - 5, segment_y,
                    px + 5, segment_y,
                    fill=trunk_dark, width=1
                )

            # Palm fronds (realistic feather-like design)
            leaf_color = "#2d8b2d"
            leaf_dark = "#1a5c1a"

            # Realistic drooping fronds - mainly left and right (not windmill!)
            # All fronds start from top center of trunk
            palm_top_x = px
            palm_top_y = py  # Top of trunk (all fronds start here!)

            # Angles mostly horizontal with variation
            for start_angle in [-30, -10, 10, 30, 150, 170, 190, 210]:
                # Main stem of frond (thin line)
                stem_points = []

                # FIRST: Add the common starting point at trunk top (all fronds start here!)
                stem_points.append((palm_top_x, palm_top_y))

                # Create curved drooping stem (10 segments for smooth curve)
                for i in range(1, 12):  # Start from 1 (not 0, since 0 is already added)
                    t = i / 11.0
                    distance = i * 5  # Extend outward from center

                    # Start angle but curve DOWNWARD progressively (toward 90°)
                    # Left side (negative angles): curve toward 90° (down)
                    # Right side (180°+): curve toward 90° (down)
                    if start_angle < 90:
                        angle_offset = t * 40  # Droop toward 90° (downward)
                    else:
                        angle_offset = -t * 40  # Droop toward 90° (downward) from other side

                    # Add wind sway effect (gentle swaying motion)
                    # More sway at the tip (increases with distance)
                    wind_offset = wind_sway * t * 3  # Tip sways 3x more than base

                    current_angle = start_angle + angle_offset + wind_offset
                    rad = math.radians(current_angle)

                    stem_x = palm_top_x + math.cos(rad) * distance
                    stem_y = palm_top_y + math.sin(rad) * distance
                    stem_points.append((stem_x, stem_y))

                    # Draw many thin leaflets along the stem (feather effect)
                    if i > 1 and i < 11:  # Skip first and last segment
                        leaflet_length = 6 - i * 0.3  # Shorter toward tip
                        leaflet_angle_left = rad + math.radians(70)
                        leaflet_angle_right = rad - math.radians(70)

                        # Left leaflet (thin line)
                        lx1 = stem_x + math.cos(leaflet_angle_left) * leaflet_length
                        ly1 = stem_y + math.sin(leaflet_angle_left) * leaflet_length
                        canvas.create_line(
                            stem_x, stem_y, lx1, ly1,
                            fill=leaf_color, width=1
                        )

                        # Right leaflet (thin line)
                        rx1 = stem_x + math.cos(leaflet_angle_right) * leaflet_length
                        ry1 = stem_y + math.sin(leaflet_angle_right) * leaflet_length
                        canvas.create_line(
                            stem_x, stem_y, rx1, ry1,
                            fill=leaf_color, width=1
                        )

                # Draw main stem (slightly thicker dark line)
                for i in range(len(stem_points) - 1):
                    canvas.create_line(
                        stem_points[i][0], stem_points[i][1],
                        stem_points[i+1][0], stem_points[i+1][1],
                        fill=leaf_dark, width=2
                    )

            # Center coconuts (brown clusters)
            coconut_color = "#654321"
            for offset in [(-4, -3), (0, -5), (4, -3)]:
                canvas.create_oval(
                    px + offset[0] - 4, py + offset[1] - 4,
                    px + offset[0] + 4, py + offset[1] + 4,
                    fill=coconut_color, outline="#3e2723"
                )

    def draw_pirate_ship(canvas, x, y, frame):
        """Draw detailed pirate ship (same as before but positioned)"""
        import math
        scale = 1.5
        ship_offset_x = x - 20
        ship_offset_y = y - 15

        # Hull shadow
        canvas.create_polygon(
            ship_offset_x - 40 * scale, ship_offset_y + 15,
            ship_offset_x + 45 * scale, ship_offset_y + 15,
            ship_offset_x + 42 * scale, ship_offset_y + 28,
            ship_offset_x - 37 * scale, ship_offset_y + 28,
            fill="#0a0a15", outline=""
        )

        # Main hull
        hull_color = "#3e2723"
        hull_outline = "#1b0d08"
        canvas.create_polygon(
            ship_offset_x - 38 * scale, ship_offset_y,
            ship_offset_x + 43 * scale, ship_offset_y,
            ship_offset_x + 40 * scale, ship_offset_y + 26,
            ship_offset_x - 35 * scale, ship_offset_y + 26,
            fill=hull_color, outline=hull_outline, width=2
        )

        # Deck line
        canvas.create_line(
            ship_offset_x - 37 * scale, ship_offset_y + 2,
            ship_offset_x + 42 * scale, ship_offset_y + 2,
            fill="#4e342e", width=2
        )

        # Cannons
        for cannon_x in [ship_offset_x - 20 * scale, ship_offset_x + 5 * scale, ship_offset_x + 25 * scale]:
            canvas.create_rectangle(
                cannon_x - 3, ship_offset_y + 10,
                cannon_x + 3, ship_offset_y + 15,
                fill="#1b0d08", outline="#000000"
            )
            canvas.create_rectangle(
                cannon_x - 1, ship_offset_y + 12,
                cannon_x + 5, ship_offset_y + 13,
                fill="#424242", outline="#212121"
            )

        # Three masts with sails
        mast_color = "#5d4037"
        for mast_idx, mast_x_offset in enumerate([-15 * scale, 5 * scale, 25 * scale]):
            mast_x = ship_offset_x + mast_x_offset
            mast_height = 65 if mast_idx == 1 else 55

            # Mast pole
            canvas.create_rectangle(
                mast_x - 2, ship_offset_y - mast_height,
                mast_x + 2, ship_offset_y,
                fill=mast_color, outline="#3e2723", width=1
            )

            # Cross beam
            beam_width = 22 if mast_idx == 1 else 18
            beam_y = ship_offset_y - mast_height * 0.7
            canvas.create_rectangle(
                mast_x - beam_width, beam_y - 2,
                mast_x + beam_width, beam_y + 2,
                fill=mast_color, outline="#3e2723"
            )

            # Sails
            sail_sway = math.sin(frame * 0.04 + mast_idx) * 3
            sail_points = [
                mast_x - beam_width + sail_sway, beam_y,
                mast_x - beam_width + 2, beam_y + 24,
                mast_x + beam_width - 2, beam_y + 24,
                mast_x + beam_width + sail_sway, beam_y
            ]
            canvas.create_polygon(
                sail_points,
                fill="#f5f5dc", outline="#d4d4b8", width=1, smooth=True
            )

        # Jolly Roger flag
        flag_x = ship_offset_x + 25 * scale
        flag_y = ship_offset_y - 65
        flag_wave = math.sin(frame * 0.08) * 4

        flag_points = [
            flag_x, flag_y,
            flag_x + 2, flag_y + 3,
            flag_x + 14 + flag_wave, flag_y + 5,
            flag_x + 14 + flag_wave * 0.7, flag_y + 13,
            flag_x + 2, flag_y + 11,
            flag_x, flag_y + 14
        ]
        canvas.create_polygon(
            flag_points,
            fill="#000000", outline="#1a1a1a", smooth=True
        )

        # Skull on flag
        skull_x = flag_x + 7
        skull_y = flag_y + 7
        canvas.create_oval(
            skull_x - 3, skull_y - 3,
            skull_x + 3, skull_y + 3,
            fill="#e0e0e0", outline=""
        )
        canvas.create_oval(skull_x - 2, skull_y - 1, skull_x - 1, skull_y, fill="#000000", outline="")
        canvas.create_oval(skull_x + 1, skull_y - 1, skull_x + 2, skull_y, fill="#000000", outline="")
        canvas.create_line(skull_x - 3, skull_y + 4, skull_x + 3, skull_y + 6, fill="#e0e0e0", width=2)
        canvas.create_line(skull_x + 3, skull_y + 4, skull_x - 3, skull_y + 6, fill="#e0e0e0", width=2)

    def draw_pirate(canvas, x, y, frame, waving=False):
        """Draw small pirate figure with hat and eyepatch"""
        import math

        # Body (brown coat)
        canvas.create_rectangle(
            x - 5, y - 12,
            x + 5, y,
            fill="#654321", outline="#3e2723"
        )

        # Head (peach skin)
        canvas.create_oval(
            x - 4, y - 20,
            x + 4, y - 12,
            fill="#f0d5a8", outline=""
        )

        # Pirate hat (black tricorn)
        hat_points = [
            x - 6, y - 20,
            x, y - 26,
            x + 6, y - 20
        ]
        canvas.create_polygon(hat_points, fill="#000000", outline="")

        # Eyepatch (black)
        canvas.create_oval(
            x - 2, y - 17,
            x + 1, y - 15,
            fill="#000000", outline=""
        )

        # Legs (brown)
        canvas.create_rectangle(x - 4, y, x - 1, y + 8, fill="#654321", outline="")
        canvas.create_rectangle(x + 1, y, x + 4, y + 8, fill="#654321", outline="")

        # Arms
        if waving:
            # Waving arm (moves up and down)
            wave_offset = math.sin(frame * 0.1) * 3
            canvas.create_line(
                x + 5, y - 10,
                x + 10, y - 15 + wave_offset,
                fill="#f0d5a8", width=2
            )
        else:
            canvas.create_line(
                x - 5, y - 10,
                x - 8, y - 5,
                fill="#f0d5a8", width=2
            )
        canvas.create_line(
            x + 5, y - 10,
            x + 8, y - 5,
            fill="#f0d5a8", width=2
        )

    def update_to_ready():
        """Update dialog to show ready state - keep animation, hide text, show chest"""
        # Trigger SUCCESS state (pirate animation)
        animation_state[0] = 'SUCCESS'
        success_animation_frame[0] = 0

        # Hide status labels (keep animation visible!)
        status_label.pack_forget()
        subtitle_label.pack_forget()

        # After success animation completes, show chest
        def show_chest():
            # Stop animation after success sequence
            animation_running[0] = False
            # Show treasure chest
            treasure_canvas.pack(pady=(10, 10))
            # URL label will be shown only if multiple URLs exist

        # Wait for success animation to finish (1 second: pirate walks to island)
        root.after(1000, show_chest)

    # Store update function for callback
    root.update_to_ready = update_to_ready

    # Center window on screen
    root.update_idletasks()
    width = root.winfo_reqwidth()
    height = root.winfo_reqheight()
    x = (root.winfo_screenwidth() // 2) - (width // 2)
    y = (root.winfo_screenheight() // 2) - (height // 2)
    root.geometry(f'+{x}+{y}')

    # Show the window
    root.deiconify()

    # Bring to front
    root.attributes('-topmost', True)
    root.focus_force()
    root.after(100, lambda: root.attributes('-topmost', False))

    # Start animation
    draw_scene()

    # Flag to signal when ready or error
    ready_flag = [False]
    error_flag = [False]

    # Pirate phrases mapped to log patterns (in startup order)
    pirate_phrases = {
        'Using native OS credential storage': 'Rationing rum...',
        'Checking for plaintext sessions to encrypt': 'Hiding treasure...',
        'Backend autopilot system initialized': 'Hoisting flag...',
        'Messenger polling synchronized': 'Studying charts...',
        'INITIAL DATA LOADED - UI READY': 'Land ahoy...'
    }

    current_phrase = ['Weighing anchor...']
    last_phrase = [None]  # Track last phrase to avoid duplicates

    # Thread to monitor log file and update status
    def log_monitor_thread():
        # Use the SAME log path logic as Node.js
        if getattr(sys, 'frozen', False):
            # .exe mode - logs in LocalAppData/userdata
            log_file = Path(os.environ.get('LOCALAPPDATA', '')) / 'ShippingManagerCoPilot' / 'userdata' / 'logs' / 'server.log'
        else:
            # .py mode - logs in project userdata directory
            log_file = PROJECT_ROOT / 'userdata' / 'logs' / 'server.log'

        # Wait for log file to be created and have content
        for i in range(50):  # Wait up to 5 seconds
            if log_file.exists() and log_file.stat().st_size > 0:
                break
            time.sleep(0.1)

        if not log_file.exists():
            return

        try:
            with open(log_file, 'r', encoding='utf-8') as f:
                # Start at beginning, but track what we've already shown
                f.seek(0)

                while not ready_flag[0] and not error_flag[0]:
                    line = f.readline()
                    if line:
                        # Check for matching patterns
                        for pattern, phrase in pirate_phrases.items():
                            if pattern in line and phrase != last_phrase[0]:
                                current_phrase[0] = phrase
                                last_phrase[0] = phrase
                                break
                    else:
                        time.sleep(0.1)
        except Exception as e:
            print(f"[SM-CoPilot] Log monitor error: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc()

    threading.Thread(target=log_monitor_thread, daemon=True).start()

    # Start health check in background thread
    def health_check_thread():
        result = on_ready_callback(root)
        if result:
            # Callback returns True when ready
            # Add 500ms delay to ensure backend logs appear first
            time.sleep(0.5)
            ready_flag[0] = True
        else:
            # Callback returned False - server crashed or timeout
            error_flag[0] = True

    threading.Thread(target=health_check_thread, daemon=True).start()

    # Poll ready/error flags from main thread and update status text
    def check_status():
        if error_flag[0]:
            # Trigger ERROR state (explosion)
            animation_state[0] = 'ERROR'
        elif ready_flag[0]:
            update_to_ready()
        else:
            # Update status label with current pirate phrase
            try:
                status_label.config(text=current_phrase[0])
                root.after(100, check_status)
            except:
                pass  # Window closed

    root.after(100, check_status)

    # Run mainloop
    root.mainloop()

def show_ready_dialog(settings):
    """Show 'Application Ready' dialog with launch button"""
    # Create ready window
    root = tk.Tk()

    # Hide window while we set it up
    root.withdraw()

    root.title("Shipping Manager CoPilot")
    root.resizable(False, False)

    # Always on top
    root.attributes('-topmost', True)

    # Set window icon
    set_window_icon(root)

    # Dark theme colors (matching settings dialog)
    bg_color = "#111827"
    fg_color = "#e0e0e0"
    accent_color = "#3b82f6"

    root.configure(bg=bg_color)

    # Handle window close
    def on_close():
        root.quit()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)

    # Main content frame
    content_frame = tk.Frame(root, bg=bg_color)
    content_frame.pack(fill=tk.BOTH, expand=True, padx=30, pady=30)

    # Success icon (checkmark)
    icon_label = tk.Label(
        content_frame,
        text="✓",
        font=("Segoe UI", 48, "bold"),
        fg="#10b981",
        bg=bg_color
    )
    icon_label.pack(pady=(0, 15))

    # Title
    title_label = tk.Label(
        content_frame,
        text="Application Ready",
        font=("Segoe UI", 16, "bold"),
        fg=fg_color,
        bg=bg_color
    )
    title_label.pack(pady=(0, 8))

    # URL display
    url = get_browser_url(settings)
    url_label = tk.Label(
        content_frame,
        text=url,
        font=("Segoe UI", 10),
        fg="#9ca3af",
        bg=bg_color
    )
    url_label.pack(pady=(0, 3))

    # Launch button
    def launch_and_close():
        webbrowser.open(url)
        try:
            root.quit()
        except:
            pass
        root.destroy()

    launch_btn = tk.Button(
        content_frame,
        text="Launch in Browser",
        command=launch_and_close,
        font=("Segoe UI", 11, "bold"),
        bg=accent_color,
        fg="white",
        activebackground="#2563eb",
        activeforeground="white",
        relief=tk.RAISED,
        borderwidth=2,
        cursor="hand2",
        width=20,
        pady=12
    )
    launch_btn.pack()

    # Center window on screen AFTER all widgets are packed
    root.update_idletasks()
    width = root.winfo_reqwidth()
    height = root.winfo_reqheight()
    x = (root.winfo_screenwidth() // 2) - (width // 2)
    y = (root.winfo_screenheight() // 2) - (height // 2)
    root.geometry(f'+{x}+{y}')

    # Show the window now that it's centered
    root.deiconify()

    # Bring to front
    root.attributes('-topmost', True)
    root.focus_force()
    root.after(100, lambda: root.attributes('-topmost', False))

    # Run mainloop (will block until window is closed)
    root.mainloop()

def get_userdata_path():
    """Get the userdata path depending on execution mode (py or exe)"""
    if IS_FROZEN:
        return Path(os.environ['LOCALAPPDATA']) / 'ShippingManagerCoPilot' / 'userdata'
    else:
        return PROJECT_ROOT / 'userdata'

def show_backup_dialog():
    """Show backup dialog with custom design"""
    # Dark theme colors (matching settings dialog)
    bg_color = "#111827"
    fg_color = "#e0e0e0"
    accent_color = "#3b82f6"
    success_color = "#10b981"

    root = tk.Tk()
    root.withdraw()

    root.title("Shipping Manager CoPilot - Backup")
    root.resizable(False, False)
    root.attributes('-topmost', True)
    set_window_icon(root)
    root.configure(bg=bg_color)

    # Header
    header_frame = tk.Frame(root, bg=bg_color)
    header_frame.pack(pady=(20, 10), padx=30, fill=tk.X)

    title_label = tk.Label(
        header_frame,
        text="💾 Create Backup",
        font=("Segoe UI", 18, "bold"),
        bg=bg_color,
        fg=accent_color
    )
    title_label.pack()

    subtitle_label = tk.Label(
        header_frame,
        text="Backup all userdata to a ZIP file",
        font=("Segoe UI", 10),
        bg=bg_color,
        fg="#9ca3af"
    )
    subtitle_label.pack(pady=(5, 0))

    # Info frame
    info_frame = tk.Frame(root, bg=bg_color)
    info_frame.pack(pady=20, padx=40, fill=tk.X)

    userdata_path = get_userdata_path()

    info_label = tk.Label(
        info_frame,
        text=f"Backup location:\n{userdata_path}",
        font=("Segoe UI", 10),
        bg=bg_color,
        fg=fg_color,
        justify=tk.LEFT
    )
    info_label.pack()

    # Status label
    status_label = tk.Label(
        info_frame,
        text="",
        font=("Segoe UI", 10, "bold"),
        bg=bg_color,
        fg=success_color,
        justify=tk.LEFT,
        wraplength=400
    )
    status_label.pack(pady=(10, 0))

    # Button frame
    button_frame = tk.Frame(root, bg=bg_color)
    button_frame.pack(pady=20)

    def do_backup():
        """Execute backup"""
        try:
            if not userdata_path.exists():
                status_label.config(text=f"Error: Userdata directory not found", fg="#ef4444")
                return

            # Create backup filename with timestamp
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            backup_filename = f"SMCoPilot_Backup_{timestamp}.zip"

            # Ask user where to save
            initial_dir = Path.home() / 'Documents'
            save_path = filedialog.asksaveasfilename(
                title="Save Backup",
                initialdir=initial_dir,
                initialfile=backup_filename,
                defaultextension=".zip",
                filetypes=[("ZIP files", "*.zip"), ("All files", "*.*")],
                parent=root
            )

            if not save_path:
                print("[Backup] User cancelled backup", file=sys.stderr)
                return

            save_path = Path(save_path)

            # Update status
            status_label.config(text="Creating backup...", fg=accent_color)
            root.update()

            # Create ZIP file
            print(f"[Backup] Creating backup from {userdata_path}...", file=sys.stderr)
            with zipfile.ZipFile(save_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                # Add metadata file
                metadata = {
                    'version': '1.0',
                    'created': datetime.now().isoformat(),
                    'source': 'ShippingManagerCoPilot',
                    'execution_mode': 'exe' if IS_FROZEN else 'script'
                }
                zipf.writestr('backup_metadata.json', json.dumps(metadata, indent=2))

                # Add all files from userdata
                for root_dir, dirs, files in os.walk(userdata_path):
                    for file in files:
                        file_path = Path(root_dir) / file
                        arcname = file_path.relative_to(userdata_path.parent)
                        zipf.write(file_path, arcname)
                        print(f"[Backup] Added: {arcname}", file=sys.stderr)

            print(f"[Backup] Backup created successfully: {save_path}", file=sys.stderr)
            status_label.config(text=f"✓ Backup created:\n{save_path.name}", fg=success_color)

        except Exception as e:
            print(f"[Backup] Error creating backup: {e}", file=sys.stderr)
            status_label.config(text=f"Error: {str(e)}", fg="#ef4444")

    def close_dialog():
        root.destroy()

    # Create Backup button
    backup_btn = tk.Button(
        button_frame,
        text="Create Backup",
        command=do_backup,
        font=("Segoe UI", 11, "bold"),
        bg=accent_color,
        fg="white",
        activebackground="#2563eb",
        activeforeground="white",
        relief=tk.RAISED,
        borderwidth=2,
        cursor="hand2",
        width=18,
        pady=10
    )
    backup_btn.pack(side=tk.LEFT, padx=8)

    # Close button
    close_btn = tk.Button(
        button_frame,
        text="Close",
        command=close_dialog,
        font=("Segoe UI", 11),
        bg="#4b5563",
        fg="white",
        activebackground="#6b7280",
        activeforeground="white",
        relief=tk.RAISED,
        borderwidth=2,
        cursor="hand2",
        width=18,
        pady=10
    )
    close_btn.pack(side=tk.LEFT, padx=8)

    # Position window centered in screen
    root.update_idletasks()
    width = 500
    height = 280
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    x = (screen_width - width) // 2
    y = (screen_height - height) // 2

    root.geometry(f"{width}x{height}+{x}+{y}")
    root.deiconify()

    # Keep on top permanently
    root.attributes('-topmost', True)
    root.lift()
    root.focus_force()

    root.mainloop()

def create_backup():
    """Show backup dialog"""
    show_backup_dialog()

def validate_backup(zip_path):
    """Validate backup ZIP structure and return metadata"""
    try:
        with zipfile.ZipFile(zip_path, 'r') as zipf:
            # Check for metadata file
            if 'backup_metadata.json' not in zipf.namelist():
                return False, "Invalid backup: missing metadata file"

            # Read metadata
            metadata_str = zipf.read('backup_metadata.json').decode('utf-8')
            metadata = json.loads(metadata_str)

            # Validate metadata structure
            required_fields = ['version', 'created', 'source']
            missing_fields = [f for f in required_fields if f not in metadata]

            if missing_fields:
                return False, f"Invalid backup: missing metadata fields: {', '.join(missing_fields)}"

            if metadata.get('source') != 'ShippingManagerCoPilot':
                return False, "Invalid backup: not a ShippingManagerCoPilot backup"

            # Check for userdata directory
            has_userdata = any('userdata/' in name for name in zipf.namelist())
            if not has_userdata:
                return False, "Invalid backup: no userdata folder found"

            return True, metadata

    except zipfile.BadZipFile:
        return False, "Invalid backup: not a valid ZIP file"
    except json.JSONDecodeError:
        return False, "Invalid backup: corrupted metadata"
    except Exception as e:
        return False, f"Invalid backup: {str(e)}"

def show_restore_dialog():
    """Show restore dialog with custom design"""
    # Dark theme colors
    bg_color = "#111827"
    fg_color = "#e0e0e0"
    accent_color = "#3b82f6"
    success_color = "#10b981"
    warning_color = "#f59e0b"
    error_color = "#ef4444"

    root = tk.Tk()
    root.withdraw()

    root.title("Shipping Manager CoPilot - Restore")
    root.resizable(False, False)
    root.attributes('-topmost', True)
    set_window_icon(root)
    root.configure(bg=bg_color)

    # Header
    header_frame = tk.Frame(root, bg=bg_color)
    header_frame.pack(pady=(20, 10), padx=30, fill=tk.X)

    title_label = tk.Label(
        header_frame,
        text="📦 Restore Backup",
        font=("Segoe UI", 18, "bold"),
        bg=bg_color,
        fg=accent_color
    )
    title_label.pack()

    subtitle_label = tk.Label(
        header_frame,
        text="Restore userdata from a backup ZIP file",
        font=("Segoe UI", 10),
        bg=bg_color,
        fg="#9ca3af"
    )
    subtitle_label.pack(pady=(5, 0))

    # Info frame
    info_frame = tk.Frame(root, bg=bg_color)
    info_frame.pack(pady=20, padx=40, fill=tk.X)

    # Backup file label
    backup_file_label = tk.Label(
        info_frame,
        text="No backup file selected",
        font=("Segoe UI", 10),
        bg=bg_color,
        fg="#6b7280",
        justify=tk.LEFT,
        wraplength=400
    )
    backup_file_label.pack()

    # Backup info label
    backup_info_label = tk.Label(
        info_frame,
        text="",
        font=("Segoe UI", 9),
        bg=bg_color,
        fg="#9ca3af",
        justify=tk.LEFT,
        wraplength=400
    )
    backup_info_label.pack(pady=(5, 0))

    # Status label
    status_label = tk.Label(
        info_frame,
        text="",
        font=("Segoe UI", 10, "bold"),
        bg=bg_color,
        fg=success_color,
        justify=tk.LEFT,
        wraplength=400
    )
    status_label.pack(pady=(10, 0))

    # Store selected backup path
    selected_backup = {'path': None, 'metadata': None}

    def select_backup_file():
        """Select backup file and validate it"""
        initial_dir = Path.home() / 'Documents'
        backup_path = filedialog.askopenfilename(
            title="Select Backup File",
            initialdir=initial_dir,
            filetypes=[("ZIP files", "*.zip"), ("All files", "*.*")],
            parent=root
        )

        if not backup_path:
            return

        backup_path = Path(backup_path)

        # Validate backup
        print(f"[Restore] Validating backup: {backup_path}", file=sys.stderr)
        status_label.config(text="Validating backup...", fg=accent_color)
        root.update()

        is_valid, result = validate_backup(backup_path)

        if not is_valid:
            status_label.config(text=f"Invalid backup: {result}", fg=error_color)
            backup_file_label.config(text="No valid backup selected", fg="#6b7280")
            backup_info_label.config(text="")
            selected_backup['path'] = None
            selected_backup['metadata'] = None
            restore_btn.config(state=tk.DISABLED)
            return

        # Valid backup
        metadata = result
        backup_date = datetime.fromisoformat(metadata['created']).strftime('%Y-%m-%d %H:%M:%S')

        selected_backup['path'] = backup_path
        selected_backup['metadata'] = metadata

        backup_file_label.config(text=f"Selected: {backup_path.name}", fg=success_color)
        backup_info_label.config(
            text=f"Created: {backup_date}\nVersion: {metadata.get('version', 'Unknown')}",
            fg="#9ca3af"
        )
        status_label.config(text="✓ Valid backup file", fg=success_color)
        restore_btn.config(state=tk.NORMAL)

    def do_restore():
        """Execute restore"""
        try:
            if not selected_backup['path']:
                status_label.config(text="Please select a backup file first", fg=warning_color)
                return

            backup_path = selected_backup['path']
            userdata_path = get_userdata_path()

            # Update status
            status_label.config(text="Restoring backup...", fg=accent_color)
            root.update()

            # Create backup of current data before restore
            print("[Restore] Creating backup of current data before restore...", file=sys.stderr)
            temp_backup_dir = userdata_path.parent / f'userdata_backup_{int(time.time())}'
            if userdata_path.exists():
                shutil.copytree(userdata_path, temp_backup_dir)
                print(f"[Restore] Current data backed up to: {temp_backup_dir}", file=sys.stderr)

            try:
                # Extract backup
                print(f"[Restore] Extracting backup to {userdata_path.parent}...", file=sys.stderr)

                with zipfile.ZipFile(backup_path, 'r') as zipf:
                    # Get all files except metadata
                    files_to_extract = [f for f in zipf.namelist() if f != 'backup_metadata.json']

                    for file in files_to_extract:
                        zipf.extract(file, userdata_path.parent)
                        print(f"[Restore] Extracted: {file}", file=sys.stderr)

                # Remove temporary backup after successful restore
                if temp_backup_dir.exists():
                    shutil.rmtree(temp_backup_dir)
                    print(f"[Restore] Removed temporary backup", file=sys.stderr)

                print("[Restore] Restore completed successfully", file=sys.stderr)
                status_label.config(text="✓ Restore complete! Restart recommended.", fg=success_color)

                # Ask to restart
                restart_confirm = messagebox.askyesno(
                    "Restart Server",
                    "Backup restored successfully!\n\n"
                    "A server restart is recommended to apply changes.\n\n"
                    "Restart now?",
                    parent=root
                )

                if restart_confirm:
                    settings = load_settings()
                    root.destroy()
                    restart_server(settings)

            except Exception as e:
                # Restore failed - recover from temp backup
                print(f"[Restore] Error during restore: {e}", file=sys.stderr)

                if temp_backup_dir.exists():
                    print("[Restore] Restoring from temporary backup...", file=sys.stderr)
                    if userdata_path.exists():
                        shutil.rmtree(userdata_path)
                    shutil.copytree(temp_backup_dir, userdata_path)
                    shutil.rmtree(temp_backup_dir)
                    print("[Restore] Recovered from temporary backup", file=sys.stderr)

                raise

        except Exception as e:
            print(f"[Restore] Error restoring backup: {e}", file=sys.stderr)
            status_label.config(text=f"Error: {str(e)}", fg=error_color)

    def close_dialog():
        root.destroy()

    # Button frame
    button_frame = tk.Frame(root, bg=bg_color)
    button_frame.pack(pady=20)

    # Select Backup button
    select_btn = tk.Button(
        button_frame,
        text="Select Backup",
        command=select_backup_file,
        font=("Segoe UI", 11, "bold"),
        bg="#6b7280",
        fg="white",
        activebackground="#9ca3af",
        activeforeground="white",
        relief=tk.RAISED,
        borderwidth=2,
        cursor="hand2",
        width=15,
        pady=10
    )
    select_btn.pack(side=tk.LEFT, padx=8)

    # Restore button (disabled initially)
    restore_btn = tk.Button(
        button_frame,
        text="Restore",
        command=do_restore,
        font=("Segoe UI", 11, "bold"),
        bg=accent_color,
        fg="white",
        activebackground="#2563eb",
        activeforeground="white",
        relief=tk.RAISED,
        borderwidth=2,
        cursor="hand2",
        width=15,
        pady=10,
        state=tk.DISABLED
    )
    restore_btn.pack(side=tk.LEFT, padx=8)

    # Close button
    close_btn = tk.Button(
        button_frame,
        text="Close",
        command=close_dialog,
        font=("Segoe UI", 11),
        bg="#4b5563",
        fg="white",
        activebackground="#6b7280",
        activeforeground="white",
        relief=tk.RAISED,
        borderwidth=2,
        cursor="hand2",
        width=15,
        pady=10
    )
    close_btn.pack(side=tk.LEFT, padx=8)

    # Position window centered in screen
    root.update_idletasks()
    width = 550
    height = 340
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    x = (screen_width - width) // 2
    y = (screen_height - height) // 2

    root.geometry(f"{width}x{height}+{x}+{y}")
    root.deiconify()

    # Keep on top permanently
    root.attributes('-topmost', True)
    root.lift()
    root.focus_force()

    root.mainloop()

def restore_backup():
    """Show restore dialog"""
    show_restore_dialog()

def on_backup_data(icon, item):
    """Backup menu item clicked"""
    thread = threading.Thread(target=create_backup, daemon=True)
    thread.start()

def on_restore_data(icon, item):
    """Restore menu item clicked"""
    thread = threading.Thread(target=restore_backup, daemon=True)
    thread.start()

def on_launch_app(icon, item):
    """Launch App menu item clicked"""
    settings = load_settings()
    url = get_browser_url(settings)
    print(f"[SM-CoPilot] Opening browser: {url}", file=sys.stderr)
    webbrowser.open(url)

def on_settings(icon, item):
    """Settings menu item clicked"""
    # Run settings dialog in separate thread to avoid blocking tray icon
    thread = threading.Thread(target=show_settings_dialog, daemon=True)
    thread.start()

def on_restart(icon, item):
    """Restart menu item clicked"""
    print("[SM-CoPilot] Restart requested from tray menu...", file=sys.stderr)

    def do_restart():
        global loading_dialog, settings_window

        # Close ALL open tkinter windows before restart (loading dialog, settings, etc.)
        if loading_dialog is not None:
            try:
                print("[SM-CoPilot] Closing loading dialog...", file=sys.stderr)
                loading_dialog.quit()
                loading_dialog.destroy()
                loading_dialog = None
            except Exception as e:
                print(f"[SM-CoPilot] Error closing loading dialog: {e}", file=sys.stderr)
                loading_dialog = None

        if settings_window is not None:
            try:
                print("[SM-CoPilot] Closing settings window...", file=sys.stderr)
                settings_window.quit()
                settings_window.destroy()
                settings_window = None
            except Exception as e:
                print(f"[SM-CoPilot] Error closing settings window: {e}", file=sys.stderr)
                settings_window = None

        # Give tkinter time to cleanup (prevent threading issues)
        time.sleep(0.5)
        print("[SM-CoPilot] Windows closed, proceeding with restart...", file=sys.stderr)

        # Load current settings
        settings = load_settings()

        # Restart server (will show loading dialog automatically)
        if restart_server(settings):
            print("[SM-CoPilot] Server restarted successfully", file=sys.stderr)
        else:
            print("[SM-CoPilot] Failed to restart server", file=sys.stderr)

    # Run restart in separate thread to avoid blocking tray icon
    thread = threading.Thread(target=do_restart, daemon=True)
    thread.start()

def on_toggle_debug_mode(icon, item):
    """Toggle Debug Mode menu item clicked"""
    global loading_dialog, settings_window, _server_starting, tray_icon

    # Prevent toggling during server startup
    if _server_starting:
        print("[SM-CoPilot] Cannot toggle Debug Mode while server is starting", file=sys.stderr)
        return

    settings = load_settings()

    # Toggle debug mode
    current_debug_mode = settings.get('debugMode', False)
    settings['debugMode'] = not current_debug_mode
    settings['logLevel'] = 'debug' if settings['debugMode'] else 'info'

    # Save settings
    if save_settings(settings):
        mode_str = "enabled" if settings['debugMode'] else "disabled"
        print(f"[SM-CoPilot] Debug Mode {mode_str} - restarting server...", file=sys.stderr)

        # Update menu to reflect new checkbox state BEFORE restarting
        if tray_icon is not None:
            try:
                print(f"[SM-CoPilot] Updating tray menu (debugMode={settings['debugMode']})", file=sys.stderr)
                # Recreate menu with updated state
                menu = pystray.Menu(
                    pystray.MenuItem("Launch App", on_launch_app),
                    pystray.MenuItem("Settings", on_settings),
                    pystray.MenuItem("Restart", on_restart),
                    pystray.Menu.SEPARATOR,
                    pystray.MenuItem("Backup & Restore", pystray.Menu(
                        pystray.MenuItem("Create Backup", on_backup_data),
                        pystray.MenuItem("Restore Backup", on_restore_data)
                    )),
                    pystray.Menu.SEPARATOR,
                    pystray.MenuItem("Certificates", pystray.Menu(
                        pystray.MenuItem("Install CA Certificate", on_install_certificates),
                        pystray.MenuItem("Uninstall CA Certificates", on_uninstall_certificates),
                        pystray.MenuItem("Download CA Certificate", on_download_certificate)
                    )),
                    pystray.Menu.SEPARATOR,
                    pystray.MenuItem("Debug Mode", on_toggle_debug_mode, checked=debug_mode_checked),
                    pystray.MenuItem("Open Server Log", on_open_server_log),
                    pystray.MenuItem("Open Debug Log", on_open_debug_log),
                    pystray.Menu.SEPARATOR,
                    pystray.MenuItem("Exit", on_exit)
                )
                tray_icon.menu = menu
                tray_icon.update_menu()
            except Exception as e:
                print(f"[SM-CoPilot] Error updating menu: {e}", file=sys.stderr)

        # Close ALL open windows before restart (loading dialog, settings, etc.)
        if loading_dialog is not None:
            try:
                print("[SM-CoPilot] Closing loading dialog...", file=sys.stderr)
                loading_dialog.quit()
                loading_dialog.destroy()
                loading_dialog = None
            except Exception as e:
                print(f"[SM-CoPilot] Error closing loading dialog: {e}", file=sys.stderr)
                loading_dialog = None

        if settings_window is not None:
            try:
                print("[SM-CoPilot] Closing settings window...", file=sys.stderr)
                settings_window.quit()
                settings_window.destroy()
                settings_window = None
            except Exception as e:
                print(f"[SM-CoPilot] Error closing settings window: {e}", file=sys.stderr)
                settings_window = None

        # Kill and restart server to apply new log level
        kill_server_from_pid_file()
        time.sleep(1)  # Wait for port to be released

        if not start_server(settings):
            print("[SM-CoPilot] Failed to restart server", file=sys.stderr)
    else:
        print("[SM-CoPilot] Failed to save Debug Mode setting", file=sys.stderr)

def on_open_server_log(icon, item):
    """Open Server Log menu item clicked"""
    log_paths = get_log_paths()
    server_log = log_paths['server_log']

    if server_log.exists():
        print(f"[SM-CoPilot] Opening server log: {server_log}", file=sys.stderr)
        open_file_with_default_app(server_log)
    else:
        print(f"[SM-CoPilot] Server log not found: {server_log}", file=sys.stderr)

def on_open_debug_log(icon, item):
    """Open Debug Log menu item clicked"""
    log_paths = get_log_paths()
    debug_log = log_paths['debug_log']

    if debug_log.exists():
        print(f"[SM-CoPilot] Opening debug log: {debug_log}", file=sys.stderr)
        open_file_with_default_app(debug_log)
    else:
        print(f"[SM-CoPilot] Debug log not found: {debug_log}", file=sys.stderr)

def on_install_certificates(icon, item):
    """Install Certificates menu item clicked"""
    print("[SM-CoPilot] Install Certificates menu clicked", file=sys.stderr)
    log_to_server_file('info', 'Install Certificates menu clicked')

    def do_install():
        try:
            print("[SM-CoPilot] Starting certificate installation...", file=sys.stderr)
            log_to_server_file('info', 'Starting certificate installation')

            # Import certificate manager
            if getattr(sys, 'frozen', False):
                helper_path = Path(sys._MEIPASS) / 'helper'
                if str(helper_path) not in sys.path:
                    sys.path.insert(0, str(helper_path))
            else:
                helper_path = PROJECT_ROOT / 'helper'
                if str(helper_path) not in sys.path:
                    sys.path.insert(0, str(helper_path))

            print(f"[SM-CoPilot] Importing certificate_manager from {helper_path}", file=sys.stderr)
            log_to_server_file('info', f'Importing certificate_manager from {helper_path}')

            import certificate_manager

            print("[SM-CoPilot] Calling install_certificate()", file=sys.stderr)
            log_to_server_file('info', 'Calling install_certificate()')

            success = certificate_manager.install_certificate()

            if success:
                print("[SM-CoPilot] Certificate installed successfully", file=sys.stderr)
                log_to_server_file('info', 'Certificate installed successfully')
            else:
                print("[SM-CoPilot] Certificate installation cancelled or failed", file=sys.stderr)
                log_to_server_file('warn', 'Certificate installation cancelled or failed')

        except Exception as e:
            print(f"[SM-CoPilot] Error installing certificate: {e}", file=sys.stderr)
            log_to_server_file('error', f'Error installing certificate: {e}')
            import traceback
            traceback.print_exc()
            show_topmost_messagebox(
                messagebox.showerror,
                "Installation Error",
                f"Failed to install certificate:\n{str(e)}"
            )

    # Run in separate thread to avoid blocking tray icon
    thread = threading.Thread(target=do_install, daemon=True)
    thread.start()

def on_uninstall_certificates(icon, item):
    """Uninstall Certificates menu item clicked"""
    print("[SM-CoPilot] Uninstall Certificates menu clicked", file=sys.stderr)
    log_to_server_file('info', 'Uninstall Certificates menu clicked')

    def do_uninstall():
        try:
            print("[SM-CoPilot] Starting certificate uninstallation...", file=sys.stderr)
            log_to_server_file('info', 'Starting certificate uninstallation')

            # Import certificate manager
            if getattr(sys, 'frozen', False):
                helper_path = Path(sys._MEIPASS) / 'helper'
                if str(helper_path) not in sys.path:
                    sys.path.insert(0, str(helper_path))
            else:
                helper_path = PROJECT_ROOT / 'helper'
                if str(helper_path) not in sys.path:
                    sys.path.insert(0, str(helper_path))

            print(f"[SM-CoPilot] Importing certificate_manager from {helper_path}", file=sys.stderr)
            log_to_server_file('info', f'Importing certificate_manager from {helper_path}')

            import certificate_manager

            print("[SM-CoPilot] Calling uninstall_certificates()", file=sys.stderr)
            log_to_server_file('info', 'Calling uninstall_certificates()')

            success = certificate_manager.uninstall_certificates()

            if success:
                print("[SM-CoPilot] Certificates uninstalled successfully", file=sys.stderr)
                log_to_server_file('info', 'Certificates uninstalled successfully')
            else:
                print("[SM-CoPilot] Certificate uninstallation cancelled or failed", file=sys.stderr)
                log_to_server_file('warn', 'Certificate uninstallation cancelled or failed')

        except Exception as e:
            print(f"[SM-CoPilot] Error uninstalling certificates: {e}", file=sys.stderr)
            log_to_server_file('error', f'Error uninstalling certificates: {e}')
            import traceback
            traceback.print_exc()
            show_topmost_messagebox(
                messagebox.showerror,
                "Uninstallation Error",
                f"Failed to uninstall certificates:\n{str(e)}"
            )

    # Run in separate thread to avoid blocking tray icon
    thread = threading.Thread(target=do_uninstall, daemon=True)
    thread.start()

def on_download_certificate(icon, item):
    """Download CA Certificate menu item clicked"""
    print("[SM-CoPilot] Downloading CA certificate...", file=sys.stderr)

    def do_download():
        try:
            # Import certificate manager
            if getattr(sys, 'frozen', False):
                helper_path = Path(sys._MEIPASS) / 'helper'
                if str(helper_path) not in sys.path:
                    sys.path.insert(0, str(helper_path))
            else:
                helper_path = PROJECT_ROOT / 'helper'
                if str(helper_path) not in sys.path:
                    sys.path.insert(0, str(helper_path))

            import certificate_manager
            success = certificate_manager.download_certificate()

            if success:
                print("[SM-CoPilot] Certificate downloaded successfully", file=sys.stderr)
            else:
                print("[SM-CoPilot] Certificate download cancelled", file=sys.stderr)

        except Exception as e:
            print(f"[SM-CoPilot] Error downloading certificate: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            show_topmost_messagebox(
                messagebox.showerror,
                "Download Error",
                f"Failed to download certificate:\n{str(e)}"
            )

    # Run in separate thread to avoid blocking tray icon
    thread = threading.Thread(target=do_download, daemon=True)
    thread.start()

def debug_mode_checked(item):
    """Check if Debug Mode is enabled (for menu checkmark)"""
    settings = load_settings()
    is_enabled = settings.get('debugMode', False)
    # Only log checkbox state when debug mode is enabled
    if is_enabled:
        print(f"[SM-CoPilot] Debug mode checkbox state: {is_enabled} (from settings: {settings})", file=sys.stderr)
    return is_enabled

def on_exit(icon, item):
    """Exit menu item clicked"""
    print("\n[SM-CoPilot] Exit requested, cleaning up...", file=sys.stderr)

    try:
        # Kill server from PID file immediately
        kill_server_from_pid_file()

        # Kill ALL child processes (including dialog windows)
        try:
            import psutil
            current_process = psutil.Process(os.getpid())
            children = current_process.children(recursive=True)
            for child in children:
                try:
                    print(f"[SM-CoPilot] Killing child process: {child.pid}", file=sys.stderr)
                    child.kill()
                except:
                    pass
        except Exception as e:
            print(f"[SM-CoPilot] Warning: Could not kill all children: {e}", file=sys.stderr)

        # Brief verification
        settings = load_settings()
        port = settings['port']

        # Quick port check (max 2 retries)
        if not is_port_in_use(port, '0.0.0.0', retries=2, delay=1):
            print(f"[SM-CoPilot] Port {port} released", file=sys.stderr)
        else:
            print(f"[SM-CoPilot] WARNING: Port {port} may still be in use", file=sys.stderr)
    except Exception as e:
        print(f"[SM-CoPilot] Cleanup error (non-fatal): {e}", file=sys.stderr)
    finally:
        # Always exit, even if cleanup fails
        print("[SM-CoPilot] Forcing exit...", file=sys.stderr)
        os._exit(0)

# Global reference to tray icon
tray_icon = None

def migrate_roaming_to_local():
    """
    One-time migration: Move user data from AppData/Roaming to AppData/Local/userdata.
    Only runs once when Roaming data exists but Local/userdata data doesn't.
    Settings are ALWAYS stored in LocalAppData/userdata, regardless of install location.
    """
    # Only run when packaged as .exe
    if not getattr(sys, 'frozen', False):
        return

    # Only run on Windows
    if platform.system() != 'Windows':
        return

    roaming_base = Path.home() / 'AppData' / 'Roaming' / 'ShippingManagerCoPilot'
    local_base = Path.home() / 'AppData' / 'Local' / 'ShippingManagerCoPilot'
    local_userdata = local_base / 'userdata'

    # Check if Local userdata/settings/sessions.json already exists (migration already done)
    local_sessions = local_userdata / 'settings' / 'sessions.json'
    if local_sessions.exists():
        return  # Already migrated

    # Check if Roaming data exists
    if not roaming_base.exists():
        return  # Nothing to migrate

    print("[SM-CoPilot] ========================================")
    print("[SM-CoPilot] Migrating user data to AppData/Local/userdata...")
    print("[SM-CoPilot] ========================================")

    try:
        import shutil

        # Create Local/userdata directory if it doesn't exist
        local_userdata.mkdir(parents=True, exist_ok=True)

        print(f"[SM-CoPilot] Copying data from Roaming to Local/userdata...")
        print(f"[SM-CoPilot] Source: {roaming_base}")
        print(f"[SM-CoPilot] Target: {local_userdata}")

        # Copy entire directory tree from Roaming to Local/userdata
        shutil.copytree(roaming_base, local_userdata, dirs_exist_ok=True)

        print(f"[SM-CoPilot] ✓ Data copied successfully")

        # Delete old Roaming directory after successful copy
        print(f"[SM-CoPilot] Removing old Roaming directory...")
        shutil.rmtree(roaming_base)

        print(f"[SM-CoPilot] ✓ Migration complete")
        print(f"[SM-CoPilot] New location: {local_userdata}")
        print("[SM-CoPilot] ========================================")

    except Exception as e:
        print(f"[SM-CoPilot] ✗ Migration failed: {e}", file=sys.stderr)
        print(f"[SM-CoPilot] Continuing with empty Local/userdata directory...")

def main():
    """Main entry point"""
    global tray_icon

    print("[SM-CoPilot] Starting Shipping Manager CoPilot Tray Icon", file=sys.stderr)
    print("[SM-CoPilot] Press Ctrl+C to exit", file=sys.stderr)

    # Clear server.log and debug.log on first startup only (use PID file as indicator)
    # If PID file doesn't exist, this is a fresh start -> clear logs
    if not PID_FILE.exists():
        log_paths = get_log_paths()
        server_log = log_paths['server_log']
        debug_log = log_paths['debug_log']

        try:
            server_log.parent.mkdir(parents=True, exist_ok=True)
            with open(server_log, 'w', encoding='utf-8') as f:
                pass  # Clear file
        except Exception as e:
            print(f"[SM-CoPilot] Warning: Could not clear server.log: {e}", file=sys.stderr)

        try:
            debug_log.parent.mkdir(parents=True, exist_ok=True)
            with open(debug_log, 'w', encoding='utf-8') as f:
                pass  # Clear file
        except Exception as e:
            print(f"[SM-CoPilot] Warning: Could not clear debug.log: {e}", file=sys.stderr)

    log_to_server_file('info', 'Shipping Manager CoPilot Starting')

    # Load tray icon (favicon.ico or fallback) FIRST
    log_to_server_file('info', 'Loading tray icon')
    icon_image = load_tray_icon()

    # Create menu
    menu = pystray.Menu(
        pystray.MenuItem("Launch App", on_launch_app),
        pystray.MenuItem("Settings", on_settings),
        pystray.MenuItem("Restart", on_restart),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Backup & Restore", pystray.Menu(
            pystray.MenuItem("Create Backup", on_backup_data),
            pystray.MenuItem("Restore Backup", on_restore_data)
        )),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Certificates", pystray.Menu(
            pystray.MenuItem("Install CA Certificate", on_install_certificates),
            pystray.MenuItem("Uninstall CA Certificates", on_uninstall_certificates),
            pystray.MenuItem("Download CA Certificate", on_download_certificate)
        )),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Debug Mode", on_toggle_debug_mode, checked=debug_mode_checked),
        pystray.MenuItem("Open Server Log", on_open_server_log),
        pystray.MenuItem("Open Debug Log", on_open_debug_log),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Exit", on_exit)
    )

    # Create tray icon
    tray_icon = pystray.Icon(
        "shipping_manager_copilot",
        icon_image,
        "Shipping Manager CoPilot",
        menu
    )

    print("[SM-CoPilot] Tray icon starting...", file=sys.stderr)
    log_to_server_file('info', 'Tray icon initialized')

    # Start server in background thread (non-blocking)
    def start_server_background():
        settings = load_settings()
        if not start_server(settings):
            print("[SM-CoPilot] Server startup failed or cancelled", file=sys.stderr)
            log_to_server_file('fatal', 'Server startup failed or cancelled - application will exit')
            # Force exit entire application
            os._exit(1)

    server_thread = threading.Thread(target=start_server_background, daemon=True)
    server_thread.start()

    # Run tray icon in separate thread (non-blocking)
    icon_thread = threading.Thread(target=tray_icon.run, daemon=False)
    icon_thread.start()
    print("[SM-CoPilot] Tray icon running", file=sys.stderr)
    log_to_server_file('info', 'Tray icon running')

    # Wait for Ctrl+C in main thread
    try:
        while icon_thread.is_alive():
            icon_thread.join(timeout=0.5)
    except KeyboardInterrupt:
        print("\nShutting down...", file=sys.stderr)
        tray_icon.stop()
        kill_server_from_pid_file()

        settings = load_settings()
        port = settings['port']

        print(f"[SM-CoPilot] Verifying port {port} is released...", file=sys.stderr)
        if not is_port_in_use(port, '0.0.0.0', retries=5, delay=2):
            print(f"[SM-CoPilot] Port {port} is now free", file=sys.stderr)
        else:
            print(f"[SM-CoPilot] WARNING: Port {port} may still be in use", file=sys.stderr)

        os._exit(0)

def cleanup_and_exit():
    """Clean shutdown - stop server and tray icon"""
    global tray_icon

    print("[SM-CoPilot] Cleaning up...", file=sys.stderr)

    # Stop server
    stop_server()

    # Stop tray icon
    if tray_icon:
        try:
            tray_icon.stop()
        except:
            pass

    print("[SM-CoPilot] Shutdown complete", file=sys.stderr)
    sys.exit(0)

def emergency_cleanup():
    """Emergency cleanup - always kill server and all children before exit"""
    try:
        kill_server_from_pid_file()

        # Kill ALL child processes (including dialog windows)
        try:
            import psutil
            current_process = psutil.Process(os.getpid())
            children = current_process.children(recursive=True)
            for child in children:
                try:
                    child.kill()
                except:
                    pass
        except:
            pass
    except:
        pass

if __name__ == '__main__':
    # Run one-time migration from Roaming to Local (if needed)
    migrate_roaming_to_local()

    # Register emergency cleanup handlers
    atexit.register(emergency_cleanup)

    # Handle Ctrl+C and other signals
    def signal_handler(sig, frame):
        print("\n[SM-CoPilot] Signal received, cleaning up...", file=sys.stderr)
        emergency_cleanup()
        os._exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    try:
        main()
    except KeyboardInterrupt:
        print("\nShutting down...", file=sys.stderr)
        # Kill server from PID file
        kill_server_from_pid_file()

        # Load settings to get current port
        settings = load_settings()
        port = settings['port']

        # Wait for port to be released before final exit
        print(f"[SM-CoPilot] Verifying port {port} is released...", file=sys.stderr)
        if not is_port_in_use(port, '0.0.0.0', retries=5, delay=2):
            print(f"[SM-CoPilot] Port {port} is now free", file=sys.stderr)
        else:
            print(f"[SM-CoPilot] WARNING: Port {port} may still be in use", file=sys.stderr)

        os._exit(0)
    except Exception as e:
        print(f"\nFatal error: {e}", file=sys.stderr)
        # Kill server from PID file
        kill_server_from_pid_file()

        # Load settings to get current port
        settings = load_settings()
        port = settings['port']

        # Wait for port to be released before final exit
        print(f"[SM-CoPilot] Verifying port {port} is released...", file=sys.stderr)
        if not is_port_in_use(port, '0.0.0.0', retries=5, delay=2):
            print(f"[SM-CoPilot] Port {port} is now free", file=sys.stderr)
        else:
            print(f"[SM-CoPilot] WARNING: Port {port} may still be in use", file=sys.stderr)

        os._exit(1)
