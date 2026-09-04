"""Serve the archive locally.

`python -m http.server` handles one request at a time, which the viewer
saturates immediately - it pulls thumbnails ten at a time and every one of them
queues behind the last. A threading server keeps the grid and the map filling
in smoothly.

    python tools/serve.py [port] [--open]

The launcher in the project root drives the same server through make_server().
"""

import argparse
import functools
import os
import socket
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIEWER = "/likes-viewer/"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # The media files never change once downloaded; let the browser keep
        # them so a reload does not re-fetch 200 MB of thumbnails.
        if "/media/" in self.path:
            self.send_header("Cache-Control", "public, max-age=604800")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            sys.stderr.write("404 %s\n" % self.path)


def in_use(port):
    """Windows SO_REUSEADDR lets you bind a port something is already serving,
    so a bind test alone reports busy ports as free. Ask twice: can anything be
    connected to, and can the address be bound without the reuse flag."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        if s.connect_ex(("127.0.0.1", port)) == 0:
            return True
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return True
    return False


def free_port(start=8000, tries=25):
    """First open port at or after `start`, so a second copy still launches."""
    for port in range(start, start + tries):
        if not in_use(port):
            return port
    raise OSError("no free port in %d-%d" % (start, start + tries))


def make_server(port=None):
    """A started-but-not-serving server plus the URL to open."""
    port = port or free_port()
    handler = functools.partial(Handler, directory=ROOT)
    # without this the server would happily bind a port already in use
    ThreadingHTTPServer.allow_reuse_address = False
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    return server, "http://localhost:%d%s" % (port, VIEWER)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("port", nargs="?", type=int, default=None)
    ap.add_argument("--open", action="store_true", help="open the viewer too")
    args = ap.parse_args()

    server, url = make_server(args.port)
    print("serving %s" % ROOT)
    print("open %s" % url)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
