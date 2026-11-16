import Testing

@testable import CodeBoardAnalysis

// As the "entry points" case of packages/analysis/test/symbols.test.ts, with cases for what it does not cover

@Suite struct EntryPointTests {
  @Test func readsPyprojectScriptsAndPackageExports() {
    #expect(
      pyprojectScripts("[project]\nname=\"x\"\n[project.scripts]\nnv = \"nanovllm.cli:main\"\n") == [
        ProjectScript(name: "nv", module: "nanovllm.cli", func: "main")
      ])
    #expect(initExports(Fixtures.nano("nanovllm/__init__.py")).map(\.name) == ["LLM", "SamplingParams"])
  }

  @Test func pyprojectScriptsOfPoetryOnlyInTheirSection() {
    let toml =
      "[tool.poetry.scripts]\r\n\"my-tool\" = 'pkg.main:run'\r\nbad = \"no colon\"\r\n[tool.other]\r\nx = \"a.b:c\"\r\n"
    #expect(pyprojectScripts(toml) == [ProjectScript(name: "my-tool", module: "pkg.main", func: "run")])
  }

  @Test func initExportsReadParenthesizedListsAliasesAndSkipStars() {
    let text =
      "# 包\nfrom .x import (\n    A,\n    B as C,  # 注释\n)\nfrom .y import *\nfrom .z import D # tail\nimport os\n"
    #expect(
      initExports(text) == [
        InitExport(name: "A", from: ".x"), InitExport(name: "C", from: ".x"), InitExport(name: "D", from: ".z"),
      ])
  }

  @Test func moduleFilesAreTheModuleFileAndThePackageInit() {
    #expect(
      moduleFiles("nanovllm.engine.scheduler") == [
        "nanovllm/engine/scheduler.py", "nanovllm/engine/scheduler/__init__.py",
      ])
    #expect(moduleFiles("..llm", base: "nanovllm") == ["nanovllm/llm.py", "nanovllm/llm/__init__.py"])
  }
}
