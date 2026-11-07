//! What gets embedded: an item cut into pieces. Every item has its whole text as one piece (title and text, cut to what the
//! model reads), plus one piece per paragraph when it has more than one, a long paragraph split by sentences; an item's
//! images are pieces too. Each text piece is written with EmbeddingGemma's document prompt and the item's own title only
//! (no board or Section path: measured on persona, the path costs 4 points of MRR). An item scores as its best piece.
//!
//! Measured on persona (75 labelled queries): whole + paragraphs MRR 74, whole only 46.

/// Characters of the whole text that go into its piece: about what the model reads (a context error shortens it further)
pub const WHOLE_CHARS: usize = 6000;
/// A paragraph longer than this many characters is split into sentences packed up to it
pub const PARA_CHARS: usize = 1200;
/// A paragraph shorter than this (in characters, trimmed) is not a piece of its own
const MIN_PARA_CHARS: usize = 8;
/// Text pieces per item, at most (the whole one included): a very long Note still costs a bounded number of embeddings
pub const MAX_PIECES: usize = 32;

/// EmbeddingGemma's prompt for a search query
pub fn query_prompt(q: &str) -> String {
    format!("task: search result | query: {q}")
}

/// EmbeddingGemma's prompt for a document piece: the item's title and the piece
pub fn doc_prompt(title: &str, text: &str) -> String {
    let title = title.trim();
    let text = text.trim();
    let title = if title.is_empty() { "none" } else { title };
    let text = if !text.is_empty() {
        text
    } else if title != "none" {
        title
    } else {
        "none"
    };
    format!("title: {title} | text: {text}")
}

/// One piece of an item's text: the prompted text to embed and where it is in the item's text, as UTF-16 offsets (what a
/// JavaScript client slices with)
#[derive(Debug, Clone, PartialEq)]
pub struct TextPiece {
    pub prompt: String,
    pub start: u32,
    pub end: u32,
}

/// The item's text pieces: the whole first, then its paragraphs (when there are two or more)
pub fn text_pieces(title: &str, text: &str) -> Vec<TextPiece> {
    let whole_end = utf16_len(text);
    let mut out = vec![TextPiece {
        prompt: doc_prompt(title, cut(text, WHOLE_CHARS)),
        start: 0,
        end: whole_end,
    }];
    let paras = paragraphs(text);
    if paras.len() > 1 {
        for (a, b) in paras {
            if out.len() >= MAX_PIECES {
                break;
            }
            out.push(TextPiece {
                prompt: doc_prompt(title, &text[a..b]),
                start: utf16_at(text, a),
                end: utf16_at(text, b),
            });
        }
    }
    out
}

