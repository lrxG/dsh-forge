#!/usr/bin/env python
# httpprobe.py — 通用 HTTP 黑盒探测器(参数化, 跨 engagement 复用)
# 用法与全部开关: python httpprobe.py --help(dsh 里经 toolbox 的 probe 调用)
# 纪律: 默认直连; 远程渗透用 --proxy 或 PENTEST_PROXY 指定; 串行 + --delay 间隔, 不瞬发并发.
import sys, time, argparse, re, os, json, difflib
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
try:
    import requests, urllib3
    urllib3.disable_warnings()
except ImportError:
    print("NEED: pip install requests"); sys.exit(2)

DEF_PROXY = os.environ.get("PENTEST_PROXY", "")
UA_DEFAULT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def kv(pairs):
    out = {}
    for p in pairs or []:
        if ":" in p:
            k, v = p.split(":", 1)
            out[k.strip()] = v.strip()
        elif "=" in p:
            k, v = p.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def read_paths(args):
    ps = []
    for item in args.path or []:
        ps.extend([x for x in item.split(",") if x != ""])
    if args.wordlist:
        with open(args.wordlist, encoding="utf-8", errors="replace") as f:
            ps.extend([ln.strip() for ln in f if ln.strip() and not ln.startswith("#")])
    if args.stdin_paths:
        ps.extend([ln.strip() for ln in sys.stdin if ln.strip()])
    return [p if p.startswith("/") or p.startswith("http") else "/" + p for p in ps]


