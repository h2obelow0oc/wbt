import sys,urllib.request,json,os
api,name,tok,kvid,admin,path=sys.argv[1:7]
boundary="----wbmgr"+os.urandom(8).hex()
parts=[]
meta={"body_part":"worker_kv.js","compatibility_date":"2025-01-01",
  "bindings":[{"type":"plain_text","name":"ADMIN_TOKEN","text":admin},
              {"type":"plain_text","name":"MAX_CONTEXT_TOKENS","text":os.environ.get("MAX_CONTEXT_TOKENS","0")},
              {"type":"plain_text","name":"LOOP_REPEAT_LIMIT","text":os.environ.get("LOOP_REPEAT_LIMIT","6")},
              {"type":"plain_text","name":"LOOP_WINDOW_MS","text":os.environ.get("LOOP_WINDOW_MS","120000")},
              {"type":"kv_namespace","name":"KV","namespace_id":kvid}]}
parts.append(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n"+json.dumps(meta)+"\r\n").encode())
data=open(path,"rb").read()
head=("--"+boundary+"\r\nContent-Disposition: form-data; name=\"worker_kv.js\"; filename=\"worker_kv.js\"\r\nContent-Type: application/javascript\r\n\r\n").encode()
parts.append(head+data+b"\r\n")
body=b"".join(parts)+b"--"+boundary.encode()+b"--\r\n"
req=urllib.request.Request(f"{api}/workers/scripts/{name}",data=body,headers={"Authorization":f"Bearer {tok}","content-type":f"multipart/form-data; boundary={boundary}"},method="PUT")
try:
    r=json.load(urllib.request.urlopen(req)); print("deploy success:",r.get("success"))
    if not r.get("success"): print(json.dumps(r,ensure_ascii=False)[:800])
except urllib.error.HTTPError as e: print("HTTP",e.code,e.read().decode()[:800])
