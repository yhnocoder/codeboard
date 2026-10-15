function decorate(cards, world) {
  world.querySelectorAll('.dim, .callout').forEach(n => n.remove());
  const a = cards[0];
  // 便签在这个风格里是「细节标注框」，用虚线引线连到某一行
  const l3 = lineBox(a, 3), ly = a.y + l3.top + l3.h / 2;
  const box = document.createElement('div'); box.className = 'callout';
  const bx = a.x + 40, by = a.y + a.el.offsetHeight + 40;
  box.style.left = bx + 'px'; box.style.top = by + 'px';
  box.innerHTML = '<b>便签 · L52</b>postprocess 之后，跑完的序列才会被收集进 outputs。';
  world.appendChild(box);
  const lx = a.x - 28;
  const l1 = document.createElement('div'); l1.className = 'dim lead';
  l1.style.cssText = `left:${lx}px;top:${ly}px;width:${a.x - lx}px;height:0;border-right:0`;
  const l2 = document.createElement('div'); l2.className = 'dim lead';
  l2.style.cssText = `left:${lx}px;top:${ly}px;width:${bx - lx}px;height:${by + 18 - ly}px;border-top:0;border-right:0;border-left:1px dotted var(--ink-2);border-bottom:1px dotted var(--ink-2)`;
  world.append(l1, l2);
}