def decode(content, charset):
    for enc in [charset, "utf-8", "gb18030", "gbk", "latin-1"]:
        if not enc:
            continue
        try:
            return content.decode(enc)
        except Exception:
            continue
    return content.decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser(
        description="参数化 HTTP 黑盒探测器: 路径枚举/差分/表单重放, 串行带间隔, 默认走本机代理。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例
  # 路径清单(存在性+鉴权边界): 只报非噪声行
  python httpprobe.py -b http://TGT:8004 -p "/Login.aspx,/admin/,/Main.aspx" --only 200,301,302,403

  # 从文件读清单 + 保存命中正文 + 抽标题
  python httpprobe.py -b http://TGT:8004 -w paths.txt --title --save hits/ --only 200

  # 登录差分(同一份 POST, 只换被怀疑的参数)
  python httpprobe.py -b http://TGT:8004 -p / --method POST -d "txtUser=admin" -d "txtPwd=x" --match 无此用户

  # 多 payload 差分: payload 文件每行一个, {PAY} 占位替换
  python httpprobe.py -b http://TGT:8004 -p / --method POST -d "txtUser={PAY}" -f payloads.txt --tag sql

  # 方法矩阵 / 请求头差分
  python httpprobe.py -b http://TGT:8004 -p / --method OPTIONS,TRACE,PUT
  python httpprobe.py -b http://TGT:8004 -p /admin/ -H "X-Forwarded-For:127.0.0.1" -H "Client-IP:10.0.0.1"

  # 计时盲注: 用 --min-time 只留超过阈值的响应
  python httpprobe.py -b http://TGT:8004 -p / --method POST -d "id=1--\\" -f pay.txt --min-time 2

  # 两包差分(IDOR/越权): 正好两个路径、一个 method、一个 payload
  python httpprobe.py -b http://TGT:8004 -p /api/orders/1 -p /api/orders/2 --diff --no-proxy
""")
    ap.add_argument("-b", "--base", required=True, help="目标基址, 如 http://1.2.3.4:8004")
    ap.add_argument("-p", "--path", action="append", help="路径, 可逗号分隔, 可重复; 给完整 URL 则忽略 base")
    ap.add_argument("-w", "--wordlist", help="路径清单文件(每行一个)")
    ap.add_argument("--stdin-paths", action="store_true", help="从 stdin 读路径清单")
    ap.add_argument("-f", "--payload-file", help="payload 清单(每行一个), 替换 URL/数据里的 {PAY}")
    ap.add_argument("--method", default="GET", help="GET/POST/..., 逗号分隔则逐个方法各发一次(默认 GET)")
    ap.add_argument("-d", "--data", action="append", help="POST 表单项 k=v, 可重复; 支持 {PAY}")
    ap.add_argument("--raw", help="原始请求体(不编码), 支持 {PAY}")
    ap.add_argument("-H", "--header", action="append", help="请求头 K:V, 可重复")
    ap.add_argument("-c", "--cookie", action="append", help="Cookie k=v, 可重复(合并成一条 Cookie 头)")
    ap.add_argument("--proxy", default=DEF_PROXY, help="代理, 默认 %s; 传 none 则直连" % DEF_PROXY)
    ap.add_argument("--no-proxy", action="store_true", help="显式直连(仅本地靶/明确豁免时)")
    ap.add_argument("--delay", type=float, default=0.2, help="每包间隔秒, 默认 0.2")
    ap.add_argument("--timeout", type=float, default=30,
                    help="单包超时, 默认 30s(旧默认 12s 会把慢查询页误判成死链,实测丢过一条 57 条身份证的成果)")
    ap.add_argument("--retries", type=int, default=1, help="失败重试次数, 默认 1")
    ap.add_argument("--only", help="只显示这些状态码, 逗号分隔, 如 200,301,403")
    ap.add_argument("--drop", default="404", help="忽略这些状态码(默认丢 404 降噪)")
    ap.add_argument("--match", action="append", help="正文关键词(逗号分隔任一命中), 打印命中上下文")
    ap.add_argument("--title", action="store_true", help="抽取并显示 <title>")
    ap.add_argument("--headers", action="store_true", help="打印全部响应头")
    ap.add_argument("--body", action="store_true", help="打印正文前 600 字(可见文本)")
    ap.add_argument("--body-full", action="store_true", help="打印完整可见正文(仍剥标签)")
    ap.add_argument("--raw-body", action="store_true",
                    help="打印**未剥离**的原始正文(Classic ASP/WebForms 的 alert() 提示在被剥掉的 <script> 里,只能这样看)")
    ap.add_argument("--raw-max", type=int, default=2000, help="--raw-body 最多打印多少字, 默认 2000")
    ap.add_argument("--save", help="把命中(或 --only 命中)的正文存到该目录")
    ap.add_argument("--charset", help="强制响应字符集, 如 gb2312 / utf-8")
    ap.add_argument("--min-time", type=float, help="只打印耗时 >= 该秒数的响应(盲注计时)")
    ap.add_argument("--follow", action="store_true", help="跟随重定向(默认不跟)")
    ap.add_argument("--vs", action="store_true",
                    help="ASP.NET WebForms / Laravel: POST 前先 GET 同 URL, 自动回填 __VIEWSTATE/__EVENTVALIDATION/"
                         "__VIEWSTATEGENERATOR/__EVENTTARGET/__EVENTARGUMENT 及 _token/_method(手工 -d 的同名字段优先)")
    ap.add_argument("--vs-from",
                    help="跨页取 token: 先 GET 该路径(同会话同 Cookie), 用于 CSRF 在表单页、提交打到另一 URL 的站点")
    ap.add_argument("--tag", default="", help="输出前缀标签, 便于多轮对照")
    ap.add_argument("--json", action="store_true", help="以 JSONL 输出, 便于二次处理")
    ap.add_argument("--diff", action="store_true",
                    help="比较两个响应正文（需正好两个 -p/--path、一个 method、一个 payload），输出 unified diff")
    args = ap.parse_args()

    paths = read_paths(args)
    if not paths:
        ap.error("没有路径: 用 -p / -w / --stdin-paths 给")
    payloads = []
    if args.payload_file:
        with open(args.payload_file, encoding="utf-8", errors="replace") as fh:
            payloads = [ln.rstrip("\n") for ln in fh if ln.strip() != ""]
    if not payloads:
        payloads = [""]
    methods = [m.strip().upper() for m in args.method.split(",") if m.strip()]
    if args.diff and not (len(paths) == 2 and len(payloads) == 1 and len(methods) == 1):
        ap.error("--diff 只比较两个响应：给正好两个 -p/--path，一个 --method，一个 payload")
    only = set(x.strip() for x in args.only.split(",")) if args.only else None
    drop = set(x.strip() for x in args.drop.split(",")) if args.drop else set()
    hdrs = kv(args.header)
    ck = "; ".join(x.strip() for x in args.cookie) if args.cookie else ""
    if ck:
        hdrs.setdefault("Cookie", ck)
    proxies = None if args.no_proxy else (None if args.proxy in ("", "none") else
                                          {"http": args.proxy, "https": args.proxy})
    sess = requests.Session()
    sess.headers["User-Agent"] = hdrs.pop("User-Agent", UA_DEFAULT)
    sess.headers.update(hdrs)
    if args.save:
        os.makedirs(args.save, exist_ok=True)

    print("# base=%s proxy=%s methods=%s paths=%d payloads=%d delay=%ss"
          % (args.base, "DIRECT" if proxies is None else args.proxy,
             "/".join(methods), len(paths), len(payloads), args.delay), flush=True)

    def sub(t):
        return t.replace("{PAY}", pay) if t else t

    diff_bodies = []
    for pay in payloads:
        for p in paths:
            url = p if p.startswith("http") else args.base + p
            url = sub(url)
            for m in methods:
                data = None if not args.data and not args.raw else (
                    kv([sub(x) for x in args.data]) if args.data else sub(args.raw))
                if (args.vs or args.vs_from) and m not in ("GET", "HEAD"):
                    if data is None:
                        data = {}
                    hsrc = (args.base + args.vs_from) if args.vs_from else url
                    hsrc = hsrc if hsrc.startswith("http") else args.base + hsrc
                    try:
                        g = sess.get(hsrc, timeout=args.timeout, verify=False, proxies=proxies)
                        gt = decode(g.content, args.charset or
                                    (g.encoding if g.encoding not in (None, "ISO-8859-1") else ""))
                        got = []
                        for hid in ("__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION",
                                    "__EVENTTARGET", "__EVENTARGUMENT", "_token", "_method",
                                    "authenticity_token"):
                            mo = (re.search(r"""name=["']%s["'][^>]*?value=["']([^"']*)["']""" % hid, gt) or
                                  re.search(r"""value=["']([^"']*)["'][^>]*?name=["']%s["']""" % hid, gt))
                            if mo and hid not in data:
                                data[hid] = mo.group(1)
                                got.append(hid)
                        print("  vs-harvest %s: %s" % (hsrc, ",".join(got) or "NOTHING"), flush=True)
                    except Exception as e:
                        print("  vs-harvest FAIL %s %s" % (hsrc, type(e).__name__), flush=True)
                    time.sleep(args.delay)
                last = None
                for attempt in range(max(1, args.retries + 1)):
                    try:
                        t0 = time.time()
                        r = sess.request(m, url, data=data, timeout=args.timeout,
                                         allow_redirects=args.follow, verify=False, proxies=proxies)
                        break
                    except Exception as e:
                        last = e
                        r = None
                        time.sleep(0.4)
                el = time.time() - t0
                if r is None:
                    print("%sFAIL %-40s %s" % (tagpre(args), url, type(last).__name__), flush=True)
                    continue
                code = str(r.status_code)
                if only and code not in only:
                    continue
                if not only and code in drop:
                    continue
                if args.min_time and el < args.min_time:
                    continue
                body = decode(r.content, args.charset or (r.encoding if r.encoding not in (None, "ISO-8859-1") else ""))
                if args.diff:
                    diff_bodies.append((url, body))
                ct = r.headers.get("Content-Type", "")
                loc = r.headers.get("Location", "")
                alw = r.headers.get("Allow", "") or r.headers.get("Public", "")
                title = ""
                if args.title:
                    mt = re.search(r"(?is)<title[^>]*>(.*?)</title>", body)
                    title = re.sub(r"\s+", " ", mt.group(1)).strip()[:70] if mt else ""
                rec = {"method": m, "url": url, "status": r.status_code, "bytes": len(r.content),
                       "secs": round(el, 3), "type": ct, "loc": loc, "allow": alw, "title": title,
                       "payload": pay or None}
                if args.json:
                    print(json.dumps(rec, ensure_ascii=False), flush=True)
                else:
                    line = "%s%-6s %-52s %s len=%-7s %ss" % (tagpre(args), m, url, r.status_code,
                                                             len(r.content), round(el, 2))
                    if alw:
                        line += " allow=%s" % alw
                    if loc:
                        line += " -> %s" % loc
                    if title:
                        line += " | %s" % title
                    print(line, flush=True)
                if args.headers:
                    for k, v in r.headers.items():
                        print("    %s: %s" % (k, v))
                if args.match:
                    for kw in [k for grp in args.match for k in grp.split(",") if k]:
                        for mo in re.finditer(re.escape(kw), body):
                            a = max(0, mo.start() - 90)
                            print("    [%s] ...%s..." % (kw, re.sub(r"\s+", " ", body[a:mo.end() + 200])[:300]))
                            break
                if args.raw_body:
                    print(body[:args.raw_max], flush=True)
                if args.body or args.body_full:
                    vis = re.sub(r"(?is)<(script|style).*?</\1>", " ", body)
                    vis = re.sub(r"(?s)<[^>]+>", " ", vis)
                    vis = re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n", "\n", vis))
                    print(vis if args.body_full else vis[:600], flush=True)
                if args.save and (not only or code in only):
                    stem = "%s_%s%s" % (m, url.replace(args.base, ""), (".%s" % code))
                    if args.tag:
                        stem += "_" + args.tag
                    elif pay:
                        stem += "_" + re.sub(r"[^A-Za-z0-9]", "", pay)[:24]
                    fn = re.sub(r"[^A-Za-z0-9._-]", "_", stem)
                    with open(os.path.join(args.save, fn), "w", encoding="utf-8") as fh:
                        fh.write(body)
                time.sleep(args.delay)


    if args.diff:
        if len(diff_bodies) != 2:
            print("DIFF NEEDS EXACTLY 2 RESPONSES: got %d" % len(diff_bodies), flush=True)
        else:
            (ua, ba), (ub, bb) = diff_bodies
            diff = list(difflib.unified_diff(
                ba.splitlines(), bb.splitlines(),
                fromfile=ua, tofile=ub, lineterm="",
            ))
            if not diff:
                print("# DIFF EMPTY: responses are identical", flush=True)
            else:
                for line in diff[:args.raw_max]:
                    print(line, flush=True)


def tagpre(args):
    return ("[%s] " % args.tag) if args.tag else ""


if __name__ == "__main__":
    main()
