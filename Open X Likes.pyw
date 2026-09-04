"""Double-click launcher: opens the viewer as its own app window.

Starts the local server and hands the URL to Chrome or Edge in `--app` mode, so
the viewer gets a plain window with no address bar or tabs and its own taskbar
entry. When that window closes, the server stops and this exits. Saved as .pyw
so Windows runs it through pythonw and no console appears.

Standard library only.
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))

from serve import make_server, wait_until_closed  # noqa: E402


def profile_dir():
    """Its own browser profile.

    Against the default profile a Chromium just tells the already-running copy
    to open a window and exits, so there is nothing to observe. A private
    profile also means the window remembers its size and position."""
    base = (os.environ.get("LOCALAPPDATA")
            or os.path.join(os.path.expanduser("~"), ".cache"))
    return os.path.join(base, "x-likes-viewer")


CHROMIUM = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""),
                 r"Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_browser():
    for path in CHROMIUM:
        if path and os.path.exists(path):
            return path
    for name in ("google-chrome", "chromium", "chromium-browser",
                 "microsoft-edge", "brave-browser"):
        found = shutil.which(name)
        if found:
            return found
    return None


def archive_status():
    """One line describing what has been built."""
    likes = os.path.join(HERE, "likes.json")
    if not os.path.exists(likes):
        return "no likes.json yet - scrape first, then run the pipeline", False
    try:
        with open(likes, encoding="utf-8") as f:
            bits = ["{:,} posts".format(len(json.load(f)))]
    except Exception:
        bits = ["likes.json unreadable"]
    if os.path.exists(os.path.join(HERE, "labels.json")):
        bits.append("labelled")
    elif os.path.exists(os.path.join(HERE, "graph.json")):
        bits.append("clustered")
    else:
        bits.append("not clustered - run tools/embed.py and tools/cluster.py")
    if not os.path.exists(os.path.join(HERE, "media", "atlas", "atlas.json")):
        bits.append("no atlas - run tools/atlas.py")
    return " · ".join(bits), True


def message(title, body):
    """The only reason to draw any UI of our own: something went wrong."""
    import tkinter as tk
    root = tk.Tk()
    root.title(title)
    root.configure(bg="#111721")
    root.resizable(False, False)
    tk.Label(root, text=title, bg="#111721", fg="#e6edf3", padx=26, pady=(22, 4),
             font=("Segoe UI", 12, "bold")).pack(anchor="w")
    tk.Label(root, text=body, bg="#111721", fg="#8b98a5", padx=26, pady=(0, 22),
             justify="left", font=("Segoe UI", 9)).pack(anchor="w")
    root.update_idletasks()
    root.geometry("+%d+%d" % ((root.winfo_screenwidth() - root.winfo_width()) // 2,
                              (root.winfo_screenheight() - root.winfo_height()) // 3))
    root.mainloop()


def selftest():
    return os.environ.get("XLIKES_SELFTEST")


def main():
    status, ok = archive_status()
    if not ok:
        message("X Likes", status + "\n\nSee the README for the pipeline steps.")
        return

    try:
        server, url = make_server()
    except OSError as e:
        message("X Likes", "Could not start the server:\n%s" % e)
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()

    browser = find_browser()
    if not browser:
        # No Chromium anywhere: open a normal tab and hold the server open
        # behind a window the user can close.
        webbrowser.open(url)
        message("X Likes", status + "\n\nServing at " + url +
                "\nClose this window to stop.")
        server.shutdown()
        return

    cmd = [
        browser,
        "--app=" + url,
        "--user-data-dir=" + profile_dir(),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
    ]
    # XLIKES_HEADLESS runs the real path with no window, for testing
    if selftest() or os.environ.get("XLIKES_HEADLESS"):
        cmd.append("--headless=new")

    try:
        subprocess.Popen(cmd)
    except Exception as e:
        message("X Likes", "Could not open the app window:\n%s" % e)
        server.shutdown()
        return

    # Deliberately not proc.wait(). Edge hands the window to a different
    # process and the one started here exits within seconds, which used to pull
    # the server out from under a window that was still opening. The page says
    # when it is there, and when it has gone.
    if selftest():
        time.sleep(float(selftest()))
    elif wait_until_closed(server) == "the viewer never connected":
        message("X Likes", "The viewer window never opened.\n\n"
                           "Try opening this by hand:\n" + url)

    server.shutdown()


if __name__ == "__main__":
    main()
