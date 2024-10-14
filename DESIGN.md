# Design of this extension

The diagram below presents a high-level overview of the design of this extension.

```
                                Extension                      LSP Server                     F* processes
                       vscode-languageclient/node        vscode-languageserver/node             Native F*
                                                                                              ___________
  .---------.  events      .---------------.               .---------------.                 |_fstar.exe_|_   
  | editor  | -----------> |  extension.ts | -----LSP--->  |   server.ts   | ---fstar-ide--->  |_fstar.exe_|_         
  |_________| <----------- |_______________| <----LSP----  |_______________| <--fstar-ide------- |_fstar.exe_|_
              diagnostics                                                                          |_fstar.exe_| 
```

## Workflow

* The editor starts the extension on an initialization event

* The extension launches a language server, implemented in server.ts, executing on the nodejs server runtime.
  The extension and server interact using Language Server Protocol (LSP).
  
* For each F* document opened by the editor, the LSP server launches multiple fstar.exe processes.
  F* implements its own IDE protocol, designed first for use by F*'s emacs mode, fstar-mode.el.
  We reuse that protocol to communicate between server.ts and fstar.exe,
  communicating using JSON-formatted IDE messages over stdin/stdout.

This three layered design has the following benefits:

* The asynchrony and server aspects to handle multiple document sessions are handled in server.ts,
  using existing nodejs libraries rather than having to build a LSP server in F* itself.

* Every document has its own F* process, providing isolation

* We reuse the IDE protocol, which has been used and tested extensively over several years in the
  context of fstar-mode.el. The IDE protocol is described here: https://github.com/FStarLang/FStar/wiki/Editor-support-for-F%2A#adding-support-for-new-ides

On the downside, our use of the custom IDE protocol means that adapting this extension for use in other
LSP-capable editors would require also re-writing server.ts, rather than being able to use fstar.exe
out of the box.

# Main event handlers

### onDidOpen

server.ts launches two F* processes per open document:

* `fstar_ide`: This is a process used to handle verification requests on the document.

* `fstar_lax_ide`: This is used to handle on-the-fly checking, symbol resolution etc.
   Fragments of a document are only lax-checked by this F* process.

### onHover

`fstar_lax_ide` is called to resolve the type of the symbol under the cursor.

### onDefinition

`fstar_lax_ide` is called to resolve the definition of the symbol under the cursor.

### onDocumentRangeFormatting

We spawn a new process fstar.exe,
and send it the `format` message with the content of the current selection, returning
its result as the reformatted content.

### onCompletion

The `server.ts` sends an `autocomplete` IDE request to fstar_lax_ide.

## Custom events

### `fstar-vscode-extension/verify-to-position`

The user can trigger this event by using `Ctrl+.`

server.ts sends a request to `fstar_ide` to check the document up
to the current cursor position.

### `fstar-vscode-extension/lax-to-position`

The user can trigger this event by using `Ctrl+Shift+.`

server.ts sends a request to `fstar_ide` to lax check the document up
to the current cursor position.

### `fstar-vscode-extension/restart`

The user can trigger this event by using `Ctrl+; Ctrl+.`

server.ts kills both the `fstar_ide` and `fstar_lax_ide` processes,
clears any other document state, and then restarts the proceses.

This is useful to rewind its state to the top of the current document
and reload any dependences.

### `fstar-vscode-extension/text-doc-changed`

When the document changes, the client forwards this event to the server, including
the first position in the document of the change. This position is not available in 
the `onDidChangeContent` LSP event, so we have a custom event for it.

To handle this event, server.ts sends a `cancel p` message to `fstar_ide`, where `p`
is the position of the change. In response, in `fstar_ide` will cancel all pending
requests to check fragments of the document whose position is at `p` or beyond.

## Events from server.ts to extension.ts

In addition to standard LSP diagnostics, hover events, definitions, completions etc., 
we have custom messages, see `fstarLspExtensions.ts` for details.

# Publishing an extension

The extension is automatically published by CI if you push a release:
1. `npx vsce package minor` to bump the version and create a release tag.
2. `git push --follow-tags` to push the release.

If you want to build the extension for local testing,
you can create a `.vsix` using `npx vsce package`.
