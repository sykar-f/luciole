; JSX on top of the TypeScript queries, for the TSX grammar: tags, their attributes, and
; the brackets around them.
(jsx_opening_element name: (identifier) @tag)
(jsx_closing_element name: (identifier) @tag)
(jsx_self_closing_element name: (identifier) @tag)
(jsx_opening_element name: (member_expression) @tag)
(jsx_closing_element name: (member_expression) @tag)
(jsx_self_closing_element name: (member_expression) @tag)
(jsx_attribute (property_identifier) @tag.attribute)
(jsx_opening_element ["<" ">"] @punctuation.bracket)
(jsx_closing_element ["</" ">"] @punctuation.bracket)
(jsx_self_closing_element ["<" "/>"] @punctuation.bracket)
(jsx_text) @none
