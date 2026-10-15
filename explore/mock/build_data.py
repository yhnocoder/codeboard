"""Build data for the CodeBoard interactive mock.

Reads the real nano-vllm source (examples/nano-vllm/nanovllm, commit bb823b3) with `ast`
and writes:
  data.js    window.NV = {...}  (files, symbols, call sites, definition sites, arg/param mapping)
  mock.html  index.html with data.js inlined (the single self-contained file that gets published)

Run:  python3 -I build_data.py
"""
import ast
import builtins
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', 'examples', 'nano-vllm', 'nanovllm'))
COMMIT = 'bb823b3'
BUILTINS = set(dir(builtins)) | {'self', 'cls'}

# ---------------------------------------------------------------- load
files, trees = {}, {}
for dp, _, fns in os.walk(ROOT):
    for fn in sorted(fns):
        if fn.endswith('.py'):
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
            src = open(full, encoding='utf-8').read()
            files[rel] = src.split('\n')
            if files[rel] and files[rel][-1] == '':
                files[rel].pop()
            trees[rel] = ast.parse(src)
files = dict(sorted(files.items()))


def modname(rel):
    m = 'nanovllm.' + rel[:-3].replace('/', '.')
    return m[:-9] if m.endswith('.__init__') else m


MOD2FILE = {modname(r): r for r in files}


def ch(f, line, bcol):
    """byte column -> character column"""
    t = files[f][line - 1]
    return len(t.encode('utf-8')[:bcol].decode('utf-8', 'ignore'))


# ---------------------------------------------------------------- pass 1: symbols
syms = {}            # id -> dict
mod_defs = {}        # file -> name -> ('sym', id) | ('line', line) | ('imp', module, name) | ('ext', module)
classes = {}         # class name -> sym id (names are unique in nano-vllm)
class_info = {}      # sym id -> {bases, methods{name:id}, attrs{name:[(line, method)]}, ann{name:node}, fields{name:line}}
func_nodes = {}      # sym id -> (file, node, class id)


def sym_range(node):
    s = min([node.lineno] + [d.lineno for d in getattr(node, 'decorator_list', [])])
    return s, node.end_lineno


def docrange(node):
    b = getattr(node, 'body', None)
    if b and isinstance(b[0], ast.Expr) and isinstance(b[0].value, ast.Constant) and isinstance(b[0].value.value, str):
        return [b[0].lineno, b[0].end_lineno]
    return None


