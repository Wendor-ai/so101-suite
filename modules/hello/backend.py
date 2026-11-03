"""Backend of the hello module. The app calls handle() for every request to /api/m/hello/<path>.

handle(method, path, body, ctx) -> (status, payload)
  method  "GET" | "POST" | "PUT" | "DELETE"
  path    what comes after /api/m/hello/, for example "greet"
  body    the JSON body as a dict ({} when there is none)
  ctx     the app: ctx.arms (dict of Arm threads), ctx.cams, ctx.PP (pick & place), ctx.TELE, ctx.store, ctx.demo
Return a status code and anything JSON can hold. Raise nothing on purpose: an exception becomes a 500 with a sentence.
"""


def handle(method, path, body, ctx):
    if path == "greet":
        name = str((body or {}).get("name") or "world")[:40]
        return 200, {"message": f"Hello, {name}!", "arms_connected": sum(1 for a in ctx.arms.values() if a.online), "demo": bool(ctx.demo)}
    if path == "ping":
        return 200, {"ok": True}
    return 404, {"error": f"The hello module has no '{path}' route. Try greet or ping."}
