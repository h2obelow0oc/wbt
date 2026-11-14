import sys,json,urllib.request
api,tok,kvid=sys.argv[1:4]
def kv_get(key):
    req=urllib.request.Request(f"{api}/storage/kv/namespaces/{kvid}/values/{key}",headers={"Authorization":f"Bearer {tok}"})
    try: return json.loads(urllib.request.urlopen(req).read())
    except: return None
def kv_put(key,val):
    req=urllib.request.Request(f"{api}/storage/kv/namespaces/{kvid}/values/{key}",data=json.dumps(val).encode(),
        headers={"Authorization":f"Bearer {tok}","content-type":"application/json"},method="PUT")
    urllib.request.urlopen(req)
# 扫描 index 修正所有 global domain 的 realm
ids=kv_get("idx_accounts") or []
for i in ids:
    a=kv_get("acc:"+i)
    if not a: continue
    d=(a.get("domain") or "").lower()
    rl="global" if ("workbuddy.ai" in d or ("codebuddy.ai" in d and ".cn" not in d)) else "cn"
    if a.get("realm")!=rl:
        a["realm"]=rl; kv_put("acc:"+i,a); print("fixed",i[:8],"->",rl)
print("done")
