"""录制静态演示版（GitHub Pages）用的数据快照：frontend/src/demo/fixtures.json。

演示版没有后端，前端在 demo 模式下用这份快照回答 /api 请求（见 frontend/src/demo/）。
快照来自真实后端：本脚本对着一个刚导入种子数据的后端走一遍"演示故事"，把各页面要用的响应录下来。

前提：后端用 demo profile + 一次性的内存库启动（录制会生成建议、确认价格、发推送、登记销售，不要对着正式库跑）：
    java -jar target/fruit-shop-1.0.0.jar --spring.profiles.active=demo --server.port=18090 ^
      "--spring.datasource.url=jdbc:h2:mem:rec;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1"
用法（仓库根目录）：
    python scripts/record_demo_fixtures.py --port 18090

故事（营业日固定为种子数据最后一天 2026-06-29，与 frontend/src/utils/bizDate.js 一致）：
  1. 用 RULE 生成建议；店主采纳大部分、改一个价、留几条待确认
     （种子数据的模型产物对 06-29 全部判"维持原价"，MODEL 当天不出建议，所以故事用 RULE）
  2. 给一个已确认的单品发推送；一位收到推送的会员来买，再登记一笔普通销售；做一次推送归因
  3. 此刻各页面的 GET 响应 = 演示版的初始状态
  4. 之后才录"点了按钮才需要"的响应：MODEL / FIXED 的生成结果、各单品各折扣的推送预览、报废与登记的回执
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "src" / "demo" / "fixtures.json"
BIZ = "2026-06-29"
STRATEGIES = ("FIXED", "RULE", "MODEL")
STORY = "RULE"  # 故事里店主用的策略
RATES = (0.5, 0.6, 0.7, 0.8, 0.9, 1.0)

base = ""


def shift(date: str, days: int) -> str:
    return (dt.date.fromisoformat(date) + dt.timedelta(days=days)).isoformat()


def call(method: str, path: str, params: dict | None = None, body: dict | None = None) -> dict:
    query = "?" + urllib.parse.urlencode(params) if params else ""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path + query, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:  # 错误响应也是统一响应体，原样录下，演示版照样回放
        return json.loads(e.read())


def key(path: str, params: dict) -> str:
    """与 frontend/src/demo/adapter.js 的 requestKey 一致：参数按名字排序，布尔写成 true/false。"""
    parts = []
    for name in sorted(params):
        value = params[name]
        if value is None:
            continue
        if isinstance(value, bool):
            value = "true" if value else "false"
        parts.append(f"{name}={value}")
    return path + ("?" + "&".join(parts) if parts else "")


def ok(body: dict, what: str) -> dict:
    if body.get("code") != 0:
        sys.exit(f"[record] {what} 失败：{body}")
    return body["data"]


def snapshot(items: list[dict]) -> dict:
    gets: dict[str, dict] = {}

    def get(path: str, **params):
        gets[key(path, params)] = call("GET", path, params)

    get("/health")
    get("/items")
    get("/pricing/model-status", bizDate=BIZ)
    for days in range(0, 11):  # 临期清单页的天数输入框是 0~10
        get("/batches/near-expiry", bizDate=BIZ, days=days)
    get("/batches/at-risk", bizDate=BIZ)
    get("/batches/on-sale", bizDate=BIZ)
    for item in items:
        for include_sold_out in (False, True):
            get("/batches/in-stock", itemId=item["id"], bizDate=BIZ, includeSoldOut=include_sold_out)
    for back in range(14):
        day = shift(BIZ, -back)
        get("/traffic/hourly", date=day)
        get("/traffic/peaks", date=day)
    for n in (7, 30, 90):  # 效果看板的三个快捷区间
        get("/sales/effect", **{"from": shift(BIZ, -(n - 1)), "to": BIZ})
    for n in (7, 30):
        get("/push/stats", **{"from": shift(BIZ, -(n - 1)), "to": BIZ})
    stats = gets[key("/push/stats", {"from": shift(BIZ, -29), "to": BIZ})].get("data") or {}
    for task in stats.get("byTask", []):
        get("/push/tasks", taskId=task["taskId"])
    get("/pricing/suggestions", bizDate=BIZ)
    for s in STRATEGIES:
        get("/pricing/suggestions", bizDate=BIZ, strategy=s)
    return gets


PREVIEW_VARY = ("title", "content", "discountRate", "discountPrice", "discountLabel", "priceNote", "messageIds")
TARGET_FIELDS = ("memberId", "nickname", "categoryName", "reason")  # 推送页名单表只显示这几列


def compact(fixtures: dict) -> None:
    """压小快照：去掉能推算出来的重复内容（adapter.js 按同样的规则还原）。"""
    gets = fixtures["gets"]
    # 临期清单：days=d 的结果就是 days=10 的结果里 daysLeft <= d 的那些行，只留 days=10
    # （metricsUpdatedAt 是每次查询现算指标的时间，前后差一两秒，比较时不算）
    def rows(d: int) -> list[dict]:
        return [{k: v for k, v in r.items() if k != "metricsUpdatedAt"}
                for r in gets[key("/batches/near-expiry", {"bizDate": BIZ, "days": d})]["data"]]

    full = rows(10)
    if all(rows(d) == [r for r in full if r["daysLeft"] <= d] for d in range(10)):
        for d in range(10):
            del gets[key("/batches/near-expiry", {"bizDate": BIZ, "days": d})]
        fixtures["meta"]["nearExpiryMaxDays"] = 10
    # 推送预览：每个单品留一份完整的 0.7 折预览，其余折扣只留随折扣变化的字段；名单只留页面显示的列
    slim = {}
    for name, body in fixtures["posts"]["preview"].items():
        item, rate = name.split("@")
        entry = slim.setdefault(item, {"byRate": {}})
        if body.get("code") != 0:
            entry["byRate"][rate] = {"error": body}
            continue
        data = body["data"]
        data["targets"] = [{f: t.get(f) for f in TARGET_FIELDS} for t in data.get("targets") or []]
        if rate == "0.7":
            entry["base"] = data
        entry["byRate"][rate] = {f: data.get(f) for f in PREVIEW_VARY}
    fixtures["posts"]["preview"] = slim


def main() -> None:
    global base
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=18090)
    args = ap.parse_args()
    base = f"http://localhost:{args.port}/api"

    # 服务能响应时，种子导入（SeedDataLoader，ApplicationRunner）可能还在跑：这时写数据会和导入的
    # strategy_daily_stat 撞唯一键，导入失败、后端退出。导入的最后一步是 strategy_daily_stat（一个事务提交），
    # 所以等效果看板在 BIZ 这天同时查得到三种策略的汇总，再开始
    for _ in range(120):
        try:
            effect = call("GET", "/sales/effect", {"from": BIZ, "to": BIZ}).get("data") or {}
            if {"FIXED", "RULE", "MODEL"} <= {d.get("strategy") for d in effect.get("daily") or []}:
                break
        except (urllib.error.URLError, ConnectionError):
            pass
        time.sleep(2)
    else:
        sys.exit("[record] 等了 4 分钟种子数据还没导入完（效果看板查不到 strategy_daily_stat）")
    items = ok(call("GET", "/items"), "商品档案")
    if ok(call("GET", "/pricing/suggestions", {"bizDate": BIZ}), "建议列表"):
        sys.exit("[record] 这个库里 2026-06-29 已经有建议了：请用一次性的新库重启后端再录")
    posts: dict = {}

    # 1. 生成 + 店主决策
    posts[f"generate:{STORY}:first"] = call("POST", "/pricing/suggestions/generate", body={"bizDate": BIZ, "strategy": STORY})
    story = ok(call("GET", "/pricing/suggestions", {"bizDate": BIZ, "strategy": STORY}), f"{STORY} 建议")
    confirmed = []
    for i, s in enumerate(story):
        if i % 4 == 3:
            continue  # 留给看板的"待确认"和演示时现场点"确认"
        price = float(s["suggestedPrice"])
        if i == 1:  # 一条店主改价：在建议价上加一点，但不超过原价
            price = min(float(s["originalPrice"]), round(price * 1.05, 1))
        body = call("POST", "/pricing/decisions", body={
            "suggestionId": s["id"], "finalPrice": price, "accepted": i != 1,
            "reason": "店主改价" if i == 1 else "采纳系统建议"})
        posts.setdefault("decide", body)
        if body.get("code") == 0:
            confirmed.append(s)
    if not confirmed:
        sys.exit("[record] 没有确认成功的建议，故事走不下去")

    # 2. 推送 + 会员成交 + 归因
    target = confirmed[0]
    preview = call("POST", "/push/preview", body={"itemId": target["itemId"], "bizDate": BIZ, "discountRate": 0.7, "targetCount": 20})
    posts["preview:story"] = preview
    task_id = ok(preview, "推送预览")["taskId"]
    posts["send"] = call("POST", "/push/send", body={"taskId": task_id, "bizDate": BIZ, "discountRate": 0.7})
    logs = (ok(call("GET", "/push/tasks", {"taskId": task_id}), "推送明细") or [{}])[0].get("logs") or []
    member_id = next((log.get("memberId") for log in logs if log.get("memberId") and not log.get("skipReason")), None)
    on_sale = ok(call("GET", "/batches/on-sale", {"bizDate": BIZ}), "特价列表")
    price = next((r["finalPrice"] for r in on_sale if r["itemId"] == target["itemId"]), target["suggestedPrice"])
    posts["feedback"] = call("POST", "/sales/feedback", body={
        "bizDate": BIZ, "itemId": target["itemId"], "quantity": 2, "unitPrice": price,
        "isReturn": False, "memberId": member_id, "requestNo": "DEMO-REC-1"})
    second = confirmed[min(2, len(confirmed) - 1)]
    call("POST", "/sales/feedback", body={
        "bizDate": BIZ, "itemId": second["itemId"], "quantity": 1, "unitPrice": second["suggestedPrice"],
        "isReturn": False, "requestNo": "DEMO-REC-2"})
    opened = next((log for log in logs if log.get("logId") and not log.get("skipReason")), None)
    if opened:
        posts["open"] = call("POST", "/push/open", body={"logId": opened["logId"]})
    posts["attribute"] = call("POST", "/push/attribute", body={"from": shift(BIZ, -6), "to": BIZ})

    # 3. 演示版的初始状态
    gets = snapshot(items)

    # 4. 点了按钮才需要的响应
    generated = {}
    for s in (x for x in STRATEGIES if x != STORY):
        posts[f"generate:{s}:first"] = call("POST", "/pricing/suggestions/generate", body={"bizDate": BIZ, "strategy": s})
        generated[s] = call("GET", "/pricing/suggestions", {"bizDate": BIZ, "strategy": s})
    for s in STRATEGIES:
        posts[f"generate:{s}:again"] = call("POST", "/pricing/suggestions/generate", body={"bizDate": BIZ, "strategy": s})
    generated["MODEL_STATUS_AFTER"] = call("GET", "/pricing/model-status", {"bizDate": BIZ})

    pending = next((s for i, s in enumerate(story) if i % 4 == 3), None)
    if pending:
        posts["decide:belowFloor"] = call("POST", "/pricing/decisions", body={
            "suggestionId": pending["id"], "finalPrice": 0.01, "accepted": False, "reason": "店主改价"})

    previews: dict[str, dict] = {}
    for item in items:
        for rate in RATES:
            previews[f"{item['id']}@{rate}"] = call("POST", "/push/preview", body={
                "itemId": item["id"], "bizDate": BIZ, "discountRate": rate, "targetCount": 20})
    posts["preview"] = previews

    near = gets[key("/batches/near-expiry", {"bizDate": BIZ, "days": 2})].get("data") or []
    if len(near) >= 2:
        posts["scrap:partial"] = call("POST", f"/batches/{near[0]['batchId']}/scrap",
                                      body={"bizDate": BIZ, "qty": 1, "reason": "磕碰损伤", "operator": "店员"})
        posts["scrap:whole"] = call("POST", f"/batches/{near[1]['batchId']}/scrap",
                                    body={"bizDate": BIZ, "reason": "已过期", "operator": "店员"})
    posts["createBatch"] = call("POST", "/batches", body={
        "itemId": items[0]["id"], "arriveDate": BIZ, "shelfLifeDays": 3, "qty": 10, "costPrice": 5})

    try:
        commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],
                                capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        commit = ""
    fixtures = {"meta": {"bizDate": BIZ}, "gets": gets, "generated": generated, "posts": posts}
    compact(fixtures)
    text = json.dumps(fixtures, ensure_ascii=False, separators=(",", ":"))
    # 决策、发送、指标的时间戳是录制当天的系统时间；演示版的营业日是 BIZ，统一挪到 BIZ，免得页面上日期对不上
    today = dt.date.today().isoformat()
    text = re.sub(re.escape(today) + r"(?=[ T]\d\d:\d\d)", BIZ, text)
    fixtures = json.loads(text)
    fixtures["meta"].update(recordedAt=dt.datetime.now().isoformat(timespec="seconds"), commit=commit)
    text = json.dumps(fixtures, ensure_ascii=False, separators=(",", ":"))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"[record] {len(fixtures['gets'])} 个 GET、{len(previews)} 个推送预览 → {OUT.relative_to(ROOT)}（{OUT.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