for f, tree in trees.items():
    md = mod_defs.setdefault(f, {})
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names:
                nm = (a.asname or a.name).split('.')[0]
                if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith('nanovllm'):
                    md[nm] = ('imp', node.module, a.name, node.lineno)
                elif isinstance(node, ast.ImportFrom):
                    md[nm] = ('ext', node.module or '', node.lineno)
                else:
                    md[nm] = ('ext', a.name, node.lineno)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            sid = f'{f}::{node.name}'
            s, e = sym_range(node)
            syms[sid] = dict(q=node.name, n=node.name, k='f', f=f, s=s, e=e, dl=node.lineno, d=docrange(node))
            md[node.name] = ('sym', sid)
            func_nodes[sid] = (f, node, None)
        elif isinstance(node, ast.ClassDef):
            cid = f'{f}::{node.name}'
            s, e = sym_range(node)
            syms[cid] = dict(q=node.name, n=node.name, k='c', f=f, s=s, e=e, dl=node.lineno, d=docrange(node))
            md[node.name] = ('sym', cid)
            classes[node.name] = cid
            info = class_info[cid] = dict(bases=[b.id if isinstance(b, ast.Name) else ast.unparse(b) for b in node.bases],
                                          methods={}, attrs={}, ann={}, fields={}, node=node, f=f)
            for it in node.body:
                if isinstance(it, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    mid = f'{f}::{node.name}.{it.name}'
                    s2, e2 = sym_range(it)
                    syms[mid] = dict(q=f'{node.name}.{it.name}', n=it.name, k='m', f=f, s=s2, e=e2, dl=it.lineno, d=docrange(it), cls=cid)
                    info['methods'][it.name] = mid
                    func_nodes[mid] = (f, it, cid)
                elif isinstance(it, ast.AnnAssign) and isinstance(it.target, ast.Name):
                    info['fields'][it.target.id] = it.lineno
                    info['ann'][it.target.id] = it.annotation
                elif isinstance(it, ast.Assign):
                    for t in it.targets:
                        if isinstance(t, ast.Name):
                            info['fields'][t.id] = it.lineno
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            tg = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in tg:
                if isinstance(t, ast.Name):
                    md[t.id] = ('line', node.lineno)


def resolve_import(module, name):
    f = MOD2FILE.get(module)
    if not f:
        return None
    d = mod_defs[f].get(name)
    if not d:
        return None
    if d[0] == 'imp':
        return resolve_import(d[1], d[2])
    if d[0] == 'sym':
        return ('sym', d[1])
    if d[0] == 'line':
        return ('at', f, d[1])
    return None


def mod_lookup(f, name):
    """What a module-level name means in file f: ('sym', id) | ('at', file, line) | ('ext', module, line) | None"""
    d = mod_defs[f].get(name)
    if not d:
        return None
    if d[0] == 'sym':
        return d
    if d[0] == 'line':
        return ('at', f, d[1])
    if d[0] == 'imp':
        r = resolve_import(d[1], d[2])
        return r or ('ext', d[1], d[3])
    if d[0] == 'ext':
        return ('ext', d[1], d[2])


def class_chain(cid):
    seen, out = set(), []
    while cid and cid not in seen:
        seen.add(cid)
        out.append(cid)
        bases = class_info[cid]['bases']
        nxt = None
        for b in bases:
            r = mod_lookup(class_info[cid]['f'], b)
            if r and r[0] == 'sym' and r[1] in class_info:
                nxt = r[1]
                break
        cid = nxt
    return out


def find_method(cid, name):
    for c in class_chain(cid):
        m = class_info[c]['methods'].get(name)
        if m:
            return m
    return None


# ---------------------------------------------------------------- types
def ann_type(f, a):
    """annotation -> ('C', cid) | ('L', cid) | None"""
    if a is None:
        return None
    if isinstance(a, ast.BinOp):  # X | None
        return ann_type(f, a.left) or ann_type(f, a.right)
    if isinstance(a, ast.Name):
        r = mod_lookup(f, a.id)
        if r and r[0] == 'sym' and r[1] in class_info:
            return ('C', r[1])
        return None
    if isinstance(a, ast.Subscript) and isinstance(a.value, ast.Name) and a.value.id == 'tuple' and isinstance(a.slice, ast.Tuple):
        return ('U', [ann_type(f, x) for x in a.slice.elts])
    if isinstance(a, ast.Subscript) and isinstance(a.value, ast.Name) and a.value.id in ('list', 'deque', 'set', 'tuple'):
        inner = ann_type(f, a.slice if not isinstance(a.slice, ast.Tuple) else a.slice.elts[0])
        if inner and inner[0] == 'C':
            return ('L', inner[1])
    return None


class Env:
    """Bindings of one function: name -> list of (line, col, type)."""

    def __init__(self, f, node, cid):
        self.f, self.node, self.cid = f, node, cid
        self.b = {}
        self.params = {}
        a = node.args
        allargs = a.posonlyargs + a.args + a.kwonlyargs + ([a.vararg] if a.vararg else []) + ([a.kwarg] if a.kwarg else [])
        for p in allargs:
            t = ann_type(f, p.annotation)
            self.params[p.arg] = (p.lineno, ch(f, p.lineno, p.col_offset), t)
        self.order = []

    def add(self, name, line, col, t):
        self.b.setdefault(name, []).append((line, col, t))

    def type_of_name(self, name, line=None):
        if name in self.b:
            prev = [x for x in self.b[name] if line is None or x[0] <= line]
            for x in reversed(prev or self.b[name]):
                if x[2]:
                    return x[2]
        if name in self.params:
            return self.params[name][2]
        return None


ATTR_TYPES = {}   # cid -> attr -> type


def attr_type(cid, name):
    for c in class_chain(cid):
        t = ATTR_TYPES.get(c, {}).get(name)
        if t:
            return t
        a = class_info[c]['ann'].get(name)
        if a is not None:
            t = ann_type(class_info[c]['f'], a)
            if t:
                return t
    return None


def type_of(e, env, line=None):
    if isinstance(e, ast.Name):
        if e.id == 'self' and env.cid:
            return ('C', env.cid)
        t = env.type_of_name(e.id, line)
        if t:
            return t
        r = mod_lookup(env.f, e.id)
        if r and r[0] == 'sym' and r[1] in class_info:
            return ('T', r[1])
        return None
    if isinstance(e, ast.Attribute):
        rt = type_of(e.value, env, line)
        if rt and rt[0] == 'C':
            return attr_type(rt[1], e.attr)
        return None
    if isinstance(e, ast.Call):
        fn = e.func
        ft = type_of(fn, env, line)
        if ft and ft[0] == 'T':
            return ('C', ft[1])
        if isinstance(fn, ast.Attribute):
            rt = type_of(fn.value, env, line)
            if rt and rt[0] == 'L' and fn.attr in ('pop', 'popleft', '__getitem__'):
                return ('C', rt[1])
            if rt and rt[0] == 'C':
                m = find_method(rt[1], fn.attr)
                if m:
                    node = func_nodes[m][1]
                    return ann_type(func_nodes[m][0], node.returns)
        if isinstance(fn, ast.Name) and fn.id in ('list', 'deque', 'sorted', 'reversed'):
            if e.args:
                t = type_of(e.args[0], env, line)
                if t and t[0] == 'L':
                    return t
        if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name) and fn.value.id == 'nn' and fn.attr == 'ModuleList' and e.args:
            return type_of(e.args[0], env, line)
        return None
    if isinstance(e, ast.Subscript):
        rt = type_of(e.value, env, line)
        if rt and rt[0] == 'L' and not isinstance(e.slice, ast.Slice):
            return ('C', rt[1])
        return None
    if isinstance(e, (ast.ListComp, ast.GeneratorExp)):
        t = type_of(e.elt, env, line)
        if t and t[0] == 'C':
            return ('L', t[1])
        return None
    if isinstance(e, ast.List) and e.elts:
        t = type_of(e.elts[0], env, line)
        if t and t[0] == 'C':
            return ('L', t[1])
    if isinstance(e, ast.IfExp):
        return type_of(e.body, env, line) or type_of(e.orelse, env, line)
    return None


