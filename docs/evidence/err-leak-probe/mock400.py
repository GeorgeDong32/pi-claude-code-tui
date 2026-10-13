import json
from http.server import BaseHTTPRequestHandler, HTTPServer

BODY = json.dumps({"error": {"type": "permission_error", "message": "x" * 1200,
    "details": [{"i": i, "pad": "y" * 60} for i in range(12)]}}).encode()

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)
    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", 8901), H).serve_forever()
