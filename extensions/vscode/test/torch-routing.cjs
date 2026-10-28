// PyTorch op routing in a real VS Code with Pylance and clangd (manual, not in CI: it needs a 2 GB PyTorch checkout). An E2E_FLOW file:
// each row puts the calling function on a new board with Alt+B, clicks the call in the card and checks which kernel the new card shows,
// the dispatch key on the arrow, the alternatives beside it, and that a card on a generated build/ file is not "+ uncommitted".
//
// The PyTorch checkout: commit 91542833cc8f1e563920a718457b4879cb01cbca (the row line numbers are from it), configured with CMake
// (CMAKE_EXPORT_COMPILE_COMMANDS; CPU only is enough), with the generated sources built: ninja caffe2/ATEN_CPU_FILES_GEN_TARGET
// caffe2/generate-torch-sources torch_python_stubs. Pylance and clangd (--compile-commands-dir=<checkout>/build) installed.
// VS Code must open the checkout in place, as the workspace (WS): a copy loses build/ and the generated files, and compile_commands.json
// holds absolute paths. run.sh opens a clone of nano-vllm, so this flow needs a launcher that opens <checkout> instead and runs
// drive.cjs with E2E_FLOW=extensions/vscode/test/torch-routing.cjs (ROWS=id,id runs some rows). Results: <OUT>/torch-routing.json, row-N.png
const fs = require("fs");

// fn = a line inside the calling function, line = the call; want = the new card's title; key = the dispatch key on the arrow;
// alts = alternatives that must be offered (text in the alternatives column); bound = text in the arrow's label
const ROWS = [
  { id: "F.softmax", file: "torch/nn/functional.py", fn: 2206, line: 2243, name: "softmax", want: "at::native::softmax", key: "CompositeImplicitAutograd", alts: ["at::native::softmax_out"] },
  { id: "at::_softmax", file: "aten/src/ATen/native/SoftMax.cpp", fn: 410, line: 416, name: "_softmax", want: "at::native::softmax_cuda_out", key: "CUDA", alts: ["CPU · at::native::softmax_cpu_out"] },
  { id: "host_softmax", file: "aten/src/ATen/native/cuda/SoftMax.cu", fn: 1459, line: 1467, name: "host_softmax", want: "at::native::host_softmax" },
  { id: "cunn_SoftMaxForward<<<>>>", file: "aten/src/ATen/native/cuda/SoftMax.cu", fn: 1096, line: 1206, name: "cunn_SoftMaxForward", want: /^cunn_SoftMaxForward</ },
  { id: "_C._nn.fractional_max_pool2d", file: "torch/nn/functional.py", fn: 441, line: 514, name: "fractional_max_pool2d", want: "at::native::fractional_max_pool2d_out_cuda", key: "CUDA", alts: ["CPU · at::native::fractional_max_pool2d_out_cpu"] },
  { id: "_C._get_cudnn_enabled", file: "torch/backends/cudnn/__init__.py", fn: 129, line: 130, name: "_get_cudnn_enabled", want: "THPModule_userEnabledCuDNN", bound: "PyMethodDef" },
  { id: "_C._get_tracing_state", file: "torch/nn/modules/module.py", fn: 1763, line: 1764, name: "_get_tracing_state", want: /lambda$/, bound: "pybind" },
  { id: "torch.ops.aten._upsample_bilinear2d_aa", file: "torch/_decomp/decompositions.py", fn: 4575, line: 4579, name: "_upsample_bilinear2d_aa", want: "at::native::_upsample_bilinear2d_aa_out_cuda", key: "CUDA", alts: ["CPU · ", "CompositeImplicitAutograd · "] },
  { id: "scatter_add_stub", file: "aten/src/ATen/native/TensorAdvancedIndexing.cpp", fn: 2352, line: 2384, name: "scatter_add_stub", want: "at::native::scatter_add_cuda_kernel", key: "CUDA", alts: ["CPU · at::native::scatter_add_cpu_kernel"], bound: "REGISTER_DISPATCH" },
  { id: "add_stub", file: "aten/src/ATen/native/BinaryOps.cpp", fn: 435, line: 438, name: "add_stub", want: "at::native::add_kernel", key: "CUDA", alts: ["CPU · at::native::add_kernel"], generated: true },
  { id: "PaddingKernel add_stub", file: "aten/src/ATen/native/cpu/PaddingKernel.cpp", fn: 396, line: 440, name: "add_stub", want: "at::native::add_stub" },
  { id: "torch.add", file: "torch/nn/utils/parametrizations.py", fn: 70, line: 96, name: "add", pre: "torch.", want: "at::native::ufunc_add_CUDA", key: "CUDA", alts: ["CPU · at::native::ufunc_add_CPU", "at::native::add", "MPS · at::native::add_out_mps"], generated: true },
];

