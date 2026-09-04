"""Serve the archive locally.

`python -m http.server` handles one request at a time, which the viewer
saturates immediately - it pulls thumbnails ten at a time and every one of them
queues behind the last. A threading server keeps the grid and the map filling
in smoothly.

    python tools/serve.py [port]
"""

import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(Handler, directory=ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    print("serving %s" % ROOT)
    print("open http://localhost:%d/likes-viewer/" % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
