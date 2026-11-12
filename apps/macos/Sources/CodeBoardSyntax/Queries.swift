// The highlight queries. Capture names are the board's classes (kw, op, fn, str, com, num, self, p) or a step the
// highlighter does in code (see `Query.Action`). Painting order: longer (outer) spans first, shorter (inner) ones over
// them, spans of equal length in pattern order, so a later pattern wins on the same node.

/// C / C++ / CUDA: the query of packages/analysis/src/highlight.ts unchanged, so code cards keep the VS Code board's colours.
let cudaQuery = #"""
  (comment) @com

  [(string_literal) (raw_string_literal) (char_literal) (system_lib_string)] @str
  (number_literal) @num
  [(true) (false) (null)] @num
  (this) @self

  [(primitive_type) (sized_type_specifier) (auto)] @kw
  (type_identifier) @fn

  [
   "break" "case" "const" "continue" "default" "do" "else" "enum" "extern" "for" "goto" "if" "inline" "return" "sizeof"
   "static" "struct" "switch" "typedef" "union" "volatile" "while" "register" "restrict" "thread_local" "__thread" "_Atomic" "_Noreturn" "noreturn" "_Nonnull"
   "__restrict__" "__inline" "__inline__" "__forceinline" "__extension__" "__attribute__" "__attribute" "__declspec" "asm" "__asm__" "__asm" "__volatile__"
   "alignas" "_Alignas" "alignof" "_Alignof" "__alignof__" "__alignof" "_alignof" "offsetof" "_Generic" "signed" "unsigned" "long" "short"
   "catch" "class" "co_await" "co_return" "co_yield" "constexpr" "constinit" "consteval" "decltype" "delete" "explicit" "final" "friend"
   "mutable" "namespace" "noexcept" "new" "operator" "override" "private" "protected" "public" "template" "throw" "try" "typename" "using"
   "concept" "requires" "virtual" "static_assert" "export" "module" "import"
   "and" "or" "not" "xor" "bitand" "bitor" "compl" "and_eq" "or_eq" "xor_eq" "not_eq"
  ] @kw

  ["#include" "#define" "#if" "#ifdef" "#ifndef" "#else" "#elif" "#elifdef" "#elifndef" "#endif" "defined"] @kw
  (preproc_directive) @kw

  [
   "=" "+=" "-=" "*=" "/=" "%=" "&=" "|=" "^=" "<<=" ">>=" "==" "!=" "<" ">" "<=" ">=" "<=>"
   "+" "-" "*" "/" "%" "++" "--" "&&" "||" "!" "~" "&" "|" "^" "<<" ">>" "?" ".*" "->*"
  ] @kw
  ["," "." "->" "::" ":"] @p
  (conditional_expression ":" @kw)
  (template_argument_list ["<" ">"] @plain)
  (template_parameter_list ["<" ">"] @plain)
  (destructor_name "~" @fn)
  (template_function arguments: (template_argument_list (type_descriptor type: (type_identifier) @plain)))
  (template_method arguments: (template_argument_list (type_descriptor type: (type_identifier) @plain)))

  (call_expression function: (_) @callee)
  (function_declarator declarator: (_) @callee)
  (template_function name: (identifier) @fn)
  (template_method name: (field_identifier) @fn)
  (field_initializer (field_identifier) @fn)
  (preproc_function_def name: (identifier) @fn)
  (preproc_def name: (identifier) @fn)
  (preproc_arg) @macro

  ((identifier) @kw (#any-of? @kw "static_cast" "reinterpret_cast" "const_cast" "dynamic_cast"))
  ((identifier) @num (#any-of? @num "threadIdx" "blockIdx" "blockDim" "gridDim" "warpSize"))

  ["__host__" "__device__" "__global__" "__tile__" "__tile_global__" "__forceinline__" "__noinline__" "__shared__" "__local__" "__constant__"
   "__managed__" "__grid_constant__" "__launch_bounds__" "__cluster_dims__" "__maxnreg__" "__align__"] @kw
  (macro_modifier) @kw
  (pragma_macro) @kw
  ["<<<" ">>>"] @kw
  """#

/// Python: what the board's shiki grammar (MagicPython with the css-variables theme, mapped by core's tokenClass) shows.
let pythonQuery = #"""
  (comment) @com
  (string) @str
  (string_start) @prefix
  (string_content) @fmt
  (interpolation) @plain
  (interpolation "{" @num "}" @num)
  [(type_conversion) (format_specifier)] @kw
  [(integer) (float) (none) (true) (false)] @num

  [
   "as" "assert" "async" "await" "break" "case" "class" "continue" "def" "del" "elif" "else" "except" "exec" "finally"
   "for" "from" "global" "if" "import" "lambda" "match" "nonlocal" "pass" "raise" "return" "try" "while" "with" "yield"
   "and" "in" "is" "not" "or" "is not" "not in"
  ] @kw
  [
   "-" "-=" "!=" "*" "**" "**=" "*=" "/" "//" "//=" "/=" "&" "&=" "%" "%=" "^" "^=" "+" "+=" "<" "<<" "<<=" "<=" "<>"
   "=" ":=" "==" ">" ">=" ">>" ">>=" "|" "|=" "~" "@" "@="
  ] @op
  ["," "." ":" ";" "->"] @p
  (argument_list ["(" ")"] @p)
  (subscript ["[" "]"] @p)
  (dictionary ["{" "}"] @p)
  (type_parameter ["[" "]"] @p)
  (format_specifier ":" @kw)
  [(function_definition ":" @plain) (class_definition ":" @plain) (lambda ":" @plain)]
  (class_definition superclasses: (argument_list ["(" ")"] @plain))

  (call function: (identifier) @fn)

  ((identifier) @num (#any-of? @num
   "bool" "bytearray" "bytes" "classmethod" "complex" "dict" "float" "frozenset" "int" "list" "object" "property" "set"
   "slice" "staticmethod" "str" "tuple" "type" "super" "metaclass" "NotImplemented" "Ellipsis"
   "__all__" "__annotations__" "__bases__" "__builtins__" "__class__" "__closure__" "__code__" "__debug__" "__defaults__"
   "__dict__" "__doc__" "__file__" "__func__" "__globals__" "__kwdefaults__" "__match_args__" "__members__"
   "__metaclass__" "__methods__" "__module__" "__mro__" "__mro_entries__" "__name__" "__qualname__" "__post_init__"
   "__self__" "__signature__" "__slots__" "__subclasses__" "__version__" "__weakref__" "__wrapped__" "__classcell__"
   "__spec__" "__path__" "__package__" "__future__" "__traceback__"))
  ((identifier) @num (#match? @num "^(((Arithmetic|Assertion|Attribute|Buffer|BlockingIO|BrokenPipe|ChildProcess|Connection(Aborted|Refused|Reset)?|EOF|Environment|FileExists|FileNotFound|FloatingPoint|IO|Import|Indentation|Index|Interrupted|IsADirectory|NotADirectory|Permission|ProcessLookup|Timeout|Key|Lookup|Memory|Name|NotImplemented|OS|Overflow|Reference|Runtime|Recursion|Syntax|System|Tab|Type|UnboundLocal|Unicode(Encode|Decode|Translate)?|Value|Windows|ZeroDivision|ModuleNotFound)Error)|((Pending)?Deprecation|Runtime|Syntax|User|Future|Import|Unicode|Bytes|Resource)?Warning|SystemExit|Stop(Async)?Iteration|KeyboardInterrupt|GeneratorExit|(Base)?Exception)$"))
  ((identifier) @fn (#any-of? @fn
   "__import__" "abs" "aiter" "all" "any" "anext" "ascii" "bin" "breakpoint" "callable" "chr" "compile" "copyright"
   "credits" "delattr" "dir" "divmod" "enumerate" "eval" "exec" "exit" "filter" "format" "getattr" "globals" "hasattr"
   "hash" "help" "hex" "id" "input" "isinstance" "issubclass" "iter" "len" "license" "locals" "map" "max" "memoryview"
   "min" "next" "oct" "open" "ord" "pow" "print" "quit" "range" "reload" "repr" "reversed" "round" "setattr" "sorted"
   "sum" "vars" "zip"))
  ((identifier) @self (#any-of? @self "self" "cls"))
  ; the built-in names above only count where they are not after a dot
  (attribute attribute: (identifier) @plain)

  (call function: (attribute attribute: (identifier) @fn))
  (class_definition superclasses: (argument_list [(identifier) (attribute)] @fn))
  (class_definition superclasses: (argument_list (attribute attribute: (identifier) @fn)))
  (class_definition superclasses: (argument_list (keyword_argument value: (identifier) @fn)))
  (function_definition name: (identifier) @fn)
  (class_definition name: (identifier) @fn)

  (expression_statement [(string) (concatenated_string)] @doc)
  (decorator) @dec
  """#

/// Rust: what the board's shiki grammar shows (all types and capitalised names in the function colour, `.` a keyword).
let rustQuery = #"""
  [(line_comment) (block_comment)] @com
  [(string_literal) (raw_string_literal) (char_literal)] @str
  [(integer_literal) (float_literal) (boolean_literal)] @num
  (self) @self

  [
   "as" "async" "await" "break" "const" "continue" "default" "dyn" "else" "enum" "extern" "fn" "for" "gen" "if" "impl"
   "in" "let" "loop" "macro_rules!" "match" "mod" "move" "pub" "raw" "ref" "return" "static" "struct" "trait" "type"
   "union" "unsafe" "use" "where" "while" "yield" "." ".." "..=" "..."
  ] @kw
  [(crate) (super) (mutable_specifier)] @kw
  [
   "::" ":" "=" "->" "=>" "+" "-" "*" "/" "%" "&" "|" "^" "!" "<<" ">>" "&&" "||" "==" "!=" "<" ">" "<=" ">="
   "+=" "-=" "*=" "/=" "%=" "&=" "|=" "^=" "<<=" ">>=" "?" "@"
  ] @op
  (type_arguments ["<" ">"] @plain)
  (type_parameters ["<" ">"] @plain)
  [(outer_doc_comment_marker) (inner_doc_comment_marker)] @com

  [(type_identifier) (primitive_type)] @fn
  ((identifier) @fn (#match? @fn "^_?[A-Z]"))
  ((identifier) @plain (#match? @plain "^[A-Z]{2}[A-Z0-9_]*$"))
  ([(identifier) (type_identifier)] @plain (#any-of? @plain "Self" "_"))
  (lifetime (identifier) @fn)
  (label (identifier) @fn)

  (function_item name: (identifier) @fn)
  (function_signature_item name: (identifier) @fn)
  (call_expression function: (_) @callee)
  (generic_function function: (_) @callee)
  (macro_invocation macro: (_) @callee "!" @fn)
  """#