def elem_type(t):
    if t and t[0] == 'L':
        return ('C', t[1])
    return None


def bind_target(env, tgt, t, line_hint=None, iter_expr=None):
    if isinstance(tgt, ast.Name):
        env.add(tgt.id, tgt.lineno, ch(env.f, tgt.lineno, tgt.col_offset), t)
    elif isinstance(tgt, (ast.Tuple, ast.List)):
        sub = [None] * len(tgt.elts)
        if t and t[0] == 'U':
            sub = list(t[1]) + [None] * len(tgt.elts)
        if iter_expr is not None and isinstance(iter_expr, ast.Call) and isinstance(iter_expr.func, ast.Name) and iter_expr.func.id == 'zip':
            sub = [elem_type(type_of(a, env)) for a in iter_expr.args] + [None] * len(tgt.elts)
        for i, el in enumerate(tgt.elts):
            bind_target(env, el, sub[i] if i < len(sub) else None)
    elif isinstance(tgt, ast.Starred):
        bind_target(env, tgt.value, None)


def walk_no_nested(node):
    """ast.walk without descending into nested function/class defs."""
    todo = list(ast.iter_child_nodes(node))
    while todo:
        n = todo.pop(0)
        yield n
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        todo.extend(ast.iter_child_nodes(n))


def build_env(sid):
    f, node, cid = func_nodes[sid]
    env = Env(f, node, cid)
    stmts = sorted([n for n in walk_no_nested(node) if hasattr(n, 'lineno') or isinstance(n, ast.comprehension)],
                   key=lambda n: (getattr(n, 'lineno', 0) or getattr(getattr(n, 'target', None), 'lineno', 0)))
    for n in stmts:
        if isinstance(n, ast.Assign):
            t = type_of(n.value, env, n.lineno)
            v = n.value
            if isinstance(v, ast.Call) and isinstance(v.func, ast.Name) and v.func.id == 'getattr' and len(v.args) >= 2 \
                    and isinstance(v.args[1], ast.Constant) and isinstance(v.args[1].value, str) and isinstance(n.targets[0], ast.Name):
                cands = [m for c in class_info.values() for nm, m in c['methods'].items() if nm == v.args[1].value]
                if len(v.args) > 2 and isinstance(v.args[2], ast.Name):
                    r = mod_lookup(f, v.args[2].id)
                    if r and r[0] == 'sym':
                        cands.append(r[1])
                if cands:
                    GETATTR.setdefault((f, n.targets[0].id), []).append((n.lineno, cands))
            for tg in n.targets:
                bind_target(env, tg, t)
        elif isinstance(n, ast.AnnAssign):
            bind_target(env, n.target, ann_type(f, n.annotation) or (type_of(n.value, env) if n.value else None))
        elif isinstance(n, ast.AugAssign):
            bind_target(env, n.target, None)
        elif isinstance(n, (ast.For, ast.AsyncFor)):
            bind_target(env, n.target, elem_type(type_of(n.iter, env, n.lineno)), iter_expr=n.iter)
        elif isinstance(n, ast.comprehension):
            bind_target(env, n.target, elem_type(type_of(n.iter, env)), iter_expr=n.iter)
        elif isinstance(n, ast.withitem) and n.optional_vars is not None:
            bind_target(env, n.optional_vars, None)
        elif isinstance(n, ast.NamedExpr):
            bind_target(env, n.target, type_of(n.value, env))
        elif isinstance(n, ast.ExceptHandler) and n.name:
            env.add(n.name, n.lineno, 0, None)
    return env


