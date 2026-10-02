; On top of tree-sitter-json's queries, which capture neither brackets nor separators (they
; fell back to the code block's color, the strings'): the punctuation, stepping back.
["{" "}" "[" "]"] @punctuation.bracket
["," ":"] @punctuation.delimiter
