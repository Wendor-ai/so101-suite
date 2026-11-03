"""A tiny HTTP client and a demo-server launcher for the API tests."""
import http.client
import json
import sys
import threading
import time


class Resp:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body

    @property
    def json(self):
        return json.loads(self.body)

    @property
    def text(self):
        return self.body.decode()

    @property
    def ctype(self):
        return (self.headers.get("Content-Type") or "").split(";")[0]


class Srv:
    """A running demo server (real stdlib server, ephemeral port, 127.0.0.1) plus helpers."""
    def __init__(self, server, httpd):
        self.server, self.httpd = server, httpd
        self.port = httpd.server_address[1]

    def request(self, method, path, body=None, raw_body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            data = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
            h = dict(headers or {})
            if data is not None:
                h.setdefault("Content-Type", "application/json")
            c.request(method, path, body=data, headers=h)
            r = c.getresponse()
            return Resp(r.status, dict(r.getheaders()), r.read())
        finally:
            c.close()

    def get(self, path, **kw): return self.request("GET", path, **kw)
    def post(self, path, body=None, **kw): return self.request("POST", path, body={} if body is None else body, **kw)

    @property
    def arms(self):
        return self.server.arms

    def arm(self, role):
        return next(a for a in self.server.arms.values() if a.role == role)

    def idx(self, role):
        return list(self.server.arms.values()).index(self.arm(role))

    def wait(self, cond, timeout=15.0, what="condition"):             # generous: a loaded or memory-starved machine (or a small CI runner) can stall a thread for several seconds
        t0 = time.time()
        while time.time() - t0 < timeout:
            v = cond()
            if v:
                return v
            time.sleep(0.05)
        raise AssertionError(f"timed out waiting for {what}")

    def wait_arms(self, n=6):
        self.wait(lambda: len(self.arms) == 2 and all(a.online and len(a.ids) == n for a in self.arms.values()), what=f"both arms online with {n} motors")


def start_demo_server(extra_args=(), config=None):
    """config: optional dict written to the demo app's config.json AFTER the demo folder is reset and BEFORE the server reads it."""
    from so101 import demo, trace
    for m in ("server", "pickplace"):
        sys.modules.pop(m, None)
    demo.uninstall()
    demo.install()
    if config is not None:
        import json
        from so101 import paths
        (paths.data_dir() / "config.json").write_text(json.dumps(config))
    trace.reset()
    import server
    httpd, _ = server.setup(["--demo", "--port", "0", "--host", "127.0.0.1", *extra_args])
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    s = Srv(server, httpd)
    s.wait_arms()
    return s


def stop_demo_server(s):
    from so101 import demo, trace
    s.httpd.shutdown()
    s.httpd.server_close()
    s.server.stop_background()
    time.sleep(0.3)
    trace.reset()
    demo.uninstall()
    for m in ("server", "pickplace"):
        sys.modules.pop(m, None)