ENVS = {}
GETATTR = {}
# two rounds: attribute types of self.x feed back into envs
for _ in range(3):
    ENVS = {sid: build_env(sid) for sid in func_nodes}
    for sid, (f, node, cid) in func_nodes.items():
        if not cid:
            continue
        env = ENVS[sid]
        for n in walk_no_nested(node):
            tgs = []
            if isinstance(n, ast.Assign):
                tgs = [(t, n.value, None) for t in n.targets]
            elif isinstance(n, ast.AnnAssign):
                tgs = [(n.target, n.value, n.annotation)]
            for t, v, a in tgs:
                if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == 'self':
                    ty = ann_type(f, a) if a is not None else None
                    ty = ty or (type_of(v, env, n.lineno) if v is not None else None)
                    if ty:
                        ATTR_TYPES.setdefault(cid, {})[t.attr] = ty
                    if _ == 0:
                        lst = class_info[cid]['attrs'].setdefault(t.attr, [])
                        if (n.lineno, syms[sid]['n']) not in lst:
                            lst.append((n.lineno, syms[sid]['n']))

# ---------------------------------------------------------------- pass 2: call sites, definition sites
calls = {}    # f -> line -> [[c0, c1, [targets], args, loop]]
peek = {}     # f -> line -> [[c0, c1, targets]]
follow = {}   # f -> line -> [file, line, label]
METHOD_NAMES = {}
for cid, info in class_info.items():
    for nm, mid in info['methods'].items():
        METHOD_NAMES.setdefault(nm, []).append(mid)
