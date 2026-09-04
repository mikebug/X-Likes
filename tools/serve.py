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
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIEWER = "/likes-viewer/"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # The viewer pings this every couple of seconds while it is open. The
        # launcher watches the timestamp to know when the window has gone:
        # waiting on the browser process does not work, because Edge hands off
        # to another process and the one you started exits immediately.
        if self.path == "/__alive":
            self.server.last_ping = time.time()
            self.send_response(204)
            self.end_headers()
            return
        return super().do_GET()

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


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Without this the server will happily bind a port already being served,
    # because Windows SO_REUSEADDR permits it.
    allow_reuse_address = False

    def handle_error(self, request, client_address):
        # A browser dropping a connection as its window closes is routine, and
        # a traceback per pending request is just noise.
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError)):
            return
        super().handle_error(request, client_address)


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
    server = Server(("127.0.0.1", port), handler)
    server.last_ping = 0.0
    return server, "http://localhost:%d%s" % (port, VIEWER)


def wait_until_closed(server, startup=60.0, idle=8.0):
    """Block until the viewer stops pinging.

    `startup` allows for a cold browser start before the first ping; `idle` is
    how long to keep serving after the last one, so a reload does not count as
    the window closing."""
    began = time.time()
    while True:
        time.sleep(1.0)
        last = server.last_ping
        if not last:
            if time.time() - began > startup:
                return "the viewer never connected"
        elif time.time() - last > idle:
            return "the viewer was closed"


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
