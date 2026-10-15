import re, json
old = open('material-v1.html').read().split('\n')
oldcss = old[55:170]  # lines 56..170
OLD = '.board:is([data-v="v1"],[data-v="warm"],[data-v="graphite"])'
out = []
for ln in oldcss:
    if ln.startswith('.world') or ln.startswith('.edges'): continue
    ln = ln.replace('aspect-ratio: 780 / 600; ', '').replace('.head-fill', '.ahead')
    ln = ln.replace('.board:not([data-v="v1"])', '.board:is([data-v="warm"],[data-v="graphite"])')
    if ln.startswith('.') and not ln.startswith('.board'):
        # 每个逗号分隔的选择器都加前缀
        sel, rest = ln.split('{', 1)
        sels = [s.strip() for s in re.split(r',(?![^(]*\))', sel)]
        ln = ', '.join(f'{OLD} {s}' for s in sels) + ' {' + rest
    out.append(ln)
css = '.board { --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; --serif: "Source Serif 4", "Songti SC", "Noto Serif SC", Georgia, serif; }\n' + '\n'.join(out) + '\n' + OLD + ' .toast { transform: none; }'
def scope(name, v):
    return open(name).read().replace(f'.s-{ {"draft":"draft","soft":"soft","color":"color","art":"art"}[v] }', f'.board[data-v="{v}"]')
for f, v in [('drafting.css', 'draft'), ('soft.css', 'soft'), ('color.css', 'color'), ('art.css', 'art')]:
    css += '\n' + open(f).read().replace(f'.s-{v}', f'.board[data-v="{v}"]')