COMMON = {'append', 'extend', 'pop', 'popleft', 'update', 'get', 'items', 'keys', 'values', 'add', 'remove', 'clear',
          'copy', 'set', 'wait', 'join', 'start', 'close', 'tolist', 'size', 'view', 'reset', 'forward', '__init__'}


def put(d, f, line, val):
    d.setdefault(f, {}).setdefault(str(line), []).append(val)


def callable_target(t):
    """type ('T', cid) called -> constructor; ('C', cid) called -> forward / __call__"""
    if not t:
        return []
    if t[0] == 'T':
        m = find_method(t[1], '__init__')
        return [m] if m else [t[1]]
    if t[0] == 'C':
        m = find_method(t[1], 'forward') or find_method(t[1], '__call__')
        return [m] if m else []
    return []


def resolve_call(fn, env, line):
    if isinstance(fn, ast.Name):
        if fn.id in env.b or fn.id in env.params:
            ga = [c for l, c in GETATTR.get((env.f, fn.id), []) if l <= line]
            if ga:
                return ga[-1]
            return callable_target(env.type_of_name(fn.id, line))
        r = mod_lookup(env.f, fn.id)
        if r and r[0] == 'sym':
            if r[1] in class_info:
                return callable_target(('T', r[1]))
            return [r[1]]
        return []
    if isinstance(fn, ast.Attribute):
        rv = fn.value
        if isinstance(rv, ast.Call) and isinstance(rv.func, ast.Name) and rv.func.id == 'super' and env.cid:
            ch_ = class_chain(env.cid)
            for c in ch_[1:]:
                m = class_info[c]['methods'].get(fn.attr)
                if m:
                    return [m]
            return []
        rt = type_of(rv, env, line)
        if rt and rt[0] in ('C', 'T'):
            m = find_method(rt[1], fn.attr)
            if m:
                return [m]
            at = attr_type(rt[1], fn.attr) if rt[0] == 'C' else None
            return callable_target(at)
        if rt is None and fn.attr not in COMMON and isinstance(rv, ast.Name) and rv.id not in mod_defs[env.f]:
            c = METHOD_NAMES.get(fn.attr, [])
            if 2 <= len(c) <= 6:
                return list(c)
        return []
    return []


def def_targets_name(n, env, line):
    name = n.id
    if name in env.b:
        sites = env.b[name]
        prev = [s for s in sites if s[0] < line or (s[0] == line and s[1] < ch(env.f, n.lineno, n.col_offset))]
        same = [s for s in sites if s[0] == line]
        pick = [same[0]] if same else [prev[-1]] if prev else sites
        out = []
        for s in pick:
            if [env.f, s[0]] not in out:
                out.append([env.f, s[0]])
        return out
    if name in env.params:
        return [[env.f, env.params[name][0]]]
    r = mod_lookup(env.f, name)
    if not r:
        return None if name in BUILTINS else []
    if r[0] == 'sym':
        s = syms[r[1]]
        return [[s['f'], s['dl']]]
    if r[0] == 'at':
        return [[r[1], r[2]]]
    if r[0] == 'ext':
        return 'ext:' + r[1]


def attr_sites(cid, name):
    for c in class_chain(cid):
        info = class_info[c]
        if name in info['methods']:
            s = syms[info['methods'][name]]
            return [[s['f'], s['dl']]]
        if name in info['fields']:
            return [[info['f'], info['fields'][name]]]
        if name in info['attrs']:
            lst = sorted(info['attrs'][name], key=lambda x: (x[1] != '__init__', x[0]))
            return [[info['f'], l] for l, _ in lst][:4]
    return None


