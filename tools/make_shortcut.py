"""Create a Desktop (and optionally Start Menu) shortcut for the viewer.

    python tools/make_shortcut.py            # Desktop
    python tools/make_shortcut.py --start    # Desktop + Start Menu

Windows only. Uses the WScript.Shell COM object through PowerShell so nothing
has to be installed - pywin32 is not required.

The shortcut runs pythonw.exe against the launcher rather than the .pyw itself,
so it still works on a machine where the .pyw file association is missing or
has been hijacked by an editor.
"""

import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCHER = os.path.join(ROOT, "Open X Likes.pyw")
ICON = os.path.join(ROOT, "icon.ico")
NAME = "X Likes.lnk"


def pythonw():
    """The windowless interpreter next to whichever python is running this."""
    exe = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    return exe if os.path.exists(exe) else sys.executable


def ps_quote(s):
    return "'" + s.replace("'", "''") + "'"


def known_folder(name):
    """Ask Windows where the folder really is.

    ~/Desktop is wrong on any machine where OneDrive has redirected it, which
    is most of them now - the real path is ~/OneDrive/Desktop."""
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "[Environment]::GetFolderPath('%s')" % name],
        capture_output=True, text=True)
    path = r.stdout.strip()
    return path if path and os.path.isdir(path) else None


def make(target_dir):
    path = os.path.join(target_dir, NAME)
    script = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut({lnk});"
        "$s.TargetPath = {exe};"
        "$s.Arguments = {args};"
        "$s.WorkingDirectory = {cwd};"
        "$s.IconLocation = {icon};"
        "$s.Description = 'Browse your X likes by topic';"
        "$s.Save()"
    ).format(
        lnk=ps_quote(path),
        exe=ps_quote(pythonw()),
        args=ps_quote('"%s"' % LAUNCHER),
        cwd=ps_quote(ROOT),
        icon=ps_quote(ICON if os.path.exists(ICON) else pythonw()),
    )
    r = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(path):
        print("failed for %s\n%s" % (target_dir, r.stderr.strip()))
        return False
    print("created %s" % path)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", action="store_true",
                    help="also add it to the Start Menu")
    args = ap.parse_args()

    if os.name != "nt":
        print("Windows only - on macOS or Linux, make a launcher for "
              "'%s' by hand." % LAUNCHER)
        return 1
    if not os.path.exists(LAUNCHER):
        print("cannot find %s" % LAUNCHER)
        return 1
    if not os.path.exists(ICON):
        print("no icon.ico - run tools/make_icon.py first for a proper icon")

    desktop = known_folder("Desktop") or os.path.join(
        os.path.expanduser("~"), "Desktop")
    ok = make(desktop)
    if args.start:
        programs = known_folder("Programs") or os.path.join(
            os.environ.get("APPDATA", ""),
            r"Microsoft\Windows\Start Menu\Programs")
        ok = make(programs) and ok
    if ok:
        print("\nDouble-click it, or pin it to the taskbar.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
