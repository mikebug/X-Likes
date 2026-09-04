"""Double-click launcher for the viewer.

Starts the local server, opens the browser, and leaves a small window behind so
there is something to close when you are done. Saved as .pyw so Windows runs it
through pythonw and no console appears.

Only the standard library, so it works on any machine that can run the pipeline.
"""

import json
import os
import sys
import threading
import tkinter as tk
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))

from serve import make_server  # noqa: E402  (path set above)

BG = "#111721"
PANEL = "#182029"
INK = "#e6edf3"
DIM = "#8b98a5"
ACCENT = "#6ea8fe"


def archive_status():
    """One line describing what has been built, so the window is worth reading."""
    likes = os.path.join(HERE, "likes.json")
    if not os.path.exists(likes):
        return "no likes.json yet - scrape first, then run the pipeline", False
    try:
        with open(likes, encoding="utf-8") as f:
            n = len(json.load(f))
        bits = ["{:,} posts".format(n)]
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


def main():
    try:
        server, url = make_server()
    except OSError as e:
        root = tk.Tk()
        root.title("X Likes")
        tk.Label(root, text="Could not start the server:\n%s" % e,
                 padx=24, pady=24).pack()
        root.mainloop()
        return

    threading.Thread(target=server.serve_forever, daemon=True).start()
    status, ok = archive_status()

    root = tk.Tk()
    root.title("X Likes")
    root.configure(bg=BG)
    root.resizable(False, False)

    wrap = tk.Frame(root, bg=BG, padx=26, pady=22)
    wrap.pack()

    tk.Label(wrap, text="X LIKES", bg=BG, fg=INK,
             font=("Segoe UI", 13, "bold")).pack(anchor="w")
    tk.Label(wrap, text=status, bg=BG, fg=DIM if ok else "#e0a0a0",
             font=("Segoe UI", 9)).pack(anchor="w", pady=(2, 14))

    link = tk.Label(wrap, text=url, bg=BG, fg=ACCENT,
                    font=("Consolas", 9), cursor="hand2")
    link.pack(anchor="w")
    link.bind("<Button-1>", lambda e: webbrowser.open(url))

    row = tk.Frame(wrap, bg=BG)
    row.pack(anchor="w", pady=(16, 0))

    def button(parent, text, command, primary=False):
        return tk.Button(
            parent, text=text, command=command,
            bg=ACCENT if primary else PANEL, fg="#0a0e14" if primary else INK,
            activebackground=ACCENT if primary else "#222c38",
            activeforeground="#0a0e14" if primary else INK,
            relief="flat", borderwidth=0, padx=16, pady=6,
            font=("Segoe UI", 9, "bold" if primary else "normal"),
            cursor="hand2")

    def quit_all():
        # shutdown() has to come from a thread other than serve_forever's,
        # which is exactly where we are
        threading.Thread(target=server.shutdown, daemon=True).start()
        root.destroy()

    button(row, "Open viewer", lambda: webbrowser.open(url), True).pack(side="left")
    button(row, "Stop", quit_all).pack(side="left", padx=(8, 0))

    tk.Label(wrap, text="closing this window stops the server",
             bg=BG, fg="#6b7785", font=("Segoe UI", 8)).pack(anchor="w", pady=(12, 0))

    root.protocol("WM_DELETE_WINDOW", quit_all)

    # centre on screen
    root.update_idletasks()
    x = (root.winfo_screenwidth() - root.winfo_width()) // 2
    y = (root.winfo_screenheight() - root.winfo_height()) // 3
    root.geometry("+%d+%d" % (x, y))

    if not os.environ.get("XLIKES_NO_BROWSER"):
        webbrowser.open(url)
    if os.environ.get("XLIKES_SELFTEST"):
        root.after(int(os.environ["XLIKES_SELFTEST"]), quit_all)

    root.mainloop()


if __name__ == "__main__":
    main()
