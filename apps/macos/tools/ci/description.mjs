// The names a pull request's description gives on the lines that start with a key ("Accept: a, b", "Mac tests: A B"),
// for the Mac jobs to run beyond what they pick (.github/workflows/macos.yml hands the description over as PR_BODY).
// Anyone can open a pull request and write anything there, so each caller checks every name against what exists before
// it uses it, and shows a name it refused only through shown(): quoted and cut short, a line of the log it prints can
// never begin with a workflow command (::error:: and the like) or carry a line break.
export function namesIn(body, key) {
  const start = `${key.toLowerCase()}:`;
  return (body ?? "")
    .split(/\r\n|\r|\n/)
    .filter((line) => line.toLowerCase().startsWith(start))
    .flatMap((line) => line.slice(start.length).split(/[\s,]+/))
    .filter(Boolean);
}

export const shown = (name) => JSON.stringify(name.slice(0, 80));