def def_targets_attr(n, env, line):
    rv = n.value
    rt = type_of(rv, env, line)
    if rt and rt[0] in ('C', 'T'):
        r = attr_sites(rt[1], n.attr)
        if r:
            return r
        return []
    if rt and rt[0] == 'L':
        return None
    # receiver is an external module / object
    root = rv
    while isinstance(root, ast.Attribute):
        root = root.value
    if isinstance(root, ast.Name):
        r = None if (root.id in env.b or root.id in env.params) else mod_lookup(env.f, root.id)
        if r and r[0] == 'ext':
            return 'ext:' + r[1]
    return []


def literal_seg(f, node):
    try:
        return ast.get_source_segment('\n'.join(files[f]), node)
    except Exception:
        return None


def call_args(c, target, env, f, parent_assign):
    """Variable candidates for a Call link: arg <-> param, plus return target."""
    out = {'a': []}
    if target in func_nodes:
        tnode = func_nodes[target][1]
        params = [p.arg for p in tnode.args.posonlyargs + tnode.args.args]
        if params and params[0] in ('self', 'cls') and (func_nodes[target][2] is not None):
            params = params[1:]
        vararg = tnode.args.vararg is not None
        stopped = False
        for i, a in enumerate(c.args):
            if isinstance(a, ast.Starred):
                stopped = True
            if stopped or i >= len(params):
                break
            if isinstance(a, ast.Constant):
                continue
            seg = literal_seg(f, a)
            if seg is None or '\n' in seg or len(seg) > 40:
                continue
            out['a'].append([seg, params[i], a.lineno, ch(f, a.lineno, a.col_offset), ch(f, a.end_lineno, a.end_col_offset)])
        kwp = set(p.arg for p in tnode.args.args + tnode.args.kwonlyargs)
        for k in c.keywords:
            if k.arg and k.arg in kwp and not isinstance(k.value, ast.Constant):
                seg = literal_seg(f, k.value)
                if seg and '\n' not in seg and len(seg) <= 40:
                    out['a'].append([seg, k.arg, k.value.lineno, ch(f, k.value.lineno, k.value.col_offset), ch(f, k.value.end_lineno, k.value.end_col_offset)])
        if vararg and stopped:
            out['va'] = 1
    if parent_assign is not None:
        tg = parent_assign.targets[0] if isinstance(parent_assign, ast.Assign) else parent_assign.target
        seg = literal_seg(f, tg)
        if seg and '\n' not in seg:
            out['r'] = seg
    return out


