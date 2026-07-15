import urllib.request, json
d = json.dumps({"cart_items":[{"blueprint_type_id":688,"runs":1,"me":10,"te":20}],"facility":{"facility_type":"raitaru","rigs":"m_basic_large_ship_mat_1","security_class":"highsec","tax_rate":5,"system_cost_index":0.006,"price_source":"jita_sell"},"skills":{"industry":5,"advanced_industry":5},"implants":{},"use_buy_prices":False})
req = urllib.request.Request("http://localhost:8080/api/blueprints/build-cost", data=d.encode(), headers={"Content-Type":"application/json"}, method="POST")
r = urllib.request.urlopen(req, timeout=30)
j = json.loads(r.read())
for m in j["items"][0]["materials"][:5]:
    print(m["material_name"], m["total_quantity"])
