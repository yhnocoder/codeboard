import CodeBoardAnalysis
import Testing

// The editor shows board marks on the files of every language the analysis reads, Rust included: the list comes from
// the language table, so a language added there gets them too
@Suite struct LangsTests {
  @Test func analyzedEditorLangsHaveTheEditorIdOfEveryAnalyzedLanguageOnce() {
    let ids = analyzedEditorLangs()
    for l in langTable where l.grammar != nil { #expect(ids.contains(l.vscodeId)) }
    for id in ["python", "cpp", "cuda-cpp", "c", "rust"] { #expect(ids.contains(id)) }
    #expect(Set(ids).count == ids.count)
    #expect(!ids.contains("typescript"))
  }
}
