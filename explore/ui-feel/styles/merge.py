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
for f, v in [('drafting.css', 'draft'), ('soft.css', 'soft'), ('color.css', 'color'), ('news.css', 'news'), ('art.css', 'art'), ('bamboo.css', 'bamboo'), ('ink.css', 'ink'), ('clay.css', 'clay'), ('city.css', 'city')]:
    css += '\n' + open(f).read().replace(f'.s-{v}', f'.board[data-v="{v}"]')

NOTES = {
 'v1': '<h2>v1 现状</h2><p>整体干净，但材质偏「网页 div」：实线边框、同一种阴影、强调色用得太多。</p>',
 'warm': '<h2>暖墨 · 已选定</h2><p>延续 v1 的暖灰和陶土色，把材质做实：0.5px 发丝线加三层阴影，工具条磨砂半透明，强调色只留给「选中」和「箭头出发的那一行」。</p>',
 'graphite': '<h2>石墨</h2><p>中性灰，强调色跟随 VS Code 的 focus 颜色，和编辑器融为一体，最接近原生 macOS app。</p>',
 'draft': '''<h2>制图</h2><p>参考 Merit 的唇笔图纸。只有墨和线，没有颜色、阴影和圆角。</p><ul>
<li><b>箭头</b>走直角虚线，像标注引线；起点是代码行右侧的小方块。</li>
<li><b>便签</b>是细节标注框，用点线引到某一行。</li>
<li><b>新版本</b>是实心方块，旧版本是空心方块。</li>
<li><b>选中</b>是外面再套一圈虚线框。</li></ul>
<h3>取舍</h3><ul><li>最安静，截图放进文档最好看。</li><li>没有颜色，卡片一多，状态不容易一眼看到。</li><li>缩小后 1px 细线会发虚，要按缩放加粗。</li></ul>''',
 'soft': '''<h2>柔光</h2><p>参考白色手表商店那张：大留白、细字重、大面积柔和投影，珊瑚色只用在一个圆按钮和几个小点上。底色带一点暖。</p><ul>
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
 'news': '''<h2>报纸</h2><p>新闻纸底、黑色油墨，整块白板排成一张报纸的版面。</p><ul>
<li><b>白板名</b>是报头：哥特体报名，下面一行期号和提交号，再加一道双线。</li>
<li><b>每张卡片是一篇报道</b>：顶部粗线，眉题写「第 1.1 版 · 文件名」，函数名是粗体大标题，斜体导语是一句话说明。</li>
<li><b>代码</b>用打字机字体，像报道里的引文。</li>
<li><b>新版本</b>是一枚红色小印章，提示条是黑底的「快讯」。</li>
<li><b>箭头上的数据</b>写成斜体，两边加破折号，像图片说明。</li></ul>
<h3>取舍</h3><ul><li>阅读感最强，适合讲解或导出成长图。</li><li>标题和导语占高度，代码区域比暖墨小。</li><li>几乎没有颜色，状态要靠印章和粗细来区分。</li></ul>''',
 'art': '''<h2>艺术</h2><p>参考 Severance 晚宴海报：薄荷纸、深绿油墨、双线框、居中排版、字距拉得很开。</p><ul>
<li><b>白板</b>四周有双线边框，背景是很淡的方格纸（这是风格的一部分，可以去掉）。</li>
<li><b>卡片头</b>居中：编号和文件名、衬线大标题、文件 / 行 / 提交三栏信息。</li>
<li><b>图注</b>写在卡片下方，像插图编号：FIG. 1.1 — THE BATCH IS CHOSEN。</li>
<li><b>工具条</b>是一条深绿色色带，按钮是字距拉开的文字。</li></ul>
<h3>取舍</h3><ul><li>最有个性，截图分享最好看。</li><li>头部很高，同样大小的白板能放的代码最少。</li><li>双线和网格缩小后会变成噪点。</li></ul>''',
 'bamboo': '''<h2>竹简</h2><p>每张卡片是一卷竹简：一行代码写在一根简上，简与简之间留一道缝，两道麻绳从头穿到尾。</p><ul>
<li><b>首简</b>是左边一根宽简，竖着写编号「一之一」，用朱砂。</li>
<li><b>标题简</b>写函数名，下面一根简用毛笔字写这张卡的一句话说明。</li>
<li><b>朱砂</b>是唯一的颜色，相当于古人的批注：关键字、可展开的调用、箭头出发的那一行。</li>
<li><b>连线</b>是麻绳，两头打结；箭头上的数据挂在一块小木签上。</li>
<li><b>有新版本</b>是一枚朱红小印。</li></ul>
<h3>取舍</h3><ul><li>代码行和竹简一一对应，行感很强，读长函数时眼睛不容易串行。</li><li>行距被竹简锁死在 19px，用户改字号时竹简要跟着变宽。</li><li>首简占掉 30px 宽度，半宽 webview 里代码区更窄。</li></ul>''',
 'ink': '''<h2>水墨</h2><p>宣纸底，下方几层淡墨远山，一缕雾慢慢左右飘（70 秒一个来回，几乎感觉不到）。浅色是一幅画；深色换成碑帖拓片，黑底白字。</p><ul>
<li><b>编号</b>是一枚白文朱印「一之一」，盖在卡片右上角；<b>有新版本</b>是朱文印「新」，红框红字。</li>
<li><b>标题下</b>是一笔干笔墨痕，代替分隔线。</li>
<li><b>代码配色</b>用国画颜料：函数是花青，字符串和数字是赭石，关键字是浓墨，朱砂只标可展开的调用。</li>
<li><b>连线</b>是毛笔线，边缘有一点纸纹的毛刺；起止都是一个墨点。</li>
<li><b>工具条</b>是一小卷手卷，两头有木轴；白板名用行草写，后面盖一枚「白板」小印。</li></ul>
<h3>取舍</h3><ul><li>最安静、最有中文气质，适合长时间读代码。</li><li>远山和雾在卡片很多时几乎被挡住，主要在空白处起作用。</li><li>毛笔线用了 SVG 滤镜，连线多时要关掉滤镜保性能。</li></ul>''',
 'clay': '''<h2>3D · 等距积木</h2><p>白板是一张等距网格纸，卡片是一块块往右下方挤出厚度的彩色积木，像等距视角的小游戏。和柔光的白色软阴影正好相反：实心的厚度、黑色描边、饱和色。</p><ul>
<li><b>每个源文件一种颜色</b>：llm_engine 是珊瑚红，scheduler 是青绿，model_runner 是靛蓝。标题带和侧面都是这个颜色。</li>
<li><b>选中</b>就是积木被抬起来：往左上移一点，厚度从 9px 变成 13px，外面一圈黄色。</li>
<li><b>连线</b>是一根黑色粗线，影子朝同一个方向，看起来也有厚度；起点是黄色小圆钮。</li>
<li><b>标签、工具条、按钮</b>都是同一套积木按键，按下去会往右下沉，厚度消失。</li>
<li><b>有新版本</b>和白板名都是黄色积木块。</li></ul>
<h3>取舍</h3><ul><li>立体感来自固定方向的厚度，没有倾斜和透视，文字始终是正的，也没有常驻动画。</li><li>颜色重、描边粗，卡片很多时会很热闹；文件超过 6 个时颜色要复用。</li><li>右下方的厚度会占掉一点空间，卡片之间要多留 10px。</li></ul>''',
 'city': '''<h2>城市道路</h2><p>白板是一张平面城市地图：街区、河流、公园做底，调用关系画成真正的马路。</p><ul>
<li><b>连线</b>是马路：灰色路面、白色路沿、黄色中线，横平竖直，拐角是圆的。</li>
<li><b>箭头</b>换成一辆小车：停在路的尽头，车头朝着被调用的卡片。</li>
<li><b>几张卡同时调用一张卡</b>时，几条路在这张卡前面的同一个路口汇合，最后一段路共用，只停一辆车。演示里多了一张 ModelRunner.loop：其他 rank 的进程在这里收到命令后，也会走到 run。</li>
<li><b>卡片标题</b>是蓝底白字的路牌；<b>编号</b>是红色的国道牌，比如 G1.1。</li>
<li><b>箭头上的数据</b>写在绿色的高速指路牌上。</li>
<li><b>有新版本</b>是橙白相间的施工牌。</li>
<li><b>深色</b>是夜里的地图：路面暗下来，中线和车灯是暖黄色。</li></ul>
<h3>取舍</h3><ul><li>方向感最强：一眼能看出谁调用谁、数据往哪儿流。</li><li>马路比普通连线宽很多，卡片之间要留出路的宽度。</li><li>没有常驻动画，车是停着的。会动的版本留到 standalone app。</li><li>汇合后共用的最后一段上放不下各自的数据牌，所以牌子挂在每条路的起点那段。</li></ul>''',
}
VCFG = {
 'v1': {'head': 'triangle'}, 'warm': {}, 'graphite': {},
 'draft': {'route': 'elbow', 'head': 'triangle', 'port': 'square', 'gap': 150},
 'soft': {'head': 'dot', 'gap': 150, 'pad': {'l': 84, 'r': 28, 't': 96, 'b': 84}},
 'color': {'head': 'triangle', 'gap': 150},
 'news': {'head': 'triangle', 'gap': 150, 'pad': {'l': 40, 'r': 40, 't': 120, 'b': 80}},
 'art': {'port': 'diamond', 'gap': 150, 'pad': {'l': 44, 'r': 44, 't': 100, 'b': 84}},
 'bamboo': {'head': 'dot', 'gap': 140, 'pad': {'l': 28, 'r': 28, 't': 70, 'b': 72}},
 'ink': {'head': 'dot', 'gap': 150, 'pad': {'l': 32, 'r': 32, 't': 78, 'b': 76}, 'defs': '<defs><filter id="brush" filterUnits="userSpaceOnUse" x="-3000" y="-3000" width="8000" height="8000"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="2"/><feDisplacementMap in="SourceGraphic" scale="2.4"/></filter></defs>'},
 'clay': {'head': 'dot', 'gap': 150, 'pad': {'l': 40, 'r': 40, 't': 80, 'b': 84},
   'defs': '<defs><filter id="isoShadow" filterUnits="userSpaceOnUse" x="-3000" y="-3000" width="8000" height="8000"><feDropShadow dx="3" dy="3" stdDeviation="0" flood-opacity=".22"/></filter></defs>'},
 'city': {'route': 'street', 'head': 'car', 'merge': True, 'port': 'circle', 'gap': 240, 'layers': ['casing', 'road', 'lane'], 'pad': {'l': 32, 'r': 32, 't': 74, 'b': 76}},
}
SCENES = {'ink': open('scene-ink.svg').read(), 'city': open('scene-city.svg').read()}
draftjs = open('drafting.js').read().replace('function decorate(cards, world) {\n  world.querySelectorAll(\'.dim, .callout\').forEach(n => n.remove());', 'function drafting(cards, world) {')
js = draftjs + f'''
function decorate(cards, world) {{ world.querySelectorAll('.dim, .callout').forEach(n => n.remove()); if (board.dataset.v === 'draft') drafting(cards, world); }}
const BASECFG = Object.assign({{}}, CFG), VCFG = {json.dumps(VCFG)}, NOTES = {json.dumps(NOTES, ensure_ascii=False)}, SCENES = {json.dumps(SCENES)};
function setV(v) {{
  board.dataset.v = v; board.querySelector('.scene').innerHTML = SCENES[v] || ''; CFG = Object.assign({{}}, BASECFG, VCFG[v]);
  document.querySelectorAll('#segV button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === v));
  document.getElementById('notes').innerHTML = NOTES[v] + '<p class="tip">切换深浅主题看两边是否都成立。所有风格用的是同一份白板数据。</p>';
  render();
}}
document.getElementById('segV').addEventListener('click', e => {{ const b = e.target.closest('button'); if (b) setV(b.dataset.v); }});
setV('warm');
'''
seg = '''<div class="ctl">版本
      <div class="seg" id="segV" role="group" aria-label="版本">
        <button id="v-v1" data-v="v1">v1</button><button id="v-warm" data-v="warm">暖墨</button><button id="v-graphite" data-v="graphite">石墨</button><button id="v-draft" data-v="draft">制图</button><button id="v-soft" data-v="soft">柔光</button><button id="v-color" data-v="color">多彩</button><button id="v-art" data-v="art">艺术</button><button id="v-news" data-v="news">报纸</button><button id="v-bamboo" data-v="bamboo">竹简</button><button id="v-ink" data-v="ink">水墨</button><button id="v-clay" data-v="clay">3D</button><button id="v-city" data-v="city">城市</button>
      </div>
    </div>
    <div class="ctl">主题'''
o = open('base.html').read()
fonts = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,600&family=DM+Mono:wght@400;500&family=Archivo:wght@500;600;700&family=Jost:wght@300;400;500;600&family=Fraunces:ital,wght@1,400&family=IBM+Plex+Mono:wght@400;500;600&family=Marcellus&family=Old+Standard+TT:ital,wght@0,400;0,700;1,400&family=Courier+Prime:wght@400;700&family=UnifrakturMaguntia&family=Noto+Serif+SC:wght@400;600&family=Ma+Shan+Zheng&family=Zhi+Mang+Xing&display=swap'
for a, b in [('%%TITLE%%', 'CodeBoard 材质'), ('%%FONTS%%', fonts), ('%%CSS%%', css + '\n.notes .tip { font-size: 12px; border-top: .5px solid var(--page-hair); padding-top: 12px; }'),
             ('%%H1%%', '白板材质对照'), ('%%SUB%%', '同一块白板、同一份数据，只换材质。左边模拟 VS Code 里的 webview。'),
             ('class="board %%BOARDCLASS%%"', 'class="board" data-v="warm"'), ('%%EYEBROW%%', 'NANO-VLLM · ENGINE'), ('%%NOTES%%', ''),
             ('const CFG = Object.assign(', 'let CFG = Object.assign('), ('%%CFG%%', '{}'), ('%%JS%%', js), ('<div class="ctl">主题', seg)]:
    assert a in o, a; o = o.replace(a, b)
o = o.replace('render();\ndocument.fonts', 'document.fonts')
o = o.replace('.ln.link .no', '.no.link').replace('.ln.link', '.hlrow').replace('.ln .no', '.gutter .no').replace('.ln .tx', '.src')
open('../material.html', 'w').write(o)
print('ok')
