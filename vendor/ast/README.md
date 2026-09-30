# vendored: AHK2 AST engine (AstHost.exe)

Copied from `C:\projects\c#\AHK2 AST` (build/, src/host/PROTOCOL.md, NODES.md, harness/flows/).
JSON-lines over stdio; see `docs/PROTOCOL.md`. Used by `ahkh ast.*` verbs (outline, parse errors, flows such as
tracing/minify/tree-shake). The parser is experimental: AutoHotkey `/Validate` and the language server remain the ground truth
(`ahkh lint` shows all opinions side by side). Refresh by re-copying those files.
