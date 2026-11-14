import sys,json,urllib.request
api,tok,kvid=sys.argv[1:4]
def kv_put(key,val):
    req=urllib.request.Request(f"{api}/storage/kv/namespaces/{kvid}/values/{key}",
        data=json.dumps(val).encode(),
        headers={"Authorization":f"Bearer {tok}","content-type":"application/json"},method="PUT")
    urllib.request.urlopen(req)
def kv_get(key):
    req=urllib.request.Request(f"{api}/storage/kv/namespaces/{kvid}/values/{key}",
        headers={"Authorization":f"Bearer {tok}"})
    try: return json.loads(urllib.request.urlopen(req).read())
    except: return None

import os
now=__import__('time').time()
ids=[]
for f,name in [("/sdcard/deep/wb-cf-proxy/token_domestic.json","国内"),("/sdcard/deep/wb-cf-proxy/token_international.json","国际")]:
    d=json.load(open(f))
    uid=d.get('uid','')
    domain=d.get('domain','')
    realm='global' if 'workbuddy.ai' in domain.lower() else 'cn'
    exp=int(d.get('expiresAt',0))
    if exp>1e12: exp=exp//1000
    acc={"id":__import__('uuid').uuid4().hex,"uid":uid,"realm":realm,"domain":domain,
         "nickname":name,"access_token":d['accessToken'],"refresh_token":d.get('refreshToken',''),
         "expires_at":exp,"enabled":1,"models":[],"created_at":int(now)}
    kv_put("acc:"+acc['id'],acc)
    ids.append(acc['id'])
    print(f"seeded {name}: id={acc['id'][:8]} uid={uid[:8]} realm={realm}")
# 合并进 idx
cur=kv_get("idx_accounts") or []
for i in ids:
    if i not in cur: cur.append(i)
kv_put("idx_accounts",cur)
print("idx_accounts:",cur)