/// The first n characters of s
pub fn cut(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn utf16_at(s: &str, byte: usize) -> u32 {
    utf16_len(&s[..byte])
}

/// The text's paragraphs as byte ranges, trimmed: split at blank lines (not inside a ``` or ~~~ fence), a paragraph over
/// PARA_CHARS split into sentences packed up to it; very short ones left out
pub fn paragraphs(text: &str) -> Vec<(usize, usize)> {
    let mut blocks: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    let mut fence: Option<&str> = None;
    let mut at = 0;
    for line in text.split_inclusive('\n') {
        let body = line.trim();
        let line_start = at;
        at += line.len();
        if let Some(f) = fence {
            if body.starts_with(f) {
                fence = None;
            }
            continue;
        }
        if body.starts_with("```") || body.starts_with("~~~") {
            fence = Some(&body[..3]);
            start.get_or_insert(line_start);
            continue;
        }
        if body.is_empty() {
            if let Some(s) = start.take() {
                blocks.push((s, line_start));
            }
        } else {
            start.get_or_insert(line_start);
        }
    }
    if let Some(s) = start {
        blocks.push((s, text.len()));
    }
    let mut out = Vec::new();
    for (a, b) in blocks {
        let (a, b) = trim(text, a, b);
        let n = text[a..b].chars().count();
        if n < MIN_PARA_CHARS {
            continue;
        }
        if n <= PARA_CHARS {
            out.push((a, b));
        } else {
            out.extend(sentence_groups(text, a, b));
        }
    }
    out
}

fn trim(text: &str, a: usize, b: usize) -> (usize, usize) {
    let s = &text[a..b];
    let lead = s.len() - s.trim_start().len();
    let t = s.trim();
    (a + lead, a + lead + t.len())
}

/// Sentences of text[a..b] (split after 。！？!? and after .;: followed by white space, and at line breaks), packed into
/// ranges of at most PARA_CHARS characters (a longer sentence is cut)
fn sentence_groups(text: &str, a: usize, b: usize) -> Vec<(usize, usize)> {
    let s = &text[a..b];
    let mut cuts = vec![0];
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    for (i, &(at, c)) in chars.iter().enumerate() {
        let next = chars.get(i + 1).map(|x| x.1);
        let end = at + c.len_utf8();
        if matches!(c, '。' | '！' | '？' | '!' | '?' | '\n')
            || (matches!(c, '.' | ';' | ':') && next.is_some_and(char::is_whitespace))
        {
            cuts.push(end);
        }
    }
    cuts.push(s.len());
    cuts.dedup();
    let mut out = Vec::new();
    let mut cur: Option<(usize, usize)> = None;
    let mut cur_chars = 0;
    for w in cuts.windows(2) {
        let (x, y) = trim(s, w[0], w[1]);
        if x >= y {
            continue;
        }
        let n = s[x..y].chars().count();
        if let Some((cx, cy)) = cur {
            if cur_chars + 1 + n <= PARA_CHARS {
                cur = Some((cx, y));
                cur_chars += 1 + n;
                continue;
            }
            out.push((cx, cy));
        }
        // a sentence longer than a piece: cut into PARA_CHARS pieces
        let mut x = x;
        while s[x..y].chars().count() > PARA_CHARS {
            let c = x + cut(&s[x..y], PARA_CHARS).len();
            out.push((x, c));
            x = c;
        }
        cur = Some((x, y));
        cur_chars = s[x..y].chars().count();
    }
    if let Some(c) = cur {
        out.push(c);
    }
    out.into_iter()
        .map(|(x, y)| trim(text, a + x, a + y))
        .filter(|(x, y)| x < y)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slice16(s: &str, a: u32, b: u32) -> String {
        let u: Vec<u16> = s.encode_utf16().collect();
        String::from_utf16(&u[a as usize..b as usize]).unwrap()
    }

    #[test]
    fn whole_item_then_each_paragraph_with_its_range() {
        let text = "## Scheduler\n\nPicks prefill or decode 显存.\n\n```py\ndef f():\n\n    pass\n```\n\nok";
        let p = text_pieces("Scheduler", text);
        assert_eq!(p[0].prompt, format!("title: Scheduler | text: {}", text.trim()));
        assert_eq!((p[0].start, p[0].end), (0, utf16_len(text)));
        let bodies: Vec<String> = p[1..].iter().map(|x| slice16(text, x.start, x.end)).collect();
        // the fence keeps its blank line; "ok" is too short to be a piece
        assert_eq!(
            bodies,
            vec![
                "## Scheduler",
                "Picks prefill or decode 显存.",
                "```py\ndef f():\n\n    pass\n```"
            ]
        );
        assert_eq!(p[2].prompt, "title: Scheduler | text: Picks prefill or decode 显存.");
    }

    #[test]
    fn one_paragraph_is_only_the_whole_piece() {
        let p = text_pieces("", "Frees kv cache blocks when a sequence ends.");
        assert_eq!(p.len(), 1);
        assert_eq!(
            p[0].prompt,
            "title: none | text: Frees kv cache blocks when a sequence ends."
        );
        assert_eq!(
            text_pieces("Only a title", "")[0].prompt,
            "title: Only a title | text: Only a title"
        );
    }

    #[test]
    fn long_paragraph_splits_by_sentences_and_pieces_are_bounded() {
        let sentence = "This sentence is about forty characters. ";
        let long = sentence.repeat(70); // ~2900 characters
        let text = format!("{long}\n\nsecond paragraph here");
        let paras = paragraphs(&text);
        assert!(paras.len() >= 4, "{paras:?}");
        for (a, b) in &paras {
            assert!(text[*a..*b].chars().count() <= PARA_CHARS);
            assert!(text[*a..*b].ends_with('.') || text[*a..*b] == *"second paragraph here");
        }
        let many: String = (0..100).map(|i| format!("paragraph number {i}\n\n")).collect();
        assert_eq!(text_pieces("t", &many).len(), MAX_PIECES);
        // a single run with no sentence ends is cut, and the whole piece is cut to WHOLE_CHARS
        let run = "字".repeat(7000);
        let p = text_pieces("t", &format!("{run}\n\nnext paragraph"));
        assert_eq!(
            p[0].prompt.chars().count(),
            "title: t | text: ".chars().count() + WHOLE_CHARS
        );
        assert!(p.len() > 5);
    }
}