for sid, (f, node, cid) in func_nodes.items():
    env = ENVS[sid]
    # parents map for assignment / loop detection
    parent = {}
    for p in ast.walk(node):
        for chn in ast.iter_child_nodes(p):
            parent[chn] = p
    nested = set()
    for n in walk_no_nested(node):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            for x in ast.walk(n):
                nested.add(x)

    def in_loop(n):
        p = parent.get(n)
        while p is not None and p is not node:
            if isinstance(p, (ast.For, ast.While, ast.AsyncFor)):
                return True
            p = parent.get(p)
        return False

    def assign_of(c):
        p, cur = parent.get(c), c
        while isinstance(p, ast.IfExp) and cur is not p.test:
            p, cur = parent.get(p), p
        if isinstance(p, (ast.Assign, ast.AnnAssign)) and p.value is cur:
            return p
        return None

    for n in ast.walk(node):
        if n in nested or n is node:
            continue
        if isinstance(n, ast.Call):
            fn = n.func
            if isinstance(fn, ast.Name):
                l, c0 = fn.lineno, ch(f, fn.lineno, fn.col_offset)
                c1 = c0 + len(fn.id)
            elif isinstance(fn, ast.Attribute):
                l = fn.end_lineno
                c1 = ch(f, l, fn.end_col_offset)
                c0 = c1 - len(fn.attr)
            else:
                continue
            tg = resolve_call(fn, env, n.lineno)
            tg = [t for t in tg if t in syms]
            if not tg:
                continue
            args = call_args(n, tg[0], env, f, assign_of(n)) if len(tg) == 1 else {'a': []}
            put(calls, f, l, [c0, c1, tg, args, 1 if in_loop(n) else 0])
        elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
            if n.id in ('self', 'cls'):
                continue
            t = def_targets_name(n, env, n.lineno)
            if t is None:
                continue
            c0 = ch(f, n.lineno, n.col_offset)
            put(peek, f, n.lineno, [c0, c0 + len(n.id), t])
        elif isinstance(n, ast.Attribute):
            l = n.end_lineno
            c1 = ch(f, l, n.end_col_offset)
            c0 = c1 - len(n.attr)
            if files[f][l - 1][c0:c1] != n.attr:
                continue
            t = def_targets_attr(n, env, n.lineno)
            if t is None or (isinstance(n.ctx, ast.Store) and not t):
                continue
            put(peek, f, l, [c0, c1, t])
        # follow: assignment line whose value is a resolvable name / attribute / call
        if isinstance(n, (ast.Assign, ast.AnnAssign)) and n.value is not None:
            v = n.value
            tgt = None
            if isinstance(v, ast.Attribute):
                tgt = def_targets_attr(v, env, n.lineno)
            elif isinstance(v, ast.Name):
                tgt = def_targets_name(v, env, n.lineno)
            elif isinstance(v, ast.Call):
                r = resolve_call(v.func, env, n.lineno)
                r = [x for x in r if x in syms]
                if len(r) == 1:
                    tgt = [[syms[r[0]]['f'], syms[r[0]]['dl']]]
            if isinstance(tgt, list) and len(tgt) == 1 and tgt[0] != [f, n.lineno]:
                seg = literal_seg(f, v)
                if seg and '\n' not in seg:
                    if len(seg) > 48:
                        seg = seg[:46] + '…'
                    follow.setdefault(f, {})[str(n.lineno)] = [tgt[0][0], tgt[0][1], seg]

# also definition sites for dataclass field defaults etc are just lines; nothing more needed.

for d in (calls, peek):
    for f in d:
        for l in d[f]:
            d[f][l].sort(key=lambda x: x[0])
            # dedupe identical ranges (e.g. Attribute and Name sharing a col)
            seen, out = set(), []
            for x in d[f][l]:
                k = (x[0], x[1])
                if k not in seen:
                    seen.add(k)
                    out.append(x)
            d[f][l] = out

# symbol map: drop internal-only keys
sym_out = {}
for k, v in syms.items():
    o = {kk: vv for kk, vv in v.items()}
    if v['k'] == 'c':
        o['m'] = list(class_info[k]['methods'].values())
    sym_out[k] = o

NV = dict(commit=COMMIT, lang='Python', root='nanovllm', files=files, syms=sym_out, calls=calls, peek=peek, follow=follow)
js = 'window.NV = ' + json.dumps(NV, ensure_ascii=False, separators=(',', ':')) + ';\n'
open(os.path.join(HERE, 'data.js'), 'w', encoding='utf-8').write(js)

# ---------------------------------------------------------------- inline into mock.html
idx = open(os.path.join(HERE, 'index.html'), encoding='utf-8').read() if os.path.exists(os.path.join(HERE, 'index.html')) else None
if idx:
    tag = '<script src="data.js"></script>'
    assert tag in idx, 'index.html must load data.js'
    out = idx.replace(tag, '<script>\n' + js.replace('</', '<\\/') + '</script>')
    open(os.path.join(HERE, 'mock.html'), 'w', encoding='utf-8').write(out)

ncalls = sum(len(v) for f in calls.values() for v in f.values())
npeek = sum(len(v) for f in peek.values() for v in f.values())
print(f'{len(files)} files, {len(syms)} symbols, {ncalls} call sites, {npeek} identifier sites, {len(js)//1024} KB data.js'
      + (f', mock.html {len(out)//1024} KB' if idx else ''))
