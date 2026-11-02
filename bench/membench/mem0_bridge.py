"""mem0 开源版的桥（记忆基准的对照系统之一，见 docs/benchmark.md）。

由 bench/membench/systems.ts 以子进程启动，按行收发 JSON：
  {"op": "add", "date": "2026-08-02", "messages": [{"role": "user"|"assistant", "content": "..."}]}  → {"ok": true}
  {"op": "search", "query": "...", "k": 10}  → {"ok": true, "memories": [{"memory": "...", "date": "..."}]}
  {"op": "spent"}  → {"ok": true, "dev_today": 1.23 | null}   可选：今天累计花费（元），用来算 mem0 建记忆花了多少；
                     没配 MEM0_STATUS 时回 null，建记忆花费记为 0（答题花费照常计数）
配置（环境变量）：
  MEM0_LLM_BASE   任意 OpenAI 兼容接口地址（含 /v1），如 https://api.example.com/v1
  BENCH_API_KEY   模型 API key（只在内存里）
  MEM0_STATUS     可选：返回 JSON 用量的接口地址（用同一个 key 访问），读其中的 dev.today.all；不配就不统计建记忆花费
  MEM0_EMBED      本地向量模型（默认 intfloat/multilingual-e5-small，中英都能用；DeepSeek 没有向量接口）
  MEM0_DIR        这次运行的临时目录（向量库、历史库）
  MEM0_MODEL      默认 deepseek-flash
不打印 key；stdout 只用来回 JSON，其余日志走 stderr。
"""
import json, os, sys, urllib.request

os.environ.setdefault('MEM0_TELEMETRY', 'False')
os.environ.setdefault('ANONYMIZED_TELEMETRY', 'False')
from mem0 import Memory  # noqa: E402

KEY = os.environ['BENCH_API_KEY']
DIR = os.environ['MEM0_DIR']
EMBED = os.environ.get('MEM0_EMBED', 'intfloat/multilingual-e5-small')
DIMS = int(os.environ.get('MEM0_EMBED_DIMS', '384'))
os.environ['MEM0_DIR'] = DIR   # mem0 的历史库位置

config = {
    'llm': {'provider': 'deepseek', 'config': {
        'model': os.environ.get('MEM0_MODEL', 'deepseek-flash'), 'api_key': KEY,
        'deepseek_base_url': os.environ['MEM0_LLM_BASE'], 'temperature': 0.1, 'max_tokens': 2000}},
    'embedder': {'provider': 'huggingface', 'config': {'model': EMBED, 'embedding_dims': DIMS}},
    'vector_store': {'provider': 'faiss', 'config': {'collection_name': 'bench', 'path': os.path.join(DIR, 'faiss'), 'embedding_model_dims': DIMS}},
    'history_db_path': os.path.join(DIR, 'history.db'),
}
mem = Memory.from_config(config)
USER = 'owner'


def spent():
    status = os.environ.get('MEM0_STATUS')
    if not status:
        return None
    req = urllib.request.Request(status, headers={'x-api-key': KEY})
    with urllib.request.urlopen(req, timeout=20) as r:
        s = json.load(r)
    return (s.get('dev') or {}).get('today', {}).get('all', 0.0)


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        op = req.get('op')
        if op == 'add':
            mem.add(req['messages'], user_id=USER, metadata={'date': req.get('date')})
            reply({'ok': True})
        elif op == 'search':
            # mem0 2.x：search 不再收 user_id，要放进 filters（否则报错会被当成“没找到”）
            r = mem.search(req['query'], filters={'user_id': USER}, top_k=int(req.get('k', 10)))
            items = r.get('results', r) if isinstance(r, dict) else r
            reply({'ok': True, 'memories': [{'memory': x.get('memory'), 'date': (x.get('metadata') or {}).get('date')} for x in items]})
        elif op == 'spent':
            reply({'ok': True, 'dev_today': spent()})
        elif op == 'close':
            reply({'ok': True})
            break
        else:
            reply({'ok': False, 'error': 'unknown op'})
    except Exception as e:  # 只回类型和简短说明，不回请求内容
        reply({'ok': False, 'error': '%s: %s' % (type(e).__name__, str(e)[:200])})