NOTES = {
 'v1': '<h2>v1 现状</h2><p>整体干净，但材质偏「网页 div」：实线边框、同一种阴影、强调色用得太多。</p>',
 'warm': '<h2>暖墨 · 已选定</h2><p>延续 v1 的暖灰和陶土色，把材质做实：0.5px 发丝线加三层阴影，工具条磨砂半透明，强调色只留给「选中」和「箭头出发的那一行」。</p>',
 'graphite': '<h2>石墨</h2><p>中性灰，强调色跟随 VS Code 的 focus 颜色，和编辑器融为一体，最接近原生 macOS app。</p>',
 'draft': '''<h2>制图</h2><p>参考 Merit 的唇笔图纸。只有墨和线，没有颜色、阴影和圆角。</p><ul>
<li><b>箭头</b>走直角虚线，像标注引线；起点是代码行右侧的小方块。</li>
<li><b>行号区间</b>画成尺寸线（卡片左侧的 L49–55）。</li>
<li><b>便签</b>是细节标注框，用点线引到某一行。</li>
<li><b>新版本</b>是实心方块，旧版本是空心方块。</li>
<li><b>选中</b>是外面再套一圈虚线框。</li></ul>
<h3>取舍</h3><ul><li>最安静，截图放进文档最好看。</li><li>没有颜色，卡片一多，状态不容易一眼看到。</li><li>缩小后 1px 细线会发虚，要按缩放加粗。</li></ul>''',
 'soft': '''<h2>柔光</h2><p>参考白色手表商店那张：大留白、细字重、大面积柔和投影，珊瑚色只用在一个圆按钮和几个小点上。</p><ul>
<li><b>代码</b>放在卡片里一块下沉的凹槽中，这是「拟物」的部分。</li>
<li><b>白板列表</b>做成左侧竖排的标签栏，当前白板下面一条珊瑚短线。</li>
<li><b>讲解</b>是右下角的珊瑚色圆形按钮。</li>
<li><b>新版本</b>是一颗珊瑚色小圆点，像购物车角标。</li></ul>
<h3>取舍</h3><ul><li>最「产品化」，演示时很体面。</li><li>大投影和大圆角很占地方，半宽 webview 里卡片之间要拉得更开。</li><li>深色主题下拟物感会弱很多。</li></ul>''',
 'color': '''<h2>多彩卡片</h2><p>参考 Marigold：奶油底、2px 墨线、直角，颜色成块使用。</p><ul>
<li><b>每个源文件一种颜色</b>：llm_engine 橙、scheduler 黄、model_runner 青，卡片顶部是这块颜色加一个小图形和大号编号。</li>
<li><b>卡片头</b>分成格子：步骤号、文件名、版本状态；底部格子放行号区间和「跟进到最新」。</li>
<li><b>斜体衬线</b>那一行是卡片的一句话说明，相当于标题下的批注。</li>
<li><b>讲解进度</b>是右上角的小方格，走到哪一步就填哪一格。</li>
<li><b>选中</b>是右下方的实心偏移投影。</li></ul>
<h3>取舍</h3><ul><li>辨识度最高，一眼分清哪张卡来自哪个文件。</li><li>颜色块占高度，卡片一多会很热闹；文件超过 6–8 个时颜色要复用。</li></ul>''',
 'art': '''<h2>艺术</h2><p>参考 Severance 晚宴海报：薄荷纸、深绿油墨、双线框、居中排版、字距拉得很开。</p><ul>
<li><b>白板</b>四周有双线边框，背景是很淡的方格纸（这是风格的一部分，可以去掉）。</li>
<li><b>卡片头</b>居中：编号和文件名、衬线大标题、文件 / 行 / 提交三栏信息。</li>
<li><b>图注</b>写在卡片下方，像插图编号：FIG. 1.1 — THE BATCH IS CHOSEN。</li>
<li><b>工具条</b>是一条深绿色色带，按钮是字距拉开的文字。</li></ul>
<h3>取舍</h3><ul><li>最有个性，截图分享最好看。</li><li>头部很高，同样大小的白板能放的代码最少。</li><li>双线和网格缩小后会变成噪点。</li></ul>''',
}
VCFG = {
 'v1': {'head': 'triangle'}, 'warm': {}, 'graphite': {},
 'draft': {'route': 'elbow', 'head': 'triangle', 'port': 'square', 'gap': 150},
 'soft': {'head': 'dot', 'gap': 150, 'pad': {'l': 84, 'r': 28, 't': 96, 'b': 84}},
 'color': {'head': 'triangle', 'gap': 150},
 'art': {'port': 'diamond', 'gap': 150, 'pad': {'l': 44, 'r': 44, 't': 100, 'b': 84}},
}
draftjs = open('drafting.js').read().replace('function decorate(cards, world) {\n  world.querySelectorAll(\'.dim, .callout\').forEach(n => n.remove());', 'function drafting(cards, world) {')
js = draftjs + f'''
function decorate(cards, world) {{ world.querySelectorAll('.dim, .callout').forEach(n => n.remove()); if (board.dataset.v === 'draft') drafting(cards, world); }}
const BASECFG = Object.assign({{}}, CFG), VCFG = {json.dumps(VCFG)}, NOTES = {json.dumps(NOTES, ensure_ascii=False)};
function setV(v) {{
  board.dataset.v = v; CFG = Object.assign({{}}, BASECFG, VCFG[v]);
  document.querySelectorAll('#segV button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === v));
  document.getElementById('notes').innerHTML = NOTES[v] + '<p class="tip">切换深浅主题看两边是否都成立。所有风格用的是同一份白板数据。</p>';
  render();
}}
document.getElementById('segV').addEventListener('click', e => {{ const b = e.target.closest('button'); if (b) setV(b.dataset.v); }});
setV('warm');
'''
seg = '''<div class="ctl">版本
      <div class="seg" id="segV" role="group" aria-label="版本">
        <button id="v-v1" data-v="v1">v1</button><button id="v-warm" data-v="warm">暖墨</button><button id="v-graphite" data-v="graphite">石墨</button><button id="v-draft" data-v="draft">制图</button><button id="v-soft" data-v="soft">柔光</button><button id="v-color" data-v="color">多彩</button><button id="v-art" data-v="art">艺术</button>
      </div>
    </div>
    <div class="ctl">主题'''
o = open('base.html').read()
fonts = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,600&family=DM+Mono:wght@400;500&family=Archivo:wght@500;600&family=Jost:wght@300;400;500;600&family=Fraunces:ital,wght@1,400&family=IBM+Plex+Mono:wght@400;500;600&family=Marcellus&display=swap'
for a, b in [('%%TITLE%%', 'CodeBoard 材质'), ('%%FONTS%%', fonts), ('%%CSS%%', css + '\n.notes .tip { font-size: 12px; border-top: .5px solid var(--page-hair); padding-top: 12px; }'),
             ('%%H1%%', '白板材质对照'), ('%%SUB%%', '同一块白板、同一份数据，只换材质。左边模拟 VS Code 里的 webview。'),
             ('class="board %%BOARDCLASS%%"', 'class="board" data-v="warm"'), ('%%EYEBROW%%', 'NANO-VLLM · ENGINE'), ('%%NOTES%%', ''),
             ('const CFG = Object.assign(', 'let CFG = Object.assign('), ('%%CFG%%', '{}'), ('%%JS%%', js), ('<div class="ctl">主题', seg)]:
    assert a in o, a; o = o.replace(a, b)
o = o.replace('render();\ndocument.fonts', 'document.fonts')
open('../material.html', 'w').write(o)
print('ok')