module.exports = async (page, t) => {
  const only = process.env.ROWS?.split(",");
  const out = [];
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  // wheel the board until the call is inside the frame (a long caller card is taller than the view)
  const inView = async (f, el) => {
    const fb = await (await f.frameElement()).boundingBox();
    for (let i = 0; i < 25; i++) {
      const b = await el.boundingBox();
      if (!b) return false;
      const dy = b.y + b.height / 2 - (fb.y + fb.height / 2);
      if (Math.abs(dy) < fb.height / 2 - 80) return true;
      await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
      await page.mouse.wheel(0, Math.max(-400, Math.min(400, dy)));
      await t.idle(f);
    }
    return false;
  };
  // After a click in a board, F1 sometimes does not reach the workbench (seen only on this big workspace): click the first editor
  // group's active tab and try again
  const retry = async (what, fn) => {
    for (let k = 0; ; k++) {
      try { return await fn(); } catch (e) {
        if (k >= 2) throw e;
        console.log(`  (${what}: retry ${k + 1})`);
        await page.keyboard.press("Escape");
        await page.locator(".editor-group-container").first().locator(".tab.active").first().click();
      }
    }
  };
  let n = 0;
  for (const row of ROWS) {
    if (only && !only.includes(row.id)) continue;
    n++;
    const r = { id: row.id };
    out.push(r);
    try {
      const f = await retry("New Board", () => t.newBoard(page, `Torch ${n} ${row.id}`.slice(0, 40)));
      await retry("open the file", () => t.openFile(page, `${t.WS}/${row.file}`, row.fn));
      await page.keyboard.press("Alt+b");
      await t.until(`${row.id}: Alt+B puts the caller on the board`, () => f.locator(".card").count(), 60000, 50);
      await t.idle(f, { ms: 60000 });
      const call = await f.locator(".card").first().evaluate((c, [line, name]) => {
        const no = [...c.querySelectorAll(".gutter .no")].find((e) => e.textContent.trim() === String(line));
        const l = no && c.querySelector(`.src .l[data-r="${no.dataset.r}"]`);
        const el = [...(l?.querySelectorAll(".call") ?? [])].find((e) => e.textContent === name);
        el?.setAttribute("data-torch-click", "");
        return !!el;
      }, [row.line, row.name]);
      t.check(call, `${row.id}: ${row.name} on line ${row.line} is a clickable call`);
      const el = f.locator("[data-torch-click]");
      if (!call || !(await inView(f, el))) continue;
      const t0 = Date.now();
      await el.click();
      await t.until(`${row.id}: the kernel's card`, () => f.locator(".card").count().then((k) => k > 1), 90000, 20);
      r.ms = Date.now() - t0;
      await t.idle(f, { ms: 60000 });
      const c = f.locator(".card").nth(1);
      r.title = flat(await c.locator(".chead .ctitle").innerText());
      r.label = flat((await f.locator(".vchips .vtop").allInnerTexts()).join(" | "));
      r.alts = flat((await f.locator(".altcol").allInnerTexts()).join(" | "));
      r.uncommitted = await c.locator(".chead .rev.unc").count();
      t.check(typeof row.want === "string" ? r.title === row.want : row.want.test(r.title), `${row.id} → ${row.want}`, r.title);
      if (row.key) t.check(new RegExp(`dispatch → ${row.key}\\b`).test(r.label), `${row.id}: dispatch key ${row.key} on the arrow`, r.label);
      if (row.bound) t.check(r.label.includes(row.bound), `${row.id}: the arrow says ${row.bound}`, r.label);
      for (const a of row.alts ?? []) t.check(r.alts.includes(a), `${row.id}: offers ${a}`, r.alts);
      t.check(!/Python · /.test(r.alts), `${row.id}: no Python functions of the same name next to kernels`, r.alts);
      // the generated file is git-ignored: pinned by its content ("not in git"), not "+ uncommitted"
      if (row.generated) t.check(!r.uncommitted && /not in git/.test(await c.locator(".chead .rev").first().getAttribute("data-tip")), `${row.id}: the generated build/ file's card is not "+ uncommitted"`);
      await t.shot(page, `row-${n}`);
    } catch (e) { r.error = String(e.message || e).split("\n")[0]; t.check(false, `${row.id} runs`, r.error); }
    console.log(`  ${JSON.stringify(r)}`);
    fs.writeFileSync(`${t.OUT}/torch-routing.json`, JSON.stringify(out, null, 1));
  }
};
